// ---------- This Month ----------
const SOURCE_LABEL = { checking: 'Bank', savings: 'Bank', paypal: 'PayPal', venmo: 'Venmo', cashapp: 'Cash App' };

function renderBalancesStrip(el, b) {
  if (!b || !b.hasBalances) { el.hidden = true; return; }
  const chip = (a) => `<span class="bal-chip${a.source === 'creditcard' ? ' card' : ''}">
      <span class="bal-acct">${escapeHtml(a.account)}${a.manual ? '<span class="bal-manual" title="Manually adjusted — will reconcile on next bank sync">✎ adjusted</span>' : ''}</span>
      <b>${usd(a.available ?? a.balance)}</b></span>`;
  const items = b.accounts.map(chip).join('');
  const asOf = b.asOf ? `<span class="bal-asof">as of ${fmtDate(b.asOf)}</span>` : '';
  el.innerHTML = `<span class="bal-label">Balances</span>${items}<span class="bal-chip total"><span class="bal-acct">Liquid</span><b>${usd(b.liquid)}</b></span>${asOf}`;
  el.hidden = false;
}

async function refreshMonth() {
  skeletonMetrics($('#monthMetrics')); skeletonRows($('#monthList'));
  const [m, bal] = await Promise.all([
    (await fetch('/api/month')).json(),
    (await fetch('/api/balances')).json().catch(() => ({})),
  ]);
  renderBalancesStrip($('#monthBalances'), bal);
  $('#monthTitle').textContent = m.label;
  $('#monthSubtitle').textContent = m.isCurrent
    ? `${m.income.count} paycheck${m.income.count === 1 ? '' : 's'} in · ${usd(m.spending.total)} spent so far`
    : `${usd(m.income.total)} in · ${usd(m.spending.total)} out`;
  $('#monthProgress').textContent = m.isCurrent ? `Day ${m.daysElapsed} of ${m.daysInMonth} · ${m.daysLeft} left` : '';

  const positive = m.net >= 0;
  const cards = [
    { label: positive ? 'Net so far' : 'Down so far', value: usd(m.net), sub: m.isCurrent ? 'income − spending, month-to-date' : 'final', hero: true, cls: positive ? 'pos' : 'neg' },
    { label: 'Income', value: usd(m.income.total), sub: `${m.income.count} received`, cls: 'pos' },
    { label: 'Spent', value: usd(m.spending.total), sub: `${m.spending.count} transactions`, cls: 'neg' },
    { label: m.projection.projecting ? 'Projected spend' : 'vs avg month',
      value: m.projection.projecting ? usd(m.projection.spending) : usd(m.avgSpending),
      sub: m.projection.projecting ? `at ${usd(m.dailyPace)}/day pace` : '3-month average' },
  ];
  $('#monthMetrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}${c.cls ? ' ' + c.cls : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#monthMetrics'));

  const max = Math.max(...m.spending.byCategory.map((c) => Math.max(c.total, c.budget || 0)), 1);
  $('#monthCategories').innerHTML = m.spending.byCategory.length
    ? m.spending.byCategory.map((c) => {
        const width = c.budget ? Math.min((c.total / c.budget) * 100, 100) : (c.total / max) * 100;
        return `
      <div class="cat-row budget-row" data-cat="${escapeHtml(c.category)}" data-budget="${c.budget || ''}" title="Click to set a budget">
        <span class="cat-name"><span class="dot" style="background:${catColor(c.category)}"></span>${escapeHtml(c.category)}</span>
        <span class="cat-bar"><span class="cat-fill" style="width:${width}%;background:${c.overBudget ? 'var(--spend)' : catColor(c.category)}"></span></span>
        <span class="cat-amt">${usd(c.total)}${c.budget ? ` <span class="cat-budget${c.overBudget ? ' over' : ''}">/ ${usd(c.budget)}</span>` : ''}</span>
      </div>`;
      }).join('') + '<p class="spend-method" style="margin-top:8px">Tip: click a category to set a monthly budget.</p>'
    : '<p class="spend-method">No spending recorded yet this month. <button class="linklike" id="addBudgetEmpty">Set a budget</button></p>';
  $('#monthCategories').querySelectorAll('.budget-row').forEach((row) =>
    row.addEventListener('click', () => openBudgetModal(row.dataset.cat, row.dataset.budget)));

  $('#monthIncome').innerHTML = m.income.items.length
    ? m.income.items.map((i) => `
      <div class="merch-row">
        <span class="merch-name">${escapeHtml(i.name)}</span>
        <span class="merch-cat">${fmtDate(i.date)}</span>
        <span class="merch-amt" style="color:var(--money)">${usd(i.amount)}</span>
      </div>`).join('')
    : '<p class="spend-method">No paychecks recorded yet this month.</p>';

  const projNote = m.projection.projecting
    ? `At <b>${usd(m.dailyPace)}/day</b>, you're on pace for <b>${usd(m.projection.spending)}</b> spent by month-end` +
      ` — projected net <b style="color:${m.projection.net >= 0 ? 'var(--money)' : 'var(--spend)'}">${usd(m.projection.net)}</b>.` +
      ` Your 3-month average is ${usd(m.avgSpending)}.`
    : `Spent ${usd(m.spending.total)} this month vs a ${usd(m.avgSpending)} 3-month average.`;
  $('#monthPace').innerHTML = `<p class="spend-method" style="margin-top:0">${projNote}</p>`;

  const el = $('#monthList');
  if (m.spending.recent.length) {
    el.innerHTML = m.spending.recent.map(spendRowHtml).join('');
    wireRecategorize(el, m.spending.recent);
  } else {
    el.innerHTML = '<div class="empty"><h3>Nothing yet this month</h3></div>';
  }
}

