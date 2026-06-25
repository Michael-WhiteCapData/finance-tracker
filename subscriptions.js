'use strict';

// Subscription data access + business rules (validation, cost normalization,
// summary math). Kept separate from the HTTP layer so it can be reused/tested.

const { db } = require('./db');

const CYCLES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly'];
const STATUSES = ['active', 'paused', 'cancelled'];

// Factor to convert one charge of a given cycle into an average monthly cost.
const CYCLE_TO_MONTHLY = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
};

const { round2 } = require('./util');

function monthlyCost(sub) {
  return sub.cost * (CYCLE_TO_MONTHLY[sub.billing_cycle] ?? 1);
}

// Validate + normalize input. `partial` allows updates that touch only some fields.
function validate(input, partial = false) {
  const out = {};
  const has = (k) => input[k] !== undefined && input[k] !== null;

  if (!partial || has('name')) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('Name is required');
    }
    out.name = input.name.trim().slice(0, 120);
  }
  if (!partial || has('cost')) {
    const cost = Number(input.cost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error('Cost must be a non-negative number');
    }
    out.cost = round2(cost);
  }
  if (!partial || has('billing_cycle')) {
    const c = input.billing_cycle || 'monthly';
    if (!CYCLES.includes(c)) throw new Error('Invalid billing cycle');
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
function decorate(sub) {
  if (!sub) return sub;
  return { ...sub, monthly: round2(monthlyCost(sub)) };
}

function getSubscription(id) {
  return decorate(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id));
}

function listSubscriptions() {
  const rows = db
    .prepare(
      `SELECT * FROM subscriptions
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                name COLLATE NOCASE`
    )
    .all();
  return rows.map(decorate);
}

function createSubscription(input) {
  const v = validate(input, false);
  const info = db
    .prepare(
      `INSERT INTO subscriptions
         (name, cost, billing_cycle, category, next_billing_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.name, v.cost, v.billing_cycle, v.category, v.next_billing_date, v.status, v.notes);
  return getSubscription(Number(info.lastInsertRowid));
}

function updateSubscription(id, input) {
  const existing = db.prepare('SELECT id FROM subscriptions WHERE id = ?').get(id);
  if (!existing) return null;
  const v = validate(input, true);
  const fields = Object.keys(v);
  if (fields.length === 0) return getSubscription(id);
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => v[f]);
  db.prepare(
    `UPDATE subscriptions SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).run(...values, id);
  return getSubscription(id);
}

function deleteSubscription(id) {
  const info = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  return info.changes > 0;
}

function summary() {
  const subs = listSubscriptions();
  const active = subs.filter((s) => s.status === 'active');
  const monthly = active.reduce((sum, s) => sum + s.monthly, 0);

  const byCategoryMap = {};
  for (const s of active) {
    byCategoryMap[s.category] = (byCategoryMap[s.category] || 0) + s.monthly;
  }
  const byCategory = Object.entries(byCategoryMap)
    .map(([category, amount]) => ({ category, monthly: round2(amount) }))
    .sort((a, b) => b.monthly - a.monthly);

  return {
    counts: {
      total: subs.length,
      active: active.length,
      paused: subs.filter((s) => s.status === 'paused').length,
      cancelled: subs.filter((s) => s.status === 'cancelled').length,
    },
    weekly: round2((monthly * 12) / 52),
    monthly: round2(monthly),
    yearly: round2(monthly * 12),
    daily: round2((monthly * 12) / 365),
    byCategory,
  };
}

module.exports = {
  CYCLES,
  STATUSES,
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  summary,
};
