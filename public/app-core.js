'use strict';

// Front-end controller: talks to the JSON API, renders the dashboard,
// and drives the add/edit modal. No framework — just the DOM.

const $ = (sel) => document.querySelector(sel);
const api = {
  async list() { return (await fetch('/api/subscriptions')).json(); },
  async summary() { return (await fetch('/api/summary')).json(); },
  async create(data) { return send('POST', '/api/subscriptions', data); },
  async update(id, data) { return send('PUT', `/api/subscriptions/${id}`, data); },
  async remove(id) { return send('DELETE', `/api/subscriptions/${id}`); },
};

async function send(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------- Formatting helpers ----------
const usd = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

const CYCLE_LABEL = {
  weekly: 'Weekly', biweekly: 'Every 2 wks', monthly: 'Monthly',
  quarterly: 'Quarterly', semiannual: 'Every 6 mo', yearly: 'Yearly',
};

// Count-up animation: finds the number inside each .metric-value and tweens it
// from 0, preserving any $ prefix and %/per-period suffix. Non-numeric values
// (e.g. a category name) are left untouched. easeOutCubic, ~600ms.
// Remembered metric values across re-renders, keyed by tab + label, so switching
// tabs doesn't re-animate every number from 0 (the "jumpy" effect). Only a value
// that actually changed animates — and from its previous value, not from 0.
const _metricVals = {};
function animateMetrics(container) {
  if (!container) return;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  container.querySelectorAll('.metric-value').forEach((el, i) => {
    const raw = el.textContent.trim();
    // Only animate numeric values ($1,234, 85%, 12) — skip labels like "P2P / People".
    if (!/^[-$\d]/.test(raw)) return;
    const m = raw.match(/-?[\d,]+\.?\d*/);
    if (!m) return;
    const target = parseFloat(m[0].replace(/,/g, ''));
    if (!isFinite(target)) return;
    const label = el.closest('.metric')?.querySelector('.metric-label')?.textContent.trim() || String(i);
    const key = (container.id || 'm') + ':' + label;
    const prev = key in _metricVals ? _metricVals[key] : 0;
    _metricVals[key] = target;
    // Unchanged since last view (tab revisit) or reduced-motion → show final value, no animation.
    if (reduce || prev === target) { el.textContent = raw; return; }
    const pre = raw.slice(0, m.index);
    const post = raw.slice(m.index + m[0].length);
    const decimals = (m[0].split('.')[1] || '').length;
    const start = performance.now(), dur = 600;
    const tick = (now) => {
      const p = Math.min((now - start) / dur, 1);
      const v = prev + (target - prev) * (1 - Math.pow(1 - p, 3));
      el.textContent = pre + v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + post;
      if (p < 1) requestAnimationFrame(tick); else el.textContent = raw;
    };
    requestAnimationFrame(tick);
  });
}

// Stable color per category so the eye can track them.
function catColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `oklch(72% 0.13 ${h})`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------- Render ----------
async function refresh() {
  const [subs, sum] = await Promise.all([api.list(), api.summary()]);
  renderMetrics(sum);
  renderBreakdown(sum);
  renderList(subs);
  renderSuggestions();
  renderReconcile();
  $('#subsSubtitle').textContent =
    sum.counts.active > 0
      ? `${sum.counts.active} active · ${usd(sum.monthly)}/mo · ${usd(sum.yearly)}/yr`
      : "Everything you're paying for, normalized to one view.";
}

function renderMetrics(s) {
  const cards = [
    { label: 'Per week', value: usd(s.weekly), sub: `${usd(s.daily)} / day`, hero: false },
    { label: 'Per month', value: usd(s.monthly), sub: 'total monthly burn', hero: true },
    { label: 'Per year', value: usd(s.yearly), sub: 'if nothing changes', hero: false },
    { label: 'Active subs', value: String(s.counts.active),
      sub: s.counts.paused ? `${s.counts.paused} paused` : 'all tracked', hero: false },
  ];
  $('#metrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#metrics'));
}

function renderBreakdown(s) {
  const el = $('#breakdown');
  if (!s.byCategory.length) { el.innerHTML = ''; return; }
  el.innerHTML = s.byCategory.map((c) => `
    <span class="cat-chip">
      <span class="dot" style="background:${catColor(c.category)}"></span>
      ${escapeHtml(c.category)} · <b>${usd(c.monthly)}/mo</b>
    </span>`).join('');
}

