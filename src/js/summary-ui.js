// summary-ui.js — a quick day/range overview visible to BOTH the owner and
// staff (unlike Dashboard/Accounts/Directory/Settings, which are
// data-owner-only in index.html/auth.js's applyRoleVisibility() — this tab
// deliberately has neither the "hidden" class nor a data-owner-only
// attribute on its nav button). Reuses the same date-range convention as
// Accounts/Dashboard's Event Summary: `date` is the EVENT date, so this
// answers "how much is happening/being collected for events in this
// window", not "what got typed into the app today".

function initSummaryTab() {
  const fromInput = document.getElementById("summary-filter-from");
  const toInput = document.getElementById("summary-filter-to");

  const today = todayIso();
  fromInput.value = today;
  toInput.value = today;

  fromInput.addEventListener("change", renderSummaryTab);
  toInput.addEventListener("change", renderSummaryTab);
  document.getElementById("summary-download-excel-btn").addEventListener("click", generateSummaryExcel);
}

function summaryDateRange() {
  const today = todayIso();
  const fromVal = document.getElementById("summary-filter-from").value;
  const toVal = document.getElementById("summary-filter-to").value;
  return { from: fromVal || today, to: toVal || today };
}

// Shared by both renderSummaryTab() (on-screen) and generateSummaryExcel()
// (download) so the two can never drift apart — same convention as
// Accounts/Directory each independently re-deriving their row set, except
// here the itemized "payments" list (advances + settlement collections,
// each with its own date/staff/amount) is nontrivial enough that it's
// worth computing once and sharing rather than duplicating.
async function computeSummaryData(from, to) {
  const [enquiries, bookings] = await Promise.all([
    EnquiriesStore.getRange(from, to),
    BookingsStore.getRange(from, to),
  ]);
  const activeBookings = bookings.filter((b) => b.status !== "cancelled");
  const settledBookings = activeBookings.filter((b) => b.settlement?.settledBy);

  // One row per actual money-changing-hands event — an advance payment or
  // a settlement collection — not one row per booking, so a booking with
  // three advances shows up three times here (each with its own date and
  // whoever actually received that specific payment). isFinalCollection
  // entries are the same legacy artifact accounts-ui.js already excludes
  // (see core.js's bookingPaid()).
  const payments = [];
  for (const b of activeBookings) {
    for (const p of (b.payments || []).filter((p) => !p.isFinalCollection)) {
      payments.push({
        date: p.date,
        customerName: b.customerName,
        staffName: p.receivedBy || "—",
        amount: toNumber(p.amount),
        type: "Advance",
        booking: b,
      });
    }
    if (b.settlement?.settledBy) {
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

  return { enquiries, activeBookings, settledBookings, payments, totalReceived };
}

async function renderSummaryTab() {
  const { from, to } = summaryDateRange();
  const halls = window.appSettings.halls;
  const { enquiries, activeBookings, settledBookings, payments, totalReceived } = await computeSummaryData(from, to);

  document.getElementById("summary-stats").innerHTML = `
    <div class="acct-summary-item"><span>Enquiries</span><strong>${enquiries.length}</strong></div>
    <div class="acct-summary-item"><span>Confirmed events</span><strong>${activeBookings.length}</strong></div>
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
  if (!activeBookings.length) {
    eventsList.innerHTML = '<div class="simple-list-empty">No confirmed events in this range.</div>';
  } else {
    for (const b of [...activeBookings].sort((a, b) => a.date.localeCompare(b.date))) {
      const item = document.createElement("div");
      item.className = "simple-list-item";
      item.innerHTML = `
        <span>${formatDateHuman(b.date)} · ${escapeHtml(hallName(halls, b.hallId))} ${slotName(b.slot)} · ${escapeHtml(b.customerName)} · ${escapeHtml(b.eventType || "")}</span>
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
    const { enquiries, activeBookings, settledBookings, payments } = await computeSummaryData(from, to);

    const workbook = window.XLSX.utils.book_new();

    const enquiryRows = enquiries.map((e) => ({
      Date: e.date,
      Customer: e.customerName,
      Phone: e.phone || "",
      "Event Type": e.eventType || "",
      Status: e.status,
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(enquiryRows), "Enquiries");

    const eventRows = activeBookings.map((b) => ({
      Date: b.date,
      Hall: hallName(halls, b.hallId),
      Slot: slotName(b.slot),
      Customer: b.customerName,
      Phone: b.phone || "",
      "Event Type": b.eventType || "",
      "Total Amount": effectiveBookingTotal(b),
    }));
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(eventRows), "Confirmed Events");

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