// Shared row markup for spending/month transaction lists (clickable to recategorize).
function spendRowHtml(t) {
  return `
    <div class="spend-row" data-id="${t.id}" title="Click to recategorize">
      <span class="sp-date">${fmtDate(t.date)}</span>
      <span class="sp-merch">${escapeHtml(t.merchant)}${t.note ? `<span class="sp-note">${escapeHtml(t.note)}</span>` : ''}</span>
      <span class="sp-cat"><span class="dot" style="background:${catColor(t.category)}"></span>${escapeHtml(t.category)}</span>
      <span class="sp-src">${SOURCE_LABEL[t.source] || t.source}</span>
      <span class="sp-amt">${usd(t.amount)}</span>
    </div>`;
}

// ---------- Spending ----------

async function refreshSpending() {
  skeletonMetrics($('#spendMetrics')); skeletonRows($('#spendList'));
  const [sum, list] = await Promise.all([
    (await fetch('/api/spending-summary')).json(),
    (await fetch('/api/spending?limit=60')).json(),
  ]);
  renderSpendMetrics(sum);
  renderSpendCategories(sum);
  renderSpendTrend(sum);
  renderSpendMerchants(sum);
  populateFilterCategories(sum);
  if (Object.values(spendFilters).some(Boolean)) await applySpendFilters(); else renderSpendList(list);
  const w = sum.windowMonths || [];
  $('#spendSubtitle').textContent = sum.monthlyAvg
    ? `${usd(sum.monthlyAvg)}/mo average · across bank, PayPal, Venmo & Cash App`
    : 'Where your money actually goes.';
  $('#spendMethod').innerHTML =
    `Breakdown covers the last ${w.length} month${w.length === 1 ? '' : 's'} (${w.slice().reverse().join(', ')}). ` +
    `Every dollar is counted once — platform payments funded from your bank are de-duplicated against the bank line, ` +
    `while balance- and credit-card-funded spend stays. Internal transfers and failed payments are excluded. ` +
    `Not yet included: any spend on a credit card you haven't imported.`;
}

function renderSpendMetrics(s) {
  const cards = [
    { label: 'Monthly average', value: usd(s.monthlyAvg), sub: 'recent run-rate', hero: true, cls: 'neg' },
    { label: 'Latest month', value: s.recentMonth ? usd(s.recentMonth.total) : '—', sub: s.recentMonth ? monthName(s.recentMonth.month) : '', cls: 'neg' },
    { label: 'Top category', value: s.byCategory[0] ? s.byCategory[0].category : '—', sub: s.byCategory[0] ? `${usd(s.byCategory[0].total)} in window` : '', cls: 'neg' },
    { label: 'Transactions', value: String(s.counts.transactions), sub: 'all sources' },
  ];
  $('#spendMetrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}${c.cls ? ' ' + c.cls : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value" style="font-size:${c.value.length > 12 ? '1.3rem' : ''}">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#spendMetrics'));
}

