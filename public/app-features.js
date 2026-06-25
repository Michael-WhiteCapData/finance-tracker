// ---------- SimpleFIN connect ----------
async function sfRefreshStatus() {
  try {
    const s = await (await fetch('/api/simplefin/status')).json();
    const btn = $('#connectBtn');
    if (s.connected) {
      btn.textContent = '🔗 Synced';
      btn.title = s.syncedAt ? `Last synced ${new Date(s.syncedAt).toLocaleString()}` : 'Connected';
    }
    return s;
  } catch { return { connected: false }; }
}
function openSfModal() {
  $('#sfBody').hidden = false; $('#sfStatus').hidden = true; $('#sfError').hidden = true;
  $('#sfConnectedActions').hidden = true;
  $('#sf-token').value = '';
  $('#sfModal').hidden = false;
  sfRefreshStatus().then((s) => {
    if (s.connected) {
      $('#sfStatus').hidden = false;
      $('#sfStatus').innerHTML = `Connected${s.syncedAt ? ` · last sync ${new Date(s.syncedAt).toLocaleString()}` : ''}. <button class="linklike" id="sfSyncNow">Sync now</button>`;
      $('#sfSyncNow').addEventListener('click', () => doSfSync());
      $('#sfConnectedActions').hidden = false;
    }
  });
}
async function doSfDisconnect() {
  if (!confirm('Disconnect the bank? This removes the stored access key, live balances, and synced transactions. Your CSV history stays.')) return;
  try {
    await send('POST', '/api/simplefin/disconnect');
    toast('Bank disconnected');
    $('#sfModal').hidden = true;
    $('#connectBtn').textContent = '🔗 Connect bank';
    await refreshActiveTab();
  } catch (e) { toast(e.message); }
}

