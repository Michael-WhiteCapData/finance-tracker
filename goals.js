'use strict';

// Savings goals. Progress is measured against net worth; the projected hit-date
// uses the recent net-worth growth rate (falls back to monthly surplus if the
// balance history is too short to trend).

const { db } = require('./db');
const simplefin = require('./simplefin');
const income = require('./income');
const spending = require('./spending');

const { round2 } = require('./util');
const DAY = 86400000;

function monthlyGrowth() {
  // Prefer measured net-worth change; else income run-rate − spending run-rate.
  const hist = simplefin.netWorth().history;
  if (hist.length >= 2) {
    const first = hist[0], last = hist[hist.length - 1];
    const days = Math.max((new Date(last.date) - new Date(first.date)) / DAY, 1);
    if (days >= 7) return round2(((last.net - first.net) / days) * 30.44);
  }
  return round2(income.monthlyTotal() - spending.monthlyTotal());
}

function list() {
  const nw = simplefin.netWorth();
  const current = nw.current != null ? nw.current : nw.liquid;
  const growth = monthlyGrowth();
  return db.prepare('SELECT * FROM goals ORDER BY target ASC').all().map((g) => {
    const remaining = round2(g.target - current);
    const pct = g.target > 0 ? Math.min(Math.round((current / g.target) * 100), 100) : 0;
    let etaMonths = null;
    if (remaining <= 0) etaMonths = 0;
    else if (growth > 0) etaMonths = Math.ceil(remaining / growth);
    return { ...g, current: round2(current), remaining, pct, monthlyGrowth: growth, etaMonths };
  });
}

function create({ name, target }) {
  const n = String(name || '').trim().slice(0, 80);
  const t = Number(target);
  if (!n) throw new Error('Goal name is required');
  if (!Number.isFinite(t) || t <= 0) throw new Error('Target must be a positive number');
  const info = db.prepare('INSERT INTO goals (name, target) VALUES (?, ?)').run(n, round2(t));
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(info.lastInsertRowid));
}

function remove(id) {
  return db.prepare('DELETE FROM goals WHERE id = ?').run(id).changes > 0;
}

module.exports = { list, create, remove };
