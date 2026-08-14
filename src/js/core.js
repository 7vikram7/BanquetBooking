// core.js — config, constants, small state accessors, date/money utils, Firebase init.
// Loaded first. No dependencies on other app scripts.

// ---------------------------------------------------------------------------
// Firebase config — hardcoded client-side on purpose (see CONTEXT.md).
// Replace the placeholders below with your real Firebase project config
// (Firebase console → Project settings → General → Your apps → SDK setup).
// Until replaced, the app runs fully on localStorage only.
// ---------------------------------------------------------------------------
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCbtI6Q0TA8RzhU7lVMQqYOlssFVeV9YYM",
  authDomain: "banquet-74423.firebaseapp.com",
  projectId: "banquet-74423",
  storageBucket: "banquet-74423.firebasestorage.app",
  messagingSenderId: "272012794305",
  appId: "1:272012794305:web:fd68b74959951957263740",
};

const FIRESTORE_COLLECTION = "banquet_kv";

// Fixed, non-secret pseudo-emails identifying the two roles as real
// Firebase Auth accounts (see auth.js). Not used for actual email
// delivery — knowing the address grants nothing without the real
// password, which is the whole point: unlike the Firestore config, a real
// password can't be read out of the public client bundle.
const OWNER_EMAIL = "owner@banquet-74423.firebaseapp.com";
const STAFF_EMAIL = "staff@banquet-74423.firebaseapp.com";

const HALL_DEFAULTS = [
  { id: "hallA", name: "Hall A" },
  { id: "hallB", name: "Hall B" },
];

const SLOTS = [
  { id: "lunch", name: "Lunch" },
  { id: "dinner", name: "Dinner" },
];

// No "converted" status: once an enquiry becomes a booking it's deleted
// (see saveBooking() in bookings-ui.js) rather than relabeled — the
// event's status from that point on lives only on the booking record.
const ENQUIRY_STATUSES = ["new", "followup", "lost"];
// A booking is now always either "confirmed" or "cancelled" — there is no
// "tentative" middle state going forward (an uncommitted event stays an
// enquiry until it's actually confirmed). "tentative" is intentionally
// NOT removed from slotStatus()'s possible outputs below, since any
// booking record written before this change could still carry that
// status — it must keep rendering distinctly rather than falling through
// to some other color.
const BOOKING_STATUSES = ["confirmed", "cancelled"];

const EVENT_TYPES = [
  "Wedding",
  "Reception",
  "Engagement",
  "Birthday",
  "Anniversary",
  "Corporate",
  "Other",
];

// Order here is display order everywhere: the menu modal's tabs and the
// generated PDF both iterate this array directly.
const MENU_CATEGORIES = [
  { id: "welcomeDrink", name: "Welcome Drink" },
  { id: "soup", name: "Soup" },
  { id: "starters", name: "Starters" },
  { id: "salad", name: "Salad" },
  { id: "raita", name: "Raita" },
  { id: "mainCourse", name: "Main Course" },
  { id: "indianBread", name: "Indian Bread" },
  { id: "dal", name: "Dal" },
  { id: "rice", name: "Rice" },
  { id: "dessert", name: "Dessert" },
  { id: "liveCounter", name: "Live Counter" },
  { id: "specialRequirement", name: "Special Requirement" },
];

// ---------------------------------------------------------------------------
// Date utils
// ---------------------------------------------------------------------------

// Local-date ISO (YYYY-MM-DD) — avoids UTC-shift bugs from toISOString().
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return isoDate(new Date());
}

function monthKey(isoDateStr) {
  return isoDateStr.slice(0, 7); // YYYY-MM
}

