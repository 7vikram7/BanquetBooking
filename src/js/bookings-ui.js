// bookings-ui.js — booking add/edit modal with an editable payments
// sub-list, enquiry-to-booking conversion finalize. Opened from
// calendar-ui.js (day/slot modals) and dashboard-ui.js (upcoming
// bookings list) — this file owns the modal only, there's no standalone
// bookings list/tab; the calendar is the single entry point.

function initBookingModal() {
  const halls = window.appSettings.halls;
  populateSelect(document.getElementById("bk-hall"), halls);
  populateSelect(document.getElementById("bk-event-type"), allEventTypes().map((t) => ({ id: t, name: t })));
  document.getElementById("bk-event-type").addEventListener("change", () => {
    syncEventTypeOtherWrap("bk-event-type", "bk-event-type-other-wrap");
  });

  document.getElementById("bk-save-btn").addEventListener("click", saveBooking);
  document.getElementById("bk-delete-btn").addEventListener("click", deleteBookingHandler);
  document.getElementById("bk-add-payment-btn").addEventListener("click", addPaymentToDraft);
  wireCallButton("bk-phone", "bk-call-btn");

  // Total amount is computed (per-plate cost x guest count + hall rent +
  // extra charges), not typed in directly — recompute on any input that
  // feeds into it.
  ["bk-guests", "bk-per-plate-cost", "bk-hall-rent", "bk-extra-amount"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateBalanceDisplay);
  });

  document.getElementById("bk-edit-menu-btn").addEventListener("click", openMenuModal);
  document.getElementById("bk-download-menu-btn").addEventListener("click", generateMenuPdf);
  document.getElementById("bk-share-menu-btn").addEventListener("click", (ev) => generateMenuPdf(ev, "share"));
  // "Done" saves the booking outright (menu included) so the user never
  // has to separately click Save in the booking modal afterward — it
  // closes the menu editor first so any validation error from saveBooking()
  // is visible in the (now-revealed) booking modal rather than hidden
  // behind the still-open menu overlay.
  document.getElementById("menu-done-btn").addEventListener("click", async () => {
    closeModal("modal-menu");
    await saveBooking();
  });
  document.getElementById("menu-download-pdf-btn").addEventListener("click", generateMenuPdf);
  document.getElementById("menu-share-pdf-btn").addEventListener("click", (ev) => generateMenuPdf(ev, "share"));

  // Deliberately no live-recompute on input here (unlike the pre-event
  // pricing fields above) — the final bill only appears once "Confirm" is
  // clicked, a distinct step from typing in the numbers.
  document.getElementById("bk-settlement-calc-btn").addEventListener("click", calculateSettlementHandler);
  document.getElementById("bk-settlement-confirm-btn").addEventListener("click", confirmSettlementHandler);
  document.getElementById("bk-event-summary-btn").addEventListener("click", generateEventSummaryPdf);
  document.getElementById("bk-event-summary-share-btn").addEventListener("click", (ev) => generateEventSummaryPdf(ev, "share"));
  document.getElementById("bk-confirmation-btn").addEventListener("click", generateBookingConfirmationPdf);
  document.getElementById("bk-confirmation-share-btn").addEventListener("click", (ev) => generateBookingConfirmationPdf(ev, "share"));
}

let editingBookingId = null;
let draftPayments = [];
let draftMenu = {}; // { [categoryId]: string[] }
let draftSettlement = null; // null until "Confirm Settlement" is clicked
// Whether this booking already had a saved, persisted settlement when the
// modal was opened — fixed for the life of this modal session, unlike
// draftSettlement (which changes the moment Confirm is clicked). Staff
// locking must key off THIS, not draftSettlement: otherwise staff's own
// first-time confirm would immediately (and wrongly) show as "locked"
// before they've even saved it, and a second adjustment before saving
// would be blocked entirely.
let settlementWasAlreadyRecorded = false;
let pendingEnquiryLink = null; // enquiry object being converted, if any

