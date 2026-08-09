'use strict';

// Variable income: per-source pay stats, paycheck auto-capture from bank
// deposits, and the median/lean-week forecast basis. Runs on an isolated DB.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.FINANCE_DB = path.join(os.tmpdir(), `ft-varinc-${process.pid}.db`);

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const income = require('../income');
const forecast = require('../forecast');

const DAY = 86400000;
const today = new Date();
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => dstr(new Date(today.getTime() - n * DAY));

function reset() {
  for (const t of ['income', 'deposits', 'subscriptions', 'transactions', 'balances']) db.exec(`DELETE FROM ${t}`);
}
const addPaycheck = (name, cost, date, cycle = 'weekly') =>
  db.prepare(`INSERT INTO income (name, cost, billing_cycle, category, next_billing_date, status)
              VALUES (?,?,?,'Payroll',?,'active')`).run(name, cost, cycle, date);
const addDeposit = (date, description, amount, ext = null) =>
  db.prepare(`INSERT INTO deposits (date, source, description, amount, ext_id) VALUES (?,'checking',?,?,?)`)
    .run(date, description, amount, ext || `t:${date}:${amount}`);

beforeEach(reset);

test('sourceStats reports median, p25, and last paycheck per source', () => {
  const amounts = [400, 450, 500, 550, 600]; // median 500, p25 450
  amounts.forEach((a, i) => addPaycheck('Acme Weekly', a, daysAgo(7 * (amounts.length - i))));
  const [s] = income.sourceStats();
  assert.equal(s.name, 'Acme Weekly');
  assert.equal(s.median, 500);
  assert.equal(s.p25, 450);
  assert.equal(s.n, 5);
  assert.equal(s.lastDate, daysAgo(7));
});

test('syncFromDeposits appends matching deposits and is idempotent', () => {
  addPaycheck('Acme Weekly', 480, daysAgo(21));
  addDeposit(daysAgo(14), 'ACME WEEKLY PAYROLL PPD', 512.34);
  addDeposit(daysAgo(7), 'ACME WEEKLY PAYROLL PPD', 455.1);
  addDeposit(daysAgo(6), 'ONLINE TRANSFER FROM SAVINGS', 300); // must never match
  addDeposit(daysAgo(20), 'ACME WEEKLY PAYROLL PPD', 480);     // ±2d of the hand-entered row → skip
  // Keyword hit but conduit/refund descriptor — a PayPal refund addressed to
  // the account holder is not a paycheck.
  addDeposit(daysAgo(5), 'PAYPAL INST XFER ACME WEEKLY', 42.99);

  assert.equal(income.syncFromDeposits().added, 2);
  assert.equal(income.syncFromDeposits().added, 0, 'second run adds nothing');
  const rows = db.prepare(`SELECT cost FROM income WHERE name = 'Acme Weekly' ORDER BY next_billing_date`).all();
  assert.deepEqual(rows.map((r) => r.cost), [480, 512.34, 455.1]);
});

test('forecast projects variable income at the median and runs a lean-week balance', () => {
  // Recent checks 300..700 (median 500, p25 400); last check 3 days ago.
  [300, 400, 500, 600, 700].forEach((a, i) => addPaycheck('Acme Weekly', a, daysAgo(3 + 7 * (4 - i))));
  db.prepare(`INSERT INTO balances (account, source, balance, available, as_of, manual, kind)
              VALUES ('Checking','checking',1000,1000,?,0,'live')`).run(dstr(today));

  const f = forecast.summary(20);
  const inc = f.timeline.filter((e) => e.kind === 'income');
  assert.ok(inc.length >= 2);
  assert.ok(inc.every((e) => e.amount === 500), 'projects the median, not the last check');
  assert.ok(f.balances.lowestLean <= f.balances.lowest, 'lean view can only be tighter');
  assert.equal(f.incomeBasis.sources[0].p25, 400);
});

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.FINANCE_DB + ext); } catch {} } });
