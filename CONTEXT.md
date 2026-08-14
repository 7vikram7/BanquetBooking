# Context

The deeper "why" behind Banquet Manager's design. Read this + README.md
before making structural changes — it should be enough to onboard without
re-deriving decisions from scratch.

## Domain model

Every venue has a configurable set of **halls** (add/rename via Settings —
see "Halls are configurable" below), each with exactly **2 daily slots**:
Lunch and Dinner (`SLOTS` in `core.js` — this part genuinely is fixed;
see Known limitations). A hall x slot x date is one bookable unit.

Two record types, both date-bucketed by *their own* `date` field:

- **Enquiry** — a lead that hasn't been confirmed. Fields: `date`, `hallId`,
  `slot`, `customerName`, `phone`, `email`, `eventType`, `guestCount`,
  `status` (`ENQUIRY_STATUSES` = `new` / `followup` / `lost` — see "Status
  vocabulary changes" below), `followUpDate`, `notes`.
- **Booking** — a confirmed reservation. Fields: contact/event fields,
  pricing (`perPlateCost`, `hallRent`, `extraAmount`, `extraAmountReason`,
  computed `totalAmount = perPlateCost*guestCount + hallRent + extraAmount`),
  `menu` (object keyed by `MENU_CATEGORIES` id → array of dish names),
  `payments[]` (`{amount, date, mode, note, receivedBy}` — pre-event
  advances only, see Settlement below), `settlement` (optional — see
  below), `status` (`BOOKING_STATUSES` = `confirmed` / `cancelled`).

**A slot's displayed status** (see `slotStatus()`/`bookingDisplayStatus()`
in `core.js`) is derived, not stored: settled booking > confirmed booking >
any active (`new`/`followup`) enquiry > available. A confirmed booking
becomes "settled" (its own distinct color) once `booking.settlement` has
been recorded. Cancelled bookings and resolved (`lost`) enquiries don't
block a slot — this is why cancelling a booking immediately frees the slot
in the calendar without deleting the record (you keep the history).

**Settlement** (`booking.settlement`): recorded via a two-step flow on the
booking modal — a "final bill" (final plate count/per-plate cost/hall
rent/extra amount, optional 5% GST) confirmed first, then a "collect"
step recording `collectedAmount` and `settledBy`. Once
`settlement.settledBy` is set, staff (not owner) can no longer edit
*anything* on that booking. `effectiveBookingTotal(booking)` (`core.js`)
= `settlement?.finalTotalAmount ?? totalAmount` is the single source of
truth for "what did this event actually cost" everywhere in the app
(Accounts, dashboard summaries, slot-modal balance display).

**Accounts tab** only lists bookings that are both non-cancelled AND
settled (`b.settlement?.settledBy` set) — an owner-only, read-only sales
ledger; a confirmed-but-unsettled booking doesn't appear there at all.

**Multiple enquiries can exist for the same hall/slot/date** (competing
leads) — the slot just shows "enquiry" status and the slot-detail modal
lists all of them. Only one non-cancelled **booking** is expected per hall/
slot/date; the UI doesn't hard-block a second one (no unique constraint —
Firestore-as-KV-store has no transactions/constraints across documents),
it just relies on the "New Booking" button being hidden once one exists in
the slot-detail modal. Directly opening "+ New Booking" from the Bookings
tab does not check this — a deliberate simplicity tradeoff, not an
oversight, given trusted single-facility usage.

