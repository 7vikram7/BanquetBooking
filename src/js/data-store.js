// data-store.js — all persistence lives here. Offline-first dual-write:
// every write goes to localStorage first (always succeeds), then Firestore
// (best-effort). Reads try Firestore first, fall back to localStorage.
//
// Firestore layout: one collection (FIRESTORE_COLLECTION), one doc per key,
// each doc shaped { value: "<JSON string>" } — simple KV store, not a
// normalized schema.
//
// Date-bucketed collections (bookings, enquiries) use monthly documents:
// key = "<name>:<YYYY-MM>" -> { "<isoDate>": [record, ...] }

function reportSyncStatus(ok, message) {
  window.dispatchEvent(new CustomEvent("banquet:syncstatus", { detail: { ok, message } }));
}

async function firestoreGet(key) {
  if (!window.firebaseReady) throw new Error("firebase not ready");
  const snap = await window.firestoreDb.collection(FIRESTORE_COLLECTION).doc(key).get();
  if (!snap.exists) return undefined;
  const data = snap.data();
  return data && typeof data.value === "string" ? JSON.parse(data.value) : undefined;
}

async function firestoreSet(key, value) {
  if (!window.firebaseReady) throw new Error("firebase not ready");
  await window.firestoreDb
    .collection(FIRESTORE_COLLECTION)
    .doc(key)
    .set({ value: JSON.stringify(value) });
}

