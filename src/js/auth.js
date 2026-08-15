// auth.js — Firebase Authentication-backed login. Real Firestore access
// control now depends on this (see firestore.rules) rather than being
// purely a client-side UI gate. Session-scoped: Firebase Auth persistence
// is explicitly set to SESSION so both it and the app's own role flag
// clear together whenever the tab/browser closes, matching the previous
// re-prompt-on-every-session behavior.
//
// Migration: accounts created before this feature only have a SHA-256
// password hash in Settings, not a real Firebase Auth account. handleLogin()
// tries real Firebase sign-in first; if that fails for both roles, it falls
// back to the legacy hash check, and on success transparently creates the
// matching Firebase account so future logins take the fast (secure) path.
// See CONTEXT.md's Security section for the full reasoning.

const ROLE_KEY = "banquet:role";
// Set only when role === "staff" — which individual staff member is
// logged in, since "staff" is no longer one shared identity (see
// handleLogin()'s phone-based lookup). Not meaningful for role === "owner".
const STAFF_NAME_KEY = "banquet:staffName";
const STAFF_ID_KEY = "banquet:staffId";

let cachedSettings = null;

function currentRole() {
  return sessionStorage.getItem(ROLE_KEY);
}

// owner satisfies any staff-level check too.
function hasRole(required) {
  const role = currentRole();
  if (!role) return false;
  if (required === "staff") return role === "staff" || role === "owner";
  return role === required;
}

// The name to auto-sign onto advances/settlements recorded in this
// session — "Owner" for the owner (who has no individual staff record),
// or the logged-in staff member's own name. Never null while actually
// logged in, since login only succeeds once a role is established.
function currentStaffName() {
  if (currentRole() === "owner") return "Owner";
  return sessionStorage.getItem(STAFF_NAME_KEY) || "Staff";
}

function currentStaffId() {
  return sessionStorage.getItem(STAFF_ID_KEY);
}

function logout() {
  sessionStorage.removeItem(ROLE_KEY);
  sessionStorage.removeItem(STAFF_NAME_KEY);
  sessionStorage.removeItem(STAFF_ID_KEY);
  if (window.firebaseReady) {
    firebase.auth().signOut().catch(() => {});
  }
  location.reload();
}

function els() {
  return {
    screen: document.getElementById("login-screen"),
    setupBlock: document.getElementById("login-setup-block"),
    loginBlock: document.getElementById("login-normal-block"),
    setupOwnerPw: document.getElementById("setup-owner-password"),
    setupOwnerPw2: document.getElementById("setup-owner-password-confirm"),
    setupBtn: document.getElementById("setup-owner-btn"),
    setupError: document.getElementById("setup-error"),
    loginPhone: document.getElementById("login-phone"),
    loginPw: document.getElementById("login-password"),
    loginBtn: document.getElementById("login-btn"),
    loginError: document.getElementById("login-error"),
    appShell: document.getElementById("app-shell"),
  };
}

async function initAuth(onSuccess) {
  cachedSettings = await getSettings();
  const e = els();

  if (window.firebaseReady) {
    try {
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION);
    } catch (err) {
      console.warn("[auth] could not set session persistence", err);
    }
  }

  if (!cachedSettings.ownerHash) {
    // First run: no owner password set yet.
    e.setupBlock.classList.remove("hidden");
    e.loginBlock.classList.add("hidden");
    e.setupBtn.addEventListener("click", () => handleSetupOwner(onSuccess));
    e.setupOwnerPw2.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") handleSetupOwner(onSuccess);
    });
    e.screen.classList.remove("hidden");
    return;
  }

  e.setupBlock.classList.add("hidden");
  e.loginBlock.classList.remove("hidden");
  e.loginBtn.addEventListener("click", () => handleLogin(onSuccess));
  e.loginPhone.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") handleLogin(onSuccess);
  });
  e.loginPw.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") handleLogin(onSuccess);
  });
  e.screen.classList.remove("hidden");

  // Already authenticated this session (e.g. tab still open after a soft reload)?
  if (currentRole()) {
    e.screen.classList.add("hidden");
    onSuccess();
  }
}

