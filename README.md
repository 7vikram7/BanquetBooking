# Banquet Manager

A white-label web app for managing bookings and enquiries at banqueting
facilities — halls x daily slots (Lunch/Dinner), each date's slots
color-coded by status. **One shared codebase serves multiple, independently
branded venues**, each fully isolated in its own Firebase project (see
[White-label multi-venue support](#white-label-multi-venue-support)).

No build step, no framework — plain HTML/CSS/JS, deployed as static files
via Firebase Hosting, with Firebase Firestore as the only backend. See
[CONTEXT.md](CONTEXT.md) for the data model and design decisions in depth.

## Current venues

| Venue | Live URL | Firebase project |
|---|---|---|
| Shree Krishna Palace | https://banquet-74423.web.app, https://skpbanquet.web.app | `banquet-74423` |
| Saga Banquet | https://saga-banquet-enquiry.web.app | `saga-banquet-enquiry` |
| Ram Krishna Banquet | https://ramkrishnabanquet.web.app | `ramkrishna-banquet-manager` |

Each venue has its own Google account, its own Firebase project, and its
own Firestore database — no venue's data is ever readable from another's.
See [Onboarding a new venue](#onboarding-a-new-venue) to add one.

## Features

- **Calendar** — month grid, every hall x Lunch/Dinner slot color-coded
  (available / enquiry / confirmed / settled). Click a day for a full
  slot-by-slot breakdown, or click a slot directly to view/create.
- **Dashboard** (owner only) — today's slots at a glance, upcoming
  bookings, open enquiries, and a date-range sales/occupancy summary
  broken down by hall + slot and facility-wide.
- **Enquiries** — track leads before they're confirmed: status (new /
  follow-up / lost), follow-up date, prefills straight into a booking. A
  "Call" button beside the phone field opens the phone's dialer directly.
  Selecting "Other" as the event type reveals a text field to name it —
  that name is remembered as a normal selectable type from then on, in
  both the enquiry and booking forms.
- **Bookings** — guest count, computed pricing (per-plate cost x guests +
  hall rent + extra amount), a menu builder (12 fixed categories) with
  PDF export for the kitchen, advance payments with running balance,
  and a two-step **Final Settlement** flow (bill → confirm → collect,
  with an optional 5% GST) that locks the event from further staff edits
  once settled. A separate Event Summary PDF covers the financial recap.
  Every downloadable PDF has a matching "Share via WhatsApp" button
  (mobile browsers only — hands the PDF to the OS share sheet).
- **Accounts** (owner only) — a read-only sales ledger of past, settled
  events with a summary strip and per-event payment breakdown; supports
  Excel export.
- **Directory** (owner only) — a permanent log of every enquiry and
  booking ever made (name, phone, date, occasion), with its own date-range
  Excel export. Deliberately untouched by Settings' Data Deletion — it's
  the one thing that's never removable from the app.
- **Settings** (owner only) — add/rename halls, add/edit/remove named
  staff members (name, mobile number, password), change the owner
  password, Firebase connection status.
- **Roles** — owner logs in with just a password (or the word "admin" in
  the mobile-number field, if that's more discoverable); each staff
  member logs in with their own mobile number + password (owner-assigned
  in Settings), unlocking Calendar/booking/enquiry entry only (Dashboard,
  Accounts, Directory, Settings tabs stay hidden). Advances and
  settlements are auto-signed with whoever's actually logged in — no
  manual "who recorded this" entry anymore. Staff also loses all edit
  rights on a settled event.

## Quick start (local, no Firebase needed)

The app runs fully on `localStorage` until you connect a Firebase project —
nothing below is required just to try it out. Local dev always sees
Shree Krishna Palace's branding/config (see `DEFAULT_SITE_KEY` in
`src/js/core.js` — `location.hostname` is `localhost`, which isn't in the
per-venue lookup table).

```
cd src
# open index.html directly in a browser, or serve it:
npx serve .
```

First launch prompts you to set an **owner password** (this is stored only
as a SHA-256 hash — see Security in CONTEXT.md). Everything you enter is
saved to your browser's localStorage.

## Onboarding a new venue

```
node scripts/onboard-venue.js --help
```

This is the standard, repeatable path — see
[templates/venue-onboarding-template.xlsx](templates/venue-onboarding-template.xlsx)
for the full ordered checklist (its "Firebase Setup Steps" sheet) and the
"New Venues" sheet to fill in one row per venue. Broad shape:

1. **Manual, in the new venue's own Google account** (can't be automated
   from here): create the Firebase project, create the Firestore database,
   register a Web App and copy its config, create a service-account key
   scoped to that project and grant it **Owner**.
2. **Automated**: `node scripts/onboard-venue.js --excel <your filled copy>`
   — appends the `SITE_CONFIGS` entry in `core.js`, wires up the Hosting
   target in `.firebaserc`/`firebase.json`, optionally processes a supplied
   logo, and prints the exact first-deploy command.
3. **First deploy + required Firestore-rules step** — the printed
   instructions cover both; see CONTEXT.md for why the rules step is not
   optional (a fresh database denies all reads/writes by default).

`onboard-venue.js` is idempotent and edits are surgical text insertions
(not parse+re-serialize), so diffs stay minimal and existing formatting is
preserved.

## Deploying (an existing venue)

```
firebase deploy --only hosting:<target> --project <projectId>
```

Every venue, including Shree Krishna Palace, deploys via its own
service-account credentials passed via env vars — see CONTEXT.md's
"Deploy mechanics" for the exact isolated-`HOME` pattern and why it's
necessary on Windows. Shree Krishna Palace originally relied on whatever
Google account was interactively logged in via `firebase login`, but that
cached session expired once in practice (blocking a deploy until someone
re-ran `firebase login` by hand) — moved to a service account
(`banquet-74423-service-account.json`) for the same reason every other
venue already used one: it doesn't silently expire.

`predeploy` mirrors `src/` into an isolated `public/` folder that Hosting
actually serves (see `firebase.json`) — this keeps anything else in the
project directory (this doc, scripts, templates) from accidentally going
live. A second predeploy step (`scripts/patch-html-meta.js <hostname>`)
then rewrites that copy's `<title>`, favicon, and Open Graph tags to
match the venue actually being deployed — required because link-preview
crawlers (WhatsApp, etc.) never run the client-side branding JS, so
without this every venue's shared links showed Shree Krishna Palace's
name/logo. `onboard-venue.js` wires this up automatically for new venues.

**Windows note**: `predeploy` uses `rm`/`cp`, and `firebase` itself is a
PowerShell script (`firebase.ps1`) that the default execution policy
blocks. From PowerShell, use `firebase.cmd` instead of `firebase`; from
Git Bash, `rm`/`cp` are already on PATH.

## Project structure

```
src/
  index.html          tab shell, modal markup, <script> tags (load order matters)
  styles.css          all styles
  assets/             per-venue logos (logo.png, logo-saga.png, ...)
  js/
    core.js             SITE_CONFIGS (per-venue config/branding), constants,
                         date/money utils, Firebase init, applyBranding()
    data-store.js        localStorage+Firestore dual-write, month-bucketed stores
    auth.js               owner/staff password gate (session-scoped)
    dashboard-ui.js         today snapshot, upcoming, open enquiries, summary
    calendar-ui.js            month grid + shared "slot detail" modal
    enquiries-ui.js             enquiry list + add/edit + convert-to-booking
    bookings-ui.js                booking modal: pricing, menu/PDF, payments,
                                   settlement/GST, Event Summary PDF
    accounts-ui.js                 settled-events sales ledger + Excel export
    directory-ui.js                 permanent customer log + Excel export
    settings-ui.js                    halls, staff accounts, sync status
    init.js                            bootstrap — MUST load last
scripts/
  onboard-venue.js                 new-venue onboarding automation (see above)
  generate-onboarding-template.js  (re)generates the Excel template below
templates/
  venue-onboarding-template.xlsx   fill-in-and-hand-back onboarding checklist
functions/            Cloud Functions for the not-yet-deployed real-Auth
                       migration (see CONTEXT.md's Security section)
firebase.json          Hosting (per-venue targets) + predeploy config
firestore.rules        Draft locked-down rules (not deployed — see CONTEXT.md;
                        live rules are currently open, set directly per project)
.firebaserc             Firebase project + hosting target aliases, per venue
```

## Known limitations (see CONTEXT.md for why)

- Slots are fixed at Lunch/Dinner (halls are configurable via Settings,
  slots are not).
- No booking-uniqueness enforcement per slot (no double-booking support).
- No email/SMS notifications for follow-ups — the dashboard just lists them.
- All three venues' actual deployed Firestore rules are fully open
  (`allow read, write: if true`) — the real-Firebase-Auth security model
  in `firestore.rules`/`functions/` is built and tested but not deployed.