**Halls are configurable (2026-08-14 onward)**: Settings has a "+ Add
Hall" button (`settings-ui.js`) that pushes a new entry onto
`window.appSettings.halls` with a timestamp-based id (`hall-<base36 time>`)
so it can never collide with an existing or previously-removed hall's id —
a real id collision would silently merge two halls' bookings together.
Every hall-consuming view (calendar grid, day/slot modals, dashboard,
accounts, booking/enquiry forms) already read `halls` as a plain array
with no hardcoded count, so this was a pure Settings-tab addition, not a
wider refactor. `HALL_DEFAULTS` in `core.js` (2 halls) is only the seed
value written the first time a venue's settings doc is created — it does
not cap how many halls a venue can have. Verified the calendar's 2-column
`.cal-slots` grid still lays out cleanly with 3 halls (each row = one
hall's Lunch/Dinner) via a standalone render test before shipping.

**Status vocabulary changes (historical)**: `ENQUIRY_STATUSES` used to
include `converted` and `BOOKING_STATUSES` used to include `tentative` —
both were removed (an enquiry converting to a booking is now deleted
outright rather than relabeled; every booking is now either confirmed or
cancelled, no tentative middle state). Both removed values are still
handled gracefully wherever a *pre-existing* record might still carry one
(re-injected as a disabled "(legacy)" option in the relevant `<select>`,
never silently blanked/corrupted on save) — but nothing can create a new
record with either value anymore.

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

## Menu PDF sizing — auto-fit, not fixed

`generateMenuPdf()` (`bookings-ui.js`) targets font sizes 130% larger than
its original v1 sizes (`MENU_PDF_BASE_SIZES` — category/item/notes text
etc.), but that's a *target*, not a guarantee: the menu's length is
unbounded (up to all 12 `MENU_CATEGORIES`, each with any number of items,
plus free-text notes), while the page is fixed (one A4 page — required,
not negotiable). `layoutMenuBody()` is shared between a measuring pass
(`draw: false`, no `doc.text()`/`doc.addPage()` calls, just accumulates
height) and the real draw pass, so the measurement is exact rather than
estimated. If the 130%-sized content doesn't fit, it's re-measured at a
smaller `scale` (computed from how much too tall it was, then re-checked)
down to `MENU_PDF_MIN_SCALE` (0.15) as an absolute backstop.

**What this means in practice** (verified empirically, not just
estimated): a typical menu (a handful of categories, a few items each)
renders at the full 130% size. A large one spanning most/all 12
categories with several items each lands around scale 0.4-0.7 — roughly
back to the *original*, pre-increase sizes, not smaller. Only a genuinely
extreme menu (every category maxed out, e.g. 8+ items x all 12
categories, plus a long notes block) shrinks further, and even then still
fits on one page — confirmed by parsing the actual page count out of
generated PDFs, not just eyeballing them. `ensureSpace()`/`doc.addPage()`
still exist inside `layoutMenuBody()` as a last-resort fallback for the
theoretical case where even the floor doesn't fit, but shouldn't trigger
for any realistic menu.

The header (logo, title, customer/date/venue line) is NOT part of this
shrink logic — `drawPdfHeader()` (shared with the Booking Confirmation and
Event Summary PDFs) now takes optional `{titleSize, detailSize,
emphasizeFields}`, and only the menu PDF passes non-default values (title
19.5pt vs. the other two PDFs' unchanged 15pt; detail 13pt vs. 10pt).

**Emphasized fields**: with `emphasizeFields: true` (menu PDF only), Date,
Venue, and Guest count render **bold**, same `detailSize` (13pt) as
everything else on the line — an earlier version made them 80% larger
(23.4pt) on their own dedicated lines, which looked disproportionate once
seen rendered; weight alone is enough emphasis, and it keeps the original
2-line layout (Customer+Date+Venue / Event type+Guest count) intact.
Since jsPDF's `doc.text()` can't mix weights within one call, bold and
normal segments on the same line are positioned manually via the small
`drawTextSegments()` helper (`doc.getTextWidth()` after each segment's
font/size is set, to know where the next one starts) — this only works
cleanly because every segment on the line shares one font size; mixing
weight is easy, mixing size is what would force a rethink (per-segment
line-height bookkeeping). The Date field uses a local
`formatDateDDMMYYYY()` (DD/MM/YYYY) — deliberately NOT the shared
`formatDateHuman()` used everywhere else in the app (calendar, other
PDFs, etc.), so this format change is scoped to just this one field.

**Logo is venue-specific, with a name fallback**: `drawPdfHeader()` (all
three PDF types) used to hardcode `imageUrlToDataUrl("assets/logo.png")`
— Shree Krishna Palace's own file — regardless of which venue's data was
actually in the PDF, so every venue's downloads showed the same logo.
Fixed to load `SITE.logo` (the active venue's own full lockup, from
`SITE_CONFIGS` — see "White-label multi-venue support" above), and the
existing try/catch around the image load (already there for a missing
logo file, e.g. a freshly onboarded venue with no logo yet) now renders
`SITE.name` as bold text in that space instead of leaving it blank.

**Real bug this surfaced**: the auto-shrink scale calculation originally
targeted `available = pageHeight - margin - startY` exactly — with the
taller emphasized-fields header eating substantially more vertical space,
a realistic case (5 items × all 12 categories) computed a scale that
should have fit (measured height landed within a fraction of a point of
the boundary — 801.89pt used vs. an 801.8898pt limit) but still overflowed
to a 2nd page in the actual rendered PDF, purely from ordinary
floating-point rounding between the measure and draw passes. Fixed with a
small fixed buffer (`PAGE_BOTTOM_BUFFER = 10`pt) subtracted from
`available` before the shrink math runs, so the target is never the exact
page edge. **Lesson: never compute a fit-to-boundary calculation to
target 100.000% of the available space — always leave deliberate slack,**
since measure-pass and draw-pass floating-point arithmetic isn't
guaranteed to agree to the last fraction of a point even when the code
path is identical. Also switched the shrink loop from a fixed
measure-once/correct-twice sequence to a bounded loop (max 5 iterations,
exits early once it fits) for the same robustness reason — a single
linear correction is exact only when nothing wraps (e.g. long notes text
re-wrapping at a different scale is not perfectly linear).

## Click-to-call and WhatsApp sharing

**Click-to-call**: `wireCallButton(inputId, buttonId)` (`core.js`) is the
only place phone numbers get a "Call" button — the two `<input>`s where a
phone number is actually entered (`enq-phone` in the enquiry modal,
`bk-phone` in the booking modal; phone is never otherwise displayed
anywhere else in the app, e.g. not in any list/summary view). Reads the
input's value at click time (not whatever it was when the modal opened,
so it stays correct through edits) and navigates to `tel:<digits>` —
non-digit/non-`+` characters are stripped since `tel:` handling isn't
reliably tolerant of spaces/dashes/brackets across phone OSes.

**WhatsApp sharing** of a generated PDF is fundamentally a file-sharing
problem, not a linking problem: `https://wa.me/` links can only prefill
TEXT into a WhatsApp chat, never attach a file — there's no URL scheme
that hands WhatsApp an arbitrary blob from a web page. The only way to do
this from a browser is the **Web Share API's file support**
(`navigator.canShare({files:[...]})`/`navigator.share({files:[...]})`),
which hands off to the OS's native share sheet (where WhatsApp shows up
as one of the options) — supported on mobile Chrome/Safari, generally
NOT supported on desktop browsers.

