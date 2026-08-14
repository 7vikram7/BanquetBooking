// settings-ui.js — hall names, staff/owner password management, sync status.
// Entire tab is owner-only (gated via applyRoleVisibility()/data-owner-only).

function renderSettingsHalls() {
  const container = document.getElementById("settings-halls");
  container.innerHTML = "";
  window.appSettings.halls.forEach((hall, idx) => {
    const row = document.createElement("div");
    row.className = "hall-name-row";
    row.innerHTML = `<label>Hall ${idx + 1} <input type="text" value="${escapeHtml(hall.name)}" data-hall-idx="${idx}" /></label>`;
    container.appendChild(row);
  });
}

function initSettingsTab() {
  renderSettingsHalls();

  document.getElementById("settings-save-halls").addEventListener("click", async () => {
    const inputs = document.querySelectorAll("#settings-halls input[data-hall-idx]");
    inputs.forEach((input) => {
      const idx = Number(input.dataset.hallIdx);
      const name = input.value.trim();
      if (name) window.appSettings.halls[idx].name = name;
    });
    await saveSettings(window.appSettings);
    refreshHallDependentUI();
  });

  document.getElementById("settings-save-staff-pw").addEventListener("click", async () => {
    const pwEl = document.getElementById("settings-staff-password");
    const errEl = document.getElementById("settings-staff-error");
    errEl.classList.remove("show");
    if (pwEl.value.length < 4) {
      errEl.textContent = "Password must be at least 4 characters.";
      errEl.classList.add("show");
      return;
    }

    // The owner setting/resetting the staff password without knowing the
    // old one is an Admin-SDK-only operation — the client can't do this to
    // another account directly, so it goes through a Cloud Function that
    // verifies the caller is really the owner (see functions/index.js).
    // That function isn't deployed to this project yet (it needs a Blaze
    // billing plan) — don't block the password change on it existing;
    // fall through to the legacy hash update below either way, same as
    // this always worked before the Cloud Function existed.
    if (window.firebaseReady) {
      try {
        const setStaffPassword = firebase.functions().httpsCallable("setStaffPassword");
        await setStaffPassword({ password: pwEl.value });
      } catch (err) {
        console.warn("[settings] setStaffPassword Cloud Function unavailable, falling back to legacy hash only", err);
      }
    }

    // Kept in sync as a fallback for when Firebase isn't reachable (see
    // auth.js's legacy migration path) — not the primary security
    // mechanism once Firestore rules require real auth.
    window.appSettings.staffHash = await sha256Hex(pwEl.value);
    await saveSettings(window.appSettings);
    pwEl.value = "";
    errEl.textContent = "Staff password saved.";
    errEl.classList.add("show");
    errEl.style.color = "var(--available)";
  });

  document.getElementById("settings-save-owner-pw").addEventListener("click", async () => {
    const pwEl = document.getElementById("settings-owner-password");
    const errEl = document.getElementById("settings-owner-error");
    errEl.classList.remove("show");
    if (pwEl.value.length < 4) {
      errEl.textContent = "Password must be at least 4 characters.";
      errEl.classList.add("show");
      return;
    }

    // Changing your OWN password is something the client SDK can do
    // directly — no Cloud Function needed, unlike the staff-reset case.
    if (window.firebaseReady && firebase.auth().currentUser) {
      try {
        await firebase.auth().currentUser.updatePassword(pwEl.value);
      } catch (err) {
        if (err.code === "auth/requires-recent-login") {
          errEl.textContent = "For security, please log out and back in, then try changing your password again.";
        } else {
          console.error("[settings] updatePassword failed", err);
          errEl.textContent = "Could not update the owner password — check your connection and try again.";
        }
        errEl.classList.add("show");
        errEl.style.color = "";
        return;
      }
    }

    // Kept in sync as a fallback for when Firebase isn't reachable (see
    // auth.js's legacy migration path) — not the primary security
    // mechanism once Firestore rules require real auth.
    window.appSettings.ownerHash = await sha256Hex(pwEl.value);
    await saveSettings(window.appSettings);
    pwEl.value = "";
    errEl.textContent = "Owner password saved.";
    errEl.classList.add("show");
    errEl.style.color = "var(--available)";
  });

  document.getElementById("settings-firebase-status").textContent = window.firebaseReady
    ? "Connected — data syncs to Firestore."
    : "Firebase not configured — data is saved to this browser only (see README to connect a Firebase project).";

  initDataDeletion();
}

