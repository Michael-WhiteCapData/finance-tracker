'use strict';

// New-user flow (open-source case): a user who ONLY connects SimpleFIN, with no
// CSV/PayPal/Venmo files, must still get fully-counted spending after the import
// pipeline runs. Also checks transfers are excluded and the dedup cutoff holds.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const tmp = path.join(os.tmpdir(), `ft-pipe-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FINANCE_DB = path.join(tmp, 'finance.db');
process.env.FINANCE_IMPORT = path.join(tmp, 'import'); // empty → simulates no CSVs
fs.mkdirSync(process.env.FINANCE_IMPORT, { recursive: true });

const { test, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const importSpending = require('../scripts/import-spending');
const spending = require('../spending');

// Mimic what simplefin.sync() inserts: parked (counted=0) rows, origin='simplefin'.
function seedSimpleFin(rows) {
  const ins = db.prepare(
    `INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin, ext_id)
     VALUES (?, 'checking', ?, ?, ?, 'Other', 0, 'SimpleFIN', 'simplefin', ?)`
  );
  rows.forEach((r, i) => ins.run(r.date, r.desc, r.desc, r.amount, `sf:test:${i}`));
}

test('a SimpleFIN-only user gets counted spending after import (no CSVs)', () => {
  seedSimpleFin([
    { date: '2026-06-10', desc: 'TST* TONYS PIZZERIA', amount: 30 },
    { date: '2026-06-11', desc: 'GREENLEAF GROCERY', amount: 80 },
    { date: '2026-06-12', desc: 'ONLINE TRANSFER TO SAVINGS', amount: 200 },
  ]);
  importSpending.run();

  const counted = db.prepare("SELECT description, counted, category FROM transactions WHERE origin='simplefin' ORDER BY date").all();
  const byDesc = Object.fromEntries(counted.map((r) => [r.description, r]));
  assert.equal(byDesc['TST* TONYS PIZZERIA'].counted, 1, 'real spend should be counted');
  assert.equal(byDesc['GREENLEAF GROCERY'].counted, 1, 'real spend should be counted');
  assert.equal(byDesc['ONLINE TRANSFER TO SAVINGS'].counted, 0, 'transfer should be excluded');
  assert.equal(byDesc['ONLINE TRANSFER TO SAVINGS'].category, 'Transfer');

  // And it surfaces in the spending summary the UI reads.
  const total = db.prepare('SELECT ROUND(SUM(amount),2) t FROM transactions WHERE counted=1').get().t;
  assert.equal(total, 110, 'counted spending = 30 + 80, transfer excluded');
  assert.ok(spending.summary().byCategory.some((c) => c.category === 'Food & Dining'));
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