// ---------- Settings ----------
async function openSettings() {
  $('#settingsModal').hidden = false;
  // Connection
  const s = await sfRefreshStatus();
  const conn = $('#setConnection');
  if (s.connected) {
    conn.innerHTML = `<div class="set-conn-row"><span class="set-ok">● Connected</span>
      <span class="set-conn-meta">${s.syncedAt ? `last sync ${new Date(s.syncedAt).toLocaleString()}` : ''}</span></div>
      <div class="set-conn-actions"><button class="btn btn-ghost" id="setSyncNow">Sync now</button>
      <button class="btn btn-ghost danger" id="setDisconnect">Disconnect</button></div>`;
    conn.querySelector('#setSyncNow').addEventListener('click', () => doSfSync());
    conn.querySelector('#setDisconnect').addEventListener('click', doSfDisconnect);
  } else {
    conn.innerHTML = `<div class="set-conn-row"><span class="set-off">○ Not connected</span></div>
      <button class="btn btn-primary" id="setConnect">Connect a bank</button>`;
    conn.querySelector('#setConnect').addEventListener('click', () => { $('#settingsModal').hidden = true; openSfModal(); });
  }
  // Budgets
  renderSettingsBudgets();
  renderSettingsAccounts();
  // Profile
  const p = await (await fetch('/api/profile')).json();
  $('#p-names').value = p.owner_names || '';
  $('#p-checking').value = p.checking_match || '';
  $('#p-savings').value = p.savings_match || '';
  $('#p-checking').placeholder = p.defaults.checking_match;
  $('#p-savings').placeholder = p.defaults.savings_match;
}
async function renderSettingsBudgets() {
  const b = await (await fetch('/api/budgets')).json();
  const el = $('#setBudgets');
  const entries = Object.entries(b);
  const rowsHtml = entries.length
    ? entries.map(([cat, lim]) => `
      <div class="set-budget-row">
        <span class="dot" style="background:${catColor(cat)}"></span>
        <span class="sb-cat">${escapeHtml(cat)}</span>
        <input class="sb-amt" type="number" min="0" step="1" value="${lim}" data-cat="${escapeHtml(cat)}" />
        <button class="icon-btn sb-del" data-cat="${escapeHtml(cat)}" title="Remove">✕</button>
      </div>`).join('')
    : '<p class="set-note">No budgets yet. Auto-set them from your spending, add one below, or click a category on the This Month tab.</p>';
  el.innerHTML = rowsHtml + '<button class="btn btn-ghost sb-suggest" id="suggestBudgets" type="button">✨ Suggest from my spending</button>';
  el.querySelectorAll('.sb-amt').forEach((i) => i.addEventListener('change', () => saveBudgetValue(i.dataset.cat, Number(i.value))));
  el.querySelectorAll('.sb-del').forEach((b) => b.addEventListener('click', () => saveBudgetValue(b.dataset.cat, 0)));
  $('#suggestBudgets')?.addEventListener('click', suggestBudgets);
}
async function saveBudgetValue(category, monthly_limit) {
  try { await send('PUT', '/api/budgets', { category, monthly_limit }); toast('Budget updated', 'success'); renderSettingsBudgets(); }
  catch (e) { toast(e.message, 'error'); }
}
async function saveProfile(e) {
  e.preventDefault();
  try {
    await send('PUT', '/api/profile', {
      owner_names: $('#p-names').value, checking_match: $('#p-checking').value, savings_match: $('#p-savings').value,
    });
    toast('Profile saved — ledger rebuilt', 'success');
    await refreshActiveTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Manual accounts ----------
const ACCT_LABEL = { investment: 'Investment', retirement: 'Retirement', cash: 'Cash', savings: 'Savings', checking: 'Checking', creditcard: 'Credit card', loan: 'Loan', other: 'Other' };
async function renderSettingsAccounts() {
  const a = await (await fetch('/api/accounts')).json();
  const el = $('#setAccounts');
  el.innerHTML = a.length ? a.map((x) => `
    <div class="set-acct-row">
      <span class="sa-name">${escapeHtml(x.account)}</span>
      <span class="sa-type">${ACCT_LABEL[x.source] || x.source}</span>
      <span class="sa-bal ${x.balance < 0 ? 'neg' : ''}">${usd(x.balance)}</span>
      <button class="icon-btn sa-del" data-acct="${escapeHtml(x.account)}" title="Remove">✕</button>
    </div>`).join('') : '<p class="set-note">None yet.</p>';
  el.querySelectorAll('.sa-del').forEach((b) => b.addEventListener('click', async () => {
    await send('DELETE', `/api/accounts/${encodeURIComponent(b.dataset.acct)}`); toast('Account removed', 'success');
    renderSettingsAccounts(); refreshActiveTab();
  }));
}
async function addAccount() {
  const name = $('#acctName').value.trim(), type = $('#acctType').value, balance = Number($('#acctBalance').value);
  if (!name || !Number.isFinite(balance)) { toast('Enter a name and balance', 'error'); return; }
  try {
    await send('POST', '/api/accounts', { name, type, balance });
    $('#acctName').value = ''; $('#acctBalance').value = '';
    toast('Account added', 'success'); renderSettingsAccounts(); refreshActiveTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Profit trend ----------
function renderProfitTrend(trend) {
  const el = $('#profitTrend');
  if (!el || !trend || !trend.length) { if (el) el.innerHTML = '<p class="spend-method">Trend builds as months accrue.</p>'; return; }
  const max = Math.max(...trend.map((t) => Math.max(t.income, t.spending)), 1);
  el.innerHTML = `<div class="ptrend">${trend.map((t) => `
    <div class="pt-col" title="${monthName(t.month)} — in ${usd(t.income)}, out ${usd(t.spending)}, net ${usd(t.net)}">
      <div class="pt-bars">
        <span class="pt-bar in" style="height:${(t.income / max) * 100}%"></span>
        <span class="pt-bar out" style="height:${(t.spending / max) * 100}%"></span>
      </div>
      <span class="pt-lbl">${t.month.slice(5)}</span>
    </div>`).join('')}</div>
    <div class="pt-legend"><span><i class="pt-dot in"></i>Income</span><span><i class="pt-dot out"></i>Spending</span></div>`;
}

// ---------- Theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = t === 'light' ? '☀' : '☾';
  try { localStorage.setItem('ft-theme', t); } catch {}
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}
async function doSfSync() {
  toast('Syncing live data…');
  try {
    const r = await send('POST', '/api/simplefin/sync');
    toast(`Synced ${r.accounts} accounts · ${r.added} new transactions`, 'success');
    $('#sfModal').hidden = true;
    await refreshActiveTab();
  } catch (e) { toast('Sync failed: ' + e.message, 'error'); }
}
async function sfConnect() {
  const token = $('#sf-token').value.trim();
  const err = $('#sfError');
  if (!token) { err.textContent = 'Paste your Setup Token first.'; err.hidden = false; return; }
  const btn = $('#sfConnect'); btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    await send('POST', '/api/simplefin/claim', { token });
    btn.textContent = 'Syncing…';
    const r = await send('POST', '/api/simplefin/sync');
    toast(`Connected — ${r.accounts} accounts, ${r.added} transactions pulled`, 'success');
    $('#sfModal').hidden = true;
    await sfRefreshStatus();
    await refreshActiveTab();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Connect & sync'; }
}

// ---------- Toast + Refresh ----------
function toast(msg, kind = 'info', ms = 2600) {
  const t = $('#toast');
  const icon = kind === 'error' ? '⚠' : kind === 'success' ? '✓' : '';
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon ? `<span class="toast-icon">${icon}</span>` : ''}<span>${escapeHtml(msg)}</span>`;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 300); }, ms);
}

// ---------- Skeleton loaders ----------
function skeletonMetrics(container) {
  if (!container) return;
  container.innerHTML = Array.from({ length: 4 }, () => `
    <div class="metric"><div class="sk-line sk-sm"></div><div class="sk-line sk-lg"></div><div class="sk-line sk-sm"></div></div>`).join('');
}
function skeletonRows(container, n = 5) {
  if (!container) return;
  container.innerHTML = Array.from({ length: n }, () => `<div class="sk-row"><div class="sk-line sk-md"></div><div class="sk-line sk-sm"></div></div>`).join('');
}

// ---------- Onboarding ----------
async function checkFirstRun() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s.hasData && !s.connected) showOnboarding();
  } catch {}
}
function showOnboarding() { $('#onboard').hidden = false; }
function hideOnboarding() { $('#onboard').hidden = true; }

function activeTab() { return document.querySelector('.tab.is-active')?.dataset.tab; }
function refreshActiveTab() {
  const map = { month: refreshMonth, upcoming: refreshUpcoming, subscriptions: refresh, income: refreshIncome, spending: refreshSpending, insights: refreshInsights, profit: refreshProfit };
  return (map[activeTab()] || refreshMonth)();
}

async function doRefresh() {
  const btn = $('#refreshBtn');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⟳ Refreshing…';
  try {
    const r = await send('POST', '/api/reimport');
    toast(`Re-imported ${r.counted} transactions${r.overridesApplied ? ` · ${r.overridesApplied} fixes kept` : ''}`);
    await refreshActiveTab();
  } catch (e) { toast('Refresh failed: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = old; }
  renderAlerts().catch(() => {});
}

// ---------- Alerts (unified severity-ranked feed) ----------
const SEV_META = {
  critical: { icon: '⛔', cls: 'crit' },
  warning: { icon: '⚠', cls: 'warn' },
  info: { icon: '•', cls: 'info' },
};
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const lsPush = (k, v) => { const a = lsGet(k); a.push(v); localStorage.setItem(k, JSON.stringify(a)); };

// Dismissals are stored as { id: dismissedAtMs } and EXPIRE after DISMISS_TTL, so
// a re-triggered critical (or any long-standing situation) eventually re-surfaces
// and the store can't grow without bound. Dynamic ids (overdraft:DATE,
// budget:YYYY-MM:cat, fees:YYYY-MM) also change when the situation changes.
const DISMISS_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
function liveDismissals() {
  let m;
  try { m = JSON.parse(localStorage.getItem('ft-dismissed-alerts') || '{}'); } catch { m = {}; }
  if (Array.isArray(m) || typeof m !== 'object' || !m) m = {}; // migrate legacy array → drop
  const now = Date.now();
  let changed = false;
  for (const [id, ts] of Object.entries(m)) { if (now - ts > DISMISS_TTL) { delete m[id]; changed = true; } }
  if (changed) localStorage.setItem('ft-dismissed-alerts', JSON.stringify(m));
  return m;
}
function dismissAlert(id) {
  const m = liveDismissals();
  m[id] = Date.now();
  localStorage.setItem('ft-dismissed-alerts', JSON.stringify(m));
}

async function renderAlerts() {
  const bar = $('#alertsBar');
  if (!bar) return;
  let data;
  try { data = await (await fetch('/api/alerts')).json(); } catch { bar.hidden = true; return; }
  const dismissed = new Set(Object.keys(liveDismissals()));
  const visible = (data.alerts || []).filter((a) => !dismissed.has(a.id));
  if (!visible.length) { bar.hidden = true; bar.innerHTML = ''; return; }

  const canAsk = ('Notification' in window) && Notification.permission === 'default';
  const head = `<div class="alerts-head">
      <span class="alerts-title">${visible.length} thing${visible.length > 1 ? 's' : ''} to look at</span>
      ${canAsk ? '<button class="alerts-notify" id="alertsNotify">🔔 Desktop alerts</button>' : ''}
      <button class="alerts-clear" id="alertsClear">Dismiss all</button>
    </div>`;
  bar.innerHTML = head + visible.map((a) => {
    const m = SEV_META[a.severity] || SEV_META.info;
    return `<div class="alert ${m.cls}" data-tab="${a.action && a.action.tab ? a.action.tab : ''}">
        <span class="alert-icon">${m.icon}</span>
        <span class="alert-body"><b>${escapeHtml(a.title)}</b><span>${escapeHtml(a.detail)}</span></span>
        <button class="alert-x" data-id="${escapeHtml(a.id)}" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>`;
  }).join('');
  bar.hidden = false;

  bar.querySelectorAll('.alert').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.alert-x')) return;
    const tab = el.dataset.tab;
    if (tab) document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  }));
  bar.querySelectorAll('.alert-x').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissAlert(x.dataset.id);
    renderAlerts();
  }));
  $('#alertsClear')?.addEventListener('click', () => {
    for (const a of visible) dismissAlert(a.id);
    renderAlerts();
  });
  $('#alertsNotify')?.addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch {}
    renderAlerts();
  });

  // Desktop push for fresh critical alerts (only once permission is granted).
  if ('Notification' in window && Notification.permission === 'granted') {
    const notified = new Set(lsGet('ft-notified-alerts'));
    for (const a of visible) {
      if (a.severity !== 'critical' || notified.has(a.id)) continue;
      try { new Notification(`💰 ${a.title}`, { body: a.detail }); } catch {}
      lsPush('ft-notified-alerts', a.id);
    }
  }
}

// Set monthly budgets in one click from the last 3 months' average spend.
async function suggestBudgets() {
  let sug;
  try { sug = await (await fetch('/api/budgets/suggest')).json(); }
  catch { return toast('Could not load suggestions', 'error'); }
  if (!sug.length) return toast('Nothing new to suggest — categories already budgeted', 'info');
  const lines = sug.map((s) => `  • ${s.category}: ${usd(s.monthly_limit)}`).join('\n');
  if (!confirm(`Set these monthly budgets from your 3-month average spend?\n\n${lines}\n\nYou can fine-tune any of them after.`)) return;
  let n = 0;
  for (const s of sug) {
    try { await send('PUT', '/api/budgets', { category: s.category, monthly_limit: s.monthly_limit }); n++; } catch {}
  }
  toast(`Set ${n} budget${n === 1 ? '' : 's'}`, 'success');
  renderSettingsBudgets();
  refreshMonth().catch(() => {});
  renderAlerts().catch(() => {});
}

