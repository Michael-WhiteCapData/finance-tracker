'use strict';

// Derived insights over the spending ledger: month-over-month category shifts,
// where peer-to-peer money goes, and avoidable "leak" costs (fees).
const { db } = require('./db');
const { round2 } = require('./util');

function recentMonths(n = 2) {
  return db
    .prepare(`SELECT DISTINCT substr(date,1,7) m FROM transactions WHERE counted = 1 ORDER BY m DESC LIMIT ?`)
    .all(n)
    .map((r) => r.m);
}

function monthOverMonth() {
  const [cur, prev] = recentMonths(2);
  if (!cur) return { current: null, previous: null, rows: [] };
  // If the current month is still in progress, compare like-for-like: the
  // previous month is capped at the same day-of-month, so a partial June isn't
  // measured against a full May (which made everything look like -100%).
  const now = new Date();
  const nowYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const partial = cur === nowYm;
  const capDay = String(now.getDate()).padStart(2, '0');
  const catTotals = (ym, cap) => {
    const map = {};
    if (!ym) return map;
    const rows = cap
      ? db.prepare(`SELECT category, ROUND(SUM(amount),2) t FROM transactions WHERE counted = 1 AND substr(date,1,7) = ? AND substr(date,9,2) <= ? GROUP BY category`).all(ym, capDay)
      : db.prepare(`SELECT category, ROUND(SUM(amount),2) t FROM transactions WHERE counted = 1 AND substr(date,1,7) = ? GROUP BY category`).all(ym);
    for (const r of rows) map[r.category] = r.t;
    return map;
  };
  const a = catTotals(cur, false), b = catTotals(prev, partial);
  const cats = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const rows = cats.map((c) => {
    const now = a[c] || 0, then = b[c] || 0, delta = round2(now - then);
    return { category: c, current: now, previous: then, delta, pct: then > 0 ? Math.round((delta / then) * 100) : null };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { current: cur, previous: prev, partial, rows };
}

function p2p() {
  const rows = db.prepare(
    `SELECT merchant, ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions
     WHERE counted = 1 AND category = 'P2P / People' GROUP BY merchant ORDER BY total DESC LIMIT 15`
  ).all();
  const total = round2(db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE counted = 1 AND category = 'P2P / People'`).get().s);
  return { total, recipients: rows };
}

function leaks() {
  const fees = db.prepare(
    `SELECT ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions WHERE counted = 1 AND category = 'Fees & Charges'`
  ).get();
  const feeItems = db.prepare(
    `SELECT merchant, ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions
     WHERE counted = 1 AND category = 'Fees & Charges' GROUP BY merchant ORDER BY total DESC LIMIT 8`
  ).all();
  const overdraft = db.prepare(
    `SELECT ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions
     WHERE counted = 1 AND (description LIKE '%PAID ITEM FEE%' OR description LIKE '%OVERDRAFT%')`
  ).get();
  return { fees: { total: round2(fees.total || 0), count: fees.n, items: feeItems }, overdraft: { total: round2(overdraft.total || 0), count: overdraft.n } };
}

function biggest() {
  return db.prepare(
    `SELECT date, merchant, category, amount FROM transactions WHERE counted = 1 ORDER BY amount DESC LIMIT 10`
  ).all();
}

function summary() {
  return { monthOverMonth: monthOverMonth(), p2p: p2p(), leaks: leaks(), biggest: biggest() };
}

module.exports = { summary };
