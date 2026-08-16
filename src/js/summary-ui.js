// summary-ui.js — a quick day/range overview visible to BOTH the owner and
// staff (unlike Dashboard/Accounts/Directory/Settings, which are
// data-owner-only in index.html/auth.js's applyRoleVisibility() — this tab
// deliberately has neither the "hidden" class nor a data-owner-only
// attribute on its nav button).

function initSummaryTab() {
  const fromInput = document.getElementById("summary-filter-from");
  const toInput = document.getElementById("summary-filter-to");

  const today = todayIso();
  fromInput.value = today;
  toInput.value = today;

  // Explicit Search, not auto-load on tab open/date change — see the
  // wide-scan comment on SUMMARY_SCAN_YEARS_BACK/FORWARD below for why:
  // same reasoning Directory's ensureDirectoryBackfilled() already
  // established for this exact kind of expensive full sweep.
  document.getElementById("summary-search-btn").addEventListener("click", renderSummaryTab);
  document.getElementById("summary-download-excel-btn").addEventListener("click", generateSummaryExcel);

  const placeholder = '<div class="simple-list-empty">Choose a date range and press Search to load entries.</div>';
  document.getElementById("summary-enquiries-list").innerHTML = placeholder;
  document.getElementById("summary-events-list").innerHTML = placeholder;
  document.getElementById("summary-settlements-list").innerHTML = placeholder;
  document.getElementById("summary-payments-list").innerHTML = placeholder;
}

function summaryDateRange() {
  const today = todayIso();
  const fromVal = document.getElementById("summary-filter-from").value;
  const toVal = document.getElementById("summary-filter-to").value;
  return { from: fromVal || today, to: toVal || today };
}

// "Bookings made", "Settlements", and "Money received" all answer "what
// ACTUALLY HAPPENED during [from,to]" — a booking taken today for a
// wedding 8 months out, a settlement closed today for an event booked
// last year, an advance collected today toward a future event — none of
// these have their own event date anywhere near [from,to]. Scoping the
// initial Firestore fetch to BookingsStore.getRange(from,to) (as the
// first version of this tab did) silently DROPS all of those, because
// that query is bucketed and filtered by the booking's own EVENT date,
// not by when the booking/settlement/payment actually happened — the
// exact bug reported after shipping: "confirmed events" only counted
// events happening in the window, not bookings taken during it.
//
// Fix: fetch a much WIDER window of event-date buckets (same idea, same
// constants, as Directory's ensureDirectoryBackfilled() — a banquet hall
// realistically doesn't take bookings further than a couple years out,
// but this stays generous), then filter EACH metric by its own actual
// action date (createdAt / settledDate / payment.date) rather than by
// the booking's event date at all. Enquiries are left scoped to their
// own event date via EnquiriesStore.getRange(from,to) — not what was
// reported broken, and "enquiries about events happening in this window"
// is a materially different (also useful) question than "enquiries
// received in this window"; revisit if that turns out to be wanted too.
const SUMMARY_SCAN_YEARS_BACK = 15;
const SUMMARY_SCAN_YEARS_FORWARD = 5;

function inRange(dateStr, from, to) {
  return !!dateStr && dateStr >= from && dateStr <= to;
}

