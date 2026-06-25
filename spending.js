'use strict';

// Spending data access. Reads the unified `transactions` ledger and rolls it up
// into the views the Spending tab needs: monthly trend, category breakdown,
// top merchants. Only `counted = 1` rows are spend (transfers / failed / deduped
// funding lines are excluded). All amounts are positive outflow magnitudes.

const { db } = require('./db');

const { round2 } = require('./util');

function buildWhere({ category, merchant, search, from, to, minAmount, maxAmount, source }) {
  const where = ['counted = 1'];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (merchant) { where.push('merchant = ?'); params.push(merchant); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (search) { where.push('(merchant LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (minAmount != null) { where.push('amount >= ?'); params.push(minAmount); }
  if (maxAmount != null) { where.push('amount <= ?'); params.push(maxAmount); }
  return { clause: where.join(' AND '), params };
}

function listTransactions(opts = {}) {
  const limit = Math.min(opts.limit || 200, 500);
  const { clause, params } = buildWhere(opts);
  return db.prepare(`SELECT * FROM transactions WHERE ${clause} ORDER BY date DESC, id DESC LIMIT ?`).all(...params, limit);
}

// Drill-down for one merchant or category: totals + monthly trend + recent rows.
function detail(opts = {}) {
  const { clause, params } = buildWhere(opts);
  const agg = db.prepare(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, MIN(date) first, MAX(date) last FROM transactions WHERE ${clause}`).get(...params);
  const byMonth = db.prepare(
    `SELECT substr(date,1,7) month, ROUND(SUM(amount),2) total FROM transactions WHERE ${clause} GROUP BY month ORDER BY month DESC LIMIT 12`
  ).all(...params);
  const transactions = db.prepare(`SELECT * FROM transactions WHERE ${clause} ORDER BY date DESC, id DESC LIMIT 50`).all(...params);
  return {
    title: opts.merchant || opts.category || 'Transactions',
    total: round2(agg.total), count: agg.n, first: agg.first, last: agg.last,
    byMonth: byMonth.reverse(), transactions,
  };
}

// Distinct YYYY-MM present in the data, newest first.
function months() {
  return db
    .prepare(`SELECT DISTINCT substr(date,1,7) m FROM transactions WHERE counted = 1 ORDER BY m DESC`)
    .all()
    .map((r) => r.m);
}

function summary() {
  const total = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM transactions WHERE counted = 1').get();

  // 12-month trend
  const byMonth = db
    .prepare(
      `SELECT substr(date,1,7) month, ROUND(SUM(amount),2) total, COUNT(*) n
       FROM transactions WHERE counted = 1
       GROUP BY month ORDER BY month DESC LIMIT 12`
    )
    .all();

  // Headline window: the 3 most recent months that have data (a stable
  // "recent run-rate" that ignores the current partial month if it skews things).
  const recentMonths = byMonth.slice(0, 3).map((r) => r.month);
  const windowClause = recentMonths.length
    ? `AND substr(date,1,7) IN (${recentMonths.map(() => '?').join(',')})`
    : '';

  const byCategory = db
    .prepare(
      `SELECT category, ROUND(SUM(amount),2) total, COUNT(*) n
       FROM transactions WHERE counted = 1 ${windowClause}
       GROUP BY category ORDER BY total DESC`
    )
    .all(...recentMonths);

  const topMerchants = db
    .prepare(
      `SELECT merchant, category, ROUND(SUM(amount),2) total, COUNT(*) n
       FROM transactions WHERE counted = 1 ${windowClause}
       GROUP BY merchant ORDER BY total DESC LIMIT 12`
    )
    .all(...recentMonths);

  const bySource = db
    .prepare(
      `SELECT source, ROUND(SUM(amount),2) total, COUNT(*) n
       FROM transactions WHERE counted = 1
       GROUP BY source ORDER BY total DESC`
    )
    .all();

  const windowTotal = recentMonths.length
    ? db.prepare(`SELECT ROUND(SUM(amount),2) s FROM transactions WHERE counted = 1 ${windowClause}`).get(...recentMonths).s || 0
    : 0;
  const monthlyAvg = recentMonths.length ? round2(windowTotal / recentMonths.length) : 0;

  // most recent full month figure
  const thisMonth = byMonth[0] || null;

  return {
    counts: { transactions: total.n },
    allTimeTotal: round2(total.s),
    monthlyAvg,                 // avg over the recent window
    windowMonths: recentMonths, // which months the breakdown covers
    recentMonth: thisMonth ? { month: thisMonth.month, total: thisMonth.total } : null,
    byMonth: byMonth.reverse(), // oldest→newest for charting
    byCategory,
    topMerchants,
    bySource,
  };
}

// Total monthly spend (recent run-rate) — reused by the Profit tab for true take-home.
function monthlyTotal() {
  return summary().monthlyAvg;
}

module.exports = { listTransactions, detail, months, summary, monthlyTotal };
