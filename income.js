'use strict';

// Income data access + business rules (validation, frequency normalization,
// summary math). Mirrors subscriptions.js so the two halves of the tracker
// behave identically — the only differences are income-appropriate wording
// (amount instead of cost, frequency instead of billing cycle) and an 'ended'
// status instead of 'cancelled'. Kept separate from the HTTP layer for reuse.

const { db } = require('./db');

const CYCLES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly'];
const STATUSES = ['active', 'paused', 'ended'];

// Factor to convert one payment of a given frequency into an average monthly amount.
const CYCLE_TO_MONTHLY = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
};

const { round2 } = require('./util');

function monthlyAmount(row) {
  return row.cost * (CYCLE_TO_MONTHLY[row.billing_cycle] ?? 1);
}

// Validate + normalize input. `partial` allows updates that touch only some fields.
function validate(input, partial = false) {
  const out = {};
  const has = (k) => input[k] !== undefined && input[k] !== null;

  if (!partial || has('name')) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('Source name is required');
    }
    out.name = input.name.trim().slice(0, 120);
  }
  if (!partial || has('cost')) {
    const cost = Number(input.cost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error('Amount must be a non-negative number');
    }
    out.cost = round2(cost);
  }
  if (!partial || has('billing_cycle')) {
    const c = input.billing_cycle || 'weekly';
    if (!CYCLES.includes(c)) throw new Error('Invalid pay frequency');
    out.billing_cycle = c;
  }
  if (!partial || has('category')) {
    out.category = (input.category || 'Other').toString().trim().slice(0, 60) || 'Other';
  }
  if (!partial || input.next_billing_date !== undefined) {
    const d = input.next_billing_date ? String(input.next_billing_date).slice(0, 10) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Date must be YYYY-MM-DD');
    out.next_billing_date = d;
  }
  if (!partial || has('status')) {
    const s = input.status || 'active';
    if (!STATUSES.includes(s)) throw new Error('Invalid status');
    out.status = s;
  }
  if (!partial || input.notes !== undefined) {
    out.notes = input.notes ? String(input.notes).slice(0, 500) : null;
  }
  return out;
}

// Attach the computed monthly-equivalent so the UI never re-derives the math.
function decorate(row) {
  if (!row) return row;
  return { ...row, monthly: round2(monthlyAmount(row)) };
}

function getIncome(id) {
  return decorate(db.prepare('SELECT * FROM income WHERE id = ?').get(id));
}

// Paychecks are a ledger: newest first by the date received (next_billing_date
// is repurposed as the pay date). NULL dates sort last.
function listIncome() {
  const rows = db
    .prepare(
      `SELECT * FROM income
       ORDER BY (next_billing_date IS NULL) ASC,
                next_billing_date DESC,
                id DESC`
    )
    .all();
  return rows.map(decorate);
}

function createIncome(input) {
  const v = validate(input, false);
  const info = db
    .prepare(
      `INSERT INTO income
         (name, cost, billing_cycle, category, next_billing_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.name, v.cost, v.billing_cycle, v.category, v.next_billing_date, v.status, v.notes);
  return getIncome(Number(info.lastInsertRowid));
}

function updateIncome(id, input) {
  const existing = db.prepare('SELECT id FROM income WHERE id = ?').get(id);
  if (!existing) return null;
  const v = validate(input, true);
  const fields = Object.keys(v);
  if (fields.length === 0) return getIncome(id);
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => v[f]);
  db.prepare(
    `UPDATE income SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).run(...values, id);
  return getIncome(id);
}

function deleteIncome(id) {
  const info = db.prepare('DELETE FROM income WHERE id = ?').run(id);
  return info.changes > 0;
}

// Days between two YYYY-MM-DD strings.
const DAY = 86400000;
const daysBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / DAY;

// Monthly-equivalent income for the Profit tab. Each distinct source (name +
// pay frequency) contributes ONE monthly equivalent — the average of its recent
// paychecks times its cycle factor — and those are SUMMED across sources. The
// old code averaged every paycheck row together, which halved the total for
// anyone with two income streams (a $X weekly + $Y biweekly job reported ~half).
function monthlyTotal() {
  const dated = listIncome().filter((r) => r.next_billing_date && r.status !== 'ended');
  if (!dated.length) return 0;
  const newest = dated[0].next_billing_date; // listIncome is date-desc
  const recent = dated.filter((r) => daysBetween(r.next_billing_date, newest) <= 90);
  const pool = recent.length ? recent : dated;

  const bySource = new Map();
  for (const r of pool) {
    const key = `${r.name}|${r.billing_cycle}`;
    const g = bySource.get(key) || { cycle: r.billing_cycle, sum: 0, n: 0 };
    g.sum += r.cost; g.n += 1;
    bySource.set(key, g);
  }
  let total = 0;
  for (const g of bySource.values()) {
    total += (g.sum / g.n) * (CYCLE_TO_MONTHLY[g.cycle] ?? 1);
  }
  return round2(total);
}

