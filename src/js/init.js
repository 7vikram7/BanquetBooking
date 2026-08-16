// init.js — bootstrap. Must load last: everything else only declares
// functions, this is the only script with code that runs immediately.

let currentTab = "calendar";

// Directory and Summary deliberately excluded — both only load when their
// own Search button is pressed (initDirectoryTab()/initSummaryTab()), not
// on every tab switch or after every save elsewhere in the app, since both
// scan a much wider window of data than what's actually displayed.
const TAB_RENDERERS = {
  calendar: renderCalendar,
  dashboard: renderDashboard,
  accounts: renderAccountsList,
  settings: async () => { renderSettingsHalls(); renderSettingsStaff(); },
};

async function refreshCurrentTab() {
  const renderFn = TAB_RENDERERS[currentTab];
  if (renderFn) await renderFn();
}

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  refreshCurrentTab();
}

function refreshHallDependentUI() {
  const halls = window.appSettings.halls;
  populateSelect(document.getElementById("enq-hall"), halls);
  populateSelect(document.getElementById("bk-hall"), halls);
  refreshCurrentTab();
}

function wireModalCloseButtons() {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  // Click on overlay backdrop (not the box itself) also closes.
  document.querySelectorAll(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay && overlay.id !== "login-screen") {
        overlay.classList.add("hidden");
      }
    });
  });
}

function wireSyncStatusBanner() {
  const banner = document.getElementById("sync-status");
  window.addEventListener("banquet:syncstatus", (ev) => {
    if (ev.detail.ok) {
      banner.classList.add("hidden");
    } else {
      banner.textContent = ev.detail.message;
      banner.classList.remove("hidden");
    }
  });
}

async function onAuthSuccess() {
  window.appSettings = await getSettings();
  applyRoleVisibility();

  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("logout-btn").addEventListener("click", logout);

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  wireModalCloseButtons();
  wireSyncStatusBanner();

  initCalendarNav();
  initSummaryTab();
  initEnquiryModal();
  initBookingModal();
  initDashboardSummary();
  initAccountsTab();
  initDirectoryTab();
  initSettingsTab();

  switchTab("calendar");
}

document.addEventListener("DOMContentLoaded", async () => {
  applyBranding();
  await initFirebase();
  await initAuth(onAuthSuccess);
});
