// directory-ui.js — owner-only permanent customer contact log. Reads only
// from DirectoryStore (see data-store.js) — this tab has no delete/edit
// capability at all, by design; the whole point is a record that survives
// Settings > Data Deletion clearing out bookings/enquiries in the same
// date range.

function initDirectoryTab() {
  const fromInput = document.getElementById("dir-filter-from");
  const toInput = document.getElementById("dir-filter-to");

  // Same "current month by default, but fully visible/adjustable" pattern
  // as Accounts — see accounts-ui.js's initAccountsTab().
  const today = new Date();
  fromInput.value = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  toInput.value = isoDate(today);

  fromInput.addEventListener("change", renderDirectoryList);
  toInput.addEventListener("change", renderDirectoryList);
  document.getElementById("dir-download-excel-btn").addEventListener("click", generateDirectoryExcel);
}

// Unlike Accounts' date range (which caps "To" at today, since a sale
// can't be in the future), the Directory legitimately wants to show
// enquiries logged FOR a future event date — so no upper cap here.
function directoryDateRange() {
  const fromVal = document.getElementById("dir-filter-from").value;
  const toVal = document.getElementById("dir-filter-to").value;
  const today = new Date();
  const defaultFromIso = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  return { from: fromVal || defaultFromIso, to: toVal || isoDate(today) };
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
