'use strict';

// Monthly spending budgets per category.
const { db } = require('./db');
const { round2 } = require('./util');

function list() {
  const rows = db.prepare('SELECT category, monthly_limit FROM budgets').all();
  const map = {};
  for (const r of rows) map[r.category] = r.monthly_limit;
  return map;
}

function set(category, limit) {
  const cat = String(category || '').trim();
  if (!cat) throw new Error('Category is required');
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 0) throw new Error('Limit must be a non-negative number');
  if (n === 0) {
    db.prepare('DELETE FROM budgets WHERE category = ?').run(cat);
    return { category: cat, monthly_limit: 0, removed: true };
  }
  db.prepare(
    `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = datetime('now')`
  ).run(cat, round2(n));
  return { category: cat, monthly_limit: round2(n) };
}

const totalLimit = () =>
  round2(db.prepare('SELECT COALESCE(SUM(monthly_limit),0) s FROM budgets').get().s);

// Suggest a monthly budget per category from the last 3 complete months' average
// spend, for categories that aren't budgeted yet. Lets the user switch the whole
// budget feature on in one click instead of guessing numbers. Skips categories
// where a "budget" makes no sense (transfers, P2P, cash, crypto).
const SUGGEST_SKIP = new Set(['P2P / People', 'Transfer', 'Cash & ATM', 'Crypto / Investment', 'Adult']);
function suggest() {
  const already = new Set(Object.keys(list()));
  const now = new Date();
  const months = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const ph = months.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT category, ROUND(SUM(amount),2) t FROM transactions
     WHERE counted = 1 AND substr(date,1,7) IN (${ph})
     GROUP BY category, substr(date,1,7)`
  ).all(...months);

  const byCat = {};
  for (const r of rows) (byCat[r.category] ||= []).push(r.t);

  const out = [];
  for (const [category, vals] of Object.entries(byCat)) {
    if (already.has(category) || SUGGEST_SKIP.has(category)) continue;
    const avg = vals.reduce((s, v) => s + v, 0) / months.length;
    if (avg < 5) continue;
    // Round up to a tidy $5 step so the suggested budget looks deliberate.
    const monthly_limit = Math.max(5, Math.ceil(avg / 5) * 5);
    out.push({ category, monthly_limit, avg: round2(avg) });
  }
  out.sort((a, b) => b.monthly_limit - a.monthly_limit);
  return out;
}

module.exports = { list, set, totalLimit, suggest };
