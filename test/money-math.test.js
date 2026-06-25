'use strict';

// Money-critical math: billing-cycle conversion, net worth (incl. signed debt),
// and savings-goal progress. Runs against an isolated temp DB.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.FINANCE_DB = path.join(os.tmpdir(), `ft-money-${process.pid}.db`);

const { test, after } = require('node:test');
const assert = require('node:assert');
const subs = require('../subscriptions');
const accounts = require('../accounts');
const goals = require('../goals');
const simplefin = require('../simplefin');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('billing cycle converts to the correct monthly equivalent', () => {
  assert.ok(near(subs.createSubscription({ name: 'Wk', cost: 100, billing_cycle: 'weekly' }).monthly, 433.33));
  assert.equal(subs.createSubscription({ name: 'Mo', cost: 50, billing_cycle: 'monthly' }).monthly, 50);
  assert.equal(subs.createSubscription({ name: 'Qt', cost: 30, billing_cycle: 'quarterly' }).monthly, 10);
  assert.equal(subs.createSubscription({ name: 'Yr', cost: 120, billing_cycle: 'yearly' }).monthly, 10);
  assert.ok(near(subs.createSubscription({ name: 'Bw', cost: 100, billing_cycle: 'biweekly' }).monthly, 216.67));
});

test('net worth sums assets and subtracts debts (debt stored negative)', () => {
  accounts.add({ name: 'Brokerage', type: 'investment', balance: 10000 });
  accounts.add({ name: 'Cash box', type: 'cash', balance: 500 });
  accounts.add({ name: 'Visa', type: 'creditcard', balance: 1500 }); // owed → stored as -1500
  const b = simplefin.balances();
  assert.equal(b.net, 9000);          // 10000 + 500 - 1500
  assert.equal(b.card, -1500);        // debt is negative
  assert.equal(b.liquid, 500);        // only cash/checking/savings count as liquid
});

test('savings goal reports correct progress vs net worth', () => {
  const g = goals.create({ name: 'Test fund', target: 18000 });
  const row = goals.list().find((x) => x.id === g.id);
  assert.equal(row.current, 9000);    // matches net worth above
  assert.equal(row.pct, 50);          // 9000 / 18000
  assert.equal(row.remaining, 9000);
});

test('goal validation rejects bad input', () => {
  assert.throws(() => goals.create({ name: '', target: 100 }));
  assert.throws(() => goals.create({ name: 'x', target: -5 }));
});

after(() => { try { fs.rmSync(process.env.FINANCE_DB); fs.rmSync(process.env.FINANCE_DB + '-wal'); fs.rmSync(process.env.FINANCE_DB + '-shm'); } catch {} });
