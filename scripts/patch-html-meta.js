#!/usr/bin/env node
/**
 * Deploy-time patch: fixes the <title>, favicon, and Open Graph meta tags
 * in public/index.html to match the venue actually being deployed.
 *
 * Why this exists: applyBranding() (core.js) sets these client-side, at
 * DOMContentLoaded — which works fine for anyone who actually opens the
 * page in a browser, but link-preview crawlers (WhatsApp, iMessage,
 * Slack, etc.) fetch the raw HTML and never run JavaScript. They only
 * ever saw the one hardcoded src/index.html <title> ("Shree Krishna
 * Palace — Banquet Manager") and favicon, regardless of which venue's
 * link was actually shared — caught when a real WhatsApp share of a
 * Saga/Ram Krishna Banquet link showed Shree Krishna Palace's name.
 *
 * Runs as a SECOND predeploy step, after "rm -rf public && cp -R src
 * public" — patches the just-copied public/index.html, never src/
 * itself, so src/ stays the one genuinely shared template with no
 * per-venue fork (see CONTEXT.md's "White-label multi-venue support").
 *
 * Usage: node scripts/patch-html-meta.js <hostname>
 *   e.g. node scripts/patch-html-meta.js saga-banquet-enquiry.web.app
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CORE_JS = path.join(ROOT, "src", "js", "core.js");
const PUBLIC_HTML = path.join(ROOT, "public", "index.html");

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

// Text-based extraction (not require()/eval — core.js references browser
// globals like `location`/`document` at its top level, so it can't just
// be loaded in Node) — same technique onboard-venue.js uses to WRITE
// SITE_CONFIGS entries, used here in reverse to READ one back out.
function readSiteConfig(hostname) {
  const src = fs.readFileSync(CORE_JS, "utf8");
  const marker = "const SITE_CONFIGS = {";
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error("Couldn't find `const SITE_CONFIGS = {` in core.js");
  const openBraceIdx = startIdx + marker.length - 1;
  const closeBraceIdx = findMatchingBracket(src, openBraceIdx, "{", "}");
  const configsBlock = src.slice(openBraceIdx, closeBraceIdx + 1);

  const hostKeyLiteral = JSON.stringify(hostname);
  let entryKeyIdx = configsBlock.indexOf(`${hostKeyLiteral}: {`);
  if (entryKeyIdx === -1) {
    // Not a literal entry — might be an alias, e.g.
    // `SITE_CONFIGS["skpbanquet.web.app"] = SITE_CONFIGS["banquet-74423.web.app"];`
    // (a second Hosting target on the same project, sharing one config
    // object rather than duplicating it — see CONTEXT.md). Resolve to
    // whichever hostname it points at and look THAT one up instead.
    const aliasMatch = src.match(
      new RegExp(`SITE_CONFIGS\\[${hostKeyLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*=\\s*SITE_CONFIGS\\["([^"]+)"\\]`)
    );
    if (!aliasMatch) {
      throw new Error(`No SITE_CONFIGS entry (or alias) for "${hostname}" in core.js`);
    }
    return readSiteConfig(aliasMatch[1]);
  }
  const entryOpenIdx = entryKeyIdx + `${hostKeyLiteral}: {`.length - 1;
  const entryCloseIdx = findMatchingBracket(configsBlock, entryOpenIdx, "{", "}");
  const entryText = configsBlock.slice(entryOpenIdx, entryCloseIdx + 1);

  const field = (name) => {
    const m = entryText.match(new RegExp(`${name}:\\s*"([^"]*)"`));
    return m ? m[1] : null;
  };
  return { name: field("name"), logo: field("logo"), logoIcon: field("logoIcon") };
}

function escapeHtmlAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function main() {
  const hostname = process.argv[2];
  if (!hostname) {
    console.error("Usage: node scripts/patch-html-meta.js <hostname>");
    process.exit(1);
  }
  if (!fs.existsSync(PUBLIC_HTML)) {
    throw new Error(`${PUBLIC_HTML} doesn't exist — run the "cp -R src public" predeploy step first.`);
  }

  const site = readSiteConfig(hostname);
  const title = `${site.name} — Banquet Manager`;
  const url = `https://${hostname}/`;
  // og:image needs an absolute URL — logo (not logoIcon) is the full
  // lockup, more recognizable as a link-preview thumbnail than the small
  // cropped icon. Falls back to the icon if this venue has no full logo
  // asset yet (see SITE_CONFIGS comments for venues still degrading
  // gracefully with a missing logo file).
  const ogImage = `${url}${site.logo || site.logoIcon}`;

  let html = fs.readFileSync(PUBLIC_HTML, "utf8");

  html = html.replace(/<title>.*?<\/title>/, `<title>${escapeHtmlAttr(title)}</title>`);
  html = html.replace(
    /<link rel="icon" href="[^"]*" \/>/,
    `<link rel="icon" href="${escapeHtmlAttr(site.logoIcon)}" />`
  );

  const ogTags = [
    `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`,
    `<meta property="og:site_name" content="${escapeHtmlAttr(site.name)}" />`,
    `<meta property="og:description" content="${escapeHtmlAttr(site.name)} — banquet booking &amp; enquiry manager." />`,
    `<meta property="og:image" content="${escapeHtmlAttr(ogImage)}" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(url)}" />`,
    `<meta property="og:type" content="website" />`,
  ].join("\n");
  // Insert right after the favicon <link> — always present at this fixed
  // spot in src/index.html's <head>, a stable anchor to insert after.
  html = html.replace(
    /(<link rel="icon" href="[^"]*" \/>\n)/,
    `$1${ogTags}\n`
  );

  fs.writeFileSync(PUBLIC_HTML, html, "utf8");
  console.log(`[patch-html-meta] ${hostname} -> "${title}"`);
}

main();
