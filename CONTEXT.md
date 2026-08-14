# Context

The deeper "why" behind Banquet Manager's design. Read this + README.md
before making structural changes — it should be enough to onboard without
re-deriving decisions from scratch.

## Domain model

The facility has exactly **2 halls**, each with exactly **2 daily slots**:
Lunch and Dinner. That's 4 bookable units per calendar date. Hall *names*
are user-editable (Settings tab); the count (2 halls x 2 slots) is not
configurable in this version — it's assumed fixed by the physical facility.

Two record types, both date-bucketed by *their own* `date` field:

- **Enquiry** — a lead that hasn't been confirmed. Fields: `date`, `hallId`,
  `slot`, `customerName`, `phone`, `email`, `eventType`, `guestCount`,
  `status` (`new` / `followup` / `converted` / `lost`), `followUpDate`,
  `notes`, `convertedBookingId`.
- **Booking** — a confirmed or tentative reservation. Fields: same contact/
  event fields, plus `totalAmount`, `payments[]` (`{amount, date, mode,
  note}`), `status` (`tentative` / `confirmed` / `cancelled`), `enquiryId`
  (set if it originated from a converted enquiry).

**A slot's displayed status** (see `slotStatus()` in `core.js`) is derived,
not stored: confirmed booking > tentative booking > any active (`new`/
`followup`) enquiry > available. Cancelled bookings and resolved
(`converted`/`lost`) enquiries don't block a slot — this is why cancelling
a booking immediately frees the slot in the calendar without deleting the
record (you keep the history).

**Multiple enquiries can exist for the same hall/slot/date** (competing
leads) — the slot just shows "enquiry" status and the slot-detail modal
lists all of them. Only one non-cancelled **booking** is expected per hall/
slot/date; the UI doesn't hard-block a second one (no unique constraint —
Firestore-as-KV-store has no transactions/constraints across documents),
it just relies on the "New Booking" button being hidden once one exists in
the slot-detail modal. Directly opening "+ New Booking" from the Bookings
tab does not check this — a deliberate simplicity tradeoff, not an
oversight, given trusted single-facility usage.

## Data storage: Firestore as KV store, bucketed by month

Firestore holds one collection (`banquet_kv`), one document per key, each
shaped `{ value: "<JSON string>" }`. No normalized relational schema.

- `banquet:settings` → `{ halls, ownerHash, staffHash }` (single doc).
- `banquet:bookings:<YYYY-MM>` → `{ "<isoDate>": [booking, ...] }`.
- `banquet:enquiries:<YYYY-MM>` → `{ "<isoDate>": [enquiry, ...] }`.

Monthly bucketing keeps each document small (a venue doing dozens of
events/month stays well under Firestore's 1 MiB doc cap for years) and lets
range queries (`BookingsStore.getRange(from, to)` in `data-store.js`)
fetch exactly the known month-keys a range touches, via `monthsBetween()`,
with no listing/index query needed. A loaded month is cached in memory
(`monthCache` inside `createDateBucketStore`) so multiple reads/writes to
the same period in one sitting don't re-fetch.

`updateRecord()` handles a record's `date` changing (moving it to a
different day, possibly a different month bucket) by removing it from the
old bucket and inserting into the new one — this matters because a
booking's date is itself an editable field.

## Offline-first dual-write

Every `safeSet()` write goes to `localStorage` first (always succeeds,
instant) and then best-effort to Firestore. Every `safeGet()` read tries
Firestore first (keeping the local mirror fresh) and silently falls back
to `localStorage` if that fails. Nothing in the UI blocks on network state
— failures just raise a dismissable-by-nature status banner
(`banquet:syncstatus` event → `#sync-status` bar in `init.js`).

This means the app is fully usable with **no Firebase project connected at
all** (`FIREBASE_CONFIG.apiKey` still `"REPLACE_ME"` in `core.js`) — every
feature works against localStorage only, which is why README's quick-start
doesn't require Firebase setup. Firebase is additive (cross-device/staff
sync), not required.

## Security model — real Firebase Auth, two fixed role accounts

As of the 2026-08 accounts migration, this is backed by real Firebase
Authentication, not just a client-side check. Two fixed, non-secret
pseudo-email accounts represent the two roles (`OWNER_EMAIL`/`STAFF_EMAIL`
in `core.js`) — knowing the address grants nothing without the real
password, unlike the Firestore config, which is genuinely public by
design. `firestore.rules` requires `request.auth != null` AND
`request.auth.token.email` to be one of those two exact addresses — a bare
`request.auth != null` would NOT be enough, since Firebase's default
Email/Password sign-up lets anyone self-register with any address.

