'use strict';

// Subscription ↔ ledger reconciliation: keeps the curated subscriptions table
// honest against the observed transactions. Covers description-keyword matching,
// PayPal amount matching, cost drift, staleness, cancelled-sub rebills, and the
// apply() writer. Runs against an isolated temp DB.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.FINANCE_DB = path.join(os.tmpdir(), `ft-reconcile-${process.pid}.db`);

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const reconcile = require('../reconcile');

const DAY = 86400000;
const today = new Date();
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => dstr(new Date(today.getTime() - n * DAY));

function reset() {
  for (const t of ['transactions', 'subscriptions']) db.exec(`DELETE FROM ${t}`);
}
const addTx = (date, amount, { merchant = 'Merchant', description = merchant, source = 'checking' } = {}) =>
  db.prepare(`INSERT INTO transactions (date, source, description, merchant, amount, category, counted, origin)
              VALUES (?,?,?,?,?,'Subscriptions',1,'import')`)
    .run(date, source, description, merchant, amount);
const addSub = (name, cost, cycle = 'monthly', status = 'active', updated_at = null) => {
  db.prepare(`INSERT INTO subscriptions (name, cost, billing_cycle, category, status, updated_at)
              VALUES (?,?,?,'Subscriptions',?,?)`)
    .run(name, cost, cycle, status, updated_at || `${daysAgo(60)} 00:00:00`);
  return Number(db.prepare('SELECT last_insert_rowid() id').get().id);
};
const entry = (report, name) => report.subs.find((s) => s.name === name);

beforeEach(reset);

test('matches a sub to ledger charges by description keyword and reports cost drift', () => {
  addSub('ChatGPT Plus', 20);
  addTx(daysAgo(40), 21.5, { merchant: 'OPENAI CHATGPT', description: 'OPENAI CHATGPT SUBSCR' });
  addTx(daysAgo(10), 21.5, { merchant: 'OPENAI CHATGPT', description: 'OPENAI CHATGPT SUBSCR' });

  const e = entry(reconcile.report(), 'ChatGPT Plus');
  assert.equal(e.matchType, 'description');
  assert.equal(e.lastCharge.date, daysAgo(10));
  assert.equal(e.observedCost, 21.5);
  assert.equal(e.costDrift, true);
  assert.equal(e.chargeCount, 2);
  assert.ok(e.suggestedNext > dstr(today), 'suggestedNext is in the future');
});

test('amount tolerance keeps same-keyword subs separate (Claude Max vs Max 5x)', () => {
  addSub('Claude Max', 215);
  addSub('Claude Max 5x', 107.5);
  addTx(daysAgo(12), 215, { description: 'ANTHROPIC CLAUDE SUB' });
  addTx(daysAgo(14), 107.5, { description: 'ANTHROPIC CLAUDE SUB' });

  const r = reconcile.report();
  assert.equal(entry(r, 'Claude Max').lastCharge.amount, 215);
  assert.equal(entry(r, 'Claude Max 5x').lastCharge.amount, 107.5);
  assert.equal(entry(r, 'Claude Max').chargeCount, 1);
});

test('matches PayPal-funded subs by amount when the bank line is opaque', () => {
  addSub('Discord Nitro', 11.02);
  addTx(daysAgo(30), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  addTx(daysAgo(1), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });

  const e = entry(reconcile.report(), 'Discord Nitro');
  assert.equal(e.matchType, 'paypal');
  assert.equal(e.lastCharge.date, daysAgo(1));
  assert.equal(e.costDrift, false);
});

test('merges itemized history with newer opaque PayPal lines (no false stale)', () => {
  // Real-world shape: old imports carried itemized PayPal rows with merchant
  // names; the live bank feed only shows "PAYPAL WEB". A sub must be dated by
  // the union of both, or it goes falsely stale the month itemized data stops.
  addSub('Spotify Premium', 12.99);
  addTx(daysAgo(85), 12.99, { merchant: 'Spotify USA', description: 'Spotify USA', source: 'paypal' });
  addTx(daysAgo(55), 12.99, { merchant: 'Spotify USA', description: 'Spotify USA', source: 'paypal' });
  addTx(daysAgo(25), 12.99, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });

  const e = entry(reconcile.report(), 'Spotify Premium');
  assert.equal(e.matchType, 'description');
  assert.equal(e.lastCharge.date, daysAgo(25));
  assert.equal(e.chargeCount, 3);
  assert.equal(e.stale, false);
});

test('flags an active sub as stale when no charge lands within 1.6 cycles', () => {
  addSub('Higgsfield', 59);
  addTx(daysAgo(75), 59, { description: 'HIGGSFIELD INC.' });

  const e = entry(reconcile.report(), 'Higgsfield');
  assert.equal(e.stale, true);

  addSub('Spotify Premium', 12.99);
  addTx(daysAgo(5), 12.99, { description: 'SPOTIFY USA' });
  assert.equal(entry(reconcile.report(), 'Spotify Premium').stale, false);
});