async function handleSetupOwner(onSuccess) {
  const e = els();
  const pw = e.setupOwnerPw.value;
  const pw2 = e.setupOwnerPw2.value;
  e.setupError.classList.remove("show");

  if (!pw || pw.length < 4) {
    e.setupError.textContent = "Password must be at least 4 characters.";
    e.setupError.classList.add("show");
    return;
  }
  if (pw !== pw2) {
    e.setupError.textContent = "Passwords do not match.";
    e.setupError.classList.add("show");
    return;
  }

  if (window.firebaseReady) {
    try {
      await firebase.auth().createUserWithEmailAndPassword(OWNER_EMAIL, pw);
    } catch (err) {
      // Firestore access is gated on real auth now, so if this fails (e.g.
      // offline right at setup time), the owner will still get in this
      // session via the legacy hash below, but Firestore reads/writes will
      // fail until a later login completes the migration. Rare in
      // practice — logged for visibility, not surfaced as a hard error.
      console.warn("[auth] could not create owner Firebase account", err);
    }
  }

  const hash = await sha256Hex(pw);
  cachedSettings.ownerHash = hash;
  await saveSettings(cachedSettings);

  sessionStorage.setItem(ROLE_KEY, "owner");
  e.screen.classList.add("hidden");
  onSuccess();
}

async function handleLogin(onSuccess) {
  const e = els();
  const phone = e.loginPhone.value.trim();
  const pw = e.loginPw.value;
  e.loginError.classList.remove("show");

  // A mobile number means this is a staff login — each staff member has
  // their own number + password (owner-managed, see Settings > Staff),
  // not one shared password with no individual identity. This is purely
  // the legacy-style client-side hash check (same soft-deterrent security
  // model as the rest of this app, see CONTEXT.md's Security section) —
  // there's no per-staff real Firebase Auth account, unlike the fixed
  // owner/staff accounts the dormant migration below still targets.
  if (phone) {
    const staff = findStaffByPhone(cachedSettings.staffMembers, phone);
    const hash = staff ? await sha256Hex(pw) : null;
    if (!staff || hash !== staff.passwordHash) {
      e.loginError.textContent = "No staff member found with that mobile number, or incorrect password.";
      e.loginError.classList.add("show");
      e.loginPw.value = "";
      return;
    }
    sessionStorage.setItem(ROLE_KEY, "staff");
    sessionStorage.setItem(STAFF_NAME_KEY, staff.name);
    sessionStorage.setItem(STAFF_ID_KEY, staff.id);
    e.screen.classList.add("hidden");
    onSuccess();
    return;
  }

  // Blank mobile number = owner login. Real Firebase sign-in first — this
  // is what Firestore access actually depends on once firestore.rules
  // requires request.auth (not live yet — see CONTEXT.md — but harmless
  // to keep trying).
  if (window.firebaseReady) {
    try {
      await firebase.auth().signInWithEmailAndPassword(OWNER_EMAIL, pw);
      sessionStorage.setItem(ROLE_KEY, "owner");
      e.screen.classList.add("hidden");
      onSuccess();
      return;
    } catch (err) {
      // Wrong password, or the account doesn't exist yet (pre-migration) —
      // fall through to the legacy hash check below.
    }
  }

  // Legacy fallback: pre-migration owner accounts only have a SHA-256 hash.
  const hash = await sha256Hex(pw);
  if (!cachedSettings.ownerHash || hash !== cachedSettings.ownerHash) {
    e.loginError.textContent = "Incorrect password.";
    e.loginError.classList.add("show");
    e.loginPw.value = "";
    return;
  }

  if (window.firebaseReady) {
    try {
      // Verifies the password against the legacy hash SERVER-SIDE (see
      // functions/index.js's claimAccount) before creating/updating the
      // Firebase Auth account — closes a real race condition where anyone
      // could otherwise try to claim the fixed owner email first, since
      // it's visible in the public client bundle.
      const claimAccount = firebase.functions().httpsCallable("claimAccount");
      await claimAccount({ role: "owner", password: pw });
      await firebase.auth().signInWithEmailAndPassword(OWNER_EMAIL, pw);
    } catch (err) {
      // Migration didn't complete this time (e.g. offline) — the legacy
      // check above already granted this session's access; it'll retry on
      // a future login. Firestore reads/writes may fail this session.
      console.warn("[auth] could not migrate owner account to Firebase Auth this session", err);
    }
  }

  sessionStorage.setItem(ROLE_KEY, "owner");
  e.screen.classList.add("hidden");
  onSuccess();
}

// Applies role-based tab visibility. Call after login and whenever settings change.
function applyRoleVisibility() {
  const owner = hasRole("owner");
  document.querySelectorAll("[data-owner-only]").forEach((el) => {
    el.classList.toggle("hidden", !owner);
  });
  const badge = document.getElementById("role-badge");
  if (badge) badge.textContent = currentStaffName();
}
