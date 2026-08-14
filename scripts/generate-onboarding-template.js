#!/usr/bin/env node
/**
 * Generates the blank venue-onboarding Excel template at
 * templates/venue-onboarding-template.xlsx. Run this only when the
 * template's shape needs to change (new column, new instructions) — the
 * user's own working copy (with real rows filled in) is a separate file
 * they keep and hand back for onboard-venue.js --excel to process; this
 * script does not touch that working copy.
 */
const path = require("path");
const ExcelJS = require("exceljs");

const OUT = path.join(__dirname, "..", "templates", "venue-onboarding-template.xlsx");

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } };
const EXAMPLE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
const EXAMPLE_FONT = { italic: true, color: { argb: "FF666666" } };

const COLUMNS = [
  { header: "Status", key: "status", width: 14 },
  { header: "Hosting URL (host)", key: "host", width: 26 },
  { header: "Display Name (name)", key: "name", width: 22 },
  { header: "Hosting Target (target)", key: "target", width: 20 },
  { header: "apiKey", key: "apiKey", width: 34 },
  { header: "authDomain", key: "authDomain", width: 30 },
  { header: "projectId", key: "projectId", width: 22 },
  { header: "storageBucket", key: "storageBucket", width: 32 },
  { header: "messagingSenderId", key: "messagingSenderId", width: 20 },
  { header: "appId", key: "appId", width: 34 },
  { header: "Logo source file path (optional)", key: "logoPath", width: 34 },
  { header: "Service account key path (optional)", key: "serviceAccountPath", width: 40 },
  { header: "Calendar enquiry color (optional)", key: "enquiryColor", width: 30 },
  { header: "Notes", key: "notes", width: 30 },
];

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "onboard-venue.js";
  wb.created = new Date();

  buildNewVenuesSheet(wb);
  buildColumnGuideSheet(wb);
  buildFirebaseStepsSheet(wb);

  await wb.xlsx.writeFile(OUT);
  console.log("Wrote", OUT);
}

function buildNewVenuesSheet(wb) {
  const ws = wb.addWorksheet("New Venues", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.columns = COLUMNS;

  const header = ws.getRow(1);
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  header.height = 30;

  // Example row (real, public values — Firebase web config isn't secret,
  // it's shipped in the client bundle by design) so the format is obvious
  // at a glance. Status "EXAMPLE" rows are always skipped by the script.
  const example = ws.addRow({
    status: "EXAMPLE",
    host: "saga-banquet-enquiry.web.app",
    name: "Saga Banquet",
    target: "saga",
    apiKey: "AIzaSyDqDKzWY4no7nmd2PcWgWZYVZzfZNwZF3M",
    authDomain: "saga-banquet-enquiry.firebaseapp.com",
    projectId: "saga-banquet-enquiry",
    storageBucket: "saga-banquet-enquiry.firebasestorage.app",
    messagingSenderId: "571445664010",
    appId: "1:571445664010:web:eb2cdbff1d1a004957c2f3",
    logoPath: "C:\\banquet\\design-assets\\saga-logo-source.jpeg",
    serviceAccountPath: "",
    enquiryColor: "#e0629c",
    notes: "Real values from an already-onboarded venue, shown for format reference only.",
  });
  example.eachCell((cell) => { cell.fill = EXAMPLE_FILL; cell.font = EXAMPLE_FONT; });

  // A handful of blank rows ready to fill in, each with the Status dropdown.
  for (let i = 0; i < 20; i++) {
    const row = ws.addRow({ status: "Pending" });
    row.getCell("status").dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"Pending,Onboarded,EXAMPLE"'],
    };
  }
}

function buildColumnGuideSheet(wb) {
  const ws = wb.addWorksheet("Column Guide");
  ws.columns = [
    { header: "Column", key: "col", width: 34 },
    { header: "What goes here", key: "desc", width: 90 },
  ];
  ws.getRow(1).eachCell((c) => { c.fill = HEADER_FILL; c.font = HEADER_FONT; });

  const rows = [
    ["Status", "Leave as \"Pending\" for any new row. The script sets this to \"Onboarded\" automatically once it has processed the row — don't set it by hand, and don't reuse an \"Onboarded\" row for a different venue. Rows marked \"EXAMPLE\" are always skipped."],
    ["Hosting URL (host)", "The exact hostname the venue will be served on, e.g. myvenue.web.app. This is the lookup key in the app's SITE_CONFIGS — must match exactly what the browser's address bar will show."],
    ["Display Name (name)", "The venue's display name shown in the app's header, browser tab title, and login screen, e.g. \"My Venue Banquets\"."],
    ["Hosting Target (target)", "A short id for this venue, lowercase, no spaces (e.g. myvenue). Used internally by Firebase Hosting and as the logo filename suffix (logo-<target>.png)."],
    ["apiKey / authDomain / projectId / storageBucket / messagingSenderId / appId", "The six fields from the venue's own Firebase project's Web App config (see the \"Firebase Setup Steps\" sheet, step 4, for exactly where to copy these from). None of these are secret — they're shipped in the public client bundle by design — so it's fine to paste them as plain text here."],
    ["Logo source file path (optional)", "A local file path to the venue's logo image, if you have one ready now. Leave blank to skip — branding can be wired up later. Works best with a plain solid-black (or otherwise near-black) background, which gets keyed to transparent automatically."],
    ["Service account key path (optional)", "Local path to the JSON service-account key downloaded in Setup Step 8. If left blank, the standard convention is assumed: C:\\Users\\<you>\\.banquet-credentials\\<projectId>-service-account.json — so just save it there and you can leave this blank."],
    ["Calendar enquiry color (optional)", "A hex color (e.g. #e0629c) to give this venue's own calendar a different \"enquiry\" color from the shared default blue — purely cosmetic, restyles only the calendar grid/legend (not status pills or borders elsewhere). Leave blank to use the shared default."],
    ["Notes", "Anything else worth remembering about this venue — free text, not read by the script."],
  ];
  rows.forEach((r) => {
    const row = ws.addRow({ col: r[0], desc: r[1] });
    row.eachCell((c) => { c.alignment = { wrapText: true, vertical: "top" }; });
  });
}

