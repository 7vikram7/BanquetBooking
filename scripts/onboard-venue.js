#!/usr/bin/env node
/**
 * Onboard a new white-labeled venue onto this shared codebase.
 *
 * This automates ONLY the repo-side steps — see the printed checklist (or
 * run with --help) for the manual, account-bound steps that must happen
 * first, in the new venue's own Google/Firebase account, before this script
 * has anything to work with. Full background: CONTEXT.md's "White-label
 * multi-venue support" section.
 *
 * Usage:
 *   node scripts/onboard-venue.js --excel path\to\your-filled-copy.xlsx
 *     Preferred, repeatable path — reads every "Pending" row on the "New
 *     Venues" sheet (see templates/venue-onboarding-template.xlsx), onboards
 *     each, then flips its Status to "Onboarded" and saves the file back in
 *     place. Already-onboarded/EXAMPLE rows are skipped, so the same
 *     spreadsheet can keep growing and be handed back run after run.
 *
 *   node scripts/onboard-venue.js \
 *     --host <hosting-hostname, e.g. myvenue.web.app> \
 *     --name "Display Name" \
 *     --target <short hosting target id, e.g. myvenue> \
 *     --apiKey <...> --authDomain <...> --projectId <...> \
 *     --storageBucket <...> --messagingSenderId <...> --appId <...> \
 *     [--logo path/to/logo-source.jpeg]
 *     One-off path for a single venue without going through Excel.
 *
 * What it does, in order:
 *   1. Appends an entry to SITE_CONFIGS in src/js/core.js
 *   2. Adds a hosting target to .firebaserc (targets.<projectId>.hosting.<target>)
 *   3. Adds a matching hosting block to firebase.json
 *   4. If --logo is given: chroma-keys a solid-black background to
 *      transparent and trims it, writing src/assets/logo-<target>.png
 *      (full lockup) and src/assets/logo-<target>-icon.png (top ~46% crop).
 *      Skip --logo and wire up real files later if the source doesn't have
 *      a plain black background — this heuristic only suits that case.
 *   5. Prints the exact first-deploy command using the service-account /
 *      isolated-HOME pattern (see CONTEXT.md) so the new venue's Firebase
 *      account is never mixed into this machine's interactive CLI login.
 *
 * All three repo-file edits are done as surgical text insertions (not
 * parse+re-serialize), so existing formatting is left untouched and diffs
 * stay minimal. Deliberately idempotent: re-running with the same
 * --host/--target is safe and just reports "already present".
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CORE_JS = path.join(ROOT, "src", "js", "core.js");
const FIREBASERC = path.join(ROOT, ".firebaserc");
const FIREBASE_JSON = path.join(ROOT, "firebase.json");
const ASSETS_DIR = path.join(ROOT, "src", "assets");
const TEMPLATE_XLSX = path.join(ROOT, "templates", "venue-onboarding-template.xlsx");
// Must match FIRESTORE_COLLECTION in src/js/core.js — every venue's data
// lives under this same collection name in its own separate database.
const FIRESTORE_COLLECTION_HINT = "banquet_kv";

const REQUIRED = [
  "host", "name", "target", "apiKey", "authDomain", "projectId",
  "storageBucket", "messagingSenderId", "appId",
];

// Must match the header text written by generate-onboarding-template.js.
const HEADER_MAP = {
  "Status": "status",
  "Hosting URL (host)": "host",
  "Display Name (name)": "name",
  "Hosting Target (target)": "target",
  "apiKey": "apiKey",
  "authDomain": "authDomain",
  "projectId": "projectId",
  "storageBucket": "storageBucket",
  "messagingSenderId": "messagingSenderId",
  "appId": "appId",
  "Logo source file path (optional)": "logoPath",
  "Service account key path (optional)": "serviceAccountPath",
  "Notes": "notes",
};

function defaultServiceAccountPath(projectId) {
  return `C:\\Users\\${os.userInfo().username}\\.banquet-credentials\\${projectId}-service-account.json`;
}

// A brand-new Firebase project's DEFAULT Hosting site is always named
// exactly <projectId>, giving <projectId>.web.app — that's fixed/immutable.
// If the requested `host` is anything else, it can only be served by
// creating a SEPARATE ("secondary") Hosting site with a matching name first
// (same technique already used for skpbanquet.web.app on banquet-74423) —
// this function only computes what that site id needs to be; it does NOT
// create it. Caught in production once already (Ram Krishna Banquet): the
// target silently bound to the default site, deploying to the wrong URL.
function deriveSiteId(host, projectId) {
  if (host && host.endsWith(".web.app")) return host.slice(0, -".web.app".length);
  return projectId;
}

function printHelp() {
  console.log(`
Onboard a new white-labeled venue.

MANUAL STEPS FIRST (in the new venue's own Google account — cannot be
automated here, see CONTEXT.md for why each one is required):
  1. Sign in to https://console.firebase.google.com as the venue's own
     Google account and create a new Firebase project.
  2. In that project: Build > Firestore Database > Create database
     (Native mode). Pick a region now — this can't be changed later.
  3. Project settings > General > Add app > Web app. Copy the resulting
     firebaseConfig object (apiKey/authDomain/projectId/storageBucket/
     messagingSenderId/appId) — you'll pass these as flags below.
  4. IAM & Admin > Service Accounts > create a key (JSON), and grant that
     service account the "Owner" role on the project (Editor/Firebase
     Admin are NOT sufficient — see CONTEXT.md's IAM ladder notes). Save
     the JSON file OUTSIDE this repo, e.g.
     C:\\Users\\<you>\\.banquet-credentials\\<projectId>-service-account.json
     (the repo's .gitignore also blocks *-service-account*.json as a
     backstop, but keep it out of the repo tree entirely).

THEN run this script — two ways to feed it:

  A) Excel (preferred for repeat use): fill in a row on the "New Venues"
     sheet of templates/venue-onboarding-template.xlsx (see its own
     "Firebase Setup Steps" and "Column Guide" sheets for the same steps
     above, spelled out in more detail), then:
       node scripts/onboard-venue.js --excel path\\to\\your-copy.xlsx
     Every row with Status left as "Pending" gets onboarded; the script
     flips each to "Onboarded" and saves the file back in place, so the
     same growing spreadsheet can be handed back again next time — already-
     onboarded rows are skipped automatically.

  B) Flags, for a single one-off venue:
     node scripts/onboard-venue.js --host <...> --name "<...>" --target <...> \\
       --apiKey <...> --authDomain <...> --projectId <...> \\
       --storageBucket <...> --messagingSenderId <...> --appId <...> \\
       [--logo path\\to\\logo-source.jpeg]

THEN (also manual, printed again at the end of a successful run):
  5. Review the diff (git diff) and commit.
  6. Run the printed first-deploy command.
  7. If the real-Auth security migration is ever revisited for this venue,
     add its owner@/staff@<authDomain> addresses to firestore.rules before
     ever deploying firestore:rules to its project — don't deploy that
     file's current contents as-is to a new project.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      args[key] = val;
      i++;
    }
  }
  return args;
}

function readFile(p) { return fs.readFileSync(p, "utf8"); }
function writeFile(p, content) { fs.writeFileSync(p, content, "utf8"); }

/** Index of the bracket matching the one at openIdx (openCh/closeCh e.g.
 * '{'/'}' or '['/']'). Simple depth counter — fine for these files since
 * values are plain strings with no embedded brackets. */
