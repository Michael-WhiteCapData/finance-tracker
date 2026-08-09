'use strict';

// Subscription ↔ ledger reconciliation — the automated version of the manual
// audit that keeps the subscriptions table honest. For every sub it finds the
// matching charges in the transactions ledger, then reports (and optionally
// applies) what the ledger says: real cost, last charge, next expected date,
// staleness. Also watches cancelled subs for rebills — a cancelled autopay that
// charges again is exactly the thing you want shouted about.
//
// Matching is two-tier:
//   1. 'description' — a per-name keyword found in description/merchant, plus an
//      amount band so same-vendor subs (Claude Max $215 vs Max 5x $107.50) stay
//      separate.
//   2. 'paypal' — PayPal-funded subs surface on the bank feed as opaque
//      "PAYPAL WEB" lines; match those by amount alone (tight tolerance).
// Amount-matched rows can date a sub but must never re-price it — the amount is
// what matched, so "observed cost" would be circular.

const { db } = require('./db');
const { round2 } = require('./util');

const DAY = 86400000;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };

const CYCLE_DAYS = { weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91, semiannual: 183, yearly: 365 };
const STALE_FACTOR = 1.6;        // no charge in this many cycles → stale
const PAYPAL_TOLERANCE = 0.15;   // $ band for opaque PayPal amount matches
const DOUBLE_FACTOR = 0.6;       // two charges closer than this × cycle → double-charge
const DOUBLE_WINDOW_DAYS = 60;   // only recent double-charges are worth flagging

function addCycle(date, cycle) {
  const d = new Date(date);
  switch (cycle) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'semiannual': d.setMonth(d.getMonth() + 6); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    case 'monthly': default: d.setMonth(d.getMonth() + 1); break;
  }
  return d;
}

// Sub name → the keyword its charges carry in the ledger. First hit wins;
// fallback is the name's first word. These are generic global vendors only —
// anything that would fingerprint personal history belongs in the git-ignored
// reconcile.local.js (same pattern as categorize.local.js), checked first.
let LOCAL_KEYWORDS = [];
try { LOCAL_KEYWORDS = require('./reconcile.local').KEYWORDS || []; } catch { /* optional */ }
const KEYWORDS = [
  ...LOCAL_KEYWORDS,
  ['claude', 'CLAUDE'], ['chatgpt', 'OPENAI'], ['openai', 'OPENAI'],
  ['spotify', 'SPOTIFY'], ['discord', 'DISCORD'], ['github', 'GITHUB'],
  ['proton', 'PROTON'], ['higgsfield', 'HIGGSFIELD'], ['simplefin', 'SIMPLEFIN'],
  ['x developer', 'DEVELOPER PLATFORM'], ['x premium', 'PAID FEATURES'],
  ['norton', 'NORTON'], ['xbox', 'XBOX'], ['microsoft', 'MSBILL'],
  ['soundcloud', 'SOUNDCLOUD'], ['ubisoft', 'UBISOFT'],
  ['netflix', 'NETFLIX'], ['apple', 'APPLE'],
];
function keywordFor(name) {
  const n = name.toLowerCase();
  for (const [k, v] of KEYWORDS) if (n.includes(k)) return v;
  const first = (n.split(/\s+/)[0] || '').replace(/[^a-z0-9]/g, '').toUpperCase();
  return first.length >= 3 ? first : null;
}

// Same-vendor subs are told apart by amount: a charge counts for this sub only
// if it lands within the band. Wide enough to absorb tax/price bumps, narrow
// enough that $107.50 never claims a $215 charge.
const amountBand = (cost) => Math.max(1.5, cost * 0.15);