// Shared by both renderSummaryTab() (on-screen) and generateSummaryExcel()
// (download) so the two can never drift apart.
async function computeSummaryData(from, to) {
  const today = new Date();
  const scanFrom = isoDate(new Date(today.getFullYear() - SUMMARY_SCAN_YEARS_BACK, today.getMonth(), today.getDate()));
  const scanTo = isoDate(new Date(today.getFullYear() + SUMMARY_SCAN_YEARS_FORWARD, today.getMonth(), today.getDate()));

  const [enquiries, allBookings] = await Promise.all([
    EnquiriesStore.getRange(from, to),
    BookingsStore.getRange(scanFrom, scanTo),
  ]);
  const activeBookings = allBookings.filter((b) => b.status !== "cancelled");

  const bookingsMade = activeBookings.filter((b) => inRange((b.createdAt || "").slice(0, 10), from, to));
  const settledBookings = activeBookings.filter((b) => b.settlement?.settledBy && inRange(b.settlement.settledDate, from, to));

  // One row per actual money-changing-hands event — an advance payment or
  // a settlement collection — not one row per booking, filtered by THAT
  // payment's own date, independent of the booking's event date or even
  // of whether the booking itself was "made" in this window.
  const payments = [];
  for (const b of activeBookings) {
    for (const p of (b.payments || []).filter((p) => !p.isFinalCollection)) {
      if (!inRange(p.date, from, to)) continue;
      payments.push({
        date: p.date,
        customerName: b.customerName,
        staffName: p.receivedBy || "—",
        amount: toNumber(p.amount),
        type: "Advance",
        booking: b,
      });
    }
    if (b.settlement?.settledBy && inRange(b.settlement.settledDate, from, to)) {
      payments.push({
        date: b.settlement.settledDate,
        customerName: b.customerName,
        staffName: b.settlement.settledBy,
        amount: settlementCollectedAmount(b),
        type: "Settlement",
        booking: b,
      });
    }
  }
  payments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const totalReceived = payments.reduce((s, p) => s + p.amount, 0);

  return { enquiries, bookingsMade, settledBookings, payments, totalReceived };
}

async function renderSummaryTab() {
  const { from, to } = summaryDateRange();
  const halls = window.appSettings.halls;
  const searchBtn = document.getElementById("summary-search-btn");

  const originalLabel = searchBtn.textContent;
  searchBtn.disabled = true;
  searchBtn.textContent = "Searching…";
  const loading = '<div class="simple-list-empty">Loading…</div>';
  document.getElementById("summary-enquiries-list").innerHTML = loading;
  document.getElementById("summary-events-list").innerHTML = loading;
  document.getElementById("summary-settlements-list").innerHTML = loading;
  document.getElementById("summary-payments-list").innerHTML = loading;

  try {
    const { enquiries, bookingsMade, settledBookings, payments, totalReceived } = await computeSummaryData(from, to);

    document.getElementById("summary-stats").innerHTML = `
      <div class="acct-summary-item"><span>Enquiries</span><strong>${enquiries.length}</strong></div>
      <div class="acct-summary-item"><span>Bookings made</span><strong>${bookingsMade.length}</strong></div>
      <div class="acct-summary-item"><span>Settlements done</span><strong>${settledBookings.length}</strong></div>
      <div class="acct-summary-item"><span>Total money received</span><strong>${formatMoney(totalReceived)}</strong></div>
    `;

    const enqList = document.getElementById("summary-enquiries-list");
    enqList.innerHTML = "";
    if (!enquiries.length) {
      enqList.innerHTML = '<div class="simple-list-empty">No enquiries in this range.</div>';
    } else {
      for (const e of [...enquiries].sort((a, b) => a.date.localeCompare(b.date))) {
        const item = document.createElement("div");
        item.className = "simple-list-item";
        item.innerHTML = `
          <span>${formatDateHuman(e.date)} · ${escapeHtml(e.customerName)}${e.phone ? " · " + escapeHtml(e.phone) : ""} · ${escapeHtml(e.eventType || "")}</span>
          <span class="status-pill status-${e.status}">${e.status}</span>
        `;
        item.addEventListener("click", () => openEnquiryModal(e));
        enqList.appendChild(item);
      }
    }

    const eventsList = document.getElementById("summary-events-list");
    eventsList.innerHTML = "";
    if (!bookingsMade.length) {
      eventsList.innerHTML = '<div class="simple-list-empty">No bookings made in this range.</div>';
    } else {
      for (const b of [...bookingsMade].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))) {
        const item = document.createElement("div");
        item.className = "simple-list-item";
        item.innerHTML = `
          <span>Booked ${formatDateHuman((b.createdAt || "").slice(0, 10))} · Event on ${formatDateHuman(b.date)} · ${escapeHtml(hallName(halls, b.hallId))} ${slotName(b.slot)} · ${escapeHtml(b.customerName)} · ${escapeHtml(b.eventType || "")} · Booked by ${escapeHtml(b.createdBy || "—")}</span>
          <span class="acct-row-money">${formatMoney(effectiveBookingTotal(b))}</span>
        `;
        item.addEventListener("click", () => openBookingModal(b));
        eventsList.appendChild(item);
      }
    }

    const settlementsList = document.getElementById("summary-settlements-list");
    settlementsList.innerHTML = "";
    if (!settledBookings.length) {
      settlementsList.innerHTML = '<div class="simple-list-empty">No settlements recorded in this range.</div>';
    } else {
      for (const b of [...settledBookings].sort((a, b) => (a.settlement.settledDate || "").localeCompare(b.settlement.settledDate || ""))) {
        const item = document.createElement("div");
        item.className = "simple-list-item";
        item.innerHTML = `
          <span>${formatDateHuman(b.settlement.settledDate)} · ${escapeHtml(b.customerName)} · Settled by ${escapeHtml(b.settlement.settledBy)}</span>
          <span class="acct-row-money">${formatMoney(effectiveBookingTotal(b))}</span>
        `;
        item.addEventListener("click", () => openBookingModal(b));
        settlementsList.appendChild(item);
      }
    }

    const paymentsList = document.getElementById("summary-payments-list");
    paymentsList.innerHTML = "";
    if (!payments.length) {
      paymentsList.innerHTML = '<div class="simple-list-empty">No money received in this range.</div>';
    } else {
      for (const p of payments) {
        const item = document.createElement("div");
        item.className = "simple-list-item";
        item.innerHTML = `
          <span>${formatDateHuman(p.date)} · ${escapeHtml(p.customerName)} · Received by ${escapeHtml(p.staffName)} · ${escapeHtml(p.type)}</span>
          <span class="acct-row-money">${formatMoney(p.amount)}</span>
        `;
        item.addEventListener("click", () => openBookingModal(p.booking));
        paymentsList.appendChild(item);
      }
    }
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = originalLabel;
  }
}

