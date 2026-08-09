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

test('transfers to a NON-own account count as spending (rent leaves as a "transfer")', () => {
  const profile = require('../profile');
  db.exec('DELETE FROM transactions');
  profile.set('own_accounts', '1111,2222');
  seedSimpleFin([
    { date: '2026-08-03', desc: 'TRANSFER FROM X1111 TO X2222', amount: 400 },  // my checking → my savings
    { date: '2026-08-05', desc: 'TRANSFER FROM X2222 TO X9999', amount: 500 },  // my savings → landlord: RENT
    { date: '2026-08-06', desc: 'ONLINE TRANSFER TO SAVINGS', amount: 50 },     // no target digits → internal
  ]);
  importSpending.run();

  const byDesc = Object.fromEntries(
    db.prepare("SELECT description, counted, category FROM transactions WHERE origin='simplefin'").all()
      .map((r) => [r.description, r])
  );
  assert.equal(byDesc['TRANSFER FROM X1111 TO X2222'].counted, 0, 'own-account shuffle excluded');
  assert.equal(byDesc['TRANSFER FROM X2222 TO X9999'].counted, 1, 'external transfer is real spending');
  assert.equal(byDesc['TRANSFER FROM X2222 TO X9999'].category, 'P2P / People');
  const rentRow = db.prepare("SELECT merchant FROM transactions WHERE description LIKE '%X9999%'").get();
  assert.equal(rentRow.merchant, 'TRANSFER TO X9999', 'target account becomes the merchant');
  assert.equal(byDesc['ONLINE TRANSFER TO SAVINGS'].counted, 0);

  // Without own_accounts configured, legacy behavior: everything excluded.
  profile.set('own_accounts', '');
  importSpending.run();
  const legacy = db.prepare("SELECT counted FROM transactions WHERE description LIKE '%X9999%'").get();
  assert.equal(legacy.counted, 0);
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
