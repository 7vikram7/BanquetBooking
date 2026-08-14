// calendar-ui.js — month grid of both halls x lunch/dinner, and the shared
// "slot detail" modal (also used by dashboard-ui.js) for viewing/creating
// bookings & enquiries for one hall+slot+date.

let currentCalendarYm = monthKey(todayIso());

function initCalendarNav() {
  document.getElementById("cal-prev").addEventListener("click", () => {
    shiftCalendarMonth(-1);
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    shiftCalendarMonth(1);
  });
  document.getElementById("cal-today").addEventListener("click", () => {
    currentCalendarYm = monthKey(todayIso());
    renderCalendar();
  });
}

function shiftCalendarMonth(delta) {
  let [y, m] = currentCalendarYm.split("-").map(Number);
  m += delta;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  currentCalendarYm = `${y}-${String(m).padStart(2, "0")}`;
  renderCalendar();
}

async function renderCalendar() {
  const halls = window.appSettings.halls;
  document.getElementById("cal-month-label").textContent = monthLabel(currentCalendarYm);

  const [bookings, enquiries] = await Promise.all([
    BookingsStore.getByMonth(currentCalendarYm),
    EnquiriesStore.getByMonth(currentCalendarYm),
  ]);

  const bookingsByDate = groupByDate(bookings);
  const enquiriesByDate = groupByDate(enquiries);

  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const name of dowNames) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = name;
    grid.appendChild(el);
  }

  const [y, m] = currentCalendarYm.split("-").map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const totalDays = daysInMonth(currentCalendarYm);
  const today = todayIso();

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement("div");
    el.className = "cal-day cal-empty";
    grid.appendChild(el);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dateIso = `${currentCalendarYm}-${String(day).padStart(2, "0")}`;
    const dayBookings = bookingsByDate[dateIso] || [];
    const dayEnquiries = enquiriesByDate[dateIso] || [];

    const cell = document.createElement("div");
    cell.className = "cal-day" + (dateIso === today ? " cal-today" : "");
    cell.dataset.date = dateIso;
    // Whole-day tap target: opens the day-detail modal (all 4 slots at
    // once). This is the primary way in on mobile, where the individual
    // slot cells below shrink to small color-only dots; slot cells stop
    // propagation so a precise tap still jumps straight to that slot.
    cell.addEventListener("click", () => openDayModal(dateIso));

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = String(day);
    cell.appendChild(num);

    const slotsWrap = document.createElement("div");
    slotsWrap.className = "cal-slots";
    halls.forEach((hall, hallIdx) => {
      for (const slot of SLOTS) {
        const status = slotStatus(dayBookings, dayEnquiries, hall.id, slot.id);
        const slotCell = document.createElement("div");
        slotCell.className = `cal-slot-cell status-${status}`;
        // Numbered by hall position (not initials) so same-initial hall
        // names (e.g. "Hall A" / "Hall B") stay visually distinguishable.
        slotCell.textContent = `${hallIdx + 1}·${slot.name.charAt(0)}`;
        slotCell.title = `${hall.name} — ${slot.name}: ${status}`;
        slotCell.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openSlotModal(dateIso, hall.id, slot.id);
        });
        slotsWrap.appendChild(slotCell);
      }
    });
    cell.appendChild(slotsWrap);
    grid.appendChild(cell);
  }
}