**Two Cloud Functions** (`functions/index.js`) exist because the client
SDK structurally cannot do certain things on its own:
- `claimAccount({ role, password })` — bootstraps/migrates the fixed
  owner or staff Firebase account from this app's original SHA-256
  password hash (still stored in `banquet_kv/banquet:settings`, kept in
  sync on every password change as an offline/no-Firebase fallback).
  Verifies the hash **server-side** before creating/updating the account —
  this closes a real race condition: since the role emails are fixed and
  public, a naive "first person to call `createUserWithEmailAndPassword`
  wins" approach would let anyone claim them first.
- `setStaffPassword({ password })` — lets the signed-in owner reset the
  staff account's password without knowing the old one. One Firebase
  client can never change *another* account's password — that's
  Admin-SDK-only, hence the function, owner-gated by checking
  `request.auth.token.email === OWNER_EMAIL`.

**Login flow** (`auth.js`'s `handleLogin()`): tries real Firebase sign-in
for both role emails first (the fast, fully-migrated path). If both fail,
falls back to the legacy SHA-256 hash comparison — covering any account
not yet migrated — and on a successful fallback match, calls
`claimAccount()` to create/update the real Firebase account, then signs in
for real. So every login after the first one for a given role takes the
fast path.

**Bootstrap exception in firestore.rules**: the settings doc
(`banquet:settings`) is deliberately **publicly readable** (writes still
require real auth) — the login screen has to read it *before* anyone is
signed in, both to decide setup-vs-login and to check the legacy hash
during migration. That doc only ever holds hall names and one-way hashes,
so this isn't a new exposure; it was already fully open under the
collection's previous rules. All actual booking/enquiry/payment data
stays fully locked behind real auth.

Firebase Auth persistence is explicitly set to `SESSION` in `initAuth()`
so it clears together with the app's own `sessionStorage` role flag on
tab/browser close — same re-prompt-every-session behavior as before this
migration.

First launch (no `ownerHash` set yet) still shows the one-time "set your
owner password" screen (`initAuth()`'s branch on `!cachedSettings.ownerHash`)
— that flow creates the owner's Firebase account directly client-side
(self-service `createUserWithEmailAndPassword`), no Cloud Function needed,
since there's no pre-existing hash to verify against yet.

Local testing against this uses the Firebase Emulator Suite (`firebase
emulators:start --only auth,firestore,functions`, requires a JRE for the
Firestore emulator), never production — see
`window.BANQUET_USE_EMULATORS` in `core.js`'s `initFirebase()`, which
points the SDK at `localhost:9099/8080/5001` instead of live Firebase when
set. The existing Playwright suite (which blocks real Firebase network
calls entirely) continues to exercise the legacy-hash-only fallback path
unmodified — it never reaches the `window.firebaseReady` branches at all.

## Deployment isolation

`firebase.json`'s `predeploy` runs `rm -rf public && cp -R src public` —
Hosting serves `public/`, never the project root directly, so nothing
outside `src/` (this doc, `.firebaserc`, stray local files) can
accidentally go live. On Windows this predeploy command needs Git's Unix
tools (`rm`, `cp`) on PATH — see README's Windows note. `cp -R src public`
is used instead of a separate `mkdir public` step because `cp -R` creates
the destination directory itself when it doesn't exist yet — `mkdir -p`
was avoided because cmd.exe's builtin `mkdir` intercepts the call before
PATH is consulted and doesn't understand `-p`.

## Known limitations (deliberate, not oversights)

- **Fixed 2 halls x 2 slots.** Adding a 3rd hall or a 3rd slot (e.g.
  "evening") would need: `HALL_DEFAULTS`/hall count assumptions loosened in
  Settings, `SLOTS` in `core.js` extended, and the calendar's `cal-slots`
  CSS grid (currently hardcoded `1fr 1fr`, i.e. 2 columns) adjusted. Not
  done because the facility has exactly 2+2 today — don't build for a
  hypothetical 3rd hall.
- **No booking uniqueness enforcement per slot** (see Domain model above)
  — acceptable given trusted, low-volume, single-facility usage where a
  double-booking would be immediately visible on the calendar anyway.
- **No notifications** (email/SMS) for enquiry follow-ups — the Dashboard's
  "Open enquiries" list is the entire follow-up mechanism. Adding real
  notifications would require a server component, which this stack
  deliberately doesn't have.
- **No multi-tenant support** — one facility, one Firestore project. If
  managing multiple venues is ever needed, key structure would need a
  facility ID prefix throughout `data-store.js`.