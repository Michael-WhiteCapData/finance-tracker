'use strict';

// PayPal activity-CSV ingestion (the two-click export from paypal.com →
// Activity → Download), added because the PDF+cipher .txt path was painful
// enough that PayPal data simply stopped being imported. Covers: parsing,
// money-out filtering, transfer/deposit skips, dedup against .txt-loaded rows,
// and dedup of the opaque bank funding line.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const tmp = path.join(os.tmpdir(), `ft-ppcsv-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FINANCE_DB = path.join(tmp, 'finance.db');
process.env.FINANCE_IMPORT = path.join(tmp, 'import');
fs.mkdirSync(path.join(process.env.FINANCE_IMPORT, 'paypal', '2026'), { recursive: true });

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const importSpending = require('../scripts/import-spending');

const PP_DIR = path.join(process.env.FINANCE_IMPORT, 'paypal');
const CSV_HEADER = '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Receipt ID","Balance"';
const csvRow = (date, name, type, status, amount) =>
  `"${date}","10:00:00","EDT","${name}","${type}","${status}","USD","${amount}","",""`;

function writeCsv(rows, file = path.join(PP_DIR, '2026', 'activity.csv')) {
  fs.writeFileSync(file, [CSV_HEADER, ...rows].join('\n'));
  return file;
}

function reset() {
  db.exec('DELETE FROM transactions');
  for (const y of fs.readdirSync(PP_DIR)) {
    const sub = path.join(PP_DIR, y);
    if (fs.statSync(sub).isDirectory()) for (const f of fs.readdirSync(sub)) fs.rmSync(path.join(sub, f));
  }
}
beforeEach(reset);

const paypalRows = () =>
  db.prepare(`SELECT * FROM transactions WHERE source = 'paypal' ORDER BY date`).all();

test('loads money-out rows from a PayPal activity CSV, skipping transfers and money-in', () => {
  writeCsv([
    csvRow('07/13/2026', 'AcmeShield LLC', 'PreApproved Payment Bill User Payment', 'Completed', '-29.90'),
    csvRow('07/13/2026', 'ExampleVendor Premium', 'PreApproved Payment Bill User Payment', 'Completed', '-42.99'),
    csvRow('07/14/2026', 'Bank Deposit to PP Account', 'Bank Deposit to PP Account', 'Completed', '53.19'),
    csvRow('07/15/2026', 'General Card Deposit', 'General Card Deposit', 'Completed', '-20.00'),
    csvRow('07/16/2026', 'Refund Corp', 'Payment Refund', 'Completed', '12.00'),
    csvRow('07/17/2026', 'Pending Merchant', 'Bill User Payment', 'Pending', '-5.00'),
  ]);
  importSpending.run();

  const rows = paypalRows();
  assert.equal(rows.length, 2);
  assert.equal(/acmeshield/i.test(rows[0].merchant) || /acmeshield/i.test(rows[0].description), true);
  assert.equal(rows[0].amount, 29.9);
  assert.equal(rows[1].amount, 42.99);
});

test('an itemized CSV row dedupes its opaque bank funding line', () => {
  writeCsv([csvRow('07/13/2026', 'AcmeShield LLC', 'PreApproved Payment Bill User Payment', 'Completed', '-29.90')]);
  // Mimic a SimpleFIN bank line for the same dollar (the "PAYPAL WEB" mystery shape).
  db.prepare(
    `INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin, ext_id)
     VALUES ('2026-07-13', 'checking', 'PAYPAL WEB', 'PAYPAL', 29.90, 'Other', 0, 'SimpleFIN', 'simplefin', 'sf:t:1')`
  ).run();
  importSpending.run();

  const bank = db.prepare(`SELECT * FROM transactions WHERE source = 'checking'`).all();
  assert.equal(bank.length, 1);
  assert.equal(bank[0].counted, 0, 'bank funding line must be deduped');
  const pp = paypalRows();
  assert.equal(pp.length, 1);
  assert.equal(pp[0].counted, 1, 'itemized row carries the spend');
});

test('handles the real export: BOM, auth/capture pairs, and refund netting', () => {
  // Real PayPal exports open with a UTF-8 BOM, emit a Pending "General
  // Authorization" alongside the Completed capture, and carry refunds as
  // positive rows that must cancel the purchase they reverse.
  const rows = [
    csvRow('07/12/2026', 'Valve Corp.', 'General Authorization', 'Pending', '-42.99'),
    csvRow('07/12/2026', 'Valve Corp.', 'Express Checkout Payment', 'Completed', '-42.99'),
    csvRow('07/12/2026', 'Valve Corp.', 'Payment Refund', 'Completed', '42.99'),
    csvRow('07/13/2026', 'Walmart.com', 'Express Checkout Payment', 'Completed', '-29.90'),
    csvRow('07/14/2026', 'G2A.COM Limited', 'General Authorization', 'Completed', '-26.22'),
    csvRow('07/15/2026', 'G2A.COM Limited', 'Express Checkout Payment', 'Completed', '-26.22'),
  ];
  fs.writeFileSync(path.join(PP_DIR, '2026', 'activity.csv'), '﻿' + [CSV_HEADER, ...rows].join('\n'));
  importSpending.run();

  const pp = paypalRows();
  // Refunded Valve purchase nets out; auth row (even Completed, next-day) never
  // loads beside its capture; Walmart + one G2A row remain.
  assert.deepEqual(pp.map((r) => [r.date, r.amount]), [['2026-07-13', 29.9], ['2026-07-15', 26.22]]);
});

test('dedup pairs each charge with its FOLLOWING bank line (same-amount cluster)', () => {
  // Two $10.74 Steam charges (7-17, 7-23) funded by bank lines 3-4 days later
  // (7-20, 7-27). Greedy first-match let the 7-23 charge steal the 7-20 line —
  // which lands BEFORE the charge, physically impossible for a funding line —
  // and left 7-27 orphaned (where it masqueraded as a GitHub charge).
  writeCsv([
    csvRow('07/23/2026', 'Valve Corp.', 'Bill User Payment', 'Completed', '-10.74'),
    csvRow('07/17/2026', 'Valve Corp.', 'Bill User Payment', 'Completed', '-10.74'),
  ]);
  const ins = db.prepare(
    `INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin, ext_id)
     VALUES (?, 'checking', 'PAYPAL WEB', 'PAYPAL', 10.74, 'Other', 0, 'SimpleFIN', 'simplefin', ?)`
  );
  ins.run('2026-07-20', 'sf:d:1');
  ins.run('2026-07-27', 'sf:d:2');
  importSpending.run();

  const counted = db.prepare(
    `SELECT date FROM transactions WHERE source = 'checking' AND counted = 1`
  ).all();
  assert.deepEqual(counted, [], 'both funding lines must be deduped');
});

test('CSV rows already present from a decoded .txt statement are not double-loaded', () => {
  // .txt statement layout: MM/DD/YYYY, type line, name line, then the amount.
  fs.writeFileSync(path.join(PP_DIR, '2026', 'statement.txt'),
    ['07/13/2026', 'PreApproved Payment', 'AcmeShield LLC', '-29.90', ''].join('\n'));
  writeCsv([csvRow('07/13/2026', 'AcmeShield LLC', 'PreApproved Payment Bill User Payment', 'Completed', '-29.90')]);
  importSpending.run();

  assert.equal(paypalRows().length, 1);
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
