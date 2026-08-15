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

Each "Share via WhatsApp" button has a `src/assets/whatsapp-icon.png`
`<img>` inside it (sized via `.whatsapp-icon` — `height: 1.1em` so it
scales with whichever button class it's in, `.btn` vs `.btn-sm`). Source:
`design-assets/whatsapp-logo-source.jpeg` — despite the `.jpeg`
extension it had a checkerboard "transparency preview" pattern baked
directly into its pixels (two near-white/near-gray shades, ~237 and
~255), not real alpha (`sharp` confirmed `hasAlpha: false`); chroma-keyed
both shades to transparent (green icon pixels have `g` far above `r`/`b`
so they never match) and trimmed, same general technique as the venue
logo processing (see "White-label multi-venue support" above).

**Real bug this surfaced**: the "Preparing…"/restore button-state pattern
(shared by all three PDF generators) captured and restored via
`btn.textContent`, which silently strips any non-text children —
harmless for the plain-text download buttons, but would have permanently
deleted the new icon out of a share button's markup the very first time
it was used (`textContent` getter ignores `<img>` entirely, so the
"restore" step replaced the button's contents with just the label text,
icon gone for good). Fixed by capturing/restoring via `innerHTML`
instead — verified with a real generate-then-restore cycle confirming the
icon's `<img>` survives byte-for-byte.

## Named staff accounts (replaces the old single shared staff password)

Staff used to be one shared password with no individual identity at all —
"Received by"/"Collected by" on advances and settlements was a free-text
field anyone with the staff password typed a name into by hand. That's
gone: `window.appSettings.staffMembers` is now an array of
`{ id, name, phone, passwordHash }` (owner-managed via Settings > Staff),
and login for a non-owner requires a matching **mobile number**, not just
a password — `auth.js`'s `handleLogin()` branches entirely on whether the
mobile-number field is blank (owner path, unchanged) or filled (staff
path: `findStaffByPhone()` looks the number up, `sha256Hex(pw)` is
compared against that specific staff member's `passwordHash` — same
client-side hash pattern as the owner password, same "soft deterrent, not
real access control" security model already documented for this whole
app). A successful staff login stores `banquet:staffName`/`banquet:staffId`
in `sessionStorage` alongside the existing `banquet:role` — `currentStaffName()`
(`auth.js`) returns that name, or `"Owner"` for the owner role, and is now
the ONLY source for `receivedBy`/`settledBy` on advances/settlements
(`addPaymentToDraft()`/`confirmSettlementHandler()` in `bookings-ui.js`) —
those fields were removed from the booking modal's markup entirely and
replaced with read-only `<strong>` displays that just show
`currentStaffName()` (or, for an already-settled booking being reopened,
the *historical* `draftSettlement.settledBy` — who actually settled it,
not whoever happens to be viewing it now).

**Phone number normalization matters more here than it first looks.**
`normalizePhone()` (`core.js`) strips non-digits AND drops a leading
India country code (`91`) when the remainder is still a plausible
10-digit number — without this, "+91 98765 43210" (as the owner might
paste it in when adding a staff member) and "9876543210" (as the staff
member might actually type it at login) would normalize to *different*
strings and simply fail to match, with no obvious reason why from either
person's perspective. This was caught by a real test failure, not
anticipated upfront — worth remembering if phone matching ever seems to
silently fail again for a differently-formatted but equivalent number.
Also used for duplicate detection when adding/editing staff (two staff
sharing a phone number would make login ambiguous, so it's rejected).

**Migration note — this is a breaking change for whoever was using the
old shared staff password.** There is no automatic carryover: the old
`staffHash` field is left in the settings shape (harmless, just unused
now) but nothing reads it anymore, and there is no bulk-import from it
into `staffMembers`. After this ships to a venue, its owner needs to add
each real staff member (Settings > Staff) before they can log in again —
this needs to happen promptly post-deploy, and the owner should be told
directly rather than discovering it when staff can't get in.

**`getSettings()`'s defaults-then-overlay pattern matters for this kind
of change generally, not just this feature**: `{ ...defaults, ...(s || {}) }`,
not `s || defaults` — the latter only applies defaults when a settings
doc doesn't exist AT ALL, which is never true for any of the three live
venues (they all already have one). Any future new settings field needs
the same treatment, or it'll come back `undefined` on every existing
installation despite looking like it has a sensible default.

**Dormant code note**: `functions/index.js`'s `claimAccount`/`setStaffPassword`
(undeployed — see "Security model" below) still reference the old single
`STAFF_EMAIL`/`staffHash` concept and were NOT updated for this change,
since they have zero live effect either way. If that real-Firebase-Auth
migration is ever revisited, it would need its own rework for per-staff
accounts (real Firebase Auth doesn't have a concept of "one fixed staff
email" that maps to this new multi-staff model at all) — flag this
explicitly if that migration ever comes back up.

Tested end-to-end with real Playwright runs (Firebase network calls
blocked via `context.route(...).abort()`, same convention as this
project's existing test suites — see the Security model section below
for why this matters: loading `src/` directly hits real production
Firestore otherwise): first-time owner setup,
adding a staff member, rejecting a duplicate phone number entered in a
different format, staff login with a differently-formatted (but
equivalent) phone number than how it was stored, wrong-password
rejection, editing a staff member's name/phone without touching their
password (old number stops working, new number + old password works),
removing a staff member, and confirming a real `addPaymentToDraft()` call
auto-signs the currently logged-in staff member's name with no manual
input at all.

**"admin" as an explicit owner-login keyword**: `handleLogin()`'s mobile-
number field means owner login when either left blank OR set to the
literal string `"admin"` (case-insensitive) — `isOwnerAttempt = !phone ||
phone.toLowerCase() === "admin"`. This is purely a discoverability nicety
on top of the existing blank-field behavior, not a separate mechanism —
"admin" never touches any stored credential named that; it's just a
second spelling of "leave this blank."

## Custom event types + a permanent customer Directory

Two related but distinct features, both from the same request, easy to
conflate because both use the word "directory":

**Custom event types** (`core.js`): `EVENT_TYPES` is now the *fixed base*
list only — `"Other"` isn't in it anymore, and `allEventTypes()` always
appends it last (`[...EVENT_TYPES, ...customEventTypes, "Other"]`), so it
stays the bottom catch-all no matter how many custom types accumulate.
Selecting "Other" in either the enquiry or booking form reveals a
"Custom event type" text input (`syncEventTypeOtherWrap()`, wired to both
selects' `change` event); if something is typed there at save time,
`readEnquiryForm()`/`readBookingForm()` use THAT as the record's real
`eventType` — the literal string `"Other"` is never actually saved once a
custom name was given — and `registerCustomEventType()` persists it into
`window.appSettings.customEventTypes` (case-insensitive deduped against
both the fixed list and already-registered custom ones) so it becomes a
normal selectable option in every future enquiry/booking, in both forms,
not just remembered for this one record. Both modals' open functions
*repopulate* the select (not just re-read stale options) specifically so
a type registered since this tab/device last loaded actually shows up,
plus `ensureEventTypeOption()` as a defensive fallback (same pattern as
the legacy "tentative"/"converted" status re-injection elsewhere in this
file) for the case where even that hasn't caught up yet.

**Directory tab** (`directory-ui.js`, new file; `DirectoryStore` in
`data-store.js`): an owner-only, append-only permanent log — every new
enquiry AND every new booking (not just ones converted from an enquiry;
bookings can be created directly) writes one entry via the shared
`addDirectoryEntry({date, customerName, phone, eventType, source})`
helper, in *addition* to whatever happens to its own normal
BookingsStore/EnquiriesStore record. `date` here is the event/occasion
date (this app's existing meaning of "date" on a booking/enquiry
record), and `source` is `"Enquiry"` or `"Booking"` — a converted
enquiry legitimately produces two directory entries (one from when it
was first enquired, one from when it became a booking), which is
intentional: they can carry different dates/event types if the
customer's plans changed in between, so both are worth keeping as a full
contact history rather than deduplicating them away.

**The entire point is that this store is never wired into deletion.**
`DirectoryStore` is built with the exact same `createDateBucketStore()`
helper as `BookingsStore`/`EnquiriesStore` (so it gets `getRange()` for
free, same querying convention as everywhere else) — which technically
gives it a working `deleteRange()`/`deleteRecord()` too, since that
helper always returns full CRUD. Nothing in this codebase calls those on
`DirectoryStore`, and settings-ui.js's Data Deletion feature only ever
touches `BookingsStore`/`EnquiriesStore` — verified directly: a real test
run added a directory entry, then ran an actual Data Deletion sweep
covering that same date range (confirmed for real via
`EnquiriesStore.getRange()`/`BookingsStore.getRange()` both coming back
empty afterward), and the directory row count was unchanged before and
after. If a future change ever needs to purge directory data, that must
be a new, deliberate, explicitly-requested feature — never a side effect
of Data Deletion gaining one more store to sweep.

Excel export (`generateDirectoryExcel()`) is the same lazy-loaded-SheetJS
pattern as `generateAccountsExcel()` in `accounts-ui.js` — one row per
entry (Sr No computed as position in the sorted list, not a stored
counter — avoids needing an atomic global counter across
possibly-concurrent writes from different devices, which this
Firestore-as-KV-store setup has no transaction support for anyway),
scoped to the tab's own From/To range.

**Explicit Search button, not auto-load.** `ensureDirectoryBackfilled()`
scans a much wider window than the visible list
(`DIRECTORY_BACKFILL_YEARS_BACK/FORWARD` = 15/5 years) against
Firestore — doing that on every tab switch or date-input change (the
original behavior) meant an expensive scan on nearly every click
anywhere near the tab. `initDirectoryTab()` no longer wires `change`
listeners on the From/To inputs, and `directory` was removed from
`TAB_RENDERERS` in `init.js` (so opening the tab, or any
`refreshCurrentTab()` elsewhere in the app while it happens to be the
active tab, no longer triggers it either) — the list only loads when
the owner presses the dedicated Search button next to the date range.
The container shows a "press Search to load entries" placeholder until
then. Download Excel is unaffected — it already reads the current
From/To values directly and can be used without pressing Search first.

**Real bug: the tab looked broken because of its default date range, not
because entries weren't being logged.** The first version copied
Accounts' "default to the current month" pattern (`initDirectoryTab()`
pre-filling From/To). That's correct FOR Accounts (a sale can't be in the
future). It's wrong here: a directory entry's `date` is the EVENT date,
and a fresh enquiry is very often for an event months away — so the
current-month default hid almost every real entry, immediately after
creating it, with no error or empty-state explanation pointing at the
date filter as the cause. Reported as "Directory isn't working"; verified
directly against `DirectoryStore` first (entries WERE there) before
touching the UI, which is what pinned it on the date range rather than
the write path. Fixed with a fixed, wide default window
(`directoryDefaultRange()`: 2 years back to 2 years forward from today)
instead of current-month — covers realistic advance-booking lead time
plus past history without being fully unbounded. `directoryDateRange()`
(used by both the list render and the Excel export) falls back to this
same wide default if the From/To inputs are ever cleared, consistent
with how Accounts falls back to its own (correctly narrow) default.

**Second real bug, reported after the date-range fix shipped: bookings/
enquiries created BEFORE the Directory feature existed never showed up
at all**, no matter how the date filter was set — because directory
entries are only ever written at creation time
(`saveEnquiry()`/`saveBooking()`'s new-record branch), there was no
mechanism backfilling entries for records that already existed when this
feature shipped. Fixed with `ensureDirectoryBackfilled()`
(`directory-ui.js`), called automatically at the start of every
`directoryEntriesInRange()` (so before both the list render and the Excel
export — no separate button to remember to click): scans a much wider
window than the tab's own display default (`DIRECTORY_BACKFILL_YEARS_BACK/
FORWARD` = 15/5, vs. the display default's 2/2 — real historical data
could predate this feature by longer than the display range's own
lookback), and for every enquiry/booking in that window, adds a directory
entry unless one already exists for it.

**Idempotency**: `addDirectoryEntry()` now takes a `sourceId` (the
originating booking/enquiry's own `id`) precisely so the backfill can
tell "already logged" apart from "never logged" and skip the former —
verified directly by revisiting the Directory tab twice in one session
and confirming the row count didn't double.

**Deliberately does NOT skip a record for having a blank customerName/
phone/eventType** — filtering incomplete records out of the backfill
would just recreate the exact "data silently doesn't show up, for a
reason that isn't obvious from the UI" problem this feature exists to
prevent. Verified with a record that had empty `customerName`/`phone`
written directly to `EnquiriesStore` (simulating genuinely old or
incomplete real data) — confirmed it gets backfilled into the directory
like any other record, not silently dropped.

**Third real bug, reported after the backfill fix shipped: "the
directory is still empty, it shows a blank page with just the date
range and download Excel button"** — this one turned out NOT to be a
display bug at all, and disproved the previous paragraph's claim that a
plain `directoryBackfillDone` boolean flag was safe. Investigated
directly against live production Firestore (rules are fully open, so a
plain unauthenticated `curl` against the Firestore REST API can read/
write `banquet_kv` for diagnosis) rather than guessing from the UI
symptom, since two previous "fixes" for this same user complaint had
each been real but incomplete. Found the real underlying enquiry/booking
records were fine, but the `banquet:directory:*` documents contained up
to 8 near-duplicate entries per record (same `sourceId`, `loggedAt`
timestamps a few milliseconds apart) — a race condition, not a blank
page: `directoryBackfillDone` was a plain boolean set `true` only after
the *entire* async scan-and-write finished, so clicking (or a page
re-render triggering) the Directory tab again before that first pass's
Firestore round-trips completed started a second, fully independent
scan that had no way to see the first scan's in-flight writes — both
then wrote their own directory entry for the same booking/enquiry.
Fixed in `directory-ui.js` by caching the in-flight *promise*
(`directoryBackfillPromise`) instead of a completion boolean, so every
concurrent caller of `ensureDirectoryBackfilled()` awaits the exact same
underlying run rather than each starting its own; the backfill loop also
now updates its `alreadyLogged` Set immediately after each write (not
only once, up front, from pre-existing entries) as defense in depth
against the same `sourceId` being processed twice within a single run
for any other reason. Verified with a dedicated test firing 5 concurrent
`renderDirectoryList()` calls via `Promise.all()` against one
pre-existing (un-backfilled) enquiry — confirmed exactly 1 directory
entry results, where the old code could produce up to 5. The duplicate
data already written to production by the old code (banquet-74423 only)
was cleaned up with a one-off script that GETs each affected
`banquet:directory:YYYY-MM` document, dedupes its entries by
`sourceId`/`id`, and PATCHes back only the `value` field.

## Booking modal's bottom Save button closes the form; other saves don't

`saveBooking()` (`bookings-ui.js`) is shared by three different UI
triggers, and only one of them should close `modal-booking`:

- **`bk-save-btn`** — the actual Save button at the very bottom of the
  form, below Advances/Menu/Final Settlement. This is the "I'm done"
  action, so it should close the form on success, same as the (much
  shorter) enquiry modal already did — `saveEnquiry()` has always closed
  `modal-enquiry` unconditionally on success since it has exactly one
  caller.
- **`addPaymentToDraft()`'s "Confirm"** on an advance — deliberately
  calls `saveBooking()` too (see its own comment: confirming an advance
  persists the whole booking on its own, no separate tap on the main
  Save needed), but the owner/staff member is very likely about to keep
  editing the same booking (record another advance, open the menu
  editor, etc.) — closing here would kick them out mid-edit.
- **the menu editor's "Done" button** — closes `modal-menu` and calls
  `saveBooking()` to persist the menu, but leaves `modal-booking` (which
  was underneath the whole time) open for the same reason.

Since `saveBooking()` itself is the shared save/validate logic, closing
the modal can't live inside it without wrongly closing it for the other
two callers. Instead `saveBooking()` returns `true`/`false` (validation
failures — the settlement-guard and required-fields checks — return
`false`, success returns `true`), and only the dedicated
`handleBookingSaveClick()` wrapper (wired to `bk-save-btn`'s click, in
place of `saveBooking` directly) checks that return value and calls
`closeModal("modal-booking")`. `addPaymentToDraft()` and the menu
editor's "Done" handler still call `saveBooking()` directly and ignore
its return value, exactly as before. Verified with a Playwright script
that: clicks the bottom Save on a freshly reopened booking and confirms
`modal-booking` gets the `hidden` class; separately reopens the same
booking, confirms an advance, and confirms the modal is *still* visible
afterward.

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

## Per-venue `<title>`/favicon/Open Graph tags — a second predeploy step

`applyBranding()` (`core.js`) sets `document.title`/the favicon
client-side, at `DOMContentLoaded` — fine for an actual visitor, but
link-preview crawlers (WhatsApp, iMessage, Slack, etc.) fetch the raw
HTML and never run JavaScript. Every venue's shared PDFs/Share-via-
WhatsApp links were showing "Shree Krishna Palace — Banquet Manager" —
caught from a real WhatsApp share of a Ram Krishna Banquet/Saga link,
not proactively. `src/index.html`'s static `<title>`/favicon `<link>`
(and, until now, complete absence of Open Graph meta tags) is genuinely
shared/generic across every venue's deploy — there is still no per-venue
*source* fork.

Fixed with a second `predeploy` command, per hosting target, added
*after* `cp -R src public`: `node scripts/patch-html-meta.js <hostname>`
(`scripts/patch-html-meta.js`, new). It patches the just-copied
`public/index.html` only — never `src/index.html` — rewriting `<title>`,
the favicon `<link>`, and injecting `og:title`/`og:site_name`/
`og:description`/`og:image`/`og:url`/`og:type`. The venue's name/logo/
logoIcon are read directly out of `core.js`'s `SITE_CONFIGS` via the same
text-based brace-matching technique `onboard-venue.js` uses to *write*
entries (can't `require()`/eval core.js directly — it references browser
globals like `location`/`document` at its top level) — one source of
truth, no risk of a second copy drifting out of sync. Also resolves
`SITE_CONFIGS` **aliases** (e.g. `skpbanquet.web.app`, which has no
literal entry of its own — see "White-label multi-venue support" above —
just `SITE_CONFIGS["skpbanquet.web.app"] = SITE_CONFIGS["banquet-74423.web.app"]`)
by pattern-matching that assignment and resolving to whichever hostname
it points at.

`onboard-venue.js`'s `addFirebaseJsonHosting()` clones an existing
hosting-array entry as a template for a new venue and swaps its
`"target"` field — it now ALSO swaps the cloned predeploy step's hostname
argument to the new venue's own `host`, or a newly onboarded venue would
silently inherit the *template* venue's branding in its link previews
instead of its own (easy to miss since it's just a shell-command string
inside a JSON array, not a structured field with its own validation).

**Caught by testing, not assumed**: a first attempt at deploying this
appeared to work from the CLI's log (`+ Finished running predeploy
script.`) but the live site's HTML had no Open Graph tags at all — the
CLI log only ever echoed the *first* predeploy command's "Running
command:" line, never the second. Root cause turned out to be mundane:
an intermediate `git checkout -- firebase.json` (used to clean up an
unrelated dummy test venue) had reverted this fix's own still-uncommitted
`firebase.json` edits right along with it, since neither was committed
yet — `git checkout` reverts the whole file to its last commit,
indiscriminately. Re-applied and reverified directly against the live
HTML (`curl`), not just the deploy log, for all four hosting targets
before trusting it. **Lesson: when cleaning up test/scratch changes to a
file via `git checkout`, check first whether that same file also holds
real, wanted, not-yet-committed edits — `git checkout` can't distinguish
between the two, it reverts everything uncommitted in that file.**

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