function chargesFor(sub) {
  // Both tiers are a UNION, not a fallback: a sub often has itemized history
  // (old PayPal imports with real merchant names) AND newer opaque "PAYPAL WEB"
  // bank lines. Dating it by only one set goes falsely stale the month the
  // itemized data stops.
  const kw = keywordFor(sub.name);
  const desc = kw
    ? db.prepare(
        `SELECT date, amount FROM transactions
         WHERE counted = 1 AND (upper(description) LIKE ? OR upper(merchant) LIKE ?)
           AND ABS(amount - ?) <= ?
         ORDER BY date`
      ).all(`%${kw}%`, `%${kw}%`, sub.cost, amountBand(sub.cost))
    : [];
  // Opaque PayPal bank lines: amount is the only signal, so keep it tight.
  const pp = db.prepare(
    `SELECT date, amount FROM transactions
     WHERE counted = 1 AND upper(merchant) = 'PAYPAL' AND ABS(amount - ?) <= ?
     ORDER BY date`
  ).all(sub.cost, PAYPAL_TOLERANCE);

  const seen = new Set();
  const rows = [...desc.map((r) => ({ ...r, byDesc: true })), ...pp]
    .filter((r) => { const k = `${r.date}|${r.amount}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return { matchType: null, rows };
  return { matchType: desc.length ? 'description' : 'paypal', rows };
}

function suggestedNext(lastDate, cycle, today) {
  let next = parse(lastDate);
  let adv = 0;
  while (next <= today && adv++ < 5000) next = addCycle(next, cycle);
  return iso(next);
}

function report() {
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());

  const all = db.prepare('SELECT * FROM subscriptions ORDER BY name COLLATE NOCASE').all();
  const subs = [];
  const rebills = [];
  const doubles = [];
  const claimed = new Set();       // amounts claimed by any sub → excluded from "unknown"
  const activeClaims = new Set();  // date|amount rows owned by active subs

  // Active subs first, so their claims can veto amount-only rebill evidence —
  // an active $12.99 Spotify and a cancelled $12.89 M365 both amount-match the
  // same opaque PayPal row, and the active sub owns it.
  const matched = all.map((sub) => ({ sub, ...chargesFor(sub) }));
  for (const m of matched) {
    if (m.sub.status !== 'active') continue;
    for (const r of m.rows) activeClaims.add(`${r.date}|${round2(r.amount)}`);
  }

  for (const { sub, matchType, rows } of matched) {
    for (const r of rows) claimed.add(round2(r.amount));

    if (sub.status === 'cancelled') {
      // updated_at is the best available cancel marker (status flips touch it).
      // Description-matched rows are strong evidence and always count; opaque
      // amount-only rows count only when no active sub claims them.
      const cancelDate = String(sub.updated_at || '').slice(0, 10);
      const after = rows.filter((r) => cancelDate && r.date > cancelDate)
        .filter((r) => r.byDesc || !activeClaims.has(`${r.date}|${round2(r.amount)}`));
      if (after.length) {
        rebills.push({
          id: sub.id, name: sub.name, cancelDate,
          charges: after.map((r) => ({ date: r.date, amount: round2(r.amount) })),
        });
      }
      continue;
    }
    if (sub.status !== 'active') continue;

    // Charges much closer than the cycle allows = double charges (or two
    // overlapping subs sharing one price) — the honest signal behind most
    // "wait, why twice?" moments. All tight dates group into ONE entry per sub
    // so a 3-charge run doesn't spam one alert per adjacent pair.
    const cycleDaysDbl = CYCLE_DAYS[sub.billing_cycle] || CYCLE_DAYS.monthly;
    const tight = new Set();
    for (let i = 1; i < rows.length; i++) {
      const gap = (parse(rows[i].date) - parse(rows[i - 1].date)) / DAY;
      const recent = (new Date() - parse(rows[i].date)) / DAY <= DOUBLE_WINDOW_DAYS;
      if (recent && gap < DOUBLE_FACTOR * cycleDaysDbl) { tight.add(rows[i - 1].date); tight.add(rows[i].date); }
    }
    if (tight.size) {
      doubles.push({ id: sub.id, name: sub.name, amount: round2(rows[rows.length - 1].amount), dates: [...tight].sort() });
    }

    const last = rows.length ? rows[rows.length - 1] : null;
    // Re-price only from description-matched rows — an amount-matched row was
    // selected BY its amount, so "observed cost" from it would be circular.
    const lastDesc = [...rows].reverse().find((r) => r.byDesc) || null;
    const cycleDays = CYCLE_DAYS[sub.billing_cycle] || CYCLE_DAYS.monthly;
    const daysSince = last ? (today - parse(last.date)) / DAY : null;
    subs.push({
      id: sub.id, name: sub.name, cost: sub.cost, cycle: sub.billing_cycle,
      matchType,
      chargeCount: rows.length,
      lastCharge: last ? { date: last.date, amount: round2(last.amount) } : null,
      observedCost: lastDesc ? round2(lastDesc.amount) : (last ? round2(last.amount) : null),
      costDrift: !!(lastDesc && Math.abs(lastDesc.amount - sub.cost) > 0.01),
      suggestedNext: last ? suggestedNext(last.date, sub.billing_cycle, today) : null,
      currentNext: sub.next_billing_date,
      stale: !!(last && daysSince > STALE_FACTOR * cycleDays),
      neverSeen: !last,
    });
  }

  // Repeated PayPal amounts nothing accounts for — new/unknown autopays.
  const unknownRecurring = db.prepare(
    `SELECT amount, COUNT(*) count, MIN(date) firstDate, MAX(date) lastDate
     FROM transactions
     WHERE counted = 1 AND upper(merchant) = 'PAYPAL'
     GROUP BY amount HAVING COUNT(*) >= 2
     ORDER BY amount DESC`
  ).all()
    .filter((g) => ![...claimed].some((c) => Math.abs(c - g.amount) <= PAYPAL_TOLERANCE))
    .map((g) => ({ amount: round2(g.amount), count: g.count, firstDate: g.firstDate, lastDate: g.lastDate }));

  return { subs, rebills, doubles, unknownRecurring };
}

// Write the ledger's truth back: next_billing_date for every matched sub, cost
// only when a description match observed a genuinely different price.
function apply() {
  const r = report();
  const changes = [];
  const upd = db.prepare(
    `UPDATE subscriptions SET next_billing_date = ?, cost = ?, updated_at = datetime('now') WHERE id = ?`
  );
  for (const s of r.subs) {
    if (!s.lastCharge) continue;
    const newCost = s.costDrift ? s.observedCost : s.cost;
    if (s.suggestedNext === s.currentNext && newCost === s.cost) continue;
    upd.run(s.suggestedNext, newCost, s.id);
    changes.push({ id: s.id, name: s.name, next_billing_date: s.suggestedNext, cost: newCost });
  }
  return changes;
}

module.exports = { report, apply };
