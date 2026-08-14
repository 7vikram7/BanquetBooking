# Banquet Manager

A web app for managing bookings and enquiries at a 2-hall banqueting
facility, each hall with Lunch and Dinner slots (4 bookable units per day).

No build step, no framework — plain HTML/CSS/JS, deployed as static files
via Firebase Hosting, with Firebase Firestore as the only backend. See
[CONTEXT.md](CONTEXT.md) for the data model and design decisions.

## Features

- **Dashboard** — today's 4 slots at a glance, upcoming bookings (7 days), open enquiries.
- **Calendar** — month grid, each day shows both halls x both slots color-coded (available / enquiry / tentative / confirmed). Click a cell to view/create.
- **Enquiries** — track leads before they're confirmed: status (new / follow-up / converted / lost), follow-up date, convert straight into a booking.
- **Bookings** — confirmed/tentative bookings with guest count, total amount, and a running payments list (advance + subsequent payments) with auto-computed balance due.
- **Settings** (owner only) — rename halls, set/change owner & staff passwords, Firebase connection status.
- **Roles** — owner password unlocks everything including Settings; staff password unlocks day-to-day booking/enquiry entry only.

## Quick start (local, no Firebase needed)

The app runs fully on `localStorage` until you connect a Firebase project —
nothing below is required just to try it out.

```
cd src
# open index.html directly in a browser, or serve it:
npx serve .
```

First launch prompts you to set an **owner password** (this is stored only
as a SHA-256 hash — see Security in CONTEXT.md). Everything you enter is
saved to your browser's localStorage.

## Connecting Firebase (to sync across devices/staff)

1. Create a Firebase project at https://console.firebase.google.com, enable **Firestore Database** (production mode is fine — rules are set explicitly, see `firestore.rules`).
2. In the Firebase console, add a **Web app** and copy the config object.
3. Paste those values into `FIREBASE_CONFIG` at the top of [src/js/core.js](src/js/core.js).
4. Update `.firebaserc` with your project ID (or run `firebase use --add`).
5. Deploy Firestore rules: `firebase deploy --only firestore:rules`.

From then on, every write saves to localStorage first (instant, always
works) and best-effort syncs to Firestore. If a write can't reach
Firestore, you'll see a small banner at the top — nothing blocks on it.

## Deploying

```
firebase login
firebase deploy
```

`predeploy` mirrors `src/` into an isolated `public/` folder that Hosting
actually serves (see `firebase.json`) — this keeps anything else in the
project directory from accidentally going live.

**Windows note**: the predeploy command uses `rm`/`cp`, which cmd.exe
doesn't have. Prepend Git's Unix tools to your session's PATH first:

```powershell
$env:PATH = "C:\Program Files\Git\usr\bin;" + $env:PATH
firebase deploy
```

## Project structure

```
src/
  index.html          tab shell, modal markup, <script> tags (load order matters)
  styles.css           all styles
  js/
    core.js             config, constants, date/money utils, Firebase init
    data-store.js        localStorage+Firestore dual-write, month-bucketed stores
    auth.js               owner/staff password gate (session-scoped)
    dashboard-ui.js         today snapshot, upcoming, open enquiries
    calendar-ui.js            month grid + shared "slot detail" modal
    enquiries-ui.js             enquiry list + add/edit + convert-to-booking
    bookings-ui.js                booking list + add/edit + payments
    settings-ui.js                 hall names, passwords, sync status
    init.js                         bootstrap — MUST load last
firebase.json         Hosting + predeploy config
firestore.rules        Firestore security rules (open — see CONTEXT.md)
.firebaserc            Firebase project alias
```

## Known limitations (see CONTEXT.md for why)

- One booking per hall/slot/date (no double-booking support).
- No email/SMS notifications for follow-ups — the dashboard just lists them.
- Security is a soft, client-side password gate, not real access control.