// Inclusive list of YYYY-MM keys spanning [fromIso, toIso].
function monthsBetween(fromIso, toIso) {
  const months = [];
  let [y, m] = fromIso.slice(0, 7).split("-").map(Number);
  const [toY, toM] = toIso.slice(0, 7).split("-").map(Number);
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function formatDateHuman(isoDateStr) {
  if (!isoDateStr) return "";
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function monthLabel(ymKey) {
  const [y, m] = ymKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function daysInMonth(ymKey) {
  const [y, m] = ymKey.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// ---------------------------------------------------------------------------
// Money utils
// ---------------------------------------------------------------------------

function formatMoney(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Misc utils
// ---------------------------------------------------------------------------

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function slotName(slotId) {
  return SLOTS.find((s) => s.id === slotId)?.name || slotId;
}

function hallName(halls, hallId) {
  return halls.find((h) => h.id === hallId)?.name || hallId;
}

// ---------------------------------------------------------------------------
// Booking / enquiry / slot-status helpers shared by calendar + dashboard
// ---------------------------------------------------------------------------

// "Advances" only — pre-settlement deposits recorded on the booking.
// Excludes any legacy `isFinalCollection` entry (older versions of this app
// auto-recorded the settlement's collected amount as a payment here; that
// money now lives on booking.settlement.collectedAmount instead — see
// settlementCollectedAmount() below — and is filtered out here as a safety
// net for any already-settled booking that hasn't been re-saved since).
function bookingPaid(booking) {
  return (booking.payments || [])
    .filter((p) => !p.isFinalCollection)
    .reduce((sum, p) => sum + toNumber(p.amount), 0);
}

// The amount collected at Final Settlement time, tracked separately from
// advances (see bookings-ui.js's confirmSettlementHandler()). Falls back
// for records saved before `collectedAmount` existed: first to a legacy
// `isFinalCollection` payment entry if one is still present, then (for
// bookings settled before that auto-collect feature existed at all) to
// "whatever's left of the final total once advances are counted."
function settlementCollectedAmount(booking) {
  if (!booking.settlement?.settledBy) return 0;
  if (booking.settlement.collectedAmount !== undefined) {
    return toNumber(booking.settlement.collectedAmount);
  }
  const legacy = (booking.payments || []).find((p) => p.isFinalCollection);
  if (legacy) return toNumber(legacy.amount);
  return Math.max(0, effectiveBookingTotal(booking) - bookingPaid(booking));
}

// Total money actually received for an event: advances plus (once settled)
// the settlement collection — the two are tracked separately but need to be
// combined for balance/"paid so far" figures.
function bookingTotalReceived(booking) {
  return bookingPaid(booking) + settlementCollectedAmount(booking);
}

// Once a booking's final settlement is recorded (see bookings-ui.js), its
// figures — not the pre-event estimate — are the authoritative total: the
// actual plate count/rent/extras on the day can differ from what was
// estimated when the booking was first made.
function effectiveBookingTotal(booking) {
  return booking.settlement?.finalTotalAmount ?? toNumber(booking.totalAmount);
}

function bookingBalance(booking) {
  return effectiveBookingTotal(booking) - bookingTotalReceived(booking);
}

function findBookingForSlot(bookingsForDate, hallId, slotId) {
  return (
    bookingsForDate.find(
      (b) => b.hallId === hallId && b.slot === slotId && b.status !== "cancelled"
    ) || null
  );
}

function findActiveEnquiriesForSlot(enquiriesForDate, hallId, slotId) {
  return enquiriesForDate.filter(
    (e) =>
      e.hallId === hallId &&
      e.slot === slotId &&
      (e.status === "new" || e.status === "followup")
  );
}

function populateSelect(selectEl, options, { includeBlank, blankLabel } = {}) {
  selectEl.innerHTML = "";
  if (includeBlank) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = blankLabel || "";
    selectEl.appendChild(opt);
  }
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name;
    selectEl.appendChild(opt);
  }
}

// Shared required-field check for enquiry/booking forms (date, hall, slot,
// event type, customer name, phone, guest count are all marked required in
// the UI — hall/slot/event type are <select>s with no blank option, so they
// can never actually be empty and don't need a runtime check here).
function requiredFieldErrors(data) {
  const missing = [];
  if (!data.date) missing.push("Date");
  if (!data.customerName) missing.push("Customer name");
  if (!data.phone) missing.push("Phone");
  if (!data.guestCount || data.guestCount <= 0) missing.push("Guest count");
  return missing;
}

// Returns 'confirmed' | 'tentative' | 'enquiry' | 'available'
function slotStatus(bookingsForDate, enquiriesForDate, hallId, slotId) {
  const booking = findBookingForSlot(bookingsForDate, hallId, slotId);
  if (booking) return bookingDisplayStatus(booking);
  const enquiries = findActiveEnquiriesForSlot(enquiriesForDate, hallId, slotId);
  if (enquiries.length) return "enquiry";
  return "available";
}

// A confirmed booking that's been through Final Settlement displays as its
// own "settled" status (orange) rather than plain "confirmed" (red) — a
// clear at-a-glance signal that the event is fully wrapped up, not just
// booked. Used both for slotStatus() (calendar dots/cells) and anywhere a
// booking's raw .status would otherwise be shown directly as a pill/label.
function bookingDisplayStatus(booking) {
  if (booking.status === "confirmed") {
    return booking.settlement?.settledBy ? "settled" : "confirmed";
  }
  return booking.status === "cancelled" ? "cancelled" : "tentative"; // legacy non-confirmed statuses
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    document.getElementById("confirm-message").textContent = message;
    openModal("modal-confirm");
    const yesBtn = document.getElementById("confirm-yes-btn");
    const noBtn = document.getElementById("confirm-no-btn");
    const cleanup = (result) => {
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      closeModal("modal-confirm");
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
  });
}

// ---------------------------------------------------------------------------
// Firebase SDK loading — gstatic primary, cdnjs fallback.
// Sets window.firebaseReady = true once app + firestore are initialized.
// ---------------------------------------------------------------------------

const FIREBASE_VERSION = "10.14.1";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function initFirebase() {
  if (FIREBASE_CONFIG.apiKey === "REPLACE_ME") {
    console.warn("[core] Firebase not configured — running localStorage-only.");
    window.firebaseReady = false;
    return;
  }
  const sources = [
    {
      app: `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`,
      fs: `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore-compat.js`,
      auth: `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth-compat.js`,
      functions: `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-functions-compat.js`,
    },
    {
      app: `https://cdnjs.cloudflare.com/ajax/libs/firebase/${FIREBASE_VERSION}/firebase-app-compat.min.js`,
      fs: `https://cdnjs.cloudflare.com/ajax/libs/firebase/${FIREBASE_VERSION}/firebase-firestore-compat.min.js`,
      auth: `https://cdnjs.cloudflare.com/ajax/libs/firebase/${FIREBASE_VERSION}/firebase-auth-compat.min.js`,
      functions: `https://cdnjs.cloudflare.com/ajax/libs/firebase/${FIREBASE_VERSION}/firebase-functions-compat.min.js`,
    },
  ];

  for (const src of sources) {
    try {
      await loadScript(src.app);
      await loadScript(src.fs);
      await loadScript(src.auth);
      await loadScript(src.functions);
      firebase.initializeApp(FIREBASE_CONFIG);
      window.firestoreDb = firebase.firestore();
      if (location.hostname === "localhost" && window.BANQUET_USE_EMULATORS) {
        firebase.auth().useEmulator("http://localhost:9099", { disableWarnings: true });
        window.firestoreDb.useEmulator("localhost", 8080);
        firebase.functions().useEmulator("localhost", 5001);
      }
      window.firebaseReady = true;
      console.info("[core] Firebase ready.");
      return;
    } catch (err) {
      console.warn("[core] Firebase source failed, trying fallback…", err);
    }
  }
  console.error("[core] All Firebase SDK sources failed — localStorage-only mode.");
  window.firebaseReady = false;
}

// ---------------------------------------------------------------------------
// jsPDF — loaded lazily (only when a "Download PDF" button is actually
// clicked, not on every page load) for the menu-PDF feature. cdnjs primary,
// jsdelivr fallback — gstatic doesn't mirror this one.
// ---------------------------------------------------------------------------

const JSPDF_VERSION = "2.5.1";
let jsPdfLoadPromise = null;

function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve();
  if (jsPdfLoadPromise) return jsPdfLoadPromise;

  const sources = [
    `https://cdnjs.cloudflare.com/ajax/libs/jspdf/${JSPDF_VERSION}/jspdf.umd.min.js`,
    `https://cdn.jsdelivr.net/npm/jspdf@${JSPDF_VERSION}/dist/jspdf.umd.min.js`,
  ];

  jsPdfLoadPromise = (async () => {
    for (const src of sources) {
      try {
        await loadScript(src);
        if (window.jspdf?.jsPDF) return;
      } catch (err) {
        console.warn("[core] jsPDF source failed, trying fallback…", err);
      }
    }
    throw new Error("All jsPDF sources failed to load.");
  })();
  return jsPdfLoadPromise;
}

// ---------------------------------------------------------------------------
// SheetJS (xlsx) — loaded lazily (only when "Download Excel" is actually
// clicked) for the Accounts tab's export feature. Same cdnjs-primary,
// jsdelivr-fallback pattern as jsPDF above.
// ---------------------------------------------------------------------------

const XLSX_VERSION = "0.18.5";
let xlsxLoadPromise = null;

function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (xlsxLoadPromise) return xlsxLoadPromise;

  const sources = [
    `https://cdnjs.cloudflare.com/ajax/libs/xlsx/${XLSX_VERSION}/xlsx.full.min.js`,
    `https://cdn.jsdelivr.net/npm/xlsx@${XLSX_VERSION}/dist/xlsx.full.min.js`,
  ];

  xlsxLoadPromise = (async () => {
    for (const src of sources) {
      try {
        await loadScript(src);
        if (window.XLSX) return;
      } catch (err) {
        console.warn("[core] XLSX source failed, trying fallback…", err);
      }
    }
    throw new Error("All XLSX sources failed to load.");
  })();
  return xlsxLoadPromise;
}

// Fetches a same-origin image and resolves its contents as a data: URL, for
// embedding into a generated PDF via doc.addImage().
function imageUrlToDataUrl(url) {
  return fetch(url)
    .then((res) => res.blob())
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        })
    );
}