function findMatchingBracket(text, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Could not find matching "${closeCh}" for "${openCh}" at index ${openIdx}`);
}

/** Splice insertText in right after the last child's closing bracket/brace,
 * i.e. just before the trailing whitespace that leads up to the container's
 * own closing bracket at closeIdx. Preserves the container's existing
 * indentation/formatting exactly. */
function insertBeforeClose(text, closeIdx, insertText) {
  const before = text.slice(0, closeIdx);
  const after = text.slice(closeIdx);
  const m = before.match(/([}\]])(\s*)$/);
  if (!m) throw new Error("Could not find insertion point (container appears empty) — edit the file by hand for this case");
  const spliceAt = before.length - m[0].length + 1;
  return before.slice(0, spliceAt) + insertText + before.slice(spliceAt) + after;
}

function addSiteConfig(opts) {
  const src = readFile(CORE_JS);
  const marker = "const SITE_CONFIGS = {";
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error("Couldn't find `const SITE_CONFIGS = {` in core.js");
  const openBraceIdx = startIdx + marker.length - 1;
  const closeBraceIdx = findMatchingBracket(src, openBraceIdx, "{", "}");

  const hostKeyLiteral = JSON.stringify(opts.host);
  if (src.slice(startIdx, closeBraceIdx).includes(hostKeyLiteral)) {
    console.log(`[core.js] SITE_CONFIGS already has an entry for ${opts.host} — skipping.`);
    return false;
  }

  const logo = `assets/logo-${opts.target}.png`;
  const logoIcon = `assets/logo-${opts.target}-icon.png`;

  const entry = `  ${hostKeyLiteral}: {
    name: ${JSON.stringify(opts.name)},
    logo: ${JSON.stringify(logo)},
    logoIcon: ${JSON.stringify(logoIcon)},
    firebase: {
      apiKey: ${JSON.stringify(opts.apiKey)},
      authDomain: ${JSON.stringify(opts.authDomain)},
      projectId: ${JSON.stringify(opts.projectId)},
      storageBucket: ${JSON.stringify(opts.storageBucket)},
      messagingSenderId: ${JSON.stringify(opts.messagingSenderId)},
      appId: ${JSON.stringify(opts.appId)},
    },
  },
`;

  // Direct splice (not insertBeforeClose): each entry already ends in its own
  // trailing comma (valid/idiomatic in a JS object literal, unlike the two
  // JSON files below), so `before` already ends exactly where it should.
  const updated = src.slice(0, closeBraceIdx) + entry + src.slice(closeBraceIdx);
  writeFile(CORE_JS, updated);
  console.log(`[core.js] Added SITE_CONFIGS["${opts.host}"].`);
  return true;
}

function addFirebasercTarget(opts) {
  const src = readFile(FIREBASERC);
  const marker = '"targets": {';
  const markerIdx = src.indexOf(marker);
  if (markerIdx === -1) throw new Error('Could not find "targets": { in .firebaserc');
  const targetsOpenIdx = markerIdx + marker.length - 1;
  const targetsCloseIdx = findMatchingBracket(src, targetsOpenIdx, "{", "}");
  const targetsBlock = src.slice(targetsOpenIdx, targetsCloseIdx + 1);

  const siteId = deriveSiteId(opts.host, opts.projectId);
  if (siteId !== opts.projectId) {
    console.log(`[.firebaserc] host "${opts.host}" needs its own Hosting site (not the project's default). Before deploying, run:\n    firebase hosting:sites:create ${siteId} --project ${opts.projectId}\n  (with the same credentials/env overrides as the deploy command below).`);
  }

  const projectKeyLiteral = `${JSON.stringify(opts.projectId)}: {`;
  const projectKeyIdx = targetsBlock.indexOf(projectKeyLiteral);

  if (projectKeyIdx === -1) {
    // Brand new project: add a whole new "<projectId>": { "hosting": {...} } entry.
    const insertText = `,\n    ${JSON.stringify(opts.projectId)}: {\n      "hosting": {\n        ${JSON.stringify(opts.target)}: [\n          ${JSON.stringify(siteId)}\n        ]\n      }\n    }`;
    const updated = insertBeforeClose(src, targetsCloseIdx, insertText);
    writeFile(FIREBASERC, updated);
    console.log(`[.firebaserc] Added new project "${opts.projectId}" with hosting target "${opts.target}" -> site "${siteId}".`);
    return true;
  }

  // Project already has targets (e.g. reusing an existing project like
  // skpbanquet does for banquet-74423) — insert into its "hosting" object.
  const projOpenBraceAbsIdx = targetsOpenIdx + projectKeyIdx + projectKeyLiteral.length - 1;
  const projCloseBraceAbsIdx = findMatchingBracket(src, projOpenBraceAbsIdx, "{", "}");
  const projBlock = src.slice(projOpenBraceAbsIdx, projCloseBraceAbsIdx + 1);

  if (projBlock.includes(`${JSON.stringify(opts.target)}: [`)) {
    console.log(`[.firebaserc] Target "${opts.target}" already exists for project ${opts.projectId} — skipping.`);
    return false;
  }

  const hostingMarkerIdx = projBlock.indexOf('"hosting": {');
  if (hostingMarkerIdx === -1) throw new Error(`Project "${opts.projectId}" block in .firebaserc has no "hosting" key — edit by hand`);
  const hostingOpenAbsIdx = projOpenBraceAbsIdx + hostingMarkerIdx + '"hosting": {'.length - 1;
  const hostingCloseAbsIdx = findMatchingBracket(src, hostingOpenAbsIdx, "{", "}");

  const insertText = `,\n        ${JSON.stringify(opts.target)}: [\n          ${JSON.stringify(siteId)}\n        ]`;
  const updated = insertBeforeClose(src, hostingCloseAbsIdx, insertText);
  writeFile(FIREBASERC, updated);
  console.log(`[.firebaserc] Added hosting target "${opts.target}" to existing project "${opts.projectId}" -> site "${siteId}".`);
  return true;
}

function addFirebaseJsonHosting(opts) {
  const src = readFile(FIREBASE_JSON);
  const marker = '"hosting": [';
  const markerIdx = src.indexOf(marker);
  if (markerIdx === -1) throw new Error('Could not find "hosting": [ in firebase.json');
  const arrOpenIdx = markerIdx + marker.length - 1;
  const arrCloseIdx = findMatchingBracket(src, arrOpenIdx, "[", "]");
  const arrInner = src.slice(arrOpenIdx + 1, arrCloseIdx);

  if (arrInner.includes(`"target": ${JSON.stringify(opts.target)}`)) {
    console.log(`[firebase.json] hosting target "${opts.target}" already present — skipping.`);
    return false;
  }

  // Clone the first entry's exact formatting as a template, swapping only "target".
  const firstBraceRel = arrInner.indexOf("{");
  const firstCloseRel = findMatchingBracket(arrInner, firstBraceRel, "{", "}");
  const templateEntry = arrInner.slice(firstBraceRel, firstCloseRel + 1);
  const newEntry = templateEntry.replace(/"target":\s*"[^"]+"/, `"target": ${JSON.stringify(opts.target)}`);

  const insertText = `,\n    ${newEntry}`;
  const updated = insertBeforeClose(src, arrCloseIdx, insertText);
  writeFile(FIREBASE_JSON, updated);
  console.log(`[firebase.json] Added hosting entry for target "${opts.target}".`);
  return true;
}

async function processLogo(opts) {
  if (!opts.logo) return;
  if (!fs.existsSync(opts.logo)) {
    console.warn(`[logo] --logo path "${opts.logo}" does not exist — skipping logo processing.`);
    return;
  }

  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    console.warn(
      `[logo] The "sharp" package isn't installed, so logo processing was skipped.\n` +
      `       Run "npm install" in ${ROOT} first (sharp is a devDependency), then re-run\n` +
      `       with the same --logo flag, or process it by hand into:\n` +
      `         src/assets/logo-${opts.target}.png\n` +
      `         src/assets/logo-${opts.target}-icon.png`
    );
    return;
  }

  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const img = sharp(opts.logo).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < 25 && g < 25 && b < 25) data[i + 3] = 0; // treat near-black as transparent
  }
  const chromaKeyed = sharp(data, { raw: { width, height, channels } }).png();
  const trimmedBuffer = await chromaKeyed.trim().toBuffer();
  const fullMeta = await sharp(trimmedBuffer).metadata();

  const fullOut = path.join(ASSETS_DIR, `logo-${opts.target}.png`);
  await sharp(trimmedBuffer).toFile(fullOut);
  console.log(`[logo] Wrote ${fullOut} (${fullMeta.width}x${fullMeta.height}).`);

  const iconFraction = opts.logoIconFraction ? parseFloat(opts.logoIconFraction) : 0.46;
  const iconRegion = { left: 0, top: 0, width: fullMeta.width, height: Math.round(fullMeta.height * iconFraction) };
  const iconCropped = await sharp(trimmedBuffer).extract(iconRegion).trim().toBuffer();
  const iconMeta = await sharp(iconCropped).metadata();
  const iconOut = path.join(ASSETS_DIR, `logo-${opts.target}-icon.png`);
  await sharp(iconCropped).toFile(iconOut);
  console.log(`[logo] Wrote ${iconOut} (${iconMeta.width}x${iconMeta.height}).`);
  console.log(`[logo] Check both files render cleanly — the black-background chroma-key heuristic doesn't suit every source image.`);
}