All three PDF generators (`generateMenuPdf`, `generateBookingConfirmationPdf`,
`generateEventSummaryPdf`) now take a `mode` parameter (`"download"`,
the default and unchanged existing behavior, or `"share"`), and the final
`doc.save(filename)` call in each was replaced with a shared
`outputPdf(doc, filename, mode)` helper: `"download"` still just calls
`doc.save()`; `"share"` builds a `File` from `doc.output("blob")` and
tries `navigator.share()`, falling back to a plain download plus an alert
telling the user to attach it manually when file-sharing isn't supported
(most desktop browsers today) or the user cancels the native share sheet
(`AbortError` — not treated as a failure). Every existing "Download ___
PDF"/"View ___" button got a matching "Share via WhatsApp" button beside
it, wired to the same generator function with `mode: "share"`, and
mirroring the same `hidden`-class visibility toggles as its download
counterpart (e.g. both only show once a booking is actually confirmed, or
once a menu has at least one item) rather than being independently
controlled — see the three `classList.toggle("hidden", ...)` sites in
`bookings-ui.js` for exactly what each pair is gated on.

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

## White-label multi-venue support

As of 2026-08-14, one shared codebase serves multiple banquet venues, each
with its own Firebase project (own database — bookings/enquiries/settings
never mix) and its own branding, via `SITE_CONFIGS` at the top of
`core.js`. Which entry is active is chosen entirely by `location.hostname`
at page load — there is **deliberately no other per-venue branching
anywhere else in the codebase**. A fix applied to `src/` applies to every
venue automatically, because it's genuinely the same files deployed to
each; there is no fork.