function buildFirebaseStepsSheet(wb) {
  const ws = wb.addWorksheet("Firebase Setup Steps");
  ws.columns = [
    { header: "#", key: "n", width: 5 },
    { header: "Step", key: "step", width: 34 },
    { header: "What to do", key: "detail", width: 100 },
  ];
  ws.getRow(1).eachCell((c) => { c.fill = HEADER_FILL; c.font = HEADER_FONT; });

  const steps = [
    ["Sign in as the venue's own account",
      "Every venue gets its own Google account, kept fully separate from every other venue's — that's what makes the data segregation real. Sign in to https://console.firebase.google.com as that account (not your own personal one)."],
    ["Create the Firebase project",
      "Click \"Add project\", name it (e.g. \"My Venue Banquet\"), Analytics is optional (fine to disable), click Create. Wait for provisioning to finish. Note the exact project ID shown (auto-generated from the name, sometimes with a random suffix) — every later step must use THIS SAME project ID, see Step 6."],
    ["Create the Firestore database",
      "Left nav: Build > Firestore Database > Create database. Choose \"Start in production mode\". Pick a region NOW — this cannot be changed later without deleting and recreating the database. Click Enable."],
    ["Decide the hosting URL",
      "Default (simplest, zero extra setup): <projectId>.web.app — always available automatically. If you'd rather have a different/nicer subdomain (e.g. \"myvenue.web.app\" instead of \"myvenue-a8f21.web.app\"), that's fine and supported, but it requires creating a SECOND Hosting site inside this project — onboard-venue.js detects this from the \"Hosting URL (host)\" column and prints the exact one-time site-creation command as part of its next-steps output. Just be aware it's an extra step, not a bug, if your requested host doesn't match the project's default."],
    ["Register a Web App and copy its config",
      "Left nav: Project settings (gear icon) > General tab > scroll to \"Your apps\" > click the </> (Web) icon > give it a nickname > Register app. Firebase Hosting setup in this wizard can be skipped/ignored. Copy the six values shown in the firebaseConfig block (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) into the matching columns on the \"New Venues\" sheet."],
    ["Create a service account for deploys — SAME PROJECT ONLY",
      "Go to https://console.cloud.google.com/iam-admin/serviceaccounts and check the project selector at the top says the EXACT project ID from Step 2/4 — not a similarly-named one, not a leftover from a previous attempt. (Real incident: a service account was created in the wrong project once, its key silently couldn't deploy anything for the venue it was meant for, and it wasn't caught until the deploy failed. Firebase project IDs are immutable and can't be aliased, so a mismatch here has no easy fix later — just recreate the key in the right project.) Click \"Create Service Account\", name it e.g. \"deploy-bot\", click Create and Continue."],
    ["Grant it the Owner role",
      "On the \"Grant this service account access to project\" step, add the role \"Owner\". (Editor and \"Firebase Admin\" were both tried and proved insufficient for enabling APIs / creating the Firestore database in earlier onboarding — Owner is what actually works, scoped to just this one project.) Click Continue, then Done."],
    ["Download the JSON key",
      "Open the new service account > Keys tab > Add Key > Create new key > JSON > it downloads automatically. Move that file to C:\\Users\\<you>\\.banquet-credentials\\<projectId>-service-account.json (create the folder if needed) — NEVER inside the git repo. Only fill in the \"Service account key path\" column on the New Venues sheet if you saved it somewhere else. Sanity check before moving on: open the JSON and confirm its \"project_id\" field matches Step 2/4's project ID exactly."],
    ["Fill in the New Venues row and hand the file back",
      "Fill in Status=\"Pending\" and every column on one row of the \"New Venues\" sheet using what you collected above, save the file, and give it back (path or attachment) so the repo-side onboarding + first deploy can be run against it."],
    ["After the first deploy: open the Firestore rules — REQUIRED",
      "\"Production mode\" (Step 3) defaults to deny-all security rules. Without this step the app deploys fine and LOOKS like it's working, but every read/write silently fails and it falls back to local-only storage in the browser — no visible error, easy to miss. This isn't optional or something to \"decide on later\" — it's required for the app to function at all. onboard-venue.js's printed next-steps include the exact commands (PowerShell, using the service account from Steps 6-8) to open this and a curl command to verify it actually took effect before trusting the app."],
  ];
  steps.forEach((s, i) => {
    const row = ws.addRow({ n: i + 1, step: s[0], detail: s[1] });
    row.eachCell((c) => { c.alignment = { wrapText: true, vertical: "top" }; });
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