function groupByDate(records) {
  const out = {};
  for (const r of records) {
    if (!out[r.date]) out[r.date] = [];
    out[r.date].push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day detail modal — lists all 4 hall/slot rows for one date, each
// drilling into the slot-detail modal below.
// ---------------------------------------------------------------------------

// Once a day's date is in the past, its events have already happened —
// staff can no longer view any of that day's details (customer info,
// payments, etc.), only the owner can. Today and future dates stay open to
// staff as normal; this only blocks days that are strictly before today.
function isPastDayBlockedForStaff(dateIso) {
  return !hasRole("owner") && dateIso < todayIso();
}

async function openDayModal(dateIso) {
  // Silently does nothing for staff on a past date — no error message, the
  // tap just doesn't open anything (see isPastDayBlockedForStaff() above).
  if (isPastDayBlockedForStaff(dateIso)) return;
  const halls = window.appSettings.halls;
  const [dayBookings, dayEnquiries] = await Promise.all([
    BookingsStore.getRange(dateIso, dateIso),
    EnquiriesStore.getRange(dateIso, dateIso),
  ]);

  document.getElementById("day-modal-title").textContent = formatDateHuman(dateIso);

  const wrap = document.getElementById("day-modal-slots");
  wrap.innerHTML = "";
  halls.forEach((hall) => {
    for (const slot of SLOTS) {
      const status = slotStatus(dayBookings, dayEnquiries, hall.id, slot.id);
      const booking = findBookingForSlot(dayBookings, hall.id, slot.id);
      const enquiries = findActiveEnquiriesForSlot(dayEnquiries, hall.id, slot.id);

      let detail = "Available";
      if (booking) detail = `${booking.customerName} (${bookingDisplayStatus(booking)})`;
      else if (enquiries.length) detail = `${enquiries.length} open enquiry${enquiries.length > 1 ? "ies" : ""}`;

      const row = document.createElement("div");
      row.className = "simple-list-item";
      row.innerHTML = `
        <span>${escapeHtml(hall.name)} — ${slot.name}: ${escapeHtml(detail)}</span>
        <span class="status-pill status-${status}">${status}</span>
      `;
      row.addEventListener("click", () => {
        closeModal("modal-day");
        openSlotModal(dateIso, hall.id, slot.id);
      });
      wrap.appendChild(row);
    }
  });

  openModal("modal-day");
}

// ---------------------------------------------------------------------------
// Slot detail modal
// ---------------------------------------------------------------------------

let slotModalContext = null; // { date, hallId, slotId }

async function openSlotModal(dateIso, hallId, slotId) {
  // Silently does nothing for staff on a past date — see openDayModal().
  if (isPastDayBlockedForStaff(dateIso)) return;
  const halls = window.appSettings.halls;
  const [dayBookings, dayEnquiries] = await Promise.all([
    BookingsStore.getRange(dateIso, dateIso),
    EnquiriesStore.getRange(dateIso, dateIso),
  ]);

  const booking = findBookingForSlot(dayBookings, hallId, slotId);
  const enquiries = dayEnquiries
    // "converted" is a legacy status (see core.js) — new conversions delete
    // the enquiry outright, but a record saved before that change can
    // still carry it. Excluding it here (not just from the active-only
    // day-modal list) keeps it from showing as a redundant duplicate of
    // the booking it became.
    .filter((e) => e.hallId === hallId && e.slot === slotId && e.status !== "converted")
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  slotModalContext = { date: dateIso, hallId, slotId };

  document.getElementById("slot-modal-title").textContent =
    `${hallName(halls, hallId)} — ${slotName(slotId)} — ${formatDateHuman(dateIso)}`;

  const bookingWrap = document.getElementById("slot-modal-booking");
  bookingWrap.innerHTML = "";
  if (booking) {
    const div = document.createElement("div");
    div.className = "simple-list-item";
    div.innerHTML = `
      <span>Booking: ${escapeHtml(booking.customerName)} · ${booking.guestCount || 0} guests ·
      Paid ${formatMoney(bookingTotalReceived(booking))} of ${formatMoney(effectiveBookingTotal(booking))}</span>
      <span class="status-pill status-${bookingDisplayStatus(booking)}">${bookingDisplayStatus(booking)}</span>
    `;
    div.addEventListener("click", () => {
      closeModal("modal-slot");
      openBookingModal(booking);
    });
    bookingWrap.appendChild(div);
  }

  const enqWrap = document.getElementById("slot-modal-enquiries");
  enqWrap.innerHTML = "";
  for (const e of enquiries) {
    const div = document.createElement("div");
    div.className = "simple-list-item";
    div.innerHTML = `
      <span>Enquiry: ${escapeHtml(e.customerName)} · ${escapeHtml(e.eventType || "")}</span>
      <span class="status-pill status-${e.status}">${e.status}</span>
    `;
    div.addEventListener("click", () => {
      closeModal("modal-slot");
      openEnquiryModal(e);
    });
    enqWrap.appendChild(div);
  }
  if (!booking && !enquiries.length) {
    enqWrap.innerHTML = '<div class="simple-list-empty">Nothing booked or enquired for this slot yet.</div>';
  }

  const newBookingBtn = document.getElementById("slot-new-booking-btn");
  newBookingBtn.classList.toggle("hidden", !!booking);
  newBookingBtn.onclick = () => {
    closeModal("modal-slot");
    openBookingModal(null, { date: dateIso, hallId, slotId });
  };

  // Once the slot is actually booked, a new enquiry against it doesn't
  // make sense — there's nothing left to enquire about.
  const newEnquiryBtn = document.getElementById("slot-new-enquiry-btn");
  newEnquiryBtn.classList.toggle("hidden", !!booking);
  newEnquiryBtn.onclick = () => {
    closeModal("modal-slot");
    openEnquiryModal(null, { date: dateIso, hallId, slotId });
  };

  openModal("modal-slot");
}