function renderList(subs) {
  const el = $('#subList');
  // Hide cancelled subscriptions from the dashboard — they stay in the data
  // (and their notes/rebill-watch records) but don't clutter the active view.
  const visible = subs.filter((s) => s.status !== 'cancelled');
  if (!visible.length) {
    el.innerHTML = `
      <div class="empty">
        <span class="e-icon">🗂️</span>
        <h3>No active subscriptions</h3>
        <p>Add one to start seeing your weekly and yearly totals.</p>
      </div>`;
    return;
  }
  el.innerHTML = visible.map(rowHtml).join('');
  el.querySelectorAll('.sub-row').forEach((row) =>
    row.addEventListener('click', () => openModal(visible.find((s) => s.id === Number(row.dataset.id)))));
}

function rowHtml(s) {
  const inactive = s.status !== 'active';
  const pill = inactive ? `<span class="pill ${s.status}">${s.status}</span>` : '';
  return `
    <div class="sub-row${inactive ? ' is-inactive' : ''}" data-id="${s.id}">
      <div class="s-name">
        <span class="name">${escapeHtml(s.name)}${pill}</span>
        ${s.notes ? `<span class="notes">${escapeHtml(s.notes)}</span>` : ''}
      </div>
      <span class="s-cat"><span class="dot" style="background:${catColor(s.category)}"></span>${escapeHtml(s.category)}</span>
      <span class="s-cycle">${CYCLE_LABEL[s.billing_cycle] || s.billing_cycle}</span>
      <span class="s-next">${fmtDate(s.next_billing_date)}</span>
      <span class="s-cost">${usd(s.cost)}</span>
      <span class="s-month">${usd(s.monthly)}</span>
      <button class="row-edit" aria-label="Edit">✎</button>
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Modal ----------
const modal = $('#modal');

function openModal(sub) {
  const editing = Boolean(sub);
  $('#modalTitle').textContent = editing ? 'Edit subscription' : 'Add subscription';
  $('#f-id').value = editing ? sub.id : '';
  $('#f-name').value = editing ? sub.name : '';
  $('#f-cost').value = editing ? sub.cost : '';
  $('#f-cycle').value = editing ? sub.billing_cycle : 'monthly';
  $('#f-category').value = editing ? sub.category : '';
  $('#f-next').value = editing && sub.next_billing_date ? sub.next_billing_date : '';
  $('#f-status').value = editing ? sub.status : 'active';
  $('#f-notes').value = editing ? (sub.notes || '') : '';
  $('#deleteBtn').hidden = !editing;
  $('#formError').hidden = true;
  modal.hidden = false;
  setTimeout(() => $('#f-name').focus(), 50);
}

function closeModal() { modal.hidden = true; }

async function saveSub(e) {
  e.preventDefault();
  const id = $('#f-id').value;
  const data = {
    name: $('#f-name').value,
    cost: $('#f-cost').value,
    billing_cycle: $('#f-cycle').value,
    category: $('#f-category').value || 'Other',
    next_billing_date: $('#f-next').value || null,
    status: $('#f-status').value,
    notes: $('#f-notes').value || null,
  };
  try {
    if (id) await api.update(Number(id), data);
    else await api.create(data);
    closeModal();
    await refresh();
  } catch (err) {
    const box = $('#formError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function deleteSub() {
  const id = $('#f-id').value;
  if (!id) return;
  if (!confirm('Delete this subscription? This cannot be undone.')) return;
  await api.remove(Number(id));
  closeModal();
  await refresh();
}

// ---------- Income ----------
const incomeApi = {
  async list() { return (await fetch('/api/income')).json(); },
  async summary() { return (await fetch('/api/income-summary')).json(); },
  async create(data) { return send('POST', '/api/income', data); },
  async update(id, data) { return send('PUT', `/api/income/${id}`, data); },
  async remove(id) { return send('DELETE', `/api/income/${id}`); },
};

async function refreshIncome() {
  skeletonMetrics($('#incMetrics')); skeletonRows($('#incList'));
  const [rows, sum] = await Promise.all([incomeApi.list(), incomeApi.summary()]);
  renderIncMetrics(sum);
  renderIncBreakdown(sum);
  renderIncList(rows, sum.year);
  $('#incSubtitle').textContent = sum.recent
    ? `Latest ${usd(sum.recent.amount)} on ${fmtDate(sum.recent.date)} · ${usd(sum.ytdTotal)} YTD · run-rate ${usd(sum.weekly)}/wk`
    : 'Your paychecks, newest first.';
}

function fmtFullDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderIncMetrics(s) {
  const recentVal = s.recent ? usd(s.recent.amount) : '—';
  const recentSub = s.recent ? `received ${fmtDate(s.recent.date)}` : 'no paychecks yet';
  const cards = [
    { label: 'Most recent', value: recentVal, sub: recentSub, hero: true, cls: 'pos' },
    { label: `${s.year} YTD`, value: usd(s.ytdTotal), sub: `${s.counts.ytd} paycheck${s.counts.ytd === 1 ? '' : 's'} this year`, cls: 'pos' },
    { label: 'Avg paycheck', value: usd(s.avgPaycheck), sub: `${s.counts.total} on record`, cls: 'pos' },
    { label: 'Run-rate', value: `${usd(s.monthly)}/mo`, sub: `${usd(s.weekly)}/wk · ${usd(s.yearly)}/yr` },
  ];
  $('#incMetrics').innerHTML = cards.map((c) => `
    <div class="metric${c.hero ? ' is-hero' : ''}${c.cls ? ' ' + c.cls : ''}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-sub">${c.sub}</div>
    </div>`).join('');
  animateMetrics($('#incMetrics'));
}

function renderIncBreakdown(s) {
  const el = $('#incBreakdown');
  if (!s.byCategory.length) { el.innerHTML = ''; return; }
  el.innerHTML = s.byCategory.map((c) => `
    <span class="cat-chip">
      <span class="dot" style="background:${catColor(c.category)}"></span>
      ${escapeHtml(c.category)} · <b>${usd(c.total)}</b>
    </span>`).join('');
}

function renderIncList(rows, year) {
  const el = $('#incList');
  if (!rows.length) {
    el.innerHTML = `
      <div class="empty">
        <span class="e-icon">💸</span>
        <h3>No paychecks yet</h3>
        <p>Add a paycheck to see your YTD total and run-rate.</p>
      </div>`;
    return;
  }
  // Running YTD: rows are newest-first, so accumulate from the bottom up within the current year.
  const ytdRunning = {};
  let acc = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.next_billing_date && Number(r.next_billing_date.slice(0, 4)) === year) {
      acc += r.cost;
      ytdRunning[r.id] = acc;
    }
  }
  el.innerHTML = rows.map((r) => incRowHtml(r, ytdRunning[r.id])).join('');
  el.querySelectorAll('.sub-row').forEach((row) =>
    row.addEventListener('click', () => openIncModal(rows.find((r) => r.id === Number(row.dataset.id)))));
}

function incRowHtml(r, ytd) {
  const inactive = r.status !== 'active';
  const pill = inactive ? `<span class="pill ${r.status}">${r.status}</span>` : '';
  return `
    <div class="sub-row${inactive ? ' is-inactive' : ''}" data-id="${r.id}">
      <span class="s-next strong">${fmtFullDate(r.next_billing_date)}</span>
      <div class="s-name">
        <span class="name">${escapeHtml(r.name)}${pill}</span>
        ${r.notes ? `<span class="notes">${escapeHtml(r.notes)}</span>` : ''}
      </div>
      <span class="s-cat"><span class="dot" style="background:${catColor(r.category)}"></span>${escapeHtml(r.category)}</span>
      <span class="s-cost pos">${usd(r.cost)}</span>
      <span class="s-month">${ytd != null ? usd(ytd) : '—'}</span>
      <button class="row-edit" aria-label="Edit">✎</button>
    </div>`;
}

const incModal = $('#incModal');

function openIncModal(row) {
  const editing = Boolean(row);
  $('#incModalTitle').textContent = editing ? 'Edit income' : 'Add income';
  $('#if-id').value = editing ? row.id : '';
  $('#if-name').value = editing ? row.name : '';
  $('#if-cost').value = editing ? row.cost : '';
  $('#if-cycle').value = editing ? row.billing_cycle : 'weekly';
  $('#if-category').value = editing ? row.category : '';
  $('#if-next').value = editing && row.next_billing_date ? row.next_billing_date : '';
  $('#if-status').value = editing ? row.status : 'active';
  $('#if-notes').value = editing ? (row.notes || '') : '';
  $('#incDeleteBtn').hidden = !editing;
  $('#incFormError').hidden = true;
  incModal.hidden = false;
  setTimeout(() => $('#if-name').focus(), 50);
}

function closeIncModal() { incModal.hidden = true; }

async function saveIncome(e) {
  e.preventDefault();
  const id = $('#if-id').value;
  const data = {
    name: $('#if-name').value,
    cost: $('#if-cost').value,
    billing_cycle: $('#if-cycle').value,
    category: $('#if-category').value || 'Other',
    next_billing_date: $('#if-next').value || null,
    status: $('#if-status').value,
    notes: $('#if-notes').value || null,
  };
  try {
    if (id) await incomeApi.update(Number(id), data);
    else await incomeApi.create(data);
    closeIncModal();
    await Promise.all([refreshIncome(), refreshProfit()]);
  } catch (err) {
    const box = $('#incFormError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function deleteIncome() {
  const id = $('#if-id').value;
  if (!id) return;
  if (!confirm('Delete this income source? This cannot be undone.')) return;
  await incomeApi.remove(Number(id));
  closeIncModal();
  await Promise.all([refreshIncome(), refreshProfit()]);
}