function openBookingModal(booking, prefill) {
  editingBookingId = booking?.id || null;
  draftPayments = booking ? [...(booking.payments || [])] : [];
  // Migrate a legacy auto-recorded settlement-collection payment (see
  // core.js's bookingPaid()) out of the advances list — its amount gets
  // folded into draftSettlement.collectedAmount below instead. Only takes
  // effect in storage once this booking is saved again; non-destructive
  // until then.
  const legacyCollectionPayment = draftPayments.find((p) => p.isFinalCollection);
  draftPayments = draftPayments.filter((p) => !p.isFinalCollection);
  draftMenu = booking?.menu ? JSON.parse(JSON.stringify(booking.menu)) : {};
  pendingEnquiryLink = prefill?.fromEnquiry || null;

  const isEdit = !!booking;
  document.getElementById("bk-modal-title").textContent = isEdit ? "Edit Booking" : "New Booking";
  document.getElementById("bk-error").classList.remove("show");
  document.getElementById("bk-id").value = booking?.id || "";
  document.getElementById("bk-orig-date").value = booking?.date || "";
  document.getElementById("bk-enquiry-id").value = booking?.enquiryId || pendingEnquiryLink?.id || "";

  const enquiry = pendingEnquiryLink;
  document.getElementById("bk-date").value = booking?.date || enquiry?.date || prefill?.date || todayIso();
  document.getElementById("bk-hall").value = booking?.hallId || enquiry?.hallId || prefill?.hallId || window.appSettings.halls[0].id;
  document.getElementById("bk-slot").value = booking?.slot || enquiry?.slot || prefill?.slotId || "lunch";
  // Repopulate (not just re-read) — see openEnquiryModal()'s identical
  // comment for why: a custom type added since this app last loaded
  // otherwise wouldn't be a selectable option yet.
  const eventTypeToShow = booking?.eventType || enquiry?.eventType || EVENT_TYPES[0];
  const eventTypeSelect = document.getElementById("bk-event-type");
  populateSelect(eventTypeSelect, allEventTypes().map((t) => ({ id: t, name: t })));
  ensureEventTypeOption(eventTypeSelect, eventTypeToShow);
  eventTypeSelect.value = eventTypeToShow;
  document.getElementById("bk-event-type-other").value = "";
  syncEventTypeOtherWrap("bk-event-type", "bk-event-type-other-wrap");
  document.getElementById("bk-customer").value = booking?.customerName || enquiry?.customerName || "";
  document.getElementById("bk-phone").value = booking?.phone || enquiry?.phone || "";
  document.getElementById("bk-email").value = booking?.email || enquiry?.email || "";
  document.getElementById("bk-guests").value = booking?.guestCount || enquiry?.guestCount || "";
  document.getElementById("bk-per-plate-cost").value = booking?.perPlateCost || "";
  document.getElementById("bk-hall-rent").value = booking?.hallRent || "";
  document.getElementById("bk-extra-amount").value = booking?.extraAmount || "";
  document.getElementById("bk-extra-amount-reason").value = booking?.extraAmountReason || "";
  if (booking && !booking.perPlateCost && !booking.hallRent && !booking.extraAmount && booking.totalAmount) {
    // Pre-migration booking: it has a manually-entered total from before
    // per-plate/hall-rent/extra existed, but no cost breakdown. Folding
    // the old total into "Extra amount" keeps the computed total
    // numerically unchanged until the user breaks it down properly —
    // without this, saving would silently recompute the total to ₹0 and
    // wipe out real financial data already on record.
    document.getElementById("bk-extra-amount").value = booking.totalAmount;
  }

  const statusSelect = document.getElementById("bk-status");
  statusSelect.querySelector('option[value="tentative"]')?.remove();
  if (booking?.status === "tentative") {
    // "Tentative" was removed as a choice going forward, but a booking
    // saved before that change could still carry it — inject the option
    // back in just for this record so editing it doesn't silently blank
    // (and then corrupt on save) a status the <select> no longer lists.
    const legacyOpt = document.createElement("option");
    legacyOpt.value = "tentative";
    legacyOpt.textContent = "Tentative (legacy)";
    statusSelect.insertBefore(legacyOpt, statusSelect.firstChild);
  }
  statusSelect.value = booking?.status || "confirmed";
  document.getElementById("bk-notes").value = booking?.notes || enquiry?.notes || "";

  document.getElementById("bk-payment-amount").value = "";
  document.getElementById("bk-payment-date").value = todayIso();
  document.getElementById("bk-payment-mode").value = "cash";
  document.getElementById("bk-payment-receivedby-display").textContent = currentStaffName();
  document.getElementById("bk-payment-note").value = "";
  document.getElementById("bk-payment-error").classList.remove("show");

  settlementWasAlreadyRecorded = !!booking?.settlement?.settledBy;
  document.getElementById("bk-settlement-calc-error").classList.remove("show");
  document.getElementById("bk-settlement-error").classList.remove("show");
  if (booking?.settlement) {
    draftSettlement = { ...booking.settlement };
    if (draftSettlement.collectedAmount === undefined) {
      // Settlement recorded before collectedAmount existed as its own
      // field — see the legacy-payment migration above.
      draftSettlement.collectedAmount = legacyCollectionPayment
        ? toNumber(legacyCollectionPayment.amount)
        : Math.max(0, toNumber(draftSettlement.finalTotalAmount) - bookingPaid({ payments: draftPayments }));
    }
    document.getElementById("bk-settlement-plates").value = draftSettlement.finalPlateCount || "";
    document.getElementById("bk-settlement-per-plate-cost").value = draftSettlement.finalPerPlateCost || "";
    document.getElementById("bk-settlement-hall-rent").value = draftSettlement.finalHallRent || "";
    document.getElementById("bk-settlement-extra-amount").value = draftSettlement.finalExtraAmount || "";
    document.getElementById("bk-settlement-extra-reason").value = draftSettlement.finalExtraReason || "";
    // Historical record of who actually settled it — NOT necessarily
    // whoever is viewing it now, unlike the not-yet-settled branch below.
    document.getElementById("bk-settlement-settledby-display").textContent = draftSettlement.settledBy || "";
    document.getElementById("bk-settlement-date").value = draftSettlement.settledDate || todayIso();
    document.getElementById("bk-settlement-gst").checked = !!draftSettlement.gstApplied;
    // Already settled at least once — show the collection figures
    // straight away rather than making them click "Confirm" again just
    // to see what was recorded. Advance received is recomputed live
    // (payments can still be added after a settlement was recorded).
    showSettlementCollectionBlock();
  } else {
    // Smart defaults from the booking's own pre-event estimate — the
    // actual numbers on the day are often the same or close, no reason
    // to make the user retype them from scratch.
    draftSettlement = null;
    document.getElementById("bk-settlement-plates").value = booking?.guestCount || enquiry?.guestCount || "";
    document.getElementById("bk-settlement-per-plate-cost").value = booking?.perPlateCost || "";
    document.getElementById("bk-settlement-hall-rent").value = booking?.hallRent || "";
    document.getElementById("bk-settlement-extra-amount").value = booking?.extraAmount || "";
    document.getElementById("bk-settlement-extra-reason").value = booking?.extraAmountReason || "";
    // Who WOULD be signing this if confirmed right now — the person
    // actually viewing this booking, since it isn't settled yet.
    document.getElementById("bk-settlement-settledby-display").textContent = currentStaffName();
    document.getElementById("bk-settlement-date").value = todayIso();
    document.getElementById("bk-settlement-gst").checked = false;
    document.getElementById("bk-settlement-collection-block").classList.add("hidden");
  }

  // Once an event is settled, staff loses edit rights to the WHOLE booking
  // — everything below keys off this same condition. Keyed off
  // settlementWasAlreadyRecorded (the state when the modal opened), not
  // draftSettlement — staff's own first-time confirm shouldn't instantly
  // lock itself out before they've even saved.
  const eventLockedForStaff = settlementWasAlreadyRecorded && !hasRole("owner");
  [
    "bk-date", "bk-hall", "bk-slot", "bk-event-type", "bk-customer", "bk-phone", "bk-email",
    "bk-guests", "bk-status", "bk-notes",
    "bk-per-plate-cost", "bk-hall-rent", "bk-extra-amount", "bk-extra-amount-reason",
  ].forEach((id) => {
    document.getElementById(id).disabled = eventLockedForStaff;
  });
  document.getElementById("bk-edit-menu-btn").classList.toggle("hidden", eventLockedForStaff);
  document.getElementById("bk-save-btn").classList.toggle("hidden", eventLockedForStaff);

  // Advances can be recorded by anyone (owner or staff) right up until the
  // event is settled — that's normal front-desk work, not something staff
  // should be locked out of. Once settled, it folds into the same
  // whole-booking lock as everything else above.
  document.getElementById("bk-advance-add-block").classList.toggle("hidden", eventLockedForStaff);

  // The Final Settlement section has its OWN, separate lock on top of the
  // staff/owner one: there's no such thing as a "final" bill before the
  // event has actually happened, so it stays disabled for EVERYONE
  // (owner included) until the booking's date is today or in the past.
  // Locking disables the inputs (still visible/readable) rather than
  // hiding them, same convention as the staff lock above.
  const settlementLocked = eventLockedForStaff || (!settlementWasAlreadyRecorded && settlementTooEarly());
  [
    "bk-settlement-plates", "bk-settlement-per-plate-cost", "bk-settlement-hall-rent",
    "bk-settlement-extra-amount", "bk-settlement-extra-reason", "bk-settlement-date", "bk-settlement-gst",
  ].forEach((id) => {
    document.getElementById(id).disabled = settlementLocked;
  });
  document.getElementById("bk-settlement-calc-btn").classList.toggle("hidden", settlementLocked);
  document.getElementById("bk-settlement-confirm-btn").classList.toggle("hidden", settlementLocked);

  renderDraftPayments();
  updateMenuSummary();
  updateSettlementSummary();

  // Staff can delete anything EXCEPT a confirmed booking — that's
  // owner-only once an event is actually confirmed (a cancelled one is no
  // longer "confirmed", so staff can still clean those up).
  const canDelete = isEdit && (booking.status !== "confirmed" || hasRole("owner"));
  document.getElementById("bk-delete-btn").classList.toggle("hidden", !canDelete);

  // A downloadable confirmation slip for the customer — available once the
  // booking has actually been saved as confirmed (not for a brand-new,
  // still-unsaved draft, and not once it's cancelled).
  const confirmationAvailable = isEdit && booking?.status === "confirmed";
  document.getElementById("bk-confirmation-btn").classList.toggle("hidden", !confirmationAvailable);
  document.getElementById("bk-confirmation-share-btn").classList.toggle("hidden", !confirmationAvailable);

  openModal("modal-booking");
}

