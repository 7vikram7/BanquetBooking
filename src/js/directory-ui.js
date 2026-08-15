// directory-ui.js — owner-only permanent customer contact log. Reads only
// from DirectoryStore (see data-store.js) — this tab has no delete/edit
// capability at all, by design; the whole point is a record that survives
// Settings > Data Deletion clearing out bookings/enquiries in the same
// date range.

// A directory entry's "date" is the EVENT date, not when it was logged —
// a brand-new enquiry is very often for an event months away, so
// defaulting this tab to "current month" (the pattern Accounts uses,
// where it's correct — a sale can't be in the future) hid almost every
// fresh entry by default. Real bug, not a hypothetical: verified directly
// against DirectoryStore that entries WERE being logged correctly; the
// tab just wasn't showing them. Wide fixed window instead — covers
// realistic advance-booking lead time (a banquet hall doesn't usually
// take bookings more than a couple years out) plus past history, without
// being literally unbounded.
const DIRECTORY_DEFAULT_YEARS_BACK = 2;
const DIRECTORY_DEFAULT_YEARS_FORWARD = 2;

function directoryDefaultRange() {
  const today = new Date();
  const from = isoDate(new Date(today.getFullYear() - DIRECTORY_DEFAULT_YEARS_BACK, today.getMonth(), today.getDate()));
  const to = isoDate(new Date(today.getFullYear() + DIRECTORY_DEFAULT_YEARS_FORWARD, today.getMonth(), today.getDate()));
  return { from, to };
}

function initDirectoryTab() {
  const fromInput = document.getElementById("dir-filter-from");
  const toInput = document.getElementById("dir-filter-to");

  const { from, to } = directoryDefaultRange();
  fromInput.value = from;
  toInput.value = to;

  fromInput.addEventListener("change", renderDirectoryList);
  toInput.addEventListener("change", renderDirectoryList);
  document.getElementById("dir-download-excel-btn").addEventListener("click", generateDirectoryExcel);
}

function directoryDateRange() {
  const fromVal = document.getElementById("dir-filter-from").value;
  const toVal = document.getElementById("dir-filter-to").value;
  const defaults = directoryDefaultRange();
  return { from: fromVal || defaults.from, to: toVal || defaults.to };
}

// Directory entries are only ever WRITTEN at creation time (saveEnquiry()/
// saveBooking()'s new-record branch) — so anything created before this
// feature existed has no directory entry at all and would otherwise never
// show up, no matter how wide the date filter is. This backfills those in,
// scanning a much wider window than the tab's own display range (real
// bookings/enquiries could predate the Directory feature by longer than
// the display default's 2-year lookback). Idempotent via `sourceId` (the
// originating booking/enquiry's own id) — already-backfilled or
// normally-logged records are skipped, so this is safe to run every time
// the tab loads, not just once.
//
// Deliberately does NOT skip a record for having a blank customerName/
// phone/eventType — every enquiry and booking gets a directory entry
// unconditionally, incomplete or not; filtering by field completeness
// would just recreate the exact "data goes missing for no visible reason"
// problem this whole feature exists to avoid.
const DIRECTORY_BACKFILL_YEARS_BACK = 15;
const DIRECTORY_BACKFILL_YEARS_FORWARD = 5;
// Caches the IN-FLIGHT promise, not just a "done" boolean — a real bug
// (caught in production, not anticipated) with a plain boolean flag: it's
// only set true at the very end, so calling this again before the first
// call finishes (e.g. clicking the Directory tab a couple of times while
// the first click's Firestore round-trip is still in progress) sees
// "not done yet" and starts a fully independent second scan, unaware of
// the first one's in-flight writes — both then add their own directory
// entry for the same enquiry, since neither sees the other's write.
// Caching the promise means every caller, however many times this is
// invoked concurrently, awaits the exact same run.
let directoryBackfillPromise = null;

