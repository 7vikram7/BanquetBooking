// directory-ui.js — owner-only permanent customer contact log. Reads only
// from DirectoryStore (see data-store.js) — this tab has no delete/edit
// capability at all, by design; the whole point is a record that survives
// Settings > Data Deletion clearing out bookings/enquiries in the same
// date range.

// A directory entry's "date" is the EVENT date, not when it was logged —
// a brand-new enquiry is very often for an event months away, so
// defaulting this tab to "current month" (the pattern Accounts uses,
// where it's correct — a sale can't be in the future) hid almost every
// fresh entry by default. Real bug, not a hypothetical: verified directly
// against DirectoryStore that entries WERE being logged correctly; the
// tab just wasn't showing them. Wide fixed window instead — covers
// realistic advance-booking lead time (a banquet hall doesn't usually
// take bookings more than a couple years out) plus past history, without
// being literally unbounded.
const DIRECTORY_DEFAULT_YEARS_BACK = 2;
const DIRECTORY_DEFAULT_YEARS_FORWARD = 2;

function directoryDefaultRange() {
  const today = new Date();
  const from = isoDate(new Date(today.getFullYear() - DIRECTORY_DEFAULT_YEARS_BACK, today.getMonth(), today.getDate()));
  const to = isoDate(new Date(today.getFullYear() + DIRECTORY_DEFAULT_YEARS_FORWARD, today.getMonth(), today.getDate()));
  return { from, to };
}

function initDirectoryTab() {
  const fromInput = document.getElementById("dir-filter-from");
  const toInput = document.getElementById("dir-filter-to");

  const { from, to } = directoryDefaultRange();
  fromInput.value = from;
  toInput.value = to;

  fromInput.addEventListener("change", renderDirectoryList);
  toInput.addEventListener("change", renderDirectoryList);
  document.getElementById("dir-download-excel-btn").addEventListener("click", generateDirectoryExcel);
}

function directoryDateRange() {
  const fromVal = document.getElementById("dir-filter-from").value;
  const toVal = document.getElementById("dir-filter-to").value;
  const defaults = directoryDefaultRange();
  return { from: fromVal || defaults.from, to: toVal || defaults.to };
}

async function directoryEntriesInRange() {
  const { from, to } = directoryDateRange();
  const entries = await DirectoryStore.getRange(from, to);
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.loggedAt || "").localeCompare(b.loggedAt || ""));
  return entries;
}

async function renderDirectoryList() {
  const container = document.getElementById("directory-list");
  const entries = await directoryEntriesInRange();

  if (!entries.length) {
    container.innerHTML = '<div class="simple-list-empty">No customer entries in this date range.</div>';
    return;
  }

  container.innerHTML = "";
  entries.forEach((entry, idx) => {
    const row = document.createElement("div");
    row.className = "acct-row";
    row.innerHTML = `
      <div class="acct-row-summary">
        <span>#${idx + 1} · ${escapeHtml(entry.customerName)}${entry.phone ? " · " + escapeHtml(entry.phone) : ""}</span>
        <span class="acct-row-money">${formatDateHuman(entry.date)} · ${escapeHtml(entry.eventType || "")} · ${escapeHtml(entry.source || "")}</span>
      </div>
    `;
    container.appendChild(row);
  });
}

// Same lazy-load-SheetJS-on-click pattern as generateAccountsExcel() in
// accounts-ui.js.
async function generateDirectoryExcel(ev) {
  const btn = ev?.currentTarget || document.getElementById("dir-download-excel-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    await loadXlsx();
    const { from, to } = directoryDateRange();
    const entries = await directoryEntriesInRange();

    if (!entries.length) {
      alert(`No customer entries between ${formatDateHuman(from)} and ${formatDateHuman(to)} to export.`);
      return;
    }

    const rows = entries.map((entry, idx) => ({
      "Sr No": idx + 1,
      "Name": entry.customerName,
      "Phone": entry.phone || "",
      "Date": entry.date,
      "Occasion": entry.eventType || "",
      "Source": entry.source || "",
    }));

    const worksheet = window.XLSX.utils.json_to_sheet(rows);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Directory");
    window.XLSX.writeFile(workbook, `Directory - ${from} to ${to}.xlsx`);
  } catch (err) {
    console.error("[directory-excel] failed to generate Excel file", err);
    alert("Could not generate the Excel file — check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