function renderDraftPayments() {
  const container = document.getElementById("bk-payments-list");
  container.innerHTML = "";
  const canEditAdvances = !settlementWasAlreadyRecorded || hasRole("owner");
  if (!draftPayments.length) {
    container.innerHTML = '<div class="simple-list-empty">No advances recorded.</div>';
  } else {
    draftPayments.forEach((p, idx) => {
      const div = document.createElement("div");
      div.className = "simple-list-item";
      div.innerHTML = `
        <span>${formatMoney(p.amount)} · ${formatDateHuman(p.date)} · ${escapeHtml(p.mode)}${p.receivedBy ? " · by " + escapeHtml(p.receivedBy) : ""}${p.note ? " · " + escapeHtml(p.note) : ""}</span>
        ${canEditAdvances ? '<button class="btn btn-sm" type="button">Remove</button>' : ""}
      `;
      if (canEditAdvances) {
        div.querySelector("button").addEventListener("click", () => {
          draftPayments.splice(idx, 1);
          renderDraftPayments();
        });
      }
      container.appendChild(div);
    });
  }
  updateBalanceDisplay();
}

async function addPaymentToDraft() {
  // Defense in depth: the advance-add controls are hidden once the event
  // is settled (for non-owners), but guard the handler itself too in case
  // it's ever reachable another way.
  if (settlementWasAlreadyRecorded && !hasRole("owner")) return;

  const errEl = document.getElementById("bk-payment-error");
  errEl.classList.remove("show");

  const amount = toNumber(document.getElementById("bk-payment-amount").value);
  const date = document.getElementById("bk-payment-date").value || todayIso();
  const mode = document.getElementById("bk-payment-mode").value;
  // Auto-signed from whoever is actually logged in — no longer manually
  // typed, so it can't be misattributed or left blank.
  const receivedBy = currentStaffName();
  const note = document.getElementById("bk-payment-note").value.trim();
  if (amount <= 0) return; // nothing to confirm

  draftPayments.push({ id: uid("pay"), amount, date, mode, receivedBy, note });
  document.getElementById("bk-payment-amount").value = "";
  document.getElementById("bk-payment-note").value = "";
  renderDraftPayments();

  // Confirming an advance is enough to save the whole booking on its own —
  // no separate tap on the main Save button needed — so "View Booking
  // Confirmation" becomes available right away. If the required fields
  // (customer/phone/guests/date) aren't filled yet, this surfaces the same
  // validation error Save would, in #bk-error; the advance itself still
  // shows in the draft list either way, it just isn't persisted until
  // those are filled in and a save (this or the main button) succeeds.
  await saveBooking();
}

function computeBookingTotal() {
  const perPlateCost = toNumber(document.getElementById("bk-per-plate-cost").value);
  const guestCount = toNumber(document.getElementById("bk-guests").value);
  const hallRent = toNumber(document.getElementById("bk-hall-rent").value);
  const extraAmount = toNumber(document.getElementById("bk-extra-amount").value);
  return perPlateCost * guestCount + hallRent + extraAmount;
}

function updateBalanceDisplay() {
  // Balance prefers the confirmed final settlement total over the
  // pre-event estimate once one exists — same rule as
  // effectiveBookingTotal() in core.js, kept in sync manually here since
  // this reads live form/draft state rather than a saved record. "Total
  // advance received" stays advances-only (matches core.js's bookingPaid);
  // the settlement's own collectedAmount is folded in separately so the
  // balance is still accurate without polluting that advances figure.
  const total = draftSettlement?.finalTotalAmount ?? computeBookingTotal();
  const advances = draftPayments.reduce((s, p) => s + toNumber(p.amount), 0);
  const collected = toNumber(draftSettlement?.collectedAmount);
  document.getElementById("bk-total-display").textContent = formatMoney(computeBookingTotal());
  document.getElementById("bk-advance-display").textContent = formatMoney(advances);
  document.getElementById("bk-balance-display").textContent = formatMoney(total - advances - collected);
}

function readBookingForm() {
  // "Other" + a typed custom value means the custom text IS the real
  // event type from here on — same rule as the enquiry form.
  const eventTypeSelect = document.getElementById("bk-event-type");
  const customEventType = document.getElementById("bk-event-type-other").value.trim();
  const eventType = eventTypeSelect.value === "Other" && customEventType ? customEventType : eventTypeSelect.value;
  return {
    date: document.getElementById("bk-date").value,
    hallId: document.getElementById("bk-hall").value,
    slot: document.getElementById("bk-slot").value,
    eventType,
    customerName: document.getElementById("bk-customer").value.trim(),
    phone: document.getElementById("bk-phone").value.trim(),
    email: document.getElementById("bk-email").value.trim(),
    guestCount: toNumber(document.getElementById("bk-guests").value),
    perPlateCost: toNumber(document.getElementById("bk-per-plate-cost").value),
    hallRent: toNumber(document.getElementById("bk-hall-rent").value),
    extraAmount: toNumber(document.getElementById("bk-extra-amount").value),
    extraAmountReason: document.getElementById("bk-extra-amount-reason").value.trim(),
    totalAmount: computeBookingTotal(),
    status: document.getElementById("bk-status").value,
    notes: document.getElementById("bk-notes").value.trim(),
    payments: draftPayments,
    menu: draftMenu,
    settlement: draftSettlement,
  };
}

// ---------------------------------------------------------------------------
// Final settlement — recorded on/after the event day once the actual final
// numbers (plate count, hall rent, extras) are known, which can differ from
// the pre-event estimate above. Same "confirm updates a draft, the booking's
// own Save button persists it" pattern as payments: editing these fields
// without clicking Confirm again leaves the last-confirmed settlement
// untouched. A booking only counts as settled — and only then shows up in
// the Accounts tab — once draftSettlement.settledBy is set.
// ---------------------------------------------------------------------------

function computeSettlementSubtotal() {
  const plates = toNumber(document.getElementById("bk-settlement-plates").value);
  const perPlateCost = toNumber(document.getElementById("bk-settlement-per-plate-cost").value);
  const hallRent = toNumber(document.getElementById("bk-settlement-hall-rent").value);
  const extraAmount = toNumber(document.getElementById("bk-settlement-extra-amount").value);
  return plates * perPlateCost + hallRent + extraAmount;
}

// There's no such thing as a "final" bill before the event has actually
// happened — reads the booking's own date field (not a settlement date
// field, which doesn't exist until Confirm Settlement is clicked).
function settlementTooEarly() {
  const eventDateIso = document.getElementById("bk-date").value;
  return !!eventDateIso && eventDateIso > todayIso();
}

// GST is only ever offered/applied at settlement time ("before settling"),
// never on the pre-event estimate — it's 5% added on top of the subtotal,
// not an inclusive split-out.
function settlementGstApplied() {
  return document.getElementById("bk-settlement-gst").checked;
}

function computeSettlementGst(subtotal) {
  return settlementGstApplied() ? subtotal * 0.05 : 0;
}

