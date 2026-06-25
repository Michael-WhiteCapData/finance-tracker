'use strict';

// Analytics + alerting: the money-sensitive derivations added alongside the
// Alerts feed. Covers the available-vs-posted forecast, overdraft detection,
// budget pace, the 3-month budget suggester, and the unified alert feed.
// Runs against an isolated temp DB; each test resets the tables it touches.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.FINANCE_DB = path.join(os.tmpdir(), `ft-analytics-${process.pid}.db`);

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const forecast = require('../forecast');
const month = require('../month');
const budgets = require('../budgets');
const alerts = require('../alerts');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const today = new Date();
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function reset() {
  for (const t of ['balances', 'transactions', 'subscriptions', 'income', 'budgets', 'balance_history', 'category_overrides']) {
    db.exec(`DELETE FROM ${t}`);
  }
}
const addBal = (account, source, balance, available) =>
  db.prepare(`INSERT INTO balances (account, source, balance, available, as_of, manual, kind) VALUES (?,?,?,?,?,0,'live')`)
    .run(account, source, balance, available, dstr(today));
const addTx = (date, amount, category, merchant = 'Merchant', source = 'checking') =>
  db.prepare(`INSERT INTO transactions (date, source, description, merchant, amount, category, counted, origin) VALUES (?,?,?,?,?,?,1,'import')`)
    .run(date, source, merchant, merchant, amount, category);
const addSub = (name, cost, cycle, next_billing_date) =>
  db.prepare(`INSERT INTO subscriptions (name, cost, billing_cycle, category, next_billing_date, status) VALUES (?,?,?,?,?,'active')`)
    .run(name, cost, cycle, 'Subscriptions', next_billing_date);

beforeEach(reset);

test('forecast projects from available balance, not posted', () => {
  addBal('Checking ••0001', 'checking', 50.00, 350.00);   // posted 50, available 350
  addBal('Savings ••0002', 'savings', 3000.00, 2700.00);  // posted 3000, available 2700
  const f = forecast.summary();
  assert.ok(near(f.balances.startingBalance, 3050.00), 'starting = available sum (350 + 2700)');
  const chk = f.balances.liquid.find((b) => b.account.includes('Checking'));
  assert.ok(near(chk.balance, 350.00), 'per-account shows available, not posted 50');
  assert.equal(f.balances.overdraftDate, null);
});

test('forecast flags an overdraft when an upcoming charge exceeds available', () => {
  addBal('Checking ••1', 'checking', 10, 10);
  const tomorrow = new Date(today.getTime() + 86400000);
  addSub('BigThing', 100, 'monthly', dstr(tomorrow));
  const f = forecast.summary();
  assert.equal(f.balances.overdraftDate, dstr(tomorrow));
  assert.ok(f.balances.lowest < 0);
});

test('month marks a category over budget when projected spend exceeds the limit', () => {
  addTx(dstr(today), 50, 'Food & Dining');
  budgets.set('Food & Dining', 1); // tiny budget → guaranteed over once projected
  const m = month.summary();
  const cat = m.spending.byCategory.find((c) => c.category === 'Food & Dining');
  assert.ok(cat, 'category appears in the month breakdown');
  assert.equal(cat.budget, 1);
  assert.equal(cat.overBudget, true);
});

test('budgets.suggest proposes limits from the last 3 months average and skips budgeted cats', () => {
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 15);
    addTx(dstr(d), 100, 'Groceries');
  }
  const g = budgets.suggest().find((x) => x.category === 'Groceries');
  assert.ok(g, 'Groceries is suggested');
  assert.ok(near(g.avg, 100));
  assert.equal(g.monthly_limit, 100); // ceil(100/5)*5
  budgets.set('Groceries', 80);
  assert.ok(!budgets.suggest().some((x) => x.category === 'Groceries'), 'already-budgeted cats are excluded');
});

test('budgets set / list / totalLimit, and 0 removes', () => {
  budgets.set('Gas & Auto', 40);
  budgets.set('Food & Dining', 60);
  assert.equal(budgets.list()['Gas & Auto'], 40);
  assert.equal(budgets.totalLimit(), 100);
  budgets.set('Gas & Auto', 0);
  assert.equal(budgets.list()['Gas & Auto'], undefined);
  assert.equal(budgets.totalLimit(), 60);
});

test('alerts.build surfaces a critical overdraft with a coherent counts shape', () => {
  addBal('Checking ••1', 'checking', 5, 5);
  const tomorrow = new Date(today.getTime() + 86400000);
  addSub('BigThing', 200, 'monthly', dstr(tomorrow));
  const a = alerts.build();
  assert.ok(a.total >= 1);
  assert.ok(a.counts.critical >= 1);
  assert.ok(a.alerts.some((x) => x.id.startsWith('overdraft') && x.severity === 'critical'));
  assert.equal(a.counts.critical + a.counts.warning + a.counts.info, a.total);
});

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.FINANCE_DB + ext); } catch {} } });
