// accounts-ui.js — owner-only ledger of past events: date-wise sales,
// expand a row to see every payment's date and who collected it.

function initAccountsTab() {
  const fromInput = document.getElementById("acct-filter-from");
  const toInput = document.getElementById("acct-filter-to");

  // Opens on the current month by default (set as actual input values, not
  // just an internal fallback) — the owner sees exactly what range is
  // active and can freely pick any other from/to dates from there.
  const today = new Date();
  fromInput.value = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  toInput.value = isoDate(today);

  fromInput.addEventListener("change", renderAccountsList);
  toInput.addEventListener("change", renderAccountsList);
  document.getElementById("acct-download-excel-btn").addEventListener("click", generateAccountsExcel);
}

// Caps at today, never future — but DOES include today. Final Settlement
// can only be recorded on or after the event's own date (see
// bookings-ui.js's settlementTooEarly()), so a same-day settlement is now
// the common case, not an edge case — excluding "today" used to make sense
// when settlement could be recorded arbitrarily far in advance, but now it
// would just hide an event's sale figure for a full day after it's
// actually been billed. The `settlement?.settledBy` filter below is what
// actually keeps unsettled/incomplete events out, not this date cap.
// Falls back to the current month if the inputs are ever cleared (they're
// pre-filled by initAccountsTab() on login, so this mostly guards against a
// manually blanked field).
function accountsDateRange() {
  const fromVal = document.getElementById("acct-filter-from").value;
  const toVal = document.getElementById("acct-filter-to").value;

  const today = new Date();
  const todayIso = isoDate(today);
  const defaultFromIso = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));

  const from = fromVal || defaultFromIso;
  const to = toVal && toVal < todayIso ? toVal : todayIso;
  return { from, to };
}

async function renderAccountsList() {
  const halls = window.appSettings.halls;
  const { from, to } = accountsDateRange();

  let bookings = await BookingsStore.getRange(from, to);
  // Only settled events belong here — an event's sale figure isn't final
  // (and shouldn't hit the books) until someone has actually recorded the
  // final settlement bill. See bookings-ui.js's confirmSettlementHandler().
  bookings = bookings.filter((b) => b.status !== "cancelled" && b.settlement?.settledBy);
  bookings.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));

  const totalSales = bookings.reduce((s, b) => s + effectiveBookingTotal(b), 0);
  const totalPaid = bookings.reduce((s, b) => s + bookingTotalReceived(b), 0);

  const summary = document.getElementById("accounts-summary");
  summary.innerHTML = `
    <div class="acct-summary-item"><span>Total sales</span><strong>${formatMoney(totalSales)}</strong></div>
    <div class="acct-summary-item"><span>Collected</span><strong>${formatMoney(totalPaid)}</strong></div>
    <div class="acct-summary-item"><span>Outstanding</span><strong>${formatMoney(totalSales - totalPaid)}</strong></div>
    <div class="acct-summary-item"><span>Events</span><strong>${bookings.length}</strong></div>
  `;

  const list = document.getElementById("accounts-list");
  list.innerHTML = "";
  if (!bookings.length) {
    list.innerHTML = '<div class="simple-list-empty">No past events in this range.</div>';
    return;
  }

  for (const b of bookings) {
    const balance = bookingBalance(b);
    const row = document.createElement("div");
    row.className = "acct-row";

    const summaryRow = document.createElement("div");
    summaryRow.className = "acct-row-summary";
    summaryRow.innerHTML = `
      <span class="acct-row-main">
        ${formatDateHuman(b.date)} · ${escapeHtml(hallName(halls, b.hallId))} ${slotName(b.slot)} ·
        ${escapeHtml(b.customerName)}${b.eventType ? " · " + escapeHtml(b.eventType) : ""}
      </span>
      <span class="acct-row-money">
        Sale ${formatMoney(effectiveBookingTotal(b))} · Paid ${formatMoney(bookingTotalReceived(b))}
        ${balance > 0 ? `· <strong class="acct-outstanding">Due ${formatMoney(balance)}</strong>` : ""}
      </span>
    `;

    const detail = document.createElement("div");
    detail.className = "acct-row-detail hidden";
    const settlementLineHtml = `
      <div class="acct-payment-row acct-settlement-line">
        <span>Final settlement: ${b.settlement.finalPlateCount || 0} plates · ${formatMoney(b.settlement.finalTotalAmount)}${b.settlement.finalExtraReason ? " · " + escapeHtml(b.settlement.finalExtraReason) : ""}</span>
        <span class="acct-payment-by">Settled by ${escapeHtml(b.settlement.settledBy)} on ${formatDateHuman(b.settlement.settledDate)}</span>
      </div>
      <div class="acct-payment-row acct-settlement-line">
        <span>Collected at settlement: ${formatMoney(settlementCollectedAmount(b))}</span>
      </div>
    `;
    // isFinalCollection entries are a legacy artifact (see core.js's
    // bookingPaid()) — a booking settled before that auto-collect feature
    // was removed may still carry one in storage until it's next saved.
    const advancePayments = (b.payments || []).filter((p) => !p.isFinalCollection);
    const advancesHtml = !advancePayments.length
      ? '<div class="simple-list-empty">No advances recorded for this event.</div>'
      : [...advancePayments]
          .sort((x, y) => (x.date || "").localeCompare(y.date || ""))
          .map(
            (p) => `
        <div class="acct-payment-row">
          <span>${formatDateHuman(p.date)} · ${formatMoney(p.amount)} · ${escapeHtml(p.mode || "")}</span>
          <span class="acct-payment-by">${p.receivedBy ? "Received by " + escapeHtml(p.receivedBy) : "Received by —"}</span>
        </div>
      `
          )
          .join("");
    detail.innerHTML = settlementLineHtml + '<div class="acct-detail-subheading">Advances</div>' + advancesHtml;
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-sm";
    editBtn.textContent = "Edit booking";
    editBtn.addEventListener("click", () => openBookingModal(b));
    detail.appendChild(editBtn);

    summaryRow.addEventListener("click", () => {
      const isOpen = !detail.classList.contains("hidden");
      document.querySelectorAll(".acct-row-detail").forEach((el) => el.classList.add("hidden"));
      document.querySelectorAll(".acct-row-summary").forEach((el) => el.classList.remove("acct-row-summary-open"));
      if (!isOpen) {
        detail.classList.remove("hidden");
        summaryRow.classList.add("acct-row-summary-open");
      }
    });

    row.appendChild(summaryRow);
    row.appendChild(detail);
    list.appendChild(row);
  }
}

