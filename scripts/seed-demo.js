'use strict';

// Populate a database with realistic FAKE data — for demos, screenshots, and
// trying the app without connecting a real bank. Writes to whatever DB is
// configured (FINANCE_DB env var, default finance.db), so run it against a
// throwaway file:  FINANCE_DB=/tmp/demo.db node --experimental-sqlite scripts/seed-demo.js
// NEVER run this against a database that holds real data — it clears tables first.

const { db } = require('../db');
const subs = require('../subscriptions');
const income = require('../income');

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(today.getTime() - n * 86400000));

// Reset
for (const t of ['subscriptions', 'income', 'transactions', 'balances', 'budgets', 'category_overrides', 'config']) {
  try { db.exec(`DELETE FROM ${t}`); } catch {}
}

// Subscriptions
[
  ['Netflix', 15.49, 'monthly', 'Subscriptions'],
  ['Spotify', 11.99, 'monthly', 'Subscriptions'],
  ['ChatGPT Plus', 20.0, 'monthly', 'Subscriptions'],
  ['GitHub Pro', 4.0, 'monthly', 'Subscriptions'],
  ['iCloud+', 2.99, 'monthly', 'Subscriptions'],
  ['Gym membership', 39.0, 'monthly', 'Bills & Utilities'],
  ['Amazon Prime', 139.0, 'yearly', 'Shopping'],
].forEach(([name, cost, cycle, cat]) =>
  subs.createSubscription({ name, cost, billing_cycle: cycle, category: cat, status: 'active' }));

// Income — weekly paychecks for the last 10 weeks
for (let w = 0; w < 10; w++) {
  income.createIncome({
    name: 'Acme Corp payroll', cost: 1100 + Math.round((Math.sin(w) * 80)),
    billing_cycle: 'weekly', category: 'Salary / Payroll',
    next_billing_date: daysAgo(w * 7 + 2), status: 'active',
  });
}

// Transactions across categories
const MERCHANTS = [
  ['Whole Foods', 'Groceries', 60, 140], ['Trader Joe\'s', 'Groceries', 30, 90],
  ['Shell', 'Gas & Auto', 35, 70], ['Chipotle', 'Food & Dining', 9, 18],
  ['Starbucks', 'Food & Dining', 4, 9], ['Local Tavern', 'Food & Dining', 25, 70],
  ['Amazon', 'Shopping', 12, 120], ['Target', 'Shopping', 20, 95],
  ['Steam', 'Gaming', 5, 60], ['CVS Pharmacy', 'Health', 8, 45],
  ['Venmo — roommate', 'P2P / People', 200, 600], ['PAID ITEM FEE', 'Fees & Charges', 36, 36],
];
const tx = db.prepare(`INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin) VALUES (?, 'checking', ?, ?, ?, ?, 1, NULL, 'import')`);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
db.exec('BEGIN');
for (let d = 0; d < 95; d++) {
  const n = Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const [m, cat, lo, hi] = MERCHANTS[Math.floor(rand() * MERCHANTS.length)];
    const amt = Math.round((lo + rand() * (hi - lo)) * 100) / 100;
    tx.run(daysAgo(d), m, m.toUpperCase(), amt, cat);
  }
}
db.exec('COMMIT');

// Balances
const bal = db.prepare(`INSERT INTO balances (account, source, balance, available, as_of, manual) VALUES (?, ?, ?, ?, ?, 0)`);
bal.run('Checking ••1234', 'checking', 2840.55, 2840.55, iso(today));
bal.run('Savings ••5678', 'savings', 8120.00, 8120.00, iso(today));
db.prepare(`INSERT INTO config (key, value) VALUES ('simplefin_access_url', 'demo://connected')`).run();

console.log('Demo data seeded. Start with the same FINANCE_DB to view it.');