function printDeployInstructions(opts) {
  const isolatedHome = `C:\\\\Temp\\\\isolated-home-${opts.target}`;
  const keyPath = opts.serviceAccountPath || defaultServiceAccountPath(opts.projectId);
  const siteId = deriveSiteId(opts.host, opts.projectId);
  const needsSiteCreate = siteId !== opts.projectId;
  const envPrefix = `USERPROFILE="${isolatedHome}" HOME=/tmp/isolated-home-${opts.target} \\\n     GOOGLE_APPLICATION_CREDENTIALS="${keyPath}"`;

  const steps = [
    `Review the diff:            git diff`,
    `Commit it:                  git add -A && git commit -m "Onboard ${opts.name} as a new venue"`,
  ];
  if (needsSiteCreate) {
    steps.push(`host "${opts.host}" isn't the project's default site (that would be\n     ${opts.projectId}.web.app) — create the secondary site "${siteId}" FIRST,\n     once, before the first deploy:\n\n     ${envPrefix} \\\n     firebase hosting:sites:create ${siteId} --project ${opts.projectId}`);
  }
  steps.push(`First deploy for this venue, using its own service account (never the\n     interactively-logged-in personal account — see CONTEXT.md):\n\n     ${envPrefix} \\\n     firebase deploy --only hosting:${opts.target} --project ${opts.projectId}`);
  // A brand-new Firestore database created in "production mode" (the setup
  // checklist's own instruction) defaults to deny-all — the app silently
  // falls back to local-only storage against that, with no visible error,
  // until rules are explicitly opened. Learned the hard way onboarding Ram
  // Krishna Banquet: this is not optional/deferrable like the old wording
  // here used to imply, it's required for the app to work at all. Uses
  // `-Encoding ascii` (not utf8) deliberately — PowerShell's utf8 writes a
  // BOM that the Firestore rules compiler rejects with a cryptic
  // "token recognition error at: '\ufeff'".
  steps.push(`Open this venue's Firestore rules — REQUIRED, not optional: a fresh\n     database defaults to deny-all, so skipping this leaves the app silently\n     falling back to local-only storage with no visible error. Run in\n     PowerShell (bash/env-var version needs the same rules content, just\n     via the isolated-HOME pattern above instead):\n\n     cd ${ROOT}\n     Copy-Item firestore.rules firestore.rules.bak\n     @'\nrules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /${FIRESTORE_COLLECTION_HINT}/{docId} {\n      allow read, write: if true;\n    }\n  }\n}\n'@ | Set-Content -Encoding ascii firestore.rules\n     $env:USERPROFILE = '${isolatedHome.replace(/\\\\/g, "\\")}'\n     $env:HOME = '${isolatedHome.replace(/\\\\/g, "\\")}'\n     $env:GOOGLE_APPLICATION_CREDENTIALS = '${keyPath}'\n     firebase.cmd deploy --only firestore:rules --project ${opts.projectId}\n     Move-Item -Force firestore.rules.bak firestore.rules\n\n     Verify without touching the app: curl should return 200 (empty {} is\n     fine, 403 means still locked):\n     curl https://firestore.googleapis.com/v1/projects/${opts.projectId}/databases/(default)/documents/${FIRESTORE_COLLECTION_HINT}`);
  steps.push(`Visit https://${opts.host} and confirm branding + a live save/read\n     round-trip against the new database.`);

  const numbered = steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  console.log(`\nNext steps for "${opts.name}" (${opts.host}):\n${numbered}\n`);
}

