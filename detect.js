'use strict';

// Auto-detect recurring charges in the spending ledger that aren't tracked as
// subscriptions yet — the automated version of a subscription audit. A charge
// qualifies if it recurs ≥3 times at a stable amount on a regular cadence and is
// still active (last seen within ~1.5 cycles).

const { db } = require('./db');
const { round2 } = require('./util');
const DAY = 86400000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function cadence(days) {
  if (days >= 5 && days <= 9) return { cycle: 'weekly', limit: 12 };
  if (days >= 12 && days <= 16) return { cycle: 'biweekly', limit: 24 };
  if (days >= 25 && days <= 35) return { cycle: 'monthly', limit: 45 };
  if (days >= 85 && days <= 95) return { cycle: 'quarterly', limit: 130 };
  if (days >= 175 && days <= 200) return { cycle: 'semiannual', limit: 260 };
  if (days >= 350 && days <= 380) return { cycle: 'yearly', limit: 400 };
  return null;
}

// Categories that are never subscriptions.
const SKIP_CAT = new Set(['P2P / People', 'Transfer', 'Fees & Charges', 'Cash & ATM', 'Crypto / Investment', 'Adult']);

function suggestions() {
  const tracked = new Set(
    db.prepare('SELECT name FROM subscriptions').all().map((s) => s.name.toLowerCase())
  );
  const rows = db.prepare(
    `SELECT merchant, category, date, amount FROM transactions
     WHERE counted = 1 ORDER BY merchant, date`
  ).all();

  const groups = {};
  for (const r of rows) (groups[r.merchant] ||= []).push(r);

  const today = Date.now();
  const out = [];
  for (const [merchant, list] of Object.entries(groups)) {
    if (!merchant || list.length < 3) continue;
    const cat = list[list.length - 1].category;
    if (SKIP_CAT.has(cat)) continue;
    // already tracked? (loose name containment either way)
    const ml = merchant.toLowerCase();
    if ([...tracked].some((t) => t.includes(ml) || ml.includes(t.split(' ')[0]))) continue;

    const amounts = list.map((r) => r.amount);
    const typical = round2(median(amounts));
    const stable = Math.max(...amounts) - Math.min(...amounts) <= Math.max(0.75, typical * 0.2);
    if (!stable) continue;

    const gaps = [];
    for (let i = 1; i < list.length; i++) gaps.push((new Date(list[i].date) - new Date(list[i - 1].date)) / DAY);
    const cad = cadence(median(gaps));
    if (!cad) continue;

    const last = list[list.length - 1].date;
    const daysSince = (today - new Date(last)) / DAY;
    if (daysSince > cad.limit) continue; // looks lapsed

    out.push({ merchant, amount: typical, cycle: cad.cycle, category: cat, count: list.length, lastDate: last });
  }
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

module.exports = { suggestions };
