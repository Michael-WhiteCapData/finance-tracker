'use strict';

// Single source of the database connection + schema.
// Uses Node's built-in SQLite (node:sqlite) so there are no native
// dependencies to compile — runs anywhere Node 22.5+ is installed.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.FINANCE_DB || path.join(__dirname, 'finance.db');

const db = new DatabaseSync(DB_PATH);

// Pragmas for a small local single-user app: WAL is fine and durable.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    cost              REAL    NOT NULL,
    billing_cycle     TEXT    NOT NULL DEFAULT 'monthly',
    category          TEXT    NOT NULL DEFAULT 'Other',
    next_billing_date TEXT,
    status            TEXT    NOT NULL DEFAULT 'active',
    notes             TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Income mirrors the subscriptions shape (same columns) so the data layer and
// API pattern stay identical. Here `cost` is the amount per period, `billing_cycle`
// is the pay frequency, `category` is the income type, and `next_billing_date` is
// the next expected payment date. Default frequency is weekly (paychecks).
db.exec(`
  CREATE TABLE IF NOT EXISTS income (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    cost              REAL    NOT NULL,
    billing_cycle     TEXT    NOT NULL DEFAULT 'weekly',
    category          TEXT    NOT NULL DEFAULT 'Other',
    next_billing_date TEXT,
    status            TEXT    NOT NULL DEFAULT 'active',
    notes             TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Spending transactions: a unified ledger of money-out across every source
// (bank checking/savings, PayPal, Venmo, Cash App). `counted = 0` marks rows
// excluded from spending totals — internal transfers, failed payments, or a
// bank funding line that's deduped against an itemized platform payment.
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    description TEXT,
    merchant    TEXT,
    amount      REAL    NOT NULL,
    category    TEXT    NOT NULL DEFAULT 'Other',
    counted     INTEGER NOT NULL DEFAULT 1,
    note        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat  ON transactions(category);
`);

// `origin` distinguishes CSV-imported rows (rebuilt wholesale on reimport) from
// live-synced rows (SimpleFIN), which must survive a CSV reimport. `ext_id` is
// the provider's transaction id, used to de-dup live syncs.
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn('transactions', 'origin', "TEXT NOT NULL DEFAULT 'import'");
ensureColumn('transactions', 'ext_id', 'TEXT');

// Key/value config (e.g. the SimpleFIN access URL — a secret, lives only in this
// git-ignored DB) and latest account balances for the live overdraft forecast.
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS balances (
    account   TEXT PRIMARY KEY,
    source    TEXT,
    balance   REAL,
    available REAL,
    as_of     TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// `manual` flags a hand-adjusted balance (e.g. a transfer the bank feed hasn't
// posted yet) so the UI can mark it and the next live sync can clear it.
ensureColumn('balances', 'manual', 'INTEGER DEFAULT 0');
// `kind` distinguishes live (SimpleFIN) accounts from user-added manual ones
// (investments, cash, 401k, a credit card you didn't connect) — for net worth.
ensureColumn('balances', 'kind', "TEXT NOT NULL DEFAULT 'live'");

// Daily balance snapshots → net-worth trend. One row per account per day.
db.exec(`
  CREATE TABLE IF NOT EXISTS balance_history (
    date    TEXT NOT NULL,
    account TEXT NOT NULL,
    source  TEXT,
    balance REAL,
    PRIMARY KEY (date, account)
  );
`);

// Bank deposits (money IN) from the live feed — kept separate from the
// spending ledger so income capture can never pollute spending math. Feeds
// income auto-capture (paychecks) and stays for future income analytics.
db.exec(`
  CREATE TABLE IF NOT EXISTS deposits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    description TEXT,
    amount      REAL    NOT NULL,
    ext_id      TEXT    UNIQUE
  );
`);

// Manual category fixes, keyed by merchant — re-applied on every import so a
// correction sticks forever and fixes every transaction from that merchant.
db.exec(`
  CREATE TABLE IF NOT EXISTS category_overrides (
    merchant  TEXT PRIMARY KEY,
    category  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Monthly spending budget per category.
db.exec(`
  CREATE TABLE IF NOT EXISTS budgets (
    category      TEXT PRIMARY KEY,
    monthly_limit REAL NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Savings goals — track progress vs net worth.
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    target     REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = { db, DB_PATH };