async function ensureDirectoryBackfilled() {
  if (!directoryBackfillPromise) {
    directoryBackfillPromise = runDirectoryBackfill();
  }
  return directoryBackfillPromise;
}

async function runDirectoryBackfill() {
  const today = new Date();
  const from = isoDate(new Date(today.getFullYear() - DIRECTORY_BACKFILL_YEARS_BACK, today.getMonth(), today.getDate()));
  const to = isoDate(new Date(today.getFullYear() + DIRECTORY_BACKFILL_YEARS_FORWARD, today.getMonth(), today.getDate()));

  const [existingEntries, enquiries, bookings] = await Promise.all([
    DirectoryStore.getRange(from, to),
    EnquiriesStore.getRange(from, to),
    BookingsStore.getRange(from, to),
  ]);
  // A Set that gets updated AS records are processed (not just seeded once
  // from existingEntries) — defense in depth against the same sourceId
  // ever appearing twice in one run, from any cause, not just the
  // concurrent-call race this was written to fix.
  const alreadyLogged = new Set(existingEntries.map((e) => e.sourceId).filter(Boolean));

  for (const enq of enquiries) {
    if (alreadyLogged.has(enq.id)) continue;
    alreadyLogged.add(enq.id);
    await addDirectoryEntry({
      date: enq.date,
      customerName: enq.customerName,
      phone: enq.phone,
      eventType: enq.eventType,
      source: "Enquiry",
      sourceId: enq.id,
    });
  }
  for (const bk of bookings) {
    if (alreadyLogged.has(bk.id)) continue;
    alreadyLogged.add(bk.id);
    await addDirectoryEntry({
      date: bk.date,
      customerName: bk.customerName,
      phone: bk.phone,
      eventType: bk.eventType,
      source: "Booking",
      sourceId: bk.id,
    });
  }
}

async function directoryEntriesInRange() {
  await ensureDirectoryBackfilled();
  const { from, to } = directoryDateRange();
  const entries = await DirectoryStore.getRange(from, to);
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.loggedAt || "").localeCompare(b.loggedAt || ""));
  return entries;
}

async function renderDirectoryList() {
  const container = document.getElementById("directory-list");
  const entries = await directoryEntriesInRange();

  if (!entries.length) {
    container.innerHTML = '<div class="simple-list-empty">No customer entries in this date range.</div>';
    return;
  }

  container.innerHTML = "";
  entries.forEach((entry, idx) => {
    const row = document.createElement("div");
    row.className = "acct-row";
    row.innerHTML = `
      <div class="acct-row-summary">
        <span>#${idx + 1} · ${escapeHtml(entry.customerName)}${entry.phone ? " · " + escapeHtml(entry.phone) : ""}</span>
        <span class="acct-row-money">${formatDateHuman(entry.date)} · ${escapeHtml(entry.eventType || "")} · ${escapeHtml(entry.source || "")}</span>
      </div>
    `;
    container.appendChild(row);
  });
}

// Same lazy-load-SheetJS-on-click pattern as generateAccountsExcel() in
// accounts-ui.js.
async function generateDirectoryExcel(ev) {
  const btn = ev?.currentTarget || document.getElementById("dir-download-excel-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadXlsx();
    const { from, to } = directoryDateRange();
    const entries = await directoryEntriesInRange();

    if (!entries.length) {
      alert(`No customer entries between ${formatDateHuman(from)} and ${formatDateHuman(to)} to export.`);
      return;
    }

    const rows = entries.map((entry, idx) => ({
      "Sr No": idx + 1,
      "Name": entry.customerName,
      "Phone": entry.phone || "",
      "Date": entry.date,
      "Occasion": entry.eventType || "",
      "Source": entry.source || "",
    }));

    const worksheet = window.XLSX.utils.json_to_sheet(rows);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Directory");
    window.XLSX.writeFile(workbook, `Directory - ${from} to ${to}.xlsx`);
  } catch (err) {
    console.error("[directory-excel] failed to generate Excel file", err);
    alert("Could not generate the Excel file — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