function monthName(m) {
  if (!m) return '';
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function renderSpendCategories(s) {
  const max = Math.max(...s.byCategory.map((c) => c.total), 1);
  const el = $('#spendCategories');
  el.innerHTML = s.byCategory.map((c) => `
    <div class="cat-row clickable" data-cat="${escapeHtml(c.category)}" title="Click to drill in">
      <span class="cat-name"><span class="dot" style="background:${catColor(c.category)}"></span>${escapeHtml(c.category)}</span>
      <span class="cat-bar"><span class="cat-fill" style="width:${(c.total / max) * 100}%;background:${catColor(c.category)}"></span></span>
      <span class="cat-amt">${usd(c.total)}</span>
    </div>`).join('');
  el.querySelectorAll('.cat-row').forEach((row) => row.addEventListener('click', () => openDrill({ category: row.dataset.cat })));
}

function renderSpendTrend(s) {
  $('#spendTrend').innerHTML = areaChart(s.byMonth.map((m) => ({ label: m.month.slice(5), value: m.total, full: monthName(m.month) })));
}

// Zero-dependency SVG area chart with gradient fill, end-dot, and per-point hover.
function areaChart(points, { w = 380, h = 130, pad = 22 } = {}) {
  if (!points.length) return '<p class="spend-method">No data yet.</p>';
  const max = Math.max(...points.map((p) => p.value), 1);
  const n = points.length;
  const x = (i) => pad + (i * (w - pad * 2)) / Math.max(n - 1, 1);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${i === n - 1 ? 3.5 : 2}" class="ac-dot${i === n - 1 ? ' end' : ''}"><title>${escapeHtml(p.full)}: ${usd(p.value)}</title></circle>`).join('');
  const labels = points.map((p, i) => (i % 2 === 0 || i === n - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${h - 5}" class="ac-lbl">${escapeHtml(p.label)}</text>` : '').join('');
  return `
    <svg viewBox="0 0 ${w} ${h}" class="area-chart" preserveAspectRatio="none" role="img" aria-label="Monthly spending trend">
      <defs><linearGradient id="acGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="var(--spend)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--spend)" stop-opacity="0.02"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#acGrad)"/>
      <path d="${line}" fill="none" stroke="var(--spend)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="ac-line"/>
      ${dots}${labels}
    </svg>`;
}

function renderSpendMerchants(s) {
  const el = $('#spendMerchants');
  el.innerHTML = s.topMerchants.map((m) => `
    <div class="merch-row clickable" data-merch="${escapeHtml(m.merchant)}" title="Click to drill in">
      <span class="merch-name">${escapeHtml(m.merchant)}</span>
      <span class="merch-cat">${escapeHtml(m.category)}</span>
      <span class="merch-amt">${usd(m.total)}</span>
    </div>`).join('');
  el.querySelectorAll('.merch-row').forEach((row) => row.addEventListener('click', () => openDrill({ merchant: row.dataset.merch })));
}

function renderSpendList(rows) {
  const el = $('#spendList');
  if (!rows.length) { el.innerHTML = `<div class="empty"><h3>No transactions</h3></div>`; return; }
  el.innerHTML = rows.map(spendRowHtml).join('');
  wireRecategorize(el, rows);
}

// ---------- Profit ----------
async function refreshProfit() {
  const p = await (await fetch('/api/profit')).json();
  const positive = p.net.monthly >= 0;
  const cards = [
    { label: 'Income', value: usd(p.income.monthly), sub: `${usd(p.income.weekly)} / wk`, cls: 'pos' },
    { label: 'Expenses', value: usd(p.expenses.monthly), sub: `${usd(p.expenses.weekly)} / wk`, cls: 'neg' },
    { label: positive ? 'Net profit / mo' : 'Net loss / mo', value: usd(p.net.monthly),
      sub: `${usd(p.net.weekly)} / wk · ${usd(p.net.yearly)} / yr`, hero: true, cls: positive ? 'pos' : 'neg' },
    { label: 'Savings rate', value: p.savingsRate == null ? '—' : `${p.savingsRate}%`,
      sub: positive ? 'of income kept' : 'spending exceeds income', cls: positive ? 'pos' : 'neg' },
  ];
  $('#profitMetrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}${c.cls ? ' ' + c.cls : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#profitMetrics'));

  const inW = p.income.monthly, outW = p.expenses.monthly;
  const subs = p.subscriptions ? p.subscriptions.monthly : 0;
  const max = Math.max(inW, outW, 1);
  $('#profitFlow').innerHTML = `
    <div class="flow-row"><span class="flow-label">Income</span>
      <span class="flow-bar"><span class="flow-fill pos" style="width:${(inW / max) * 100}%"></span></span>
      <span class="flow-val">${usd(inW)}/mo</span></div>
    <div class="flow-row"><span class="flow-label">Total spending</span>
      <span class="flow-bar"><span class="flow-fill neg" style="width:${(outW / max) * 100}%"></span></span>
      <span class="flow-val">${usd(outW)}/mo</span></div>
    <div class="flow-row"><span class="flow-label" style="opacity:.7;">↳ of which subs</span>
      <span class="flow-bar"><span class="flow-fill neg" style="width:${(subs / max) * 100}%;opacity:.5;"></span></span>
      <span class="flow-val" style="opacity:.7;">${usd(subs)}/mo</span></div>
    <div class="flow-note">${positive
      ? `You keep <b>${usd(p.net.monthly)}</b> a month${p.savingsRate != null ? ` — a ${p.savingsRate}% savings rate` : ''}.`
      : `You're spending <b>${usd(Math.abs(p.net.monthly))}</b>/mo more than you bring in.`}
      <br/><span class="flow-sub">Income is your paycheck run-rate; spending spans bank, PayPal, Venmo & Cash App. Excludes any un-imported credit card.</span></div>`;
  renderProfitTrend(p.trend);
}

$('#profitSubtitle').textContent = 'Income minus all spending.';

// Cashflow calendar: a 6-week grid from the start of this week, with income (green)
// and charges (red) marked on their days.
function renderCalendar(timeline) {
  const el = $('#upCalendar');
  if (!el) return;
  const byDay = {};
  for (const e of timeline) (byDay[e.date] ||= []).push(e);
  const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const n0 = new Date();
  const today = new Date(n0.getFullYear(), n0.getMonth(), n0.getDate()); // local midnight today
  const todayISO = localISO(today);
  const start = new Date(today); start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = localISO(d);
    const evs = byDay[iso] || [];
    const isToday = iso === todayISO;
    const inc = evs.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
    const out = evs.filter((e) => e.kind === 'charge').reduce((s, e) => s + e.amount, 0);
    const past = d < today;
    cells += `<div class="cal-cell${isToday ? ' today' : ''}${past ? ' past' : ''}${evs.length ? ' has' : ''}" title="${escapeHtml(evs.map((e) => `${e.name}: ${e.kind === 'income' ? '+' : '−'}${usd(e.amount)}`).join('\n'))}">
      <span class="cal-num">${d.getDate()}</span>
      ${inc ? `<span class="cal-in">+${Math.round(inc)}</span>` : ''}
      ${out ? `<span class="cal-out">−${Math.round(out)}</span>` : ''}
    </div>`;
  }
  el.innerHTML = `<div class="cal-grid">${dow.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>`;
}

// ---------- Upcoming (forecast) ----------
async function refreshUpcoming() {
  skeletonMetrics($('#upMetrics')); skeletonRows($('#upTimeline'));
  const f = await (await fetch('/api/forecast')).json();
  const t = f.totals;
  const net14pos = t.net14 >= 0;
  $('#upSubtitle').textContent = `${f.chargeCount} charges in the next ${f.windowDays} days · ${usd(f.monthlySubTotal)}/mo in subscriptions`;
  const cards = [
    { label: 'Next 14 days', value: usd(t.net14), sub: `${usd(t.in14)} in · ${usd(t.out14)} out`, hero: true, cls: net14pos ? 'pos' : 'neg' },
    { label: 'Coming in', value: usd(t.in30), sub: 'paychecks · next 30 days', cls: 'pos' },
    { label: 'Going out', value: usd(t.out30), sub: 'subscriptions · next 30 days', cls: 'neg' },
    { label: 'Net 30 days', value: usd(t.net30), sub: t.net30 >= 0 ? 'covered' : 'shortfall', cls: t.net30 >= 0 ? 'pos' : 'neg' },
  ];
  $('#upMetrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}${c.cls ? ' ' + c.cls : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#upMetrics'));

  renderCalendar(f.timeline || []);
  const bal = f.balances || {};
  // Balances strip (shown once SimpleFIN is connected).
  if (bal.hasBalances) {
    const items = bal.liquid.map((b) => `<span class="bal-chip"><span class="bal-acct">${escapeHtml(b.account)}</span><b>${usd(b.balance)}</b></span>`).join('');
    const card = bal.card != null ? `<span class="bal-chip card"><span class="bal-acct">Credit card</span><b>${usd(bal.card)}</b></span>` : '';
    $('#upBalances').innerHTML = `<span class="bal-label">Available now</span>${items}${card}
      <span class="bal-chip total"><span class="bal-acct">Liquid total</span><b>${usd(bal.startingBalance)}</b></span>`;
    $('#upBalances').hidden = false;
  } else {
    $('#upBalances').hidden = true;
  }

  // Running line: from the real balance if we have it, else a $0 swing.
  let running = bal.hasBalances ? bal.startingBalance : 0;
  const rows = f.timeline.map((e) => {
    running += e.kind === 'income' ? e.amount : -e.amount;
    const whenLbl = e.daysAway <= 0 ? 'today' : e.daysAway === 1 ? 'tomorrow' : `${e.daysAway}d · ${fmtDate(e.date)}`;
    return `
      <div class="up-row ${e.kind}">
        <span class="up-when">${whenLbl}</span>
        <span class="up-item"><span class="up-dot ${e.kind}"></span>${escapeHtml(e.name)}</span>
        <span class="up-amt ${e.kind}">${e.kind === 'income' ? '+' : '−'}${usd(e.amount)}</span>
        <span class="up-run ${running < 0 ? 'neg' : ''}">${usd(running)}</span>
      </div>`;
  }).join('');
  $('#upTimeline').innerHTML = rows || '<div class="empty"><h3>Nothing scheduled in this window</h3></div>';

  const undated = f.undated.length
    ? ` Not shown (no charge history to date them — likely credit-card billed): ${f.undated.map((u) => `${escapeHtml(u.name)} ${usd(u.amount)}`).join(', ')}.`
    : '';
  let lead;
  if (bal.hasBalances) {
    lead = bal.overdraftDate
      ? `⚠ Heads up — your balance is projected to go negative around <b>${fmtDate(bal.overdraftDate)}</b> (low point ${usd(bal.lowest)}). That's overdraft territory. `
      : `✓ You stay positive through this window — lowest point ${usd(bal.lowest)}${bal.lowestDate ? ` around ${fmtDate(bal.lowestDate)}` : ''}. Running column is your real projected balance. `;
    if (!bal.overdraftDate && bal.lowestLean != null && bal.lowestLean !== bal.lowest) {
      lead += bal.leanOverdraftDate
        ? `⚠ On lean paychecks (25th pct) you'd dip negative around <b>${fmtDate(bal.leanOverdraftDate)}</b> (${usd(bal.lowestLean)}). `
        : `Lean-week view (25th pct pay): lowest ${usd(bal.lowestLean)}. `;
    }
  } else {
    lead = 'Running total is the swing from today (starts at $0), not your actual balance — connect a bank for real balance tracking. ';
  }
  const basis = (f.incomeBasis && f.incomeBasis.sources && f.incomeBasis.sources.length)
    ? ' Income is variable — projected at each source’s typical (median) recent paycheck.'
    : '';
  $('#upNote').innerHTML = lead + 'Dates are projected from each item’s last charge + its cycle.' + basis + undated;
}

