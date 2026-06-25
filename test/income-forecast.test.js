'use strict';

// Phase-1 correctness fixes: multi-source income, forecast cadence/multi-source,
// the old-anchor guard, date validation, and content-specific alert ids.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.FINANCE_DB = path.join(os.tmpdir(), `ft-incfc-${process.pid}.db`);

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const income = require('../income');
const forecast = require('../forecast');
const subscriptions = require('../subscriptions');
const alerts = require('../alerts');

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const today = new Date();
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return dstr(d); };

function reset() {
  for (const t of ['balances', 'transactions', 'subscriptions', 'income', 'budgets', 'balance_history', 'category_overrides']) db.exec(`DELETE FROM ${t}`);
}
const addBal = (acct, source, bal) =>
  db.prepare(`INSERT INTO balances (account, source, balance, available, as_of, manual, kind) VALUES (?,?,?,?,?,0,'live')`).run(acct, source, bal, bal, dstr(today));
const addIncome = (name, cost, cycle, date) =>
  db.prepare(`INSERT INTO income (name, cost, billing_cycle, category, next_billing_date, status) VALUES (?,?,?,?,?,'active')`).run(name, cost, cycle, 'Income', date);
const addSub = (name, cost, cycle, date) =>
  db.prepare(`INSERT INTO subscriptions (name, cost, billing_cycle, category, next_billing_date, status) VALUES (?,?,?,?,?,'active')`).run(name, cost, cycle, 'Subscriptions', date);

beforeEach(reset);

test('monthlyTotal SUMS distinct income sources (was halving)', () => {
  addIncome('Job A', 1000, 'weekly', daysAgo(3));   // 1000 * 52/12 = 4333.33/mo
  addIncome('Job B', 2000, 'biweekly', daysAgo(5));  // 2000 * 26/12 = 4333.33/mo
  // Correct combined monthly run-rate is the SUM, ~8666.67 — not the average (~4333).
  assert.ok(near(income.monthlyTotal(), 8666.67, 0.5), `got ${income.monthlyTotal()}`);
});

test('forecast projects each income source at its OWN cadence and keeps both', () => {
  addBal('Checking', 'checking', 5000);
  addIncome('Biweekly Job', 500, 'biweekly', daysAgo(2));
  addIncome('Weekly Job', 300, 'weekly', daysAgo(1));
  const f = forecast.summary(35);
  const names = new Set(f.timeline.filter((e) => e.kind === 'income').map((e) => e.name));
  assert.ok(names.has('Biweekly Job') && names.has('Weekly Job'), 'both income sources appear');
  const biweekly = f.timeline.filter((e) => e.kind === 'income' && e.name === 'Biweekly Job').map((e) => e.date).sort();
  assert.ok(biweekly.length >= 2, 'biweekly job projected more than once');
  const gap = (new Date(biweekly[1]) - new Date(biweekly[0])) / 86400000;
  assert.equal(gap, 14, 'biweekly spacing is 14 days, not hardcoded 7');
});

test('forecast keeps a subscription with a very old anchor (guard fix)', () => {
  addBal('Checking', 'checking', 1000);
  addSub('OldMonthly', 10, 'monthly', '2018-01-15'); // ~100 catch-up steps — old shared guard dropped it
  const charges = forecast.summary(35).timeline.filter((e) => e.kind === 'charge' && e.name === 'OldMonthly');
  assert.ok(charges.length >= 1, 'old-anchor subscription still appears in the forecast');
});

test('next_billing_date must be YYYY-MM-DD', () => {
  assert.throws(() => subscriptions.createSubscription({ name: 'Bad', cost: 5, next_billing_date: 'not-a-date' }));
  assert.throws(() => income.createIncome({ name: 'Bad', cost: 5, billing_cycle: 'weekly', next_billing_date: '2024/01/01' }));
  assert.doesNotThrow(() => subscriptions.createSubscription({ name: 'Good', cost: 5, next_billing_date: '2026-07-01' }));
});

test('overdraft alert id is content-specific (re-surfaces a new overdraft)', () => {
  addBal('Checking', 'checking', 5);
  const tomorrow = new Date(today.getTime() + 86400000);
  addSub('Big', 200, 'monthly', dstr(tomorrow));
  const a = alerts.build();
  assert.ok(a.alerts.some((x) => x.id.startsWith('overdraft:') && x.severity === 'critical'), 'id carries the date');
});

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.FINANCE_DB + ext); } catch {} } });