// Reveals the collection block and fills in every figure: subtotal, GST
// (if the checkbox is on — line stays hidden otherwise), final total, what's
// already been received as advances (computed live off draftPayments, not a
// snapshot — a payment can still be added after a settlement was first
// recorded), and what's left to collect right now. Always recomputes from
// current field/checkbox state rather than accepting a total as a param, so
// re-opening an already-settled booking (fields pre-filled from the saved
// record) reproduces the same figures without needing to store them twice.
//
// Once a settlement has actually been confirmed for these exact figures,
// the "still to collect" preview line is swapped for a persistent "Amount
// collected" line right above the button — the single clearest signal that
// Confirm Settlement actually did something (see confirmSettlementHandler()
// for why that amount isn't also added to the Advances list).
function showSettlementCollectionBlock() {
  const subtotal = computeSettlementSubtotal();
  const gstApplied = settlementGstApplied();
  const gstAmount = computeSettlementGst(subtotal);
  const total = subtotal + gstAmount;
  const advance = bookingPaid({ payments: draftPayments });
  const amountToCollect = total - advance;

  document.getElementById("bk-settlement-subtotal-display").textContent = formatMoney(subtotal);
  document.getElementById("bk-settlement-gst-line").classList.toggle("hidden", !gstApplied);
  document.getElementById("bk-settlement-gst-display").textContent = formatMoney(gstAmount);
  document.getElementById("bk-settlement-total-display").textContent = formatMoney(total);
  document.getElementById("bk-settlement-advance-display").textContent = formatMoney(advance);

  const recorded = draftSettlement && draftSettlement.finalTotalAmount === total;
  document.getElementById("bk-settlement-collect-line").classList.toggle("hidden", recorded);
  document.getElementById("bk-settlement-collect-display").textContent = formatMoney(amountToCollect);
  document.getElementById("bk-settlement-recorded-line").classList.toggle("hidden", !recorded);
  if (recorded) {
    document.getElementById("bk-settlement-recorded-display").textContent = formatMoney(draftSettlement.collectedAmount);
    document.getElementById("bk-settlement-recorded-by").textContent =
      `— collected by ${draftSettlement.settledBy} on ${formatDateHuman(draftSettlement.settledDate)}`;
  }

  document.getElementById("bk-settlement-collection-block").classList.remove("hidden");

  return total;
}

// Step 1: "Confirm" on the bill fields (plate count, per-plate cost, hall
// rent, extra amount) computes the final total and reveals step 2 — it
// doesn't record anything yet, that only happens via confirmSettlementHandler().
function calculateSettlementHandler() {
  const errEl = document.getElementById("bk-settlement-calc-error");
  errEl.classList.remove("show");

  if (settlementWasAlreadyRecorded && !hasRole("owner")) {
    errEl.textContent = "This settlement is already recorded — only the owner can change it.";
    errEl.classList.add("show");
    return;
  }

  if (!settlementWasAlreadyRecorded && settlementTooEarly()) {
    errEl.textContent = "Final settlement can only be recorded on or after the event day.";
    errEl.classList.add("show");
    return;
  }

  const plates = toNumber(document.getElementById("bk-settlement-plates").value);
  if (plates <= 0) {
    errEl.textContent = "Enter the final plate count before confirming.";
    errEl.classList.add("show");
    return;
  }

  showSettlementCollectionBlock();
}

function updateSettlementSummary() {
  const summaryEl = document.getElementById("bk-settlement-summary");
  const settled = !!draftSettlement?.settledBy;
  // Viewing/sending the summary is a read-only action — available to
  // anyone once settled, not gated by the owner-only edit lock.
  document.getElementById("bk-event-summary-btn").classList.toggle("hidden", !settled);
  document.getElementById("bk-event-summary-share-btn").classList.toggle("hidden", !settled);
  if (!settled) {
    summaryEl.textContent = settlementTooEarly()
      ? `Settlement can be recorded on or after the event day (${formatDateHuman(document.getElementById("bk-date").value)}).`
      : "Not settled yet — record this on or after the event day.";
    return;
  }
  const locked = settlementWasAlreadyRecorded && !hasRole("owner");
  summaryEl.textContent =
    `Settled by ${draftSettlement.settledBy} on ${formatDateHuman(draftSettlement.settledDate)} — final total ${formatMoney(draftSettlement.finalTotalAmount)}` +
    (draftSettlement.gstApplied ? " (incl. 5% GST)." : ".") +
    (locked ? " Locked — only the owner can change a recorded settlement." : "");
}

function confirmSettlementHandler() {
  const errEl = document.getElementById("bk-settlement-error");
  errEl.classList.remove("show");

  // Defense in depth: the Confirm button is hidden once locked, but guard
  // the handler itself too in case it's ever reachable another way. Keyed
  // off settlementWasAlreadyRecorded, not draftSettlement — staff must
  // still be free to re-confirm their OWN not-yet-saved settlement as many
  // times as they like before clicking the booking's Save button.
  if (settlementWasAlreadyRecorded && !hasRole("owner")) {
    errEl.textContent = "This settlement is already recorded — only the owner can change it.";
    errEl.classList.add("show");
    return;
  }

  if (!settlementWasAlreadyRecorded && settlementTooEarly()) {
    errEl.textContent = "Final settlement can only be recorded on or after the event day.";
    errEl.classList.add("show");
    return;
  }

  if (document.getElementById("bk-settlement-collection-block").classList.contains("hidden")) {
    errEl.textContent = 'Click "Confirm" above to calculate the final bill first.';
    errEl.classList.add("show");
    return;
  }

  // Auto-signed from whoever is actually logged in — no longer manually
  // typed, so it can't be misattributed.
  const settledBy = currentStaffName();

  const subtotal = computeSettlementSubtotal();
  const gstApplied = settlementGstApplied();
  const gstAmount = computeSettlementGst(subtotal);
  const finalTotalAmount = subtotal + gstAmount;
  const settledDate = document.getElementById("bk-settlement-date").value || todayIso();

  // The remaining balance is assumed collected by the same person right
  // then, but deliberately NOT added to the Advances list — advances are
  // pre-settlement deposits only. It's tracked on the settlement itself
  // (collectedAmount) and shown as its own "Amount collected" line just
  // above this button instead (see showSettlementCollectionBlock()).
  // Re-confirming a settlement (e.g. an owner correcting a figure)
  // recomputes this fresh each time rather than accumulating.
  const advanceReceived = bookingPaid({ payments: draftPayments });
  const collectedAmount = Math.max(0, finalTotalAmount - advanceReceived);

  draftSettlement = {
    finalPlateCount: toNumber(document.getElementById("bk-settlement-plates").value),
    finalPerPlateCost: toNumber(document.getElementById("bk-settlement-per-plate-cost").value),
    finalHallRent: toNumber(document.getElementById("bk-settlement-hall-rent").value),
    finalExtraAmount: toNumber(document.getElementById("bk-settlement-extra-amount").value),
    finalExtraReason: document.getElementById("bk-settlement-extra-reason").value.trim(),
    subtotal,
    gstApplied,
    gstAmount,
    settledBy,
    settledDate,
    finalTotalAmount,
    collectedAmount,
  };
  renderDraftPayments();
  showSettlementCollectionBlock();
  updateSettlementSummary();
  updateBalanceDisplay();
}

