'use strict';

// Manual accounts the bank feed can't reach (investments, cash, 401k, an
// un-connected credit card). They live in the balances table with kind='manual'
// so they count toward net worth and survive syncs (which only touch live rows).

const { db } = require('./db');
const { round2 } = require('./util');

// Credit card / loan balances are debt → stored negative so net worth sums cleanly.
const DEBT = new Set(['creditcard', 'loan']);
const TYPES = ['checking', 'savings', 'investment', 'retirement', 'cash', 'creditcard', 'loan', 'other'];

function list() {
  return db.prepare("SELECT account, source, balance FROM balances WHERE kind = 'manual' ORDER BY account").all();
}

function add({ name, type, balance }) {
  const n = String(name || '').trim().slice(0, 60);
  const t = TYPES.includes(type) ? type : 'other';
  let bal = Number(balance);
  if (!n) throw new Error('Account name is required');
  if (!Number.isFinite(bal)) throw new Error('Balance must be a number');
  // Don't let a manual account clobber a live (SimpleFIN) account of the same name.
  const existing = db.prepare('SELECT kind FROM balances WHERE account = ?').get(n);
  if (existing && existing.kind !== 'manual') {
    throw new Error(`"${n}" is already a live bank account — use a different name`);
  }
  bal = DEBT.has(t) ? -Math.abs(bal) : Math.abs(bal); // debts negative, assets positive
  db.prepare(
    `INSERT INTO balances (account, source, balance, available, as_of, manual, kind, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'manual', datetime('now'))
     ON CONFLICT(account) DO UPDATE SET source=excluded.source, balance=excluded.balance,
       available=excluded.available, as_of=excluded.as_of, kind='manual', updated_at=datetime('now')`
  ).run(n, t, round2(bal), round2(bal), new Date().toISOString().slice(0, 10));
  return { account: n, source: t, balance: round2(bal) };
}

function remove(account) {
  return db.prepare("DELETE FROM balances WHERE account = ? AND kind = 'manual'").run(account).changes > 0;
}

module.exports = { list, add, remove, TYPES };