**Current venues:**
- **Shree Krishna Palace** — project `banquet-74423`, hosting targets
  `main` (`banquet-74423.web.app`) and `skpbanquet` (`skpbanquet.web.app`,
  a second Hosting *target* on the *same* project — see below). Google
  account: `pancharatnapimpri@gmail.com`. Original venue; the default
  `SITE` when `location.hostname` matches nothing in `SITE_CONFIGS`
  (local dev, previews).
- **Saga Banquet** — project `saga-banquet-enquiry`, hosting target `saga`
  (`saga-banquet-enquiry.web.app`). Google account:
  `pingarahospitality@gmail.com`. Has its own logo (`assets/logo-saga.png`/
  `-icon.png`) and its own calendar enquiry color — see "Per-venue theming
  beyond logo/name" below.
- **Ram Krishna Banquet** — project `ramkrishna-banquet-manager`, hosting
  target `ramkrishnabanquet`, served from a **secondary** Hosting site
  (also named `ramkrishnabanquet`) inside that project, *not* its default
  site (`ramkrishna-banquet-manager.web.app`, which is deployed but
  unused/orphaned) — see "Custom hosting URL needs a secondary Hosting
  site" below for why. No logo supplied yet (degrades gracefully, same
  pattern as Saga initially had).

**Per-venue theming beyond logo/name**: a venue can optionally set
`enquiryColor` in its `SITE_CONFIGS` entry (e.g. Saga's `"#e0629c"`,
pink); `applyBranding()` sets a `--enquiry-calendar` CSS custom property
from it, which only `.dot-enquiry`/`.cal-slot-cell.status-enquiry` use
(the calendar's own enquiry color) — deliberately a *separate* variable
from `--enquiry` (used everywhere else: status pills, slot-card borders)
so a venue can restyle just its calendar without recoloring enquiry
indicators elsewhere in the app. A venue with no `enquiryColor` set falls
through to `styles.css`'s default (`--enquiry-calendar: var(--enquiry)`).
Settable at onboarding time (Excel's "Calendar enquiry color (optional)"
column, or `--enquiryColor` for the flag-based path) — added after Saga's
color was originally wired in by hand-editing `core.js`, so a future venue
doesn't need that follow-up manual step.

## Venue onboarding tooling

Manually onboarding Saga (the second venue) involved enough repetitive,
error-prone file editing that a third venue (Ram Krishna Banquet) got
dedicated tooling instead: `scripts/onboard-venue.js` (run with `--help`
for the full checklist) plus `templates/venue-onboarding-template.xlsx`
(a fill-in-and-hand-back spreadsheet with its own "Firebase Setup Steps"
and "Column Guide" sheets). Two ways to feed the script — `--excel <file>`
(reads every `Pending` row on the "New Venues" sheet, onboards each,
flips it to `Onboarded`, saves the file back in place — safe to hand back
the same growing spreadsheet repeatedly) or `--host/--name/--target/...`
flags for a one-off venue. All repo-file edits are surgical text
insertions (matching-brace-aware splicing), not parse+re-serialize, so
diffs stay minimal and existing formatting/comments survive untouched.

**Three real mistakes this tooling caught or caused, worth knowing about
if onboarding ever goes wrong again:**

1. **Service account created in the wrong GCP project.** Ram Krishna
   Banquet's first service-account key had `project_id: "rk-twelve21"`,
   but the pasted Web App config was for `ramkrishna-banquet-manager` — a
   genuinely different, immutable project. Firebase project IDs can never
   be aliased, so there's no fix except regenerating the key inside the
   *correct* project. Caught by reading the key's own `project_id` field
   before using it, not by trusting the filename. The onboarding template
   now has an explicit step telling the operator to open the downloaded
   JSON and compare `project_id` against the project used two steps
   earlier, specifically because this happened.
2. **Custom hosting URL needs a secondary Hosting site.** A brand-new
   Firebase project's *default* Hosting site is always named exactly
   `<projectId>`, giving `<projectId>.web.app` — immutable. `onboard-venue.js`
   originally bound every new venue's target straight to that default
   site regardless of the requested `host`, which silently deployed Ram
   Krishna Banquet to `ramkrishna-banquet-manager.web.app` instead of the
   requested `ramkrishnabanquet.web.app`. Fixed: the script now derives
   the real site id from `host` (`deriveSiteId()`) and, when it differs
   from the project id, both warns during the repo-edit step and prints a
   `firebase hosting:sites:create <siteId> --project <projectId>` command
   as part of the next-steps output — same technique already used for
   `skpbanquet.web.app` on `banquet-74423`.
3. **A fresh Firestore database denies everything by default.** "Start in
   production mode" (this repo's own setup instructions, deliberately —
   "test mode" auto-expires) means `allow read, write: if false` until
   rules are explicitly opened. Ram Krishna Banquet deployed successfully
   and *looked* fine, but every read/write was silently denied and the
   app fell back to local-only `localStorage` with no visible error —
   only noticed when the owner reported "it's offline, only shows local
   data." `onboard-venue.js`'s printed next-steps now include this as an
   explicit, REQUIRED (not deferrable) step, plus a `curl` command against
   the Firestore REST API to verify it actually took effect (`200 {}` =
   open, `403 PERMISSION_DENIED` = still locked) without needing to log
   into the app itself to check.

   One more wrinkle hit deploying that rules fix: PowerShell's
   `Set-Content -Encoding utf8` writes a **UTF-8 byte-order-mark**, which
   the Firestore rules compiler rejects (`token recognition error at:
   '﻿'`). Fix is `-Encoding ascii` instead (the rules content here is
   always plain ASCII) — baked into the script's printed PowerShell
   snippet now.