// Per-source pay statistics over the trailing paychecks — the basis for
// variable-income forecasting. Pay that isn't salaried swings week to week, so
// projecting the LAST check forward misleads; the median is the honest
// "typical week" and the 25th percentile is the honest "lean week".
const pct = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)];
function sourceStats(windowCount = 12) {
  const rows = db.prepare(
    `SELECT name, billing_cycle, category, cost, next_billing_date FROM income
     WHERE status = 'active' AND next_billing_date IS NOT NULL
     ORDER BY next_billing_date DESC`
  ).all();
  const by = new Map();
  for (const r of rows) {
    const key = `${r.name}|${r.billing_cycle}`;
    let g = by.get(key);
    if (!g) {
      g = { name: r.name, cycle: r.billing_cycle, category: r.category, lastDate: r.next_billing_date, lastAmount: r.cost, amounts: [] };
      by.set(key, g);
    }
    if (g.amounts.length < windowCount) g.amounts.push(r.cost);
  }
  return [...by.values()].map((g) => {
    const sorted = [...g.amounts].sort((a, b) => a - b);
    return {
      name: g.name, cycle: g.cycle, category: g.category,
      lastDate: g.lastDate, lastAmount: round2(g.lastAmount),
      n: sorted.length,
      median: round2(pct(sorted, 0.5)),
      p25: round2(pct(sorted, 0.25)),
      min: round2(sorted[0]),
      max: round2(sorted[sorted.length - 1]),
    };
  });
}

// Append bank deposits that match a known income source to the paycheck ledger.
// Conservative on purpose: a deposit only counts when its description carries
// the source's name keyword — transfers, refunds, and one-off deposits never
// match. Idempotent: a paycheck already in the ledger (±2 days, same amount)
// is skipped, so hand-entered history and re-syncs don't duplicate.
function syncFromDeposits() {
  const sources = db.prepare(
    `SELECT name, billing_cycle, MAX(category) category FROM income
     WHERE status = 'active' AND next_billing_date IS NOT NULL
     GROUP BY name, billing_cycle`
  ).all();
  const deposits = db.prepare('SELECT date, description, amount FROM deposits ORDER BY date').all();
  const dup = db.prepare(
    `SELECT 1 FROM income WHERE name = ?
       AND ABS(julianday(next_billing_date) - julianday(?)) <= 2
       AND ABS(cost - ?) < 0.005`
  );
  let added = 0;
  for (const s of sources) {
    const kw = (s.name.split(/\s+/)[0] || '').toUpperCase();
    if (kw.length < 3) continue;
    for (const d of deposits) {
      const desc = (d.description || '').toUpperCase();
      if (!desc.includes(kw)) continue;
      // A source keyword that is also the account holder's name matches P2P
      // cashouts and refunds addressed to them — conduits/transfers/refunds
      // are never paychecks.
      if (/PAYPAL|VENMO|CASH ?APP|ZELLE|TRANSFER|XFER|REFUND|RETURN|REVERSAL|COINBASE/i.test(desc)) continue;
      if (dup.get(s.name, d.date, d.amount)) continue;
      createIncome({
        name: s.name, cost: d.amount, billing_cycle: s.billing_cycle,
        category: s.category || 'Payroll', next_billing_date: d.date,
        status: 'active', notes: 'auto-captured from bank deposit',
      });
      added++;
    }
  }
  return { added };
}

// Income received per calendar month (from paycheck dates).
function byMonth() {
  const map = {};
  for (const r of db.prepare(
    `SELECT substr(next_billing_date,1,7) m, ROUND(SUM(cost),2) total FROM income
     WHERE status = 'active' AND next_billing_date IS NOT NULL GROUP BY m`
  ).all()) map[r.m] = r.total;
  return map;
}

function summary() {
  const rows = listIncome();
  const dated = rows.filter((r) => r.next_billing_date);
  const year = new Date().getFullYear();
  const ytdRows = dated.filter((r) => Number(r.next_billing_date.slice(0, 4)) === year);
  const ytdTotal = round2(ytdRows.reduce((s, r) => s + r.cost, 0));
  const recent = dated[0] || null; // newest paycheck (date-desc order)
  const avgPaycheck = round2(
    rows.length ? rows.reduce((s, r) => s + r.cost, 0) / rows.length : 0
  );
  const monthly = monthlyTotal();

  const byCategoryMap = {};
  for (const r of rows) byCategoryMap[r.category] = (byCategoryMap[r.category] || 0) + r.cost;
  const byCategory = Object.entries(byCategoryMap)
    .map(([category, amount]) => ({ category, total: round2(amount) }))
    .sort((a, b) => b.total - a.total);

  return {
    counts: { total: rows.length, ytd: ytdRows.length },
    year,
    ytdTotal,
    avgPaycheck,
    recent: recent ? { name: recent.name, amount: recent.cost, date: recent.next_billing_date } : null,
    // run-rate, for the Profit tab + at-a-glance
    weekly: round2((monthly * 12) / 52),
    monthly,
    yearly: round2(monthly * 12),
    daily: round2((monthly * 12) / 365),
    byCategory,
  };
}

module.exports = {
  CYCLES,
  STATUSES,
  listIncome,
  getIncome,
  createIncome,
  updateIncome,
  deleteIncome,
  monthlyTotal,
  byMonth,
  summary,
  sourceStats,
  syncFromDeposits,
};