// Never closes the modal itself — Save, Confirm Settlement, confirming an
// advance, and the menu editor's Done all persist in place; the only way
// to close the booking modal is the × button. This lets the user keep
// working in the same modal after saving (e.g. immediately downloading
// "View Booking Confirmation") without having to reopen it.
async function saveBooking() {
  const errEl = document.getElementById("bk-error");
  errEl.classList.remove("show");

  // Defense in depth: the Save button is hidden for staff once an event is
  // settled, but guard the handler itself too in case it's ever reachable
  // another way (e.g. the menu editor's "Done", which also calls this).
  if (settlementWasAlreadyRecorded && !hasRole("owner")) {
    errEl.textContent = "This event is settled — only the owner can make changes.";
    errEl.classList.add("show");
    return;
  }

  const data = readBookingForm();

  const missing = requiredFieldErrors(data);
  if (missing.length) {
    errEl.textContent = `Please fill in the required fields: ${missing.join(", ")}.`;
    errEl.classList.add("show");
    return;
  }

  // No-ops for anything that isn't a genuinely new custom value — see
  // registerCustomEventType() and readEnquiryForm()'s identical comment.
  await registerCustomEventType(data.eventType);

  const id = document.getElementById("bk-id").value;
  let savedBooking;
  if (id) {
    const origDate = document.getElementById("bk-orig-date").value;
    savedBooking = await BookingsStore.updateRecord(id, origDate, data);
  } else {
    savedBooking = await BookingsStore.addRecord({
      id: uid("bk"),
      createdAt: new Date().toISOString(),
      enquiryId: pendingEnquiryLink?.id || null,
      ...data,
    });
    // Logged even when this booking came from converting an enquiry
    // (which already logged its own directory entry when IT was first
    // created) — the two can end up with different dates/event types if
    // the customer's plans changed between enquiring and actually
    // booking, so both are worth keeping as a full contact history.
    await addDirectoryEntry({
      date: data.date,
      customerName: data.customerName,
      phone: data.phone,
      eventType: data.eventType,
      source: "Booking",
    });
    if (pendingEnquiryLink) {
      // No "converted" status — once an enquiry becomes a booking, the
      // event's status lives only on the booking (confirmed/cancelled).
      // All the enquiry's substantive fields were already carried over
      // into the new booking record via openBookingModal()'s prefill, so
      // nothing is lost by removing the enquiry itself.
      await EnquiriesStore.deleteRecord(pendingEnquiryLink.id, pendingEnquiryLink.date);
    }
  }
  pendingEnquiryLink = null;

  // A brand-new booking's #bk-id/#bk-orig-date are never set until now —
  // sync them (and editingBookingId) to the just-persisted record so a
  // second save in the same session (e.g. confirming another advance, or
  // clicking Save again) updates this same record instead of creating a
  // duplicate.
  editingBookingId = savedBooking.id;
  document.getElementById("bk-id").value = savedBooking.id;
  document.getElementById("bk-orig-date").value = savedBooking.date;
  const stillConfirmed = savedBooking.status === "confirmed";
  document.getElementById("bk-confirmation-btn").classList.toggle("hidden", !stillConfirmed);
  document.getElementById("bk-confirmation-share-btn").classList.toggle("hidden", !stillConfirmed);
  await refreshCurrentTab();
}

async function deleteBookingHandler() {
  const id = document.getElementById("bk-id").value;
  const date = document.getElementById("bk-orig-date").value;
  if (!id) return;

  // Defense in depth: the Delete button is hidden for staff on a confirmed
  // booking, but guard the handler itself too in case it's ever reachable
  // another way.
  const status = document.getElementById("bk-status").value;
  if (status === "confirmed" && !hasRole("owner")) {
    alert("Only the owner can delete a confirmed booking.");
    return;
  }

  const ok = await confirmDialog("Delete this booking? This cannot be undone.");
  if (!ok) return;
  await BookingsStore.deleteRecord(id, date);
  closeModal("modal-booking");
  await refreshCurrentTab();
}

// ---------------------------------------------------------------------------
// Menu editor — opened on top of the booking modal (which stays open
// underneath). Draft state (draftMenu) is only committed to the booking
// record when the booking itself is saved, same as draftPayments.
// ---------------------------------------------------------------------------

function updateMenuSummary() {
  const categoriesWithItems = MENU_CATEGORIES.filter((c) => (draftMenu[c.id] || []).length > 0);
  const totalItems = categoriesWithItems.reduce((sum, c) => sum + draftMenu[c.id].length, 0);
  const summaryEl = document.getElementById("bk-menu-summary");
  summaryEl.textContent = totalItems
    ? `${totalItems} item${totalItems > 1 ? "s" : ""} across ${categoriesWithItems.length} categor${categoriesWithItems.length > 1 ? "ies" : "y"}.`
    : "No menu items yet.";
  // Quick PDF access without opening the full menu editor — only useful
  // once there's actually a menu to view/download.
  document.getElementById("bk-download-menu-btn").classList.toggle("hidden", totalItems === 0);
  document.getElementById("bk-share-menu-btn").classList.toggle("hidden", totalItems === 0);
}

// All 12 categories are listed at once, each with its own input — clicking
// through a tab per category to add one dish was too tedious for entering
// a full menu. Only a category's chip row re-renders on add/remove (not
// the whole list), so the input the user is typing into never loses focus.
function openMenuModal() {
  renderMenuCategories();
  openModal("modal-menu");
}

function renderMenuCategories() {
  const wrap = document.getElementById("menu-categories");
  wrap.innerHTML = "";
  for (const cat of MENU_CATEGORIES) {
    const block = document.createElement("div");
    block.className = "menu-category-block";

    const header = document.createElement("div");
    header.className = "menu-category-header";
    header.textContent = cat.name;
    block.appendChild(header);

    const chips = document.createElement("div");
    chips.className = "menu-category-chips";
    chips.id = `menu-chips-${cat.id}`;
    block.appendChild(chips);

    const addRow = document.createElement("div");
    addRow.className = "menu-category-add-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add a dish…";
    // Typing a dish and tapping away (blur) commits it on its own — no tap
    // on "+" required for the common case. Enter and "+" both also commit
    // AND keep focus in the field, for quickly adding several dishes to the
    // same category back-to-back without leaving it; "+" only really earns
    // its keep for that "one more, same category" flow now.
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addMenuItemToCategory(cat.id, input, { refocus: true });
      }
    });
    input.addEventListener("blur", () => addMenuItemToCategory(cat.id, input));
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-sm";
    addBtn.title = "Add another";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => addMenuItemToCategory(cat.id, input, { refocus: true }));
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    block.appendChild(addRow);

    wrap.appendChild(block);
    renderCategoryChips(cat.id);
  }
}