**To add a new venue**: see "Venue onboarding tooling" above. Nothing in
`src/` should need to change to add a venue — if it does, that's a bug in
this abstraction, not a reason to special-case a venue.

**`applyBranding()`** (`core.js`, called once from `init.js` at
`DOMContentLoaded`, before `initAuth()`) rewrites `document.title`, the
favicon, the login screen's logo/alt/subtitle, and the app header's
logo/name to match the active `SITE` — the static HTML's hardcoded
"Shree Krishna Palace" text is just the pre-JS/default-fallback content,
correct for `DEFAULT_SITE_KEY` (also what local dev/Playwright testing
always sees, since `location.hostname` is `localhost` there).

**Deploy mechanics — every venue's Google account is deliberately kept
separate.** `pancharatnapimpri@gmail.com` (already `firebase login`'d
interactively on this machine, long before this feature existed) has zero
access to any other venue's project, and that's intentional — segregation
is the whole point of a separate Google account per venue, so don't "fix"
this by granting cross-account access. Instead, every venue *except*
Shree Krishna Palace deploys via a **Google Cloud service account key**,
scoped only to that one project, stored *outside* this repo entirely at
`C:\Users\akash\.banquet-credentials\<projectId>-service-account.json`
(also `.gitignore`'d by pattern as defense-in-depth in case a key like
this is ever dropped inside the repo — see git history, it's happened
twice, both times caught before being staged). The service account needs
the **Owner** role on that project — Editor/"Firebase Admin" alone aren't
sufficient to enable APIs or create the Firestore database (see below);
discovered both times by hitting a real 403 on that specific step, not
assumed upfront.

