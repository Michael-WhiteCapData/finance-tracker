'use strict';

// Forward-looking cashflow: projects each active subscription's next charge(s)
// and each upcoming paycheck across a window, so you can see what's about to hit
// and whether income covers it — the early-warning against overdrafts.

const { db } = require('./db');
const { round2 } = require('./util');
const incomeRepo = require('./income');
// Local-date helpers (not UTC) so "today" matches the user's calendar day and
// date math stays consistent with the local-dated transactions.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const DAY = 86400000;

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

// Map a subscription name to a description keyword we can find in the ledger.
function keywordFor(name) {
  const n = name.toLowerCase();
  const map = [
    ['claude', 'claude'], ['chatgpt', 'openai'], ['openai', 'openai'], ['spotify', 'spotify'],
    ['discord', 'discord'], ['github', 'github'], ['proton', 'proton'], ['higgsfield', 'higgsfield'],
    ['x developer', 'x corp'], ['norton', 'norton'], ['xbox', 'xbox'], ['microsoft', 'microsoft'],
    ['apple', 'apple'], ['netflix', 'netflix'], ['dynalist', 'dynalist'],
  ];
  for (const [k, v] of map) if (n.includes(k)) return v;
  return (n.split(/\s+/)[0] || '').replace(/[^a-z0-9]/g, '');
}

function lastCharge(name) {
  const kw = keywordFor(name);
  if (!kw || kw.length < 3) return null;
  const row = db.prepare(`SELECT MAX(date) d FROM transactions WHERE upper(description) LIKE ?`).get(`%${kw.toUpperCase()}%`);
  return row && row.d ? row.d : null;
}

function summary(days = 35) {
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()); // local midnight today
  const end = new Date(today.getTime() + days * DAY);

  const subs = db.prepare(`SELECT name, cost, billing_cycle, next_billing_date FROM subscriptions WHERE status = 'active'`).all();
  const upcoming = [];
  const undated = [];
  for (const s of subs) {
    const anchor = s.next_billing_date || lastCharge(s.name);
    if (!anchor) { undated.push({ name: s.name, amount: round2(s.cost), cycle: s.billing_cycle }); continue; }
    // Step forward from the anchor until we're in the future, then collect hits
    // in the window. The two loops use SEPARATE counters: a shared one let an old
    // anchor (many catch-up steps) exhaust the budget before any charge in the
    // window was collected, silently dropping the subscription from the forecast.
    let next = parse(anchor);
    let adv = 0;
    while (next <= today && adv++ < 5000) next = addCycle(next, s.billing_cycle);
    let col = 0;
    while (next <= end && col++ < 60) {
      upcoming.push({ date: iso(next), name: s.name, amount: round2(s.cost), cycle: s.billing_cycle, kind: 'charge' });
      next = addCycle(next, s.billing_cycle);
    }
  }

  // Upcoming paychecks: project EVERY active income source at its own cadence.
  // Pay isn't salaried — checks vary week to week — so each source projects at
  // its MEDIAN recent paycheck (the typical week), and carries its 25th
  // percentile so the balance line can also be run lean-week (the honest
  // overdraft warning for variable income).
  const income = [];
  const paySources = incomeRepo.sourceStats();
  for (const p of paySources) {
    let next = parse(p.lastDate);
    let adv = 0;
    while (next <= today && adv++ < 5000) next = addCycle(next, p.cycle);
    let col = 0;
    while (next <= end && col++ < 60) {
      income.push({ date: iso(next), name: p.name, amount: p.median, lean: p.p25, kind: 'income' });
      next = addCycle(next, p.cycle);
    }
  }

  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  income.sort((a, b) => a.date.localeCompare(b.date));

  // Real balances (from SimpleFIN) turn the running line into an actual
  // overdraft warning. Liquid = checking + savings; the card is tracked separately.
  const balRows = db.prepare('SELECT account, source, balance, available FROM balances').all();
  const liquid = balRows.filter((b) => b.source === 'checking' || b.source === 'savings');
  const hasBalances = liquid.length > 0;
  // Project from *available* (spendable today), not posted, so the overdraft
  // warning reflects money that's actually free of pending holds/transfers.
  const startingBalance = hasBalances ? round2(liquid.reduce((s, b) => s + (b.available ?? b.balance), 0)) : null;
  const cardRow = balRows.find((b) => b.source === 'creditcard');

  // Project the running balance to find the low point (and overdraft date, if
  // any) — twice: at typical (median) income, and at lean-week (p25) income.
  // Variable pay means the typical view can look safe while a run of lean
  // weeks still overdrafts; both views are surfaced.
  let lowest = startingBalance, lowestDate = null, overdraftDate = null;
  let lowestLean = startingBalance, leanOverdraftDate = null;
  if (hasBalances) {
    let run = startingBalance, runLean = startingBalance;
    const merged = [...upcoming, ...income].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of merged) {
      run += e.kind === 'income' ? e.amount : -e.amount;
      runLean += e.kind === 'income' ? (e.lean ?? e.amount) : -e.amount;
      if (run < lowest) { lowest = round2(run); lowestDate = e.date; }
      if (run < 0 && !overdraftDate) overdraftDate = e.date;
      if (runLean < lowestLean) lowestLean = round2(runLean);
      if (runLean < 0 && !leanOverdraftDate) leanOverdraftDate = e.date;
    }
  }

  const within = (arr, d) => arr.filter((x) => (parse(x.date) - today) / DAY <= d);
  const sum = (arr) => round2(arr.reduce((s, x) => s + x.amount, 0));
  const out14 = sum(within(upcoming, 14)), in14 = sum(within(income, 14));
  const out30 = sum(within(upcoming, 30)), in30 = sum(within(income, 30));

  // Merge into a single timeline for display.
  const timeline = [...upcoming, ...income].sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
    ...e, daysAway: Math.round((parse(e.date) - today) / DAY),
  }));

  return {
    today: iso(today), windowDays: days,
    timeline,
    undated,
    balances: {
      hasBalances,
      startingBalance,
      liquid: liquid.map((b) => ({ account: b.account, balance: round2(b.available ?? b.balance) })),
      card: cardRow ? round2(cardRow.balance) : null,
      lowest: hasBalances ? round2(lowest) : null,
      lowestDate,
      overdraftDate,
      lowestLean: hasBalances ? round2(lowestLean) : null,
      leanOverdraftDate,
    },
    incomeBasis: {
      method: 'median of recent paychecks (lean view: 25th percentile)',
      sources: paySources,
    },
    totals: {
      out14, in14, net14: round2(in14 - out14),
      out30, in30, net30: round2(in30 - out30),
    },
    chargeCount: upcoming.length,
    monthlySubTotal: round2(subs.reduce((s, x) => s + x.cost * ({ weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, yearly: 1 / 12 }[x.billing_cycle] ?? 1), 0)),
  };
}

module.exports = { summary };
