// ---------- Wire up ----------
$('#addBtn').addEventListener('click', () => openModal(null));
$('#modalClose').addEventListener('click', closeModal);
$('#cancelBtn').addEventListener('click', closeModal);
$('#deleteBtn').addEventListener('click', deleteSub);
$('#subForm').addEventListener('submit', saveSub);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

$('#incAddBtn').addEventListener('click', () => openIncModal(null));
$('#incModalClose').addEventListener('click', closeIncModal);
$('#incCancelBtn').addEventListener('click', closeIncModal);
$('#incDeleteBtn').addEventListener('click', deleteIncome);
$('#incForm').addEventListener('submit', saveIncome);
incModal.addEventListener('click', (e) => { if (e.target === incModal) closeIncModal(); });

$('#refreshBtn').addEventListener('click', doRefresh);
$('#connectBtn').addEventListener('click', openSfModal);
$('#themeBtn').addEventListener('click', toggleTheme);
$('#sfDisconnect').addEventListener('click', doSfDisconnect);
$('#settingsBtn').addEventListener('click', () => openSettings().catch((e) => toast(e.message, 'error')));
$('#settingsClose').addEventListener('click', () => ($('#settingsModal').hidden = true));
$('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true; });
$('#profileForm').addEventListener('submit', saveProfile);
$('#acctAddBtn').addEventListener('click', addAccount);
// Spending filters
let fltTimer;
$('#fltSearch').addEventListener('input', () => { clearTimeout(fltTimer); fltTimer = setTimeout(() => { spendFilters.search = $('#fltSearch').value.trim(); applySpendFilters(); }, 250); });
$('#fltCategory').addEventListener('change', () => { spendFilters.category = $('#fltCategory').value; applySpendFilters(); });
$('#fltFrom').addEventListener('change', () => { spendFilters.from = $('#fltFrom').value; applySpendFilters(); });
$('#fltTo').addEventListener('change', () => { spendFilters.to = $('#fltTo').value; applySpendFilters(); });
$('#fltClear').addEventListener('click', () => {
  Object.keys(spendFilters).forEach((k) => delete spendFilters[k]);
  $('#fltSearch').value = ''; $('#fltCategory').value = ''; $('#fltFrom').value = ''; $('#fltTo').value = '';
  applySpendFilters();
});
// Drill modal
$('#drillClose').addEventListener('click', () => ($('#drillModal').hidden = true));
$('#drillModal').addEventListener('click', (e) => { if (e.target.id === 'drillModal') $('#drillModal').hidden = true; });
// Goals
$('#addGoalBtn').addEventListener('click', () => { $('#goalForm').hidden = !$('#goalForm').hidden; if (!$('#goalForm').hidden) $('#goalName').focus(); });
$('#goalCancel').addEventListener('click', () => ($('#goalForm').hidden = true));
$('#goalForm').addEventListener('submit', addGoal);
$('#setBudgetAddBtn').addEventListener('click', () => {
  const cat = $('#setBudgetCat').value.trim(), amt = Number($('#setBudgetAmt').value);
  if (!cat || !(amt > 0)) { toast('Enter a category and amount', 'error'); return; }
  saveBudgetValue(cat, amt).then(() => { $('#setBudgetCat').value = ''; $('#setBudgetAmt').value = ''; });
});
$('#onboardConnect').addEventListener('click', () => { hideOnboarding(); openSfModal(); });
$('#onboardImport').addEventListener('click', () => { hideOnboarding(); doRefresh(); });
$('#onboardSkip').addEventListener('click', hideOnboarding);
try { applyTheme(localStorage.getItem('ft-theme') || 'dark'); } catch { applyTheme('dark'); }
checkFirstRun();
// Register the service worker (PWA / installable / offline shell).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
$('#sfClose').addEventListener('click', () => ($('#sfModal').hidden = true));
$('#sfCancel').addEventListener('click', () => ($('#sfModal').hidden = true));
$('#sfConnect').addEventListener('click', sfConnect);
$('#sfModal').addEventListener('click', (e) => { if (e.target.id === 'sfModal') $('#sfModal').hidden = true; });
sfRefreshStatus();
$('#catModalClose').addEventListener('click', () => ($('#catModal').hidden = true));
$('#catModal').addEventListener('click', (e) => { if (e.target.id === 'catModal') $('#catModal').hidden = true; });
$('#budgetModalClose').addEventListener('click', () => ($('#budgetModal').hidden = true));
$('#budgetCancel').addEventListener('click', () => ($('#budgetModal').hidden = true));
$('#budgetForm').addEventListener('submit', saveBudget);
$('#budgetModal').addEventListener('click', (e) => { if (e.target.id === 'budgetModal') $('#budgetModal').hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) closeModal();
  if (!incModal.hidden) closeIncModal();
  if (!$('#catModal').hidden) $('#catModal').hidden = true;
  if (!$('#budgetModal').hidden) $('#budgetModal').hidden = true;
});

initTabs();
// Default tab is "This Month"; subscriptions and the rest load when their tab opens.
refreshMonth().catch((err) => {
  $('#monthMetrics').innerHTML = `<div class="empty"><h3>Couldn't load data</h3><p>${escapeHtml(err.message)}</p></div>`;
});
// Alerts feed is global (shown on every tab); load it once on boot and refresh
// it whenever the data changes. Also re-check when the tab regains focus.
renderAlerts().catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAlerts().catch(() => {}); });