Using a service account requires bypassing firebase-tools' own cached CLI
login, which otherwise silently wins over `GOOGLE_APPLICATION_CREDENTIALS`
for every command (confirmed by testing with a deliberately broken
credentials path — the error didn't change, proving the env var wasn't
even being consulted). firebase-tools resolves its "am I logged in"
config via `os.homedir()`, which on native Windows Node.js reads the
`USERPROFILE` environment variable — **not** Git Bash's `$HOME` (setting
`$HOME` alone doesn't work; both look like they should matter but only
`USERPROFILE` actually does). So every non-Shree-Krishna-Palace command
needs both overridden together, pointed at an empty scratch directory so
no cached login is found there:
```
USERPROFILE="C:\\Temp\\isolated-home-<venue>" HOME=/tmp/isolated-home-<venue> \
GOOGLE_APPLICATION_CREDENTIALS="C:\\Users\\akash\\.banquet-credentials\\<projectId>-service-account.json" \
firebase <command> --project <projectId>
```
(`onboard-venue.js`'s printed next-steps generate this exact command per
venue.) Shree Krishna Palace commands need none of this — just run
normally, using the already-cached `pancharatnapimpri@gmail.com` login.

**PowerShell-specific gotcha**: `firebase` itself is a `.ps1` script,
which the default execution policy blocks from running at all
(`... cannot be loaded because running scripts is disabled on this
system`). Use `firebase.cmd` instead of `firebase` when running any of
these commands from PowerShell (Git Bash doesn't have this problem).

**Firestore must be created explicitly for a brand-new project** — creating
a Firebase project does not auto-provision a Firestore database. The first
`firebase deploy --only firestore:rules` against a project with no database
yet will create one automatically (Native mode, Standard edition), but
picks a **default region with no way to ask first** (`nam5`, US
multi-region, for Saga) — worth deliberately choosing via
`firebase firestore:databases:create --location <region>` *before* the
first rules/data deploy if a specific region matters (e.g. lower latency
for non-US users) — this can't be changed later without deleting and
recreating the database, which is destructive to any data already in it.
Saga's `nam5` placement was accepted as fine for this app's usage pattern
(low-frequency staff bookings, not latency-sensitive) rather than
redone — flag this to a user if the topic of regions/latency ever comes up
again, since it's genuinely a one-way door.

**All three venues currently run the fully-open Firestore rules**
(`allow read, write: if true`, on the `banquet_kv` collection specifically
— every fresh project defaults to deny-all, see "Venue onboarding
tooling" above) — the locked-down, real-Firebase-Auth rules described
under "Security model" above are still just a draft sitting in
`firestore.rules`, written against `banquet-74423`'s own
`OWNER_EMAIL`/`STAFF_EMAIL` and not deployed to any project. It would need
each other venue's equivalent `<authDomain>` addresses added too before
ever being deployed there.

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

- **Slots are fixed at Lunch/Dinner** (`SLOTS` in `core.js`) — unlike
  halls (configurable since 2026-08-14, see Domain model above), adding a
  3rd slot (e.g. "evening") would need `SLOTS` extended and the
  calendar's `.cal-slots` CSS grid (currently hardcoded `1fr 1fr`, i.e. 2
  columns, laid out per-hall-per-row) reworked, since the grid's row
  grouping currently assumes exactly 2 slots per hall. Not done because
  no venue onboarded so far needs more than 2 daily slots.
- **No booking uniqueness enforcement per slot** (see Domain model above)
  — acceptable given trusted, low-volume, single-facility usage where a
  double-booking would be immediately visible on the calendar anyway.
- **No notifications** (email/SMS) for enquiry follow-ups — the Dashboard's
  "Open enquiries" list is the entire follow-up mechanism. Adding real
  notifications would require a server component, which this stack
  deliberately doesn't have.
- **Multi-tenant since 2026-08**: see the "White-label multi-venue support"
  section above — one shared codebase, per-hostname Firebase project +
  branding lookup in `core.js`.