// Exports the same settled-events set renderAccountsList() shows (same
// date range, same status/settlement filter) as a real .xlsx — one row per
// event with the full breakdown, not just what fits in the on-screen
// summary line. SheetJS (XLSX) is lazy-loaded the same way jsPDF is for the
// PDF exports elsewhere in this app, so it costs nothing until this button
// is actually clicked.
async function generateAccountsExcel(ev) {
  const btn = ev?.currentTarget || document.getElementById("acct-download-excel-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadXlsx();
    const halls = window.appSettings.halls;
    const { from, to } = accountsDateRange();

    let bookings = await BookingsStore.getRange(from, to);
    bookings = bookings.filter((b) => b.status !== "cancelled" && b.settlement?.settledBy);
    bookings.sort((a, b) => a.date.localeCompare(b.date));

    if (!bookings.length) {
      alert(`No settled events between ${formatDateHuman(from)} and ${formatDateHuman(to)} to export.`);
      return;
    }

    const rows = bookings.map((b) => {
      const s = b.settlement;
      const advancePayments = (b.payments || []).filter((p) => !p.isFinalCollection);
      const advancesDetail = advancePayments
        .map((p) => `${formatMoney(p.amount)} by ${p.receivedBy || "—"}`)
        .join("; ");
      return {
        Date: b.date,
        Hall: hallName(halls, b.hallId),
        Slot: slotName(b.slot),
        Customer: b.customerName,
        Phone: b.phone || "",
        "Event Type": b.eventType || "",
        "Guest Count": s.finalPlateCount || b.guestCount || 0,
        "Rate Per Plate": s.finalPerPlateCost || 0,
        "Hall Rent": s.finalHallRent || 0,
        "Extra Amount": s.finalExtraAmount || 0,
        "Extra Reason": s.finalExtraReason || "",
        "GST Applied": s.gstApplied ? "Yes" : "No",
        "GST Amount": s.gstAmount || 0,
        "Total Amount": effectiveBookingTotal(b),
        "Advances Received": bookingPaid(b),
        "Advances Detail": advancesDetail,
        "Collected At Settlement": settlementCollectedAmount(b),
        "Total Received": bookingTotalReceived(b),
        "Balance Due": bookingBalance(b),
        "Settled By": s.settledBy || "",
        "Settled Date": s.settledDate || "",
      };
    });

    const worksheet = window.XLSX.utils.json_to_sheet(rows);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Events");
    window.XLSX.writeFile(workbook, `Accounts - ${from} to ${to}.xlsx`);
  } catch (err) {
    console.error("[accounts-excel] failed to generate Excel file", err);
    alert("Could not generate the Excel file — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
