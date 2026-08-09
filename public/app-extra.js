// ---------- Category picker (recategorize) ----------
let CATS = [];
async function ensureCats() { if (!CATS.length) CATS = await (await fetch('/api/categories')).json(); return CATS; }
async function openCatModal(t) {
  await ensureCats();
  $('#catModalSub').textContent = `${t.merchant} · ${usd(t.amount)} · now: ${t.category}`;
  const pick = $('#catPicker');
  pick.innerHTML = CATS.map((c) => `<button class="cat-pick${c === t.category ? ' is-current' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
  pick.querySelectorAll('.cat-pick').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await send('PUT', `/api/transactions/${t.id}/category`, { category: b.dataset.cat });
      toast(`${r.updated} transaction${r.updated === 1 ? '' : 's'} → ${r.category}`, 'success');
      $('#catModal').hidden = true;
      await refreshActiveTab();
    } catch (e) { toast(e.message); }
  }));
  $('#catModal').hidden = false;
}

// ---------- Budget editor ----------
function openBudgetModal(category, current) {
  $('#budgetModalTitle').textContent = `Budget — ${category}`;
  $('#b-category').value = category;
  $('#b-limit').value = current || '';
  $('#budgetModal').hidden = false;
  setTimeout(() => $('#b-limit').focus(), 50);
}
async function saveBudget(e) {
  e.preventDefault();
  try {
    await send('PUT', '/api/budgets', { category: $('#b-category').value, monthly_limit: Number($('#b-limit').value || 0) });
    toast('Budget saved', 'success');
    $('#budgetModal').hidden = true;
    await refreshActiveTab();
  } catch (err) { toast(err.message); }
}

// Attach recategorize-on-click to every .spend-row in a container, given its data.
function wireRecategorize(container, rows) {
  container.querySelectorAll('.spend-row[data-id]').forEach((row) =>
    row.addEventListener('click', () => {
      const t = rows.find((x) => x.id === Number(row.dataset.id));
      if (t) openCatModal(t);
    }));
}

// ---------- Spending filters ----------
const spendFilters = {};
function spendQuery(extra = {}) {
  const p = new URLSearchParams({ limit: '120' });
  const f = { ...spendFilters, ...extra };
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
async function applySpendFilters() {
  const rows = await (await fetch('/api/spending?' + spendQuery())).json();
  renderSpendList(rows);
  const active = Object.values(spendFilters).some(Boolean);
  const clr = $('#fltClear'); if (clr) clr.style.visibility = active ? 'visible' : 'hidden';
}
function populateFilterCategories(sum) {
  const sel = $('#fltCategory');
  if (!sel || sel.options.length > 1) return;
  for (const c of sum.byCategory) sel.add(new Option(c.category, c.category));
}

// ---------- Drill-down ----------
async function openDrill(filters) {
  const d = await (await fetch('/api/spending-detail?' + new URLSearchParams(filters))).json();
  $('#drillTitle').textContent = d.title;
  const chart = d.byMonth.length >= 2
    ? areaChart(d.byMonth.map((m) => ({ label: m.month.slice(5), value: m.total, full: m.month })))
    : '';
  $('#drillBody').innerHTML = `
    <div class="drill-stats">
      <div><div class="ds-num">${usd(d.total)}</div><div class="ds-lbl">total</div></div>
      <div><div class="ds-num">${d.count}</div><div class="ds-lbl">transactions</div></div>
      <div><div class="ds-num">${d.count ? usd(d.total / d.count) : '—'}</div><div class="ds-lbl">average</div></div>
      <div><div class="ds-num">${d.first ? fmtDate(d.first) : '—'}</div><div class="ds-lbl">since</div></div>
    </div>
    ${chart}
    <div class="drill-list">${d.transactions.map((t) => `
      <div class="drill-row"><span class="dr-date">${fmtDate(t.date)}</span>
        <span class="dr-merch">${escapeHtml(t.merchant)}</span>
        <span class="dr-cat">${escapeHtml(t.category)}</span>
        <span class="dr-amt">${usd(t.amount)}</span></div>`).join('')}</div>`;
  $('#drillModal').hidden = false;
}

// ---------- Goals ----------
async function renderGoals() {
  const el = $('#goalsList');
  if (!el) return;
  const goals = await (await fetch('/api/goals')).json();
  el.innerHTML = goals.length ? goals.map((g) => `
    <div class="goal-row" data-id="${g.id}">
      <div class="goal-top"><span class="goal-name">${escapeHtml(g.name)}</span>
        <span class="goal-amt">${usd(g.current)} / ${usd(g.target)}</span>
        <button class="icon-btn goal-del" title="Remove">✕</button></div>
      <div class="goal-bar"><span class="goal-fill" style="width:${g.pct}%"></span></div>
      <div class="goal-meta">${g.pct}%${g.remaining > 0
        ? ` · ${usd(g.remaining)} to go${g.etaMonths != null ? ` · ~${g.etaMonths} mo at ${usd(g.monthlyGrowth)}/mo` : (g.monthlyGrowth <= 0 ? ' · not growing yet' : '')}`
        : ' · 🎉 reached!'}</div>
    </div>`).join('') : '<p class="set-note">No goals yet. Set one to track progress against your net worth.</p>';
  el.querySelectorAll('.goal-del').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.target.closest('.goal-row').dataset.id;
    await send('DELETE', `/api/goals/${id}`); toast('Goal removed', 'success'); renderGoals();
  }));
}
async function addGoal(e) {
  e.preventDefault();
  try {
    await send('POST', '/api/goals', { name: $('#goalName').value, target: Number($('#goalTarget').value) });
    $('#goalName').value = ''; $('#goalTarget').value = ''; $('#goalForm').hidden = true;
    toast('Goal added', 'success'); renderGoals();
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- Net worth ----------
function renderNetWorth(nw) {
  const el = $('#netWorth');
  if (!el) return;
  if (!nw || nw.current == null) { el.hidden = true; return; }
  el.hidden = false;
  const pts = (nw.history || []).map((h) => ({ label: h.date.slice(5), value: h.net, full: h.date }));
  const first = pts.length ? pts[0].value : nw.current;
  const change = round2v(nw.current - first);
  const chart = pts.length >= 2 ? areaChartPos(pts) : `<p class="spend-method" style="margin:8px 0 0">Your net-worth trend builds here as balances sync over time.</p>`;
  el.innerHTML = `
    <div class="nw-head">
      <div><div class="nw-label">Net worth</div><div class="nw-value">${usd(nw.current)}</div>
        ${pts.length >= 2 ? `<div class="nw-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${usd(Math.abs(change))} since ${fmtDate(pts[0].full)}</div>` : ''}
      </div>
      <div class="nw-split"><span>Liquid <b>${usd(nw.liquid)}</b></span>${nw.card != null ? `<span>Card <b class="neg">${usd(nw.card)}</b></span>` : ''}</div>
    </div>
    ${chart}`;
}
const round2v = (n) => Math.round(n * 100) / 100;
// area chart variant tinted green (positive/net worth)
function areaChartPos(points) { return areaChart(points, {}).replace(/var\(--spend\)/g, 'var(--money)').replace(/acGrad/g, 'nwGrad'); }

// ---------- Detected subscriptions ----------
async function renderSuggestions() {
  const el = $('#subSuggest');
  if (!el) return;
  let s = [];
  try { s = await (await fetch('/api/detect-subscriptions')).json(); } catch { return; }
  const dismissed = JSON.parse(localStorage.getItem('ft-dismissed-subs') || '[]');
  s = s.filter((x) => !dismissed.includes(x.merchant));
  if (!s.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="suggest-card">
      <div class="suggest-head"><span class="suggest-icon">✨</span> We spotted ${s.length} recurring charge${s.length === 1 ? '' : 's'} you're not tracking</div>
      <div class="suggest-list">${s.map((x) => `
        <div class="suggest-row" data-m="${escapeHtml(x.merchant)}">
          <span class="sg-name">${escapeHtml(x.merchant)}</span>
          <span class="sg-meta">${usd(x.amount)} · ${CYCLE_LABEL[x.cycle] || escapeHtml(x.cycle)} · seen ${x.count}×</span>
          <button class="btn btn-primary sg-add">Track</button>
          <button class="icon-btn sg-skip" title="Dismiss">✕</button>
        </div>`).join('')}</div>
    </div>`;
  el.querySelectorAll('.suggest-row').forEach((row) => {
    const x = s.find((i) => i.merchant === row.dataset.m);
    row.querySelector('.sg-add').addEventListener('click', async () => {
      try {
        await api.create({ name: x.merchant, cost: x.amount, billing_cycle: x.cycle, category: x.category === 'Other' ? 'Subscriptions' : x.category, status: 'active' });
        toast(`Tracking ${x.merchant}`, 'success');
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    row.querySelector('.sg-skip').addEventListener('click', () => {
      const d = JSON.parse(localStorage.getItem('ft-dismissed-subs') || '[]'); d.push(x.merchant);
      localStorage.setItem('ft-dismissed-subs', JSON.stringify(d));
      renderSuggestions();
    });
  });
}

// ---------- Subscription ↔ ledger reconciliation ----------
// Shows what the ledger says the subs table has wrong: rebills of cancelled
// subs (critical), stale subs, and pending cost/date corrections — with a
// one-click apply so the table never rots the way a manual list does.
async function renderReconcile() {
  const el = $('#subReconcile');
  if (!el) return;
  let r = null;
  try { r = await (await fetch('/api/reconcile')).json(); } catch { return; }
  const drifted = r.subs.filter((s) => s.costDrift);
  const dated = r.subs.filter((s) => s.lastCharge && s.suggestedNext !== s.currentNext);
  const stale = r.subs.filter((s) => s.stale);
  if (!r.rebills.length && !r.doubles.length && !drifted.length && !dated.length && !stale.length && !r.unknownRecurring.length) {
    el.innerHTML = '';
    return;
  }
  const row = (name, meta, bad) => `
    <div class="suggest-row">
      <span class="sg-name">${bad ? '⚠ ' : ''}${escapeHtml(name)}</span>
      <span class="sg-meta">${escapeHtml(meta)}</span>
    </div>`;
  const parts = [];
  for (const rb of r.rebills) {
    const last = rb.charges[rb.charges.length - 1];
    parts.push(row(rb.name, `cancelled ${rb.cancelDate}, but charged ${usd(last.amount)} on ${fmtDate(last.date)} — check the autopay`, true));
  }
  for (const d of r.doubles) parts.push(row(d.name, `charged ${usd(d.amount)} twice in one cycle (${fmtDate(d.dates[0])} + ${fmtDate(d.dates[1])}) — duplicate or overlapping subs`, true));
  for (const s of stale) parts.push(row(s.name, `no charge since ${fmtDate(s.lastCharge.date)} — lapsed or moved cards?`, true));
  for (const s of drifted) parts.push(row(s.name, `bank says ${usd(s.observedCost)}, tracked as ${usd(s.cost)}`));
  for (const u of r.unknownRecurring) parts.push(row(`Unknown PayPal autopay`, `${usd(u.amount)} seen ${u.count}× (${fmtDate(u.firstDate)}–${fmtDate(u.lastDate)}) — matches no tracked sub`, true));
  const applyable = drifted.length + dated.length;
  el.innerHTML = `
    <div class="suggest-card reconcile-card">
      <div class="suggest-head"><span class="suggest-icon">⇄</span> Ledger check
        ${applyable ? `<button class="btn btn-primary" id="recApply" style="margin-left:auto;">Apply ${applyable} correction${applyable === 1 ? '' : 's'}</button>` : ''}
      </div>
      <div class="suggest-list">${parts.join('')}
        ${dated.length && !drifted.length ? row(`${dated.length} next-charge date${dated.length === 1 ? '' : 's'}`, 'refreshed from the latest charges on apply') : ''}
      </div>
    </div>`;
  const btn = $('#recApply');
  if (btn) btn.addEventListener('click', async () => {
    try {
      const res = await (await fetch('/api/reconcile/apply', { method: 'POST' })).json();
      toast(`Updated ${res.changes.length} subscription${res.changes.length === 1 ? '' : 's'} from the ledger`, 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- Insights ----------
async function refreshInsights() {
  const [d, nw] = await Promise.all([
    (await fetch('/api/insights')).json(),
    (await fetch('/api/networth')).json().catch(() => null),
  ]);
  renderNetWorth(nw);
  renderGoals();
  $('#insightLeaks').innerHTML = `
    <div class="leak-card warn">
      <div class="leak-amt">${usd(d.leaks.overdraft.total)}</div>
      <div class="leak-lbl">overdraft fees · ${d.leaks.overdraft.count} hits</div>
      <div class="leak-note">Avoidable — the single biggest waste in your data.</div>
    </div>
    <div class="leak-card">
      <div class="leak-amt">${usd(d.leaks.fees.total)}</div>
      <div class="leak-lbl">all bank fees · ${d.leaks.fees.count}</div>
      <div class="leak-note">${d.leaks.fees.items.slice(0, 3).map((i) => `${escapeHtml(i.merchant)} ${usd(i.total)}`).join(' · ')}</div>
    </div>`;

  const pmax = Math.max(...d.p2p.recipients.map((r) => r.total), 1);
  $('#insightP2P').innerHTML = `<p class="spend-method" style="margin:0 0 10px">${usd(d.p2p.total)} total to people (all-time)</p>` +
    d.p2p.recipients.map((r) => `
      <div class="cat-row">
        <span class="cat-name">${escapeHtml(r.merchant)}</span>
        <span class="cat-bar"><span class="cat-fill" style="width:${(r.total / pmax) * 100}%;background:var(--accent)"></span></span>
        <span class="cat-amt">${usd(r.total)}</span>
      </div>`).join('');

  const mom = d.monthOverMonth;
  $('#insightMoM').innerHTML = mom.rows.length
    ? `<p class="spend-method" style="margin:0 0 10px">${mom.current} vs ${mom.previous}${mom.partial ? ' · month-to-date (same days)' : ''}</p>` + mom.rows.map((r) => {
        const up = r.delta > 0;
        return `<div class="mom-row">
          <span class="mom-cat">${escapeHtml(r.category)}</span>
          <span class="mom-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${usd(Math.abs(r.delta))}${r.pct != null ? ` (${r.pct > 0 ? '+' : ''}${r.pct}%)` : ''}</span>
        </div>`;
      }).join('')
    : '<p class="spend-method">Need two months of data.</p>';

  $('#insightBiggest').innerHTML = d.biggest.map((t) => `
    <div class="merch-row">
      <span class="merch-name">${escapeHtml(t.merchant)}</span>
      <span class="merch-cat">${fmtDate(t.date)} · ${escapeHtml(t.category)}</span>
      <span class="merch-amt">${usd(t.amount)}</span>
    </div>`).join('');
}

// ---------- Tabs ----------
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
    document.querySelectorAll('.panel').forEach((p) =>
      p.classList.toggle('is-active', p.dataset.panel === btn.dataset.tab));
    if (btn.dataset.tab === 'month') refreshMonth().catch(() => {});
    if (btn.dataset.tab === 'upcoming') refreshUpcoming().catch(() => {});
    if (btn.dataset.tab === 'subscriptions') refresh().catch(() => {});
    if (btn.dataset.tab === 'income') refreshIncome().catch(() => {});
    if (btn.dataset.tab === 'spending') refreshSpending().catch(() => {});
    if (btn.dataset.tab === 'insights') refreshInsights().catch(() => {});
    if (btn.dataset.tab === 'profit') refreshProfit().catch(() => {});
  });
}