// One workbook, one sheet per list — the exact same rows shown on screen
// (via computeSummaryData()), so the download always matches what's
// visible. Same lazy-loaded-SheetJS pattern as generateAccountsExcel()/
// generateDirectoryExcel().
async function generateSummaryExcel(ev) {
  const btn = ev?.currentTarget || document.getElementById("summary-download-excel-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadXlsx();
    const halls = window.appSettings.halls;
    const { from, to } = summaryDateRange();
    const { enquiries, bookingsMade, settledBookings, payments } = await computeSummaryData(from, to);

    const workbook = window.XLSX.utils.book_new();

    const enquiryRows = enquiries.map((e) => ({
      Date: e.date,
      Customer: e.customerName,
      Phone: e.phone || "",
      "Event Type": e.eventType || "",
      Status: e.status,
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(enquiryRows), "Enquiries");

    const eventRows = bookingsMade.map((b) => ({
      "Booked Date": (b.createdAt || "").slice(0, 10),
      "Event Date": b.date,
      Hall: hallName(halls, b.hallId),
      Slot: slotName(b.slot),
      Customer: b.customerName,
      Phone: b.phone || "",
      "Event Type": b.eventType || "",
      "Booked By": b.createdBy || "",
      "Total Amount": effectiveBookingTotal(b),
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(eventRows), "Bookings Made");

    const settlementRows = settledBookings.map((b) => ({
      "Settled Date": b.settlement.settledDate || "",
      Customer: b.customerName,
      "Settled By": b.settlement.settledBy || "",
      "Final Total": effectiveBookingTotal(b),
      "Collected At Settlement": settlementCollectedAmount(b),
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(settlementRows), "Settlements");

    const paymentRows = payments.map((p) => ({
      Date: p.date,
      Customer: p.customerName,
      "Staff Name": p.staffName,
      Type: p.type,
      Amount: p.amount,
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(paymentRows), "Money Received");

    window.XLSX.writeFile(workbook, `Summary - ${from} to ${to}.xlsx`);
  } catch (err) {
    console.error("[summary-excel] failed to generate Excel file", err);
    alert("Could not generate the Excel file — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