function renderCategoryChips(categoryId) {
  const container = document.getElementById(`menu-chips-${categoryId}`);
  const items = draftMenu[categoryId] || [];
  container.innerHTML = "";
  if (!items.length) return;
  items.forEach((item, idx) => {
    const chip = document.createElement("span");
    chip.className = "menu-chip";
    chip.innerHTML = `${escapeHtml(item)} <button type="button" aria-label="Remove ${escapeHtml(item)}">&times;</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      items.splice(idx, 1);
      renderCategoryChips(categoryId);
      updateMenuSummary();
    });
    container.appendChild(chip);
  });
}

// `refocus` is only passed by Enter/"+" (the "add another to this same
// category" flow) — the blur-triggered auto-commit deliberately leaves
// focus alone, otherwise forcing it back onto this (now-cleared) input
// would fight whatever the user actually tapped next (another category's
// field, the Done button, etc).
function addMenuItemToCategory(categoryId, inputEl, { refocus } = {}) {
  const value = inputEl.value.trim();
  if (!value) return;
  if (!draftMenu[categoryId]) draftMenu[categoryId] = [];
  draftMenu[categoryId].push(value);
  inputEl.value = "";
  if (refocus) inputEl.focus();
  renderCategoryChips(categoryId);
  updateMenuSummary();
}

// The logo PNG is a few hundred KB at its native resolution — way more
// than needed for a ~140pt-wide placement in the PDF. Downscaling via
// canvas before addImage() keeps the generated PDF a few hundred KB
// instead of several MB, since jsPDF embeds the raw pixel data it's given.
function resizeImageDataUrl(dataUrl, maxWidth) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const width = Math.round(img.naturalWidth * scale);
      const height = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width, height });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Shared PDF header — logo on the left, title + ~2 compact event-detail
// lines to its right, then a divider. Used by both the menu and
// event-summary PDFs (identical booking-context header, different body).
// Returns the y-position where the caller's content should start.
// PDF-only date format (DD/MM/YYYY) for the Menu PDF's emphasized Date
// field — deliberately NOT touching the shared formatDateHuman() in
// core.js, which is used all over the rest of the app and elsewhere in
// this same file; isoDateStr is already zero-padded "YYYY-MM-DD" from the
// <input type="date">, so this is just a reorder, no Date object needed.
function formatDateDDMMYYYY(isoDateStr) {
  if (!isoDateStr) return "—";
  const [y, m, d] = isoDateStr.split("-");
  return `${d}/${m}/${y}`;
}

// jsPDF has no rich-text run within a single doc.text() call, so mixing
// bold and normal weight on one line means positioning each segment by
// hand — doc.getTextWidth() (accurate only once the matching font/size is
// set) gives each segment's width to advance by. All segments share one
// font size; only weight (bold vs normal) varies per segment.
function drawTextSegments(doc, x, y, size, segments) {
  doc.setFontSize(size);
  let curX = x;
  for (const seg of segments) {
    doc.setFont("helvetica", seg.bold ? "bold" : "normal");
    doc.text(seg.text, curX, y);
    curX += doc.getTextWidth(seg.text);
  }
}

// titleSize/detailSize default to the original values, and emphasizeFields
// defaults to off, so the other two PDF types (Booking Confirmation, Event
// Summary) are unaffected — only generateMenuPdf() opts into either.
async function drawPdfHeader(doc, pageWidth, margin, title, { titleSize = 15, detailSize = 10, emphasizeFields = false } = {}) {
  const y = margin;
  let headerTextX = margin;
  let headerBottom = y;
  try {
    // SITE.logo (core.js) is this venue's own full lockup logo, not a
    // fixed path — each venue's PDFs must show ITS OWN logo, not whichever
    // venue happened to be first (all three previously always loaded
    // "assets/logo.png", Shree Krishna Palace's file, regardless of which
    // venue's data was actually in the PDF).
    const rawLogoDataUrl = await imageUrlToDataUrl(SITE.logo);
    const logo = await resizeImageDataUrl(rawLogoDataUrl, 300);
    const logoWidth = 80;
    const logoHeight = logoWidth * (logo.height / logo.width);
    doc.addImage(logo.dataUrl, "PNG", margin, y, logoWidth, logoHeight);
    headerTextX = margin + logoWidth + 16;
    headerBottom = Math.max(headerBottom, y + logoHeight);
  } catch (err) {
    // No logo file for this venue yet (e.g. a freshly onboarded one) —
    // fall back to the venue's name as bold text instead of leaving a
    // blank gap where a logo would be.
    console.warn("[pdf] logo failed to load, falling back to venue name", err);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(SITE.name, margin, y + 16);
    headerBottom = Math.max(headerBottom, y + 20);
  }

  const halls = window.appSettings.halls;
  const customer = document.getElementById("bk-customer").value.trim() || "Guest";
  const dateVal = document.getElementById("bk-date").value;
  const hallId = document.getElementById("bk-hall").value;
  const slotId = document.getElementById("bk-slot").value;
  const eventType = document.getElementById("bk-event-type").value;
  const guests = document.getElementById("bk-guests").value;

  let textY = y + 14;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(titleSize);
  doc.text(title, headerTextX, textY);
  textY += titleSize * (17 / 15); // same line-gap-to-font-size ratio as the original 15pt/17pt

  const availWidth = pageWidth - margin - headerTextX;

  if (emphasizeFields) {
    // Date/Venue/Guest count are bold, same size as everything else on
    // this line — an earlier version made them 80% larger on their own
    // lines, which looked disproportionate; weight alone is enough
    // emphasis without breaking the line-per-line layout below.
    const venueText = `${hallName(halls, hallId)} — ${slotName(slotId)}`;
    drawTextSegments(doc, headerTextX, textY, detailSize, [
      { text: `Customer: ${customer}  ·  Date: `, bold: false },
      { text: formatDateDDMMYYYY(dateVal), bold: true },
      { text: "  ·  Venue: ", bold: false },
      { text: venueText, bold: true },
    ]);
    textY += detailSize * 1.3;
    drawTextSegments(doc, headerTextX, textY, detailSize, [
      { text: `Event type: ${eventType || "—"}  ·  Guest count: `, bold: false },
      { text: guests || "—", bold: true },
    ]);
    textY += detailSize * 1.3;
  } else {
    const detailLine1 = `Customer: ${customer}  ·  Date: ${dateVal ? formatDateHuman(dateVal) : "—"}  ·  Venue: ${hallName(halls, hallId)} — ${slotName(slotId)}`;
    const detailLine2 = `Event type: ${eventType || "—"}  ·  Guest count: ${guests || "—"}`;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(detailSize);
    const detailLineHeight = detailSize * 1.3; // same ratio as the original 10pt/13pt
    for (const line of [...doc.splitTextToSize(detailLine1, availWidth), ...doc.splitTextToSize(detailLine2, availWidth)]) {
      doc.text(line, headerTextX, textY);
      textY += detailLineHeight;
    }
  }
  headerBottom = Math.max(headerBottom, textY);

  const dividerY = headerBottom + 14;
  doc.setDrawColor(200);
  doc.line(margin, dividerY, pageWidth - margin, dividerY);
  return dividerY + 22;
}

// Builds and downloads a PDF from the booking form's current (possibly
// unsaved) field values plus draftMenu — deliberately reads live form
// inputs rather than the last-saved booking record, so "finalize the menu
// then download" works before ever clicking Save. No pricing/payment info
// by design — this is a menu handout, not a financial document. Wired to
// two buttons (inside the menu editor, and a shortcut on the main booking
// modal so a menu can be downloaded without opening the editor at all) —
// ev.currentTarget picks out whichever one was actually clicked so its
// label/disabled state updates rather than the other button's.
// Font sizes are 130% of the original menu-PDF sizes (12/10.5/11 -> these).
// Spacing constants (line height, gaps) scale with them at the same ratio
// so the layout's proportions stay consistent, not just the text itself.
const MENU_PDF_BASE_SIZES = {
  categorySize: 15.6,   // was 12
  itemSize: 13.65,      // was 10.5
  emptySize: 14.3,      // was 11
  notesHeadingSize: 15.6,  // was 12
  notesBodySize: 13.65,    // was 10.5
  lineHeight: 18.2,        // was 14
  categoryGap: 15.6,       // was 12
  afterCategoryHeading: 20.8, // was 16
  emptyStateGap: 26,          // was 20
  notesTopGap: 7.8,           // was 6
  afterDivider: 26,            // was 20
  afterNotesHeading: 20.8,     // was 16
};
// If a menu is large enough that the 130% sizes above don't fit on one
// page, layoutMenuBody() is re-run at a smaller scale until it does. In
// practice a typical menu (a handful of categories, a few items each)
// renders at scale 1 (the full 130% sizes); a large one using most/all 12
// categories with several items each lands somewhere around 0.4-0.7
// (roughly the original, pre-increase sizes) — tested empirically, not
// just estimated. This floor (0.15, ~2pt item text) only exists as an
// absolute backstop for genuinely extreme menus (every category maxed
// out) so "always fits on one page" can't be silently violated; it's not
// meant to be legible on its own, and shouldn't be hit by any realistic
// menu. If even the floor doesn't fit, ensureSpace()/addPage() below is
// the last-resort fallback.
const MENU_PDF_MIN_SCALE = 0.15;

// Lays out the menu's variable-length body (categories/items + notes) at a
// given scale, either measuring (draw:false, no doc.text() calls — just
// returns the total height it would take) or actually drawing it. Sharing
// this between the measure and draw passes is what makes the measurement
// trustworthy — it's the exact same code path, not an approximation.
function layoutMenuBody(doc, { draw, scale, margin, pageWidth, pageHeight, startY, notesVal }) {
  const s = MENU_PDF_BASE_SIZES;
  const lineHeight = s.lineHeight * scale;
  const categoryGap = s.categoryGap * scale;
  let y = startY;
  let overflowed = false;

  function ensureSpace(neededHeight) {
    if (!draw) return;
    if (y + neededHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
      overflowed = true;
    }
  }

  let anyItems = false;
  for (const cat of MENU_CATEGORIES) {
    const items = draftMenu[cat.id] || [];
    if (!items.length) continue;
    anyItems = true;

    ensureSpace(s.afterCategoryHeading + items.length * lineHeight);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(s.categorySize * scale);
    if (draw) doc.text(cat.name, margin, y);
    y += s.afterCategoryHeading * scale;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(s.itemSize * scale);
    for (const item of items) {
      ensureSpace(lineHeight);
      if (draw) doc.text(`•  ${item}`, margin + 12, y);
      y += lineHeight;
    }
    y += categoryGap;
  }

  if (!anyItems) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(s.emptySize * scale);
    if (draw) doc.text("No menu items recorded yet.", margin, y);
    y += s.emptyStateGap * scale;
  }

  if (notesVal) {
    ensureSpace(50 * scale);
    y += s.notesTopGap * scale;
    if (draw) {
      doc.setDrawColor(200);
      doc.line(margin, y, pageWidth - margin, y);
    }
    y += s.afterDivider * scale;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(s.notesHeadingSize * scale);
    if (draw) doc.text("Notes", margin, y);
    y += s.afterNotesHeading * scale;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(s.notesBodySize * scale);
    for (const line of doc.splitTextToSize(notesVal, pageWidth - margin * 2)) {
      ensureSpace(lineHeight);
      if (draw) doc.text(line, margin, y);
      y += lineHeight;
    }
  }

  return { finalY: y, heightUsed: y - startY, overflowed };
}

// Shared "what happens to a finished PDF" step for all three PDF types —
// either the normal browser download (doc.save()), or handed to the OS
// share sheet via the Web Share API's file support so the user can pick
// WhatsApp (or anything else) from it. There's no way to attach an
// arbitrary file to a WhatsApp message from a plain web page without that
// OS-level share support — wa.me links only prefill TEXT, never a file —
// so browsers without it (most desktop browsers today) fall back to a
// plain download plus a nudge to attach it manually.
async function outputPdf(doc, filename, mode) {
  if (mode !== "share") {
    doc.save(filename);
    return;
  }
  const file = new File([doc.output("blob")], filename, { type: "application/pdf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // user cancelled the share sheet — not a failure
      console.warn("[share] navigator.share failed, falling back to download", err);
    }
  }
  doc.save(filename);
  alert("Your browser can't share files directly here. The PDF has been downloaded instead — attach it to WhatsApp manually.");
}

async function generateMenuPdf(ev, mode = "download") {
  const btn = ev?.currentTarget || document.getElementById("menu-download-pdf-btn");
  // innerHTML, not textContent: some of these buttons (the "Share via
  // WhatsApp" ones) contain an <img> icon alongside their label — textContent
  // would silently and permanently strip it the first time this runs, since
  // restoring via textContent afterward replaces all children with a single
  // text node, icon included.
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Preparing PDF…";

  try {
    await loadJsPdf();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const startY = await drawPdfHeader(doc, pageWidth, margin, "Event Menu", { titleSize: 19.5, detailSize: 13, emphasizeFields: true });
    const customer = document.getElementById("bk-customer").value.trim() || "Guest";
    const dateVal = document.getElementById("bk-date").value;
    const notesVal = document.getElementById("bk-notes").value.trim();

    // A small buffer, not the literal page boundary — targeting exactly
    // 100% of the page height left the measured/drawn heights within a
    // fraction of a point of each other (observed directly: 801.89pt used
    // vs. an 801.8898pt boundary), so ordinary floating-point rounding
    // between the measure and draw passes was enough to tip a real case
    // onto a 2nd page despite the math "fitting". This buffer trades an
    // invisible amount of blank space for actually reliable fitting.
    const PAGE_BOTTOM_BUFFER = 10;
    const available = pageHeight - margin - startY - PAGE_BOTTOM_BUFFER;
    const layoutArgs = { margin, pageWidth, pageHeight, startY, notesVal };

    // Measure at full size (scale 1 = the 130% sizes) first — this never
    // draws or adds pages, just asks "how tall would this be?". Height
    // scales ~linearly with scale, so this converges in 1-2 corrections in
    // practice, but loop (bounded) rather than assume — text wrapping
    // (long notes) isn't perfectly linear, and this is cheap since nothing
    // is drawn until the loop exits.
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const { heightUsed } = layoutMenuBody(doc, { draw: false, scale, ...layoutArgs });
      if (heightUsed <= available || scale <= MENU_PDF_MIN_SCALE) break;
      scale = Math.max(MENU_PDF_MIN_SCALE, scale * (available / heightUsed));
    }

    // Real draw pass at the (possibly shrunk) scale. layoutMenuBody()'s own
    // ensureSpace()/addPage() stays in as a last-resort fallback only —
    // with the measure loop and buffer above, it shouldn't actually
    // trigger for any realistic menu.
    layoutMenuBody(doc, { draw: true, scale, ...layoutArgs });

    const filenameSafe = customer.replace(/[^a-z0-9]+/gi, "_");
    await outputPdf(doc, `Menu - ${filenameSafe} - ${dateVal || "undated"}.pdf`, mode);
  } catch (err) {
    console.error("[menu-pdf] failed to generate PDF", err);
    alert("Could not generate the PDF — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

// jsPDF's base-14 fonts (helvetica/times/courier) don't include the ₹
// glyph — it silently renders as a stray superscript "1" instead of
// failing loudly. PDF text needs this formatter instead of formatMoney();
// the on-screen app UI is unaffected and keeps using the real ₹ symbol.
function formatMoneyForPdf(n) {
  return formatMoney(n).replace("₹", "Rs. ");
}

// A downloadable confirmation slip for the customer — the basic pre-event
// facts (contact, rate, total, advance so far) once a booking has been
// saved as confirmed. Reads live form/draft state (not the last-saved
// record), same as generateMenuPdf(), so it reflects whatever's currently
// on screen even before the next Save. Deliberately excludes settlement
// figures — this is the "you're booked" document, not the closing bill
// (that's generateEventSummaryPdf(), only relevant once settled).
async function generateBookingConfirmationPdf(ev, mode = "download") {
  const btn = ev?.currentTarget || document.getElementById("bk-confirmation-btn");
  const originalLabel = btn.innerHTML; // see generateMenuPdf() for why innerHTML, not textContent
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadJsPdf();
    const { jsPDF } = window.jspdf;
    // A5, not A4 — this is a compact handout, not a multi-section document
    // like the menu/event-summary PDFs.
    const doc = new jsPDF({ unit: "pt", format: "a5" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 30;
    const lineHeight = 14;

    let y = await drawPdfHeader(doc, pageWidth, margin, "Booking Confirmation");
    const customer = document.getElementById("bk-customer").value.trim() || "Guest";
    const dateVal = document.getElementById("bk-date").value;
    const phone = document.getElementById("bk-phone").value.trim();
    const email = document.getElementById("bk-email").value.trim();

    // Pass the format explicitly on every extra page — jsPDF's addPage()
    // silently falls back to A4 when called with no arguments, regardless
    // of what the document was constructed with, which would otherwise
    // undo the whole point of generating this as A5.
    function ensureSpace(neededHeight) {
      if (y + neededHeight > pageHeight - margin) {
        doc.addPage("a5");
        y = margin;
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Booking Details", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);

    const perPlateCost = toNumber(document.getElementById("bk-per-plate-cost").value);
    const hallRent = toNumber(document.getElementById("bk-hall-rent").value);
    const extraAmount = toNumber(document.getElementById("bk-extra-amount").value);
    const extraReason = document.getElementById("bk-extra-amount-reason").value.trim();
    const total = computeBookingTotal();
    const advance = draftPayments.reduce((s, p) => s + toNumber(p.amount), 0);

    const lines = [
      `Phone: ${phone || "—"}`,
      ...(email ? [`Email: ${email}`] : []),
      `Rate (per plate): ${formatMoneyForPdf(perPlateCost)}`,
      ...(hallRent > 0 ? [`Hall rent: ${formatMoneyForPdf(hallRent)}`] : []),
      ...(extraAmount > 0 ? [`Extra amount: ${formatMoneyForPdf(extraAmount)}${extraReason ? " (" + extraReason + ")" : ""}`] : []),
      `Total amount: ${formatMoneyForPdf(total)}`,
    ];
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    }

    // Advances are itemized (amount + who took it) rather than shown as a
    // single summed figure — there can be more than one, from different
    // staff, and the customer's slip should show who to follow up with.
    if (draftPayments.length) {
      ensureSpace(lineHeight);
      doc.text("Advance received:", margin, y);
      y += lineHeight;
      for (const p of draftPayments) {
        ensureSpace(lineHeight);
        doc.text(`   ${formatMoneyForPdf(p.amount)} — received by ${p.receivedBy || "—"}`, margin, y);
        y += lineHeight;
      }
      ensureSpace(lineHeight);
      doc.text(`Total advance received: ${formatMoneyForPdf(advance)}`, margin, y);
      y += lineHeight;
    } else {
      ensureSpace(lineHeight);
      doc.text(`Advance received: ${formatMoneyForPdf(0)}`, margin, y);
      y += lineHeight;
    }

    ensureSpace(lineHeight);
    doc.text(`Balance due: ${formatMoneyForPdf(total - advance)}`, margin, y);
    y += lineHeight;

    const notesVal = document.getElementById("bk-notes").value.trim();
    if (notesVal) {
      ensureSpace(50);
      y += 6;
      doc.setDrawColor(200);
      doc.line(margin, y, pageWidth - margin, y);
      y += 20;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("Notes", margin, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      for (const line of doc.splitTextToSize(notesVal, pageWidth - margin * 2)) {
        ensureSpace(lineHeight);
        doc.text(line, margin, y);
        y += lineHeight;
      }
    }

    const filenameSafe = customer.replace(/[^a-z0-9]+/gi, "_");
    await outputPdf(doc, `Booking Confirmation - ${filenameSafe} - ${dateVal || "undated"}.pdf`, mode);
  } catch (err) {
    console.error("[booking-confirmation-pdf] failed to generate PDF", err);
    alert("Could not generate the confirmation — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

// A shareable recap for the owner once an event is settled — the final
// bill breakdown, the full payment history (including the auto-recorded
// final collection), and running totals. Only ever shown/available once
// draftSettlement exists (see updateSettlementSummary()'s button toggle),
// so this deliberately doesn't handle an "unsettled" state. Menu content
// stays out of this one on purpose — it's a separate, kitchen-facing
// document (generateMenuPdf() above); this one is the financial recap.
async function generateEventSummaryPdf(ev, mode = "download") {
  const btn = ev?.currentTarget || document.getElementById("bk-event-summary-btn");
  const originalLabel = btn.innerHTML; // see generateMenuPdf() for why innerHTML, not textContent
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadJsPdf();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    const lineHeight = 14;

    let y = await drawPdfHeader(doc, pageWidth, margin, "Event Summary");
    const customer = document.getElementById("bk-customer").value.trim() || "Guest";
    const dateVal = document.getElementById("bk-date").value;

    function ensureSpace(neededHeight) {
      if (y + neededHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Final Settlement", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    const s = draftSettlement;
    const settlementLines = s
      ? [
          `Final plate count: ${s.finalPlateCount || 0}`,
          `Per plate cost: ${formatMoneyForPdf(s.finalPerPlateCost || 0)}`,
          `Hall rent: ${formatMoneyForPdf(s.finalHallRent || 0)}`,
          `Extra amount: ${formatMoneyForPdf(s.finalExtraAmount || 0)}${s.finalExtraReason ? " (" + s.finalExtraReason + ")" : ""}`,
          // subtotal/gstApplied are absent on settlements recorded before
          // GST existed as a concept — fall back to the total either way.
          `Subtotal: ${formatMoneyForPdf(s.subtotal ?? s.finalTotalAmount ?? 0)}`,
          ...(s.gstApplied ? [`GST (5%): ${formatMoneyForPdf(s.gstAmount || 0)}`] : []),
          `Final total: ${formatMoneyForPdf(s.finalTotalAmount || 0)}`,
          `Settled by ${s.settledBy} on ${formatDateHuman(s.settledDate)}`,
        ]
      : ["Not settled yet."];
    for (const line of settlementLines) {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += 12;

    ensureSpace(30);
    doc.setDrawColor(200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Advances Received", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    if (!draftPayments.length) {
      doc.text("No advances recorded.", margin, y);
      y += lineHeight;
    } else {
      for (const p of [...draftPayments].sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
        ensureSpace(lineHeight);
        doc.text(`${formatDateHuman(p.date)} · ${formatMoneyForPdf(p.amount)} · ${p.mode || ""} · by ${p.receivedBy || "—"}`, margin, y);
        y += lineHeight;
      }
    }
    y += 8;

    const advance = bookingPaid({ payments: draftPayments });
    const collected = toNumber(draftSettlement?.collectedAmount);
    const total = draftSettlement?.finalTotalAmount ?? computeBookingTotal();
    ensureSpace(4 * lineHeight + 10);
    doc.setFont("helvetica", "bold");
    doc.text(`Total advances received: ${formatMoneyForPdf(advance)}`, margin, y);
    y += lineHeight;
    if (s) {
      doc.text(`Collected at settlement: ${formatMoneyForPdf(collected)}`, margin, y);
      y += lineHeight;
    }
    doc.text(`Total received: ${formatMoneyForPdf(advance + collected)}`, margin, y);
    y += lineHeight;
    doc.text(`Balance due: ${formatMoneyForPdf(total - advance - collected)}`, margin, y);
    y += lineHeight;

    const notesVal = document.getElementById("bk-notes").value.trim();
    if (notesVal) {
      ensureSpace(50);
      y += 6;
      doc.setDrawColor(200);
      doc.line(margin, y, pageWidth - margin, y);
      y += 20;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("Notes", margin, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      for (const line of doc.splitTextToSize(notesVal, pageWidth - margin * 2)) {
        ensureSpace(lineHeight);
        doc.text(line, margin, y);
        y += lineHeight;
      }
    }

    const filenameSafe = customer.replace(/[^a-z0-9]+/gi, "_");
    await outputPdf(doc, `Event Summary - ${filenameSafe} - ${dateVal || "undated"}.pdf`, mode);
  } catch (err) {
    console.error("[event-summary-pdf] failed to generate PDF", err);
    alert("Could not generate the summary — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}