// ---------------------------------------------------------------------------
// Data Deletion — permanent, owner-only removal of bookings/enquiries within
// a date range. Two-step: "Preview" counts what's in range and reveals a
// type-to-confirm block; "Permanently Delete" only runs once the owner has
// typed the literal word DELETE. Editing the date range (or the "GST only"
// scope checkbox) after previewing hides the confirm block again, so a
// confirm can never fire against a scope other than the one that was
// actually previewed.
//
// The "GST only" checkbox narrows this to just bookings that were settled
// (actually billed) without GST applied — a distinct, opt-in scope from the
// plain "everything in range" delete. Enquiries have no GST concept, so
// they're left untouched entirely when this scope is active.
// ---------------------------------------------------------------------------

// A settled booking whose final bill did NOT include GST — undefined
// gstApplied covers bookings settled before the GST feature existed.
function isUnbilledGstBooking(booking) {
  return !!booking.settlement?.settledBy && !booking.settlement?.gstApplied;
}

function initDataDeletion() {
  const fromEl = document.getElementById("delete-range-from");
  const toEl = document.getElementById("delete-range-to");
  const gstOnlyEl = document.getElementById("delete-range-gst-only");
  const confirmBlock = document.getElementById("delete-range-confirm-block");
  const confirmInput = document.getElementById("delete-range-confirm-input");
  const summaryEl = document.getElementById("delete-range-preview-summary");
  const errEl = document.getElementById("delete-range-error");

  function resetConfirmState() {
    confirmBlock.classList.add("hidden");
    confirmInput.value = "";
    errEl.classList.remove("show");
  }

  fromEl.addEventListener("change", resetConfirmState);
  toEl.addEventListener("change", resetConfirmState);
  gstOnlyEl.addEventListener("change", resetConfirmState);

  document.getElementById("delete-range-preview-btn").addEventListener("click", async () => {
    errEl.classList.remove("show");
    resetConfirmState();

    const from = fromEl.value;
    const to = toEl.value;
    if (!from || !to) {
      errEl.textContent = "Pick both a From and To date first.";
      errEl.classList.add("show");
      return;
    }
    if (from > to) {
      errEl.textContent = "From date must be on or before the To date.";
      errEl.classList.add("show");
      return;
    }
    const gstOnly = gstOnlyEl.checked;

    if (gstOnly) {
      const bookings = (await BookingsStore.getRange(from, to)).filter(isUnbilledGstBooking);
      if (!bookings.length) {
        summaryEl.textContent = `No settled events without GST billing found between ${formatDateHuman(from)} and ${formatDateHuman(to)}.`;
        return;
      }
      summaryEl.textContent = `Found ${bookings.length} settled event${bookings.length === 1 ? "" : "s"} billed without GST between ${formatDateHuman(from)} and ${formatDateHuman(to)}. Enquiries are not affected by this scope.`;
      confirmBlock.classList.remove("hidden");
      return;
    }

    const [bookings, enquiries] = await Promise.all([
      BookingsStore.getRange(from, to),
      EnquiriesStore.getRange(from, to),
    ]);

    if (!bookings.length && !enquiries.length) {
      summaryEl.textContent = `No bookings or enquiries found between ${formatDateHuman(from)} and ${formatDateHuman(to)}.`;
      return;
    }

    summaryEl.textContent =
      `Found ${bookings.length} booking${bookings.length === 1 ? "" : "s"} and ${enquiries.length} enquir${enquiries.length === 1 ? "y" : "ies"} ` +
      `between ${formatDateHuman(from)} and ${formatDateHuman(to)}.`;
    confirmBlock.classList.remove("hidden");
  });

  document.getElementById("delete-range-confirm-btn").addEventListener("click", async () => {
    errEl.classList.remove("show");

    if (confirmInput.value !== "DELETE") {
      errEl.textContent = "Type DELETE exactly (all caps) to confirm.";
      errEl.classList.add("show");
      return;
    }

    const from = fromEl.value;
    const to = toEl.value;
    const gstOnly = gstOnlyEl.checked;
    const btn = document.getElementById("delete-range-confirm-btn");
    btn.disabled = true;
    try {
      if (gstOnly) {
        const deletedBookings = await BookingsStore.deleteRange(from, to, isUnbilledGstBooking);
        summaryEl.textContent = `Deleted ${deletedBookings} settled event${deletedBookings === 1 ? "" : "s"} billed without GST between ${formatDateHuman(from)} and ${formatDateHuman(to)}.`;
      } else {
        const [deletedBookings, deletedEnquiries] = await Promise.all([
          BookingsStore.deleteRange(from, to),
          EnquiriesStore.deleteRange(from, to),
        ]);
        summaryEl.textContent = `Deleted ${deletedBookings} booking${deletedBookings === 1 ? "" : "s"} and ${deletedEnquiries} enquir${deletedEnquiries === 1 ? "y" : "ies"} between ${formatDateHuman(from)} and ${formatDateHuman(to)}.`;
      }
      resetConfirmState();
      await refreshCurrentTab();
    } finally {
      btn.disabled = false;
    }
  });
}
