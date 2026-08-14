// Cloud Functions — the things the client-side Firebase Auth SDK
// structurally cannot do safely on its own. Two callable functions:
//
// claimAccount({ role, password }) — bootstraps/migrates the fixed owner
// or staff pseudo-account from this app's pre-existing SHA-256 password
// hash (stored in the banquet_kv/banquet:settings doc). Verifying the hash
// SERVER-SIDE before creating/updating the Firebase Auth account is what
// closes a real race condition: the owner/staff email addresses are fixed
// and visible in the public client bundle, so if account creation were
// just "first person to call createUserWithEmailAndPassword(email, pw)
// wins" (the naive client-only approach), anyone could beat the real
// owner to claiming that email after this feature ships but before their
// first post-migration login. Requiring the caller to already know the
// real password (proven via the hash) closes that gap — this is exactly
// as secure as the password-based gate this app already had, just now
// also backed by a real Firebase Auth account and locked-down Firestore
// rules going forward.
//
// setStaffPassword({ password }) — lets an ALREADY-migrated, signed-in
// owner reset the staff account's password without knowing the old one.
// The client SDK can never do this for another account — Admin-SDK-only.
//
// Fixed, non-secret pseudo-emails identify the two roles as real Firebase
// Auth accounts — see src/js/core.js's OWNER_EMAIL/STAFF_EMAIL (must match
// exactly). They are never used for actual email delivery.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const OWNER_EMAIL = "owner@banquet-74423.firebaseapp.com";
const STAFF_EMAIL = "staff@banquet-74423.firebaseapp.com";
const SETTINGS_COLLECTION = "banquet_kv";
const SETTINGS_DOC_ID = "banquet:settings";

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function createOrUpdateAuthUser(email, password) {
  let user = null;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  if (user) {
    await admin.auth().updateUser(user.uid, { password });
  } else {
    await admin.auth().createUser({ email, password });
  }
}

exports.claimAccount = onCall(async (request) => {
  const role = request.data?.role;
  const password = request.data?.password;
  if (role !== "owner" && role !== "staff") {
    throw new HttpsError("invalid-argument", "role must be 'owner' or 'staff'.");
  }
  if (typeof password !== "string" || !password) {
    throw new HttpsError("invalid-argument", "password is required.");
  }

  const snap = await admin.firestore().collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID).get();
  const settings = snap.exists && snap.data()?.value ? JSON.parse(snap.data().value) : null;
  const expectedHash = role === "owner" ? settings?.ownerHash : settings?.staffHash;
  if (!expectedHash) {
    throw new HttpsError("failed-precondition", "No password has been set for this role yet.");
  }
  if (sha256Hex(password) !== expectedHash) {
    throw new HttpsError("permission-denied", "Incorrect password.");
  }

  await createOrUpdateAuthUser(role === "owner" ? OWNER_EMAIL : STAFF_EMAIL, password);
  return { ok: true };
});

exports.setStaffPassword = onCall(async (request) => {
  if (!request.auth || request.auth.token.email !== OWNER_EMAIL) {
    throw new HttpsError("permission-denied", "Only the owner can set the staff password.");
  }

  const newPassword = request.data?.password;
  if (typeof newPassword !== "string" || newPassword.length < 4) {
    throw new HttpsError("invalid-argument", "Password must be at least 4 characters.");
  }

  await createOrUpdateAuthUser(STAFF_EMAIL, newPassword);
  return { ok: true };
});
