// dashboard-ui.js — "Today" snapshot, upcoming bookings, open enquiries.

async function renderDashboard() {
  const halls = window.appSettings.halls;
  const today = todayIso();

  const [todaysBookings, todaysEnquiries] = await Promise.all([
    BookingsStore.getRange(today, today),
    EnquiriesStore.getRange(today, today),
  ]);

  document.getElementById("dashboard-today-heading").textContent =
    "Today — " + formatDateHuman(today);

  const row = document.getElementById("dashboard-today");
  row.innerHTML = "";
  for (const hall of halls) {
    for (const slot of SLOTS) {
      const status = slotStatus(todaysBookings, todaysEnquiries, hall.id, slot.id);
      const booking = findBookingForSlot(todaysBookings, hall.id, slot.id);
      const enquiries = findActiveEnquiriesForSlot(todaysEnquiries, hall.id, slot.id);

      const card = document.createElement("div");
      card.className = `slot-card status-${status}`;
      let detail = "Available";
      if (booking) {
        detail = `${escapeHtml(booking.customerName)} (${bookingDisplayStatus(booking)})`;
      } else if (enquiries.length) {
        detail = `${enquiries.length} open enquiry${enquiries.length > 1 ? "ies" : ""}`;
      }
      card.innerHTML = `<h4>${escapeHtml(hall.name)} — ${slot.name}</h4><p>${detail}</p>`;
      card.addEventListener("click", () => openSlotModal(today, hall.id, slot.id));
      row.appendChild(card);
    }
  }

  await renderDashboardSummary();
  await renderDashboardUpcoming(halls);
  await renderDashboardOpenEnquiries();
}

// ---------------------------------------------------------------------------
// Event Summary — hall x slot event/guest/sales totals for a selectable
// month (Prev/Next, like the Calendar tab) or a manually-typed custom date
// range. The From/To inputs are the actual source of truth for what's
// rendered; Prev/Next/This Month are just shortcuts that set those inputs
// to a full calendar month and re-render — a custom range is simply
// whatever the user types into them directly.
// ---------------------------------------------------------------------------

let dashSummaryYm = monthKey(todayIso());

function initDashboardSummary() {
  document.getElementById("dash-summary-prev").addEventListener("click", () => shiftDashSummaryMonth(-1));
  document.getElementById("dash-summary-next").addEventListener("click", () => shiftDashSummaryMonth(1));
  document.getElementById("dash-summary-this-month").addEventListener("click", () => {
    dashSummaryYm = monthKey(todayIso());
    setDashSummaryRangeToMonth(dashSummaryYm);
    renderDashboardSummary();
  });
  document.getElementById("dash-summary-from").addEventListener("change", renderDashboardSummary);
  document.getElementById("dash-summary-to").addEventListener("change", renderDashboardSummary);
  setDashSummaryRangeToMonth(dashSummaryYm);
}

function setDashSummaryRangeToMonth(ymKey) {
  document.getElementById("dash-summary-from").value = `${ymKey}-01`;
  document.getElementById("dash-summary-to").value = `${ymKey}-${String(daysInMonth(ymKey)).padStart(2, "0")}`;
}

function shiftDashSummaryMonth(delta) {
  let [y, m] = dashSummaryYm.split("-").map(Number);
  m += delta;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  dashSummaryYm = `${y}-${String(m).padStart(2, "0")}`;
  setDashSummaryRangeToMonth(dashSummaryYm);
  renderDashboardSummary();
}

// A range label that reads as a month name when the From/To inputs happen
// to span exactly one full calendar month (the common case, reached via
// Prev/Next/This Month), and as an explicit date span otherwise (a
// manually-typed custom range).
function dashSummaryRangeLabel(from, to) {
  const ym = from.slice(0, 7);
  if (from === `${ym}-01` && to === `${ym}-${String(daysInMonth(ym)).padStart(2, "0")}`) {
    return monthLabel(ym);
  }
  return `${formatDateHuman(from)} – ${formatDateHuman(to)}`;
}