function localGet(key) {
  const raw = localStorage.getItem(key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function localSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// Read: Firestore first, fall back to localStorage. Never throws.
async function safeGet(key) {
  try {
    const remote = await firestoreGet(key);
    if (remote !== undefined) {
      localSet(key, remote); // keep local mirror fresh
      reportSyncStatus(true, "");
      return remote;
    }
  } catch (err) {
    reportSyncStatus(false, "Offline — showing locally saved data.");
  }
  return localGet(key);
}

// Write: localStorage first (always succeeds), then best-effort Firestore.
async function safeSet(key, value) {
  localSet(key, value);
  try {
    await firestoreSet(key, value);
    reportSyncStatus(true, "");
  } catch (err) {
    reportSyncStatus(false, "Saved locally — will not sync until back online.");
  }
}

// ---------------------------------------------------------------------------
// Settings (single doc)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "banquet:settings";

async function getSettings() {
  const s = await safeGet(SETTINGS_KEY);
  // Defaults spread FIRST, then whatever's actually stored on top — a
  // settings doc that already exists (true for every live venue) still
  // needs new fields like staffMembers backfilled; `s || {defaults}` would
  // only apply when there's no doc at all, leaving staffMembers undefined
  // on every existing installation.
  return {
    halls: HALL_DEFAULTS,
    ownerHash: null,
    staffHash: null,
    staffMembers: [],
    customEventTypes: [],
    ...(s || {}),
  };
}

async function saveSettings(settings) {
  await safeSet(SETTINGS_KEY, settings);
}

// ---------------------------------------------------------------------------
// Date-bucketed record stores (bookings, enquiries)
// ---------------------------------------------------------------------------

function createDateBucketStore(name) {
  const monthCache = new Map(); // ymKey -> { "<isoDate>": [record,...] }

  function bucketKey(ymKey) {
    return `banquet:${name}:${ymKey}`;
  }

  async function loadMonth(ymKey, forceRefresh) {
    if (!forceRefresh && monthCache.has(ymKey)) return monthCache.get(ymKey);
    const data = (await safeGet(bucketKey(ymKey))) || {};
    monthCache.set(ymKey, data);
    return data;
  }

  async function saveMonth(ymKey, data) {
    monthCache.set(ymKey, data);
    await safeSet(bucketKey(ymKey), data);
  }

  async function getRange(fromIso, toIso) {
    const months = monthsBetween(fromIso, toIso);
    const out = [];
    for (const ym of months) {
      const bucket = await loadMonth(ym);
      for (const dateKey of Object.keys(bucket)) {
        if (dateKey < fromIso || dateKey > toIso) continue;
        for (const rec of bucket[dateKey]) out.push(rec);
      }
    }
    return out;
  }

  async function getByMonth(ymKey) {
    const bucket = await loadMonth(ymKey);
    const out = [];
    for (const dateKey of Object.keys(bucket)) {
      for (const rec of bucket[dateKey]) out.push(rec);
    }
    return out;
  }

  async function getById(id, hintIso) {
    if (hintIso) {
      const bucket = await loadMonth(monthKey(hintIso));
      const rec = (bucket[hintIso] || []).find((r) => r.id === id);
      if (rec) return rec;
    }
    // Fall back: scan cached months, then give up (caller should pass hintIso when known).
    for (const [, bucket] of monthCache) {
      for (const dateKey of Object.keys(bucket)) {
        const rec = bucket[dateKey].find((r) => r.id === id);
        if (rec) return rec;
      }
    }
    return null;
  }

  async function addRecord(record) {
    const ym = monthKey(record.date);
    const bucket = await loadMonth(ym);
    if (!bucket[record.date]) bucket[record.date] = [];
    bucket[record.date].push(record);
    await saveMonth(ym, bucket);
    return record;
  }

  // updates: partial fields to merge. Handles date changing (moves between buckets/days).
  async function updateRecord(id, oldDate, updates) {
    const oldYm = monthKey(oldDate);
    const oldBucket = await loadMonth(oldYm);
    const list = oldBucket[oldDate] || [];
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Record ${id} not found on ${oldDate}`);
    const updated = { ...list[idx], ...updates, id, updatedAt: new Date().toISOString() };

    const newDate = updated.date;
    if (newDate === oldDate) {
      list[idx] = updated;
      oldBucket[oldDate] = list;
      await saveMonth(oldYm, oldBucket);
    } else {
      list.splice(idx, 1);
      oldBucket[oldDate] = list;
      await saveMonth(oldYm, oldBucket);

      const newYm = monthKey(newDate);
      const newBucket = newYm === oldYm ? oldBucket : await loadMonth(newYm);
      if (!newBucket[newDate]) newBucket[newDate] = [];
      newBucket[newDate].push(updated);
      await saveMonth(newYm, newBucket);
    }
    return updated;
  }

  async function deleteRecord(id, isoDateHint) {
    const ym = monthKey(isoDateHint);
    const bucket = await loadMonth(ym);
    const list = bucket[isoDateHint] || [];
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    bucket[isoDateHint] = list;
    await saveMonth(ym, bucket);
    return true;
  }

  // Permanently removes records dated within [fromIso, toIso] — rewrites
  // each affected month bucket once (not a per-record delete), so a large
  // range doesn't turn into hundreds of individual Firestore writes.
  // Returns how many records were removed, for a confirmation UI to report
  // back before/after. No undo — the caller is responsible for confirming
  // with the user first (see settings-ui.js).
  //
  // `matchFn(record)`, if given, narrows this to only records it returns
  // true for (e.g. "settled but never billed with GST") — records that
  // don't match are left untouched. Omit it to delete everything in range,
  // as before.
  async function deleteRange(fromIso, toIso, matchFn) {
    const months = monthsBetween(fromIso, toIso);
    let removed = 0;
    for (const ym of months) {
      const bucket = await loadMonth(ym);
      let changed = false;
      for (const dateKey of Object.keys(bucket)) {
        if (dateKey < fromIso || dateKey > toIso) continue;
        const list = bucket[dateKey];
        const kept = matchFn ? list.filter((r) => !matchFn(r)) : [];
        removed += list.length - kept.length;
        if (kept.length) bucket[dateKey] = kept;
        else delete bucket[dateKey];
        changed = true;
      }
      if (changed) await saveMonth(ym, bucket);
    }
    return removed;
  }

  return { loadMonth, getRange, getByMonth, getById, addRecord, updateRecord, deleteRecord, deleteRange };
}

const BookingsStore = createDateBucketStore("bookings");
const EnquiriesStore = createDateBucketStore("enquiries");

// A permanent, append-only customer contact log — every new enquiry AND
// every new booking (bookings aren't always converted from an enquiry
// first) adds one entry here, in addition to whatever happens to its own
// BookingsStore/EnquiriesStore record. Deliberately built the same
// date-bucketed way as those two stores (so it gets getRange() for free,
// same querying convention as everywhere else in this app) — but
// settings-ui.js's Data Deletion feature must NEVER be wired to touch
// this store, by design: "keep this directory intact" even when
// bookings/enquiries within the same range are permanently deleted. If a
// future change ever needs to purge directory data, that has to be a
// deliberate, separate, explicitly-requested feature — not a side effect
// of the existing delete-range tool gaining one more store to sweep.
const DirectoryStore = createDateBucketStore("directory");

// Shared by saveEnquiry()/saveBooking() (see enquiries-ui.js/bookings-ui.js)
// AND directory-ui.js's backfill (see ensureDirectoryBackfilled() there —
// bookings/enquiries created before this feature existed never got a
// directory entry at creation time, since that only happens going
// forward; the backfill catches those up). `date` here is the
// event/occasion date (this app's existing meaning of "date" on an
// enquiry or booking record), not when the entry was logged — `loggedAt`
// separately captures that, in case the two ever need to be told apart.
// `sourceId` is the originating booking/enquiry's own id — what makes the
// backfill idempotent (safe to re-run: it checks this before adding).
async function addDirectoryEntry({ date, customerName, phone, eventType, source, sourceId }) {
  await DirectoryStore.addRecord({
    id: uid("dir"),
    date,
    customerName,
    phone,
    eventType,
    source,
    sourceId,
    loggedAt: new Date().toISOString(),
  });
}