test('reports a never-seen sub without marking it stale', () => {
  addSub('Proton Unlimited (#2)', 9.99);
  const e = entry(reconcile.report(), 'Proton Unlimited (#2)');
  assert.equal(e.lastCharge, null);
  assert.equal(e.neverSeen, true);
  assert.equal(e.stale, false);
});

test('detects a rebill of a cancelled sub (including opaque PayPal near-amounts)', () => {
  addSub('AcmeShield (UNRECOGNIZED)', 29.95, 'monthly', 'cancelled', `${daysAgo(45)} 00:00:00`);
  addTx(daysAgo(60), 29.95, { merchant: 'PAYPAL', description: 'PAYPAL WEB' }); // before cancel — fine
  addTx(daysAgo(20), 29.9, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });  // after cancel — rebill

  const r = reconcile.report();
  assert.equal(r.rebills.length, 1);
  assert.equal(r.rebills[0].name, 'AcmeShield (UNRECOGNIZED)');
  assert.equal(r.rebills[0].charges.length, 1);
  assert.equal(r.rebills[0].charges[0].date, daysAgo(20));
});

test('does not report a rebill from a row an active sub already claims', () => {
  // Spotify ($12.99, active) and M365 ($12.89, cancelled) sit within the PayPal
  // amount tolerance of the same opaque row — the active sub owns it.
  addSub('Spotify Premium', 12.99);
  addSub('Microsoft 365 (personal)', 12.89, 'monthly', 'cancelled', `${daysAgo(45)} 00:00:00`);
  addTx(daysAgo(10), 12.99, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });

  const r = reconcile.report();
  assert.equal(r.rebills.length, 0);
  assert.equal(entry(r, 'Spotify Premium').lastCharge.date, daysAgo(10));
});

test('a description-matched rebill is reported even if amounts collide', () => {
  addSub('Spotify Premium', 12.99);
  addSub('AcmeShield (UNRECOGNIZED)', 12.99, 'monthly', 'cancelled', `${daysAgo(45)} 00:00:00`);
  addTx(daysAgo(10), 12.99, { merchant: 'ACMESHIELD LLC', description: 'ACMESHIELD LLC' });

  const r = reconcile.report();
  assert.equal(r.rebills.length, 1);
  assert.equal(r.rebills[0].name, 'AcmeShield (UNRECOGNIZED)');
});

test('flags an active sub charged twice within a fraction of its cycle', () => {
  addSub('GitHub', 10.74);
  addTx(daysAgo(20), 10.74, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  addTx(daysAgo(13), 10.74, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });

  const r = reconcile.report();
  assert.equal(r.doubles.length, 1);
  assert.equal(r.doubles[0].name, 'GitHub');
  assert.deepEqual(r.doubles[0].dates, [daysAgo(20), daysAgo(13)]);

  // Three tight charges = ONE grouped entry (was one entry per adjacent pair).
  addTx(daysAgo(6), 10.74, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  const r2 = reconcile.report();
  assert.equal(r2.doubles.length, 1);
  assert.deepEqual(r2.doubles[0].dates, [daysAgo(20), daysAgo(13), daysAgo(6)]);

  // A normal monthly gap must not flag.
  reset();
  addSub('Discord Nitro', 11.02);
  addTx(daysAgo(32), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  addTx(daysAgo(1), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  assert.equal(reconcile.report().doubles.length, 0);
});

test('surfaces repeated unmatched PayPal amounts as unknown recurring', () => {
  addSub('Discord Nitro', 11.02);
  addTx(daysAgo(40), 42.99, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  addTx(daysAgo(10), 42.99, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });
  addTx(daysAgo(10), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' }); // claimed by Nitro

  const r = reconcile.report();
  assert.equal(r.unknownRecurring.length, 1);
  assert.equal(r.unknownRecurring[0].amount, 42.99);
  assert.equal(r.unknownRecurring[0].count, 2);
});

test('apply() writes next_billing_date always, cost only for description matches', () => {
  const idDesc = addSub('ChatGPT Plus', 20);
  const idPp = addSub('Discord Nitro', 11);
  addTx(daysAgo(10), 21.5, { description: 'OPENAI CHATGPT SUBSCR' });
  addTx(daysAgo(2), 11.02, { merchant: 'PAYPAL', description: 'PAYPAL WEB' });

  const changes = reconcile.apply();
  assert.equal(changes.length, 2);

  const descRow = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(idDesc);
  assert.equal(descRow.cost, 21.5);
  assert.ok(descRow.next_billing_date > dstr(today));

  const ppRow = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(idPp);
  assert.equal(ppRow.cost, 11, 'amount-matched cost must not be rewritten from the amount that matched it');
  assert.ok(ppRow.next_billing_date > dstr(today));
});

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.FINANCE_DB + ext); } catch {} } });