async function runExcelMode(excelPath) {
  if (!fs.existsSync(excelPath)) throw new Error(`Excel file not found: ${excelPath}`);

  let ExcelJS;
  try {
    ExcelJS = require("exceljs");
  } catch (e) {
    throw new Error(`The "exceljs" package isn't installed. Run "npm install" in ${ROOT} first (it's a devDependency), then re-run.`);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.getWorksheet("New Venues");
  if (!ws) throw new Error(`No "New Venues" sheet found in ${excelPath}. Compare against ${TEMPLATE_XLSX}.`);

  // Header text -> column number. Not relying on ExcelJS's `.key` mapping,
  // since column keys are a write-time-only convenience and aren't
  // reconstructed when re-reading an existing file from disk.
  const colForKey = {};
  ws.getRow(1).eachCell((cell, colNumber) => {
    const key = HEADER_MAP[String(cell.value || "").trim()];
    if (key) colForKey[key] = colNumber;
  });
  const missingCols = REQUIRED.filter((k) => !colForKey[k]);
  if (missingCols.length || !colForKey.status) {
    throw new Error(`"New Venues" sheet is missing expected column(s): ${[...missingCols, ...(colForKey.status ? [] : ["status"])].join(", ")}. Compare header row against ${TEMPLATE_XLSX}.`);
  }

  function cellText(row, key) {
    const colNum = colForKey[key];
    if (!colNum) return undefined;
    const v = row.getCell(colNum).value;
    if (v == null || v === "") return undefined;
    if (typeof v === "object" && "text" in v) return String(v.text).trim(); // rich text / hyperlink cells
    return String(v).trim();
  }

  const processed = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const statusCell = row.getCell(colForKey.status);
    const status = String(statusCell.value || "").trim().toLowerCase();
    if (status === "example" || status === "onboarded") continue;

    const opts = {};
    REQUIRED.forEach((k) => { opts[k] = cellText(row, k); });
    opts.logo = cellText(row, "logoPath");
    opts.serviceAccountPath = cellText(row, "serviceAccountPath");

    const missing = REQUIRED.filter((k) => !opts[k]);
    if (missing.length) {
      if (missing.length < REQUIRED.length) {
        console.warn(`[excel] Row ${r}: skipping — missing ${missing.join(", ")}.`);
      }
      continue;
    }

    console.log(`\n--- Row ${r}: "${opts.name}" (${opts.host}) -> ${opts.projectId} ---`);
    addSiteConfig(opts);
    addFirebasercTarget(opts);
    addFirebaseJsonHosting(opts);
    await processLogo(opts);

    statusCell.value = "Onboarded";
    processed.push(opts);
  }

  if (!processed.length) {
    console.log('\nNo pending rows found (everything is already "Onboarded", "EXAMPLE", or incomplete).');
    return;
  }

  await wb.xlsx.writeFile(excelPath);
  console.log(`\nMarked ${processed.length} row(s) "Onboarded" and saved ${excelPath}.`);
  processed.forEach(printDeployInstructions);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  if (args.excel) {
    await runExcelMode(args.excel);
    return;
  }

  const missing = REQUIRED.filter((k) => !args[k]);
  if (missing.length) {
    console.error(`Missing required flag(s): ${missing.map((m) => "--" + m).join(", ")}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  console.log(`Onboarding "${args.name}" (${args.host}) -> Firebase project "${args.projectId}"...\n`);

  addSiteConfig(args);
  addFirebasercTarget(args);
  addFirebaseJsonHosting(args);
  await processLogo(args);
  printDeployInstructions(args);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
