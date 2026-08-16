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
}

function summaryDateRange() {
  const today = todayIso();
  const fromVal = document.getElementById("summary-filter-from").value;
  const toVal = document.getElementById("summary-filter-to").value;
  return { from: fromVal || today, to: toVal || today };
}

async function renderSummaryTab() {
  const { from, to } = summaryDateRange();

  const [enquiries, bookings] = await Promise.all([
    EnquiriesStore.getRange(from, to),
    BookingsStore.getRange(from, to),
  ]);
  const activeBookings = bookings.filter((b) => b.status !== "cancelled");
  const settledBookings = activeBookings.filter((b) => b.settlement?.settledBy);
  // Every non-cancelled booking's advances count, plus whatever's been
  // collected at settlement for the ones that have one — not just the
  // settled subset, unlike Accounts' "Collected" figure (which is
  // deliberately scoped to the settled ledger only, see accounts-ui.js).
  // This card means "money that changed hands for this window", full stop.
  const totalReceived = activeBookings.reduce((s, b) => s + bookingTotalReceived(b), 0);

  const container = document.getElementById("summary-stats");
  container.innerHTML = `
    <div class="acct-summary-item"><span>Enquiries</span><strong>${enquiries.length}</strong></div>
    <div class="acct-summary-item"><span>Confirmed events</span><strong>${activeBookings.length}</strong></div>
    <div class="acct-summary-item"><span>Settlements done</span><strong>${settledBookings.length}</strong></div>
    <div class="acct-summary-item"><span>Total money received</span><strong>${formatMoney(totalReceived)}</strong></div>
  `;
}
