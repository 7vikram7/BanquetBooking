// enquiries-ui.js — enquiry add/edit modal + convert-to-booking handoff.
// Opened from calendar-ui.js (day/slot modals) and dashboard-ui.js (open
// enquiries list) — this file owns the modal only, there's no standalone
// enquiries list/tab; the calendar is the single entry point.

function initEnquiryModal() {
  const halls = window.appSettings.halls;
  populateSelect(document.getElementById("enq-hall"), halls);
  populateSelect(document.getElementById("enq-event-type"), allEventTypes().map((t) => ({ id: t, name: t })));
  document.getElementById("enq-event-type").addEventListener("change", () => {
    syncEventTypeOtherWrap("enq-event-type", "enq-event-type-other-wrap");
  });

  document.getElementById("enq-save-btn").addEventListener("click", saveEnquiry);
  document.getElementById("enq-delete-btn").addEventListener("click", deleteEnquiryHandler);
  document.getElementById("enq-convert-btn").addEventListener("click", convertEnquiryHandler);
  wireCallButton("enq-phone", "enq-call-btn");
}

let editingEnquiry = null;

function openEnquiryModal(enquiry, prefill) {
  editingEnquiry = enquiry;
  const isEdit = !!enquiry;
  document.getElementById("enq-modal-title").textContent = isEdit ? "Edit Enquiry" : "New Enquiry";
  document.getElementById("enq-error").classList.remove("show");
  document.getElementById("enq-id").value = enquiry?.id || "";
  document.getElementById("enq-orig-date").value = enquiry?.date || "";
  document.getElementById("enq-date").value = enquiry?.date || prefill?.date || todayIso();
  document.getElementById("enq-hall").value = enquiry?.hallId || prefill?.hallId || window.appSettings.halls[0].id;
  document.getElementById("enq-slot").value = enquiry?.slot || prefill?.slotId || "lunch";
  // Repopulate (not just re-read) — a custom type added since this app
  // last loaded needs to actually be in the list before .value can select
  // it. ensureEventTypeOption() is still a defensive fallback on top —
  // e.g. a type registered on another device/tab that hasn't synced here.
  const eventTypeSelect = document.getElementById("enq-event-type");
  populateSelect(eventTypeSelect, allEventTypes().map((t) => ({ id: t, name: t })));
  ensureEventTypeOption(eventTypeSelect, enquiry?.eventType);
  eventTypeSelect.value = enquiry?.eventType || EVENT_TYPES[0];
  document.getElementById("enq-event-type-other").value = "";
  syncEventTypeOtherWrap("enq-event-type", "enq-event-type-other-wrap");
  document.getElementById("enq-customer").value = enquiry?.customerName || "";
  document.getElementById("enq-phone").value = enquiry?.phone || "";
  document.getElementById("enq-email").value = enquiry?.email || "";
  document.getElementById("enq-guests").value = enquiry?.guestCount || "";

  const statusSelect = document.getElementById("enq-status");
  statusSelect.querySelector('option[value="converted"]')?.remove();
  if (enquiry?.status === "converted") {
    // "Converted" was removed as a status going forward — enquiries are
    // now deleted on conversion instead — but a record saved before that
    // change could still carry it. Same guard as the booking modal's
    // legacy "tentative" handling: inject the option back in just for
    // this record so it displays correctly instead of silently blanking.
    const legacyOpt = document.createElement("option");
    legacyOpt.value = "converted";
    legacyOpt.textContent = "Converted (legacy)";
    statusSelect.insertBefore(legacyOpt, statusSelect.firstChild);
  }
  statusSelect.value = enquiry?.status || "new";
  document.getElementById("enq-followup-date").value = enquiry?.followUpDate || "";
  document.getElementById("enq-notes").value = enquiry?.notes || "";

  document.getElementById("enq-delete-btn").classList.toggle("hidden", !isEdit);
  document.getElementById("enq-convert-btn").classList.toggle("hidden", !isEdit || enquiry.status === "converted");

  openModal("modal-enquiry");
}

function readEnquiryForm() {
  // "Other" + a typed custom value means the custom text IS the real
  // event type from here on — the record never stores the literal string
  // "Other" once something more specific was actually typed in.
  const eventTypeSelect = document.getElementById("enq-event-type");
  const customEventType = document.getElementById("enq-event-type-other").value.trim();
  const eventType = eventTypeSelect.value === "Other" && customEventType ? customEventType : eventTypeSelect.value;
  return {
    date: document.getElementById("enq-date").value,
    hallId: document.getElementById("enq-hall").value,
    slot: document.getElementById("enq-slot").value,
    eventType,
    customerName: document.getElementById("enq-customer").value.trim(),
    phone: document.getElementById("enq-phone").value.trim(),
    email: document.getElementById("enq-email").value.trim(),
    guestCount: toNumber(document.getElementById("enq-guests").value),
    status: document.getElementById("enq-status").value,
    followUpDate: document.getElementById("enq-followup-date").value || null,
    notes: document.getElementById("enq-notes").value.trim(),
  };
}

async function saveEnquiry() {
  const errEl = document.getElementById("enq-error");
  errEl.classList.remove("show");
  const data = readEnquiryForm();

  const missing = requiredFieldErrors(data);
  if (missing.length) {
    errEl.textContent = `Please fill in the required fields: ${missing.join(", ")}.`;
    errEl.classList.add("show");
    return;
  }

  // Registering happens regardless of new-vs-edit and no-ops for anything
  // that isn't a genuinely new custom value (see registerCustomEventType())
  // — simplest to just always call it here rather than duplicate the
  // "was this actually custom" check that function already does.
  await registerCustomEventType(data.eventType);

  const id = document.getElementById("enq-id").value;
  if (id) {
    const origDate = document.getElementById("enq-orig-date").value;
    await EnquiriesStore.updateRecord(id, origDate, data);
  } else {
    const newId = uid("enq");
    await EnquiriesStore.addRecord({
      id: newId,
      createdAt: new Date().toISOString(),
      ...data,
    });
    await addDirectoryEntry({
      date: data.date,
      customerName: data.customerName,
      phone: data.phone,
      eventType: data.eventType,
      source: "Enquiry",
      sourceId: newId,
    });
  }
  closeModal("modal-enquiry");
  await refreshCurrentTab();
}

async function deleteEnquiryHandler() {
  const id = document.getElementById("enq-id").value;
  const date = document.getElementById("enq-orig-date").value;
  if (!id) return;
  const ok = await confirmDialog("Delete this enquiry? This cannot be undone.");
  if (!ok) return;
  await EnquiriesStore.deleteRecord(id, date);
  closeModal("modal-enquiry");
  await refreshCurrentTab();
}

function convertEnquiryHandler() {
  if (!editingEnquiry) return;
  const enquiry = editingEnquiry;
  closeModal("modal-enquiry");
  openBookingModal(null, {
    date: enquiry.date,
    hallId: enquiry.hallId,
    slotId: enquiry.slot,
    fromEnquiry: enquiry,
  });
}