async function renderDashboardSummary() {
  const halls = window.appSettings.halls;
  const from = document.getElementById("dash-summary-from").value;
  const to = document.getElementById("dash-summary-to").value;
  if (!from || !to) return;

  document.getElementById("dash-summary-range-label").textContent = dashSummaryRangeLabel(from, to);

  const bookings = (await BookingsStore.getRange(from, to)).filter((b) => b.status !== "cancelled");

  const container = document.getElementById("dashboard-summary");
  container.innerHTML = "";

  let totalEvents = 0;
  let totalGuests = 0;
  let totalSales = 0;
  for (const hall of halls) {
    for (const slot of SLOTS) {
      const matches = bookings.filter((b) => b.hallId === hall.id && b.slot === slot.id);
      const events = matches.length;
      const guests = matches.reduce((s, b) => s + toNumber(b.guestCount), 0);
      const sales = matches.reduce((s, b) => s + effectiveBookingTotal(b), 0);
      totalEvents += events;
      totalGuests += guests;
      totalSales += sales;

      const card = document.createElement("div");
      card.className = "acct-summary-item";
      card.innerHTML = `
        <span>${escapeHtml(hall.name)} — ${slot.name}</span>
        <strong>${events} event${events === 1 ? "" : "s"}</strong>
        <span class="dash-summary-sub">${guests} guests · ${formatMoney(sales)}</span>
      `;
      container.appendChild(card);
    }
  }

  const totalCard = document.createElement("div");
  totalCard.className = "acct-summary-item dash-summary-total";
  totalCard.innerHTML = `
    <span>Facility total</span>
    <strong>${totalEvents} event${totalEvents === 1 ? "" : "s"}</strong>
    <span class="dash-summary-sub">${totalGuests} guests · ${formatMoney(totalSales)}</span>
  `;
  container.appendChild(totalCard);
}

async function renderDashboardUpcoming(halls) {
  const today = new Date();
  const from = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const to = isoDate(toDate);

  const bookings = (await BookingsStore.getRange(from, to))
    .filter((b) => b.status !== "cancelled")
    .sort((a, b) => a.date.localeCompare(b.date));

  const container = document.getElementById("dashboard-upcoming");
  container.innerHTML = "";
  if (!bookings.length) {
    container.innerHTML = '<div class="simple-list-empty">No upcoming bookings in the next 7 days.</div>';
    return;
  }
  for (const b of bookings) {
    const item = document.createElement("div");
    item.className = "simple-list-item";
    item.innerHTML = `
      <span>${formatDateHuman(b.date)} · ${escapeHtml(hallName(halls, b.hallId))} ${slotName(b.slot)} · ${escapeHtml(b.customerName)}</span>
      <span class="status-pill status-${bookingDisplayStatus(b)}">${bookingDisplayStatus(b)}</span>
    `;
    item.addEventListener("click", () => openBookingModal(b));
    container.appendChild(item);
  }
}

async function renderDashboardOpenEnquiries() {
  const today = new Date();
  const from = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30));
  const to = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90));

  const enquiries = (await EnquiriesStore.getRange(from, to))
    .filter((e) => e.status === "new" || e.status === "followup")
    .sort((a, b) => (a.followUpDate || a.date).localeCompare(b.followUpDate || b.date));

  const container = document.getElementById("dashboard-open-enquiries");
  container.innerHTML = "";
  if (!enquiries.length) {
    container.innerHTML = '<div class="simple-list-empty">No open enquiries.</div>';
    return;
  }
  for (const e of enquiries.slice(0, 25)) {
    const item = document.createElement("div");
    item.className = "simple-list-item";
    item.innerHTML = `
      <span>${formatDateHuman(e.date)} · ${escapeHtml(e.customerName)} · ${escapeHtml(e.eventType || "")}${e.followUpDate ? ` · follow up ${formatDateHuman(e.followUpDate)}` : ""}</span>
      <span class="status-pill status-${e.status}">${e.status}</span>
    `;
    item.addEventListener("click", () => openEnquiryModal(e));
    container.appendChild(item);
  }
}
