'use strict';

// SimpleFIN Bridge integration — read-only real-time bank/card data.
// Flow: a one-time base64 Setup Token is "claimed" (POST) for an Access URL that
// carries credentials; we store that URL in the (git-ignored) config table and
// GET /accounts from it to pull balances + transactions. No bank creds touch us.

const { db } = require('./db');
const { categorize, merchant } = require('./categorize');
const profile = require('./profile');

const { round2 } = require('./util');
// Local YYYY-MM-DD (matches the user's calendar day and the local-dated CSV rows).
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function getAccessUrl() {
  const r = db.prepare("SELECT value FROM config WHERE key = 'simplefin_access_url'").get();
  return r ? r.value : null;
}
function setConfig(key, value) {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
function isConnected() { return !!getAccessUrl(); }

// Reject non-HTTPS or private/loopback targets so a crafted setup token can't
// turn the claim/sync fetch into an SSRF probe of internal services (cloud
// metadata, localhost admin ports, RFC-1918 hosts).
function assertSafeUrl(raw, label) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${label} is not a valid URL`); }
  if (u.protocol !== 'https:') throw new Error(`${label} must use https`);
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|::1$|::ffff:7f|::ffff:127|fc|fd|fe80)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    throw new Error(`${label} points to a private or local address`);
  }
  return u;
}

// Exchange a Setup Token for a long-lived Access URL.
async function claim(setupToken) {
  const token = String(setupToken || '').trim();
  if (!token) throw new Error('Setup token is required');
  let claimUrl;
  try { claimUrl = Buffer.from(token, 'base64').toString('utf8'); }
  catch { throw new Error('Token is not valid base64'); }
  assertSafeUrl(claimUrl, 'Setup token URL');
  const res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (!res.ok) throw new Error(`Claim failed (${res.status}). The token may already be used — generate a fresh one.`);
  const accessUrl = (await res.text()).trim();
  if (!/@/.test(accessUrl)) throw new Error('Claim did not return a valid access URL');
  assertSafeUrl(accessUrl, 'Access URL');
  setConfig('simplefin_access_url', accessUrl);
  setConfig('simplefin_claimed_at', new Date().toISOString());
  return { connected: true };
}

// Map a SimpleFIN account to one of our source labels.
function sourceFor(acct) {
  const n = `${acct.name || ''} ${acct.org && acct.org.name || ''}`.toLowerCase();
  if (/credit|card|visa|mastercard|amex|discover/.test(n)) return 'creditcard';
  if (profile.savingsMatch().test(n)) return 'savings';
  if (profile.checkingMatch().test(n)) return 'checking';
  return (acct.name || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
}

// Pull accounts + transactions, store balances, upsert transactions (origin=simplefin).
async function sync({ days = 120 } = {}) {
  const accessUrl = getAccessUrl();
  if (!accessUrl) throw new Error('Not connected — claim a SimpleFIN setup token first');
  // The access URL embeds basic-auth credentials. fetch() refuses credentials in
  // the URL, so move them to an Authorization header and never log the raw URL.
  const u = new URL(accessUrl);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '');
  const startDate = Math.floor((Date.now() - days * 86400000) / 1000);
  let res;
  try {
    res = await fetch(`${base}/accounts?start-date=${startDate}`, { headers: { Authorization: auth } });
  } catch {
    throw new Error('SimpleFIN request failed (network/credentials issue)');
  }
  if (!res.ok) throw new Error(`SimpleFIN fetch failed (HTTP ${res.status})`);
  const data = await res.json();

  const ins = db.prepare(
    `INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin, ext_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simplefin', ?)`
  );
  const exists = db.prepare('SELECT 1 FROM transactions WHERE ext_id = ?');
  const depIns = db.prepare(
    `INSERT OR IGNORE INTO deposits (date, source, description, amount, ext_id)
     VALUES (?, ?, ?, ?, ?)`
  );
  const bal = db.prepare(
    `INSERT INTO balances (account, source, balance, available, as_of, manual, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(account) DO UPDATE SET source=excluded.source, balance=excluded.balance,
       available=excluded.available, as_of=excluded.as_of, manual=0, updated_at=datetime('now')`
  );
  const snapshot = db.prepare(
    `INSERT INTO balance_history (date, account, source, balance) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, account) DO UPDATE SET balance=excluded.balance, source=excluded.source`
  );

  let added = 0, accounts = 0;
  db.exec('BEGIN');
  try {
    for (const a of data.accounts || []) {
      accounts++;
      const source = sourceFor(a);
      const asOf = a['balance-date'] ? localDay(new Date(a['balance-date'] * 1000)) : null;
      // Friendly display name: "Checking ••1234" instead of the raw bank label.
      const last4 = ((a.name || '').match(/(\d{4})/) || [])[1] || '';
      const label = source === 'savings' ? 'Savings' : source === 'checking' ? 'Checking' : source === 'creditcard' ? 'Credit card' : (a.name || source).replace(/\s+/g, ' ').trim();
      const acctName = last4 ? `${label} ••${last4}` : label;
      const balNow = round2(Number(a.balance) || 0);
      bal.run(acctName, source, balNow, round2(Number(a['available-balance'] ?? a.balance) || 0), asOf);
      snapshot.run(localDay(), acctName, source, balNow);
      for (const t of a.transactions || []) {
        const extId = `sf:${a.id}:${t.id}`;
        if (exists.get(extId)) continue;          // already synced
        const amt = Number(t.amount);
        if (!isFinite(amt)) continue;
        const desc = (t.description || t.payee || t.memo || '').trim();
        const date = localDay(new Date((t.posted || t.transacted_at) * 1000));
        // Money IN goes to the deposits table (never the spending ledger) so
        // income auto-capture can see paychecks land. Card credits are refunds/
        // payments, not income — skip those.
        if (amt > 0) {
          if (source === 'checking' || source === 'savings') {
            depIns.run(date, source, desc, round2(amt), extId);
          }
          continue;
        }
        // Inserted counted=0 here; the import pipeline's loadSimpleFin() re-derives
        // these rows as the live source of truth (counted=1, deduped against the
        // CSV/PayPal/Venmo/Cash App ledger over the range they cover). Auto-sync
        // runs that pipeline after every sync, so live bank spending stays counted.
        ins.run(date, source, desc, merchant(desc), round2(Math.abs(amt)), categorize(desc), 0, 'SimpleFIN', extId);
        added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  setConfig('simplefin_synced_at', new Date().toISOString());
  // Auto-capture paychecks: deposits matching a known income source append to
  // the income ledger, so variable pay stays current without manual entry.
  let incomeAdded = 0;
  try { incomeAdded = require('./income').syncFromDeposits().added; } catch { /* never block a sync */ }
  return { accounts, added, incomeAdded, syncedAt: new Date().toISOString() };
}

// Hand-adjust a balance (and its available) by a signed delta — flags it manual
// so the UI marks it; the next live sync overwrites and clears the flag.
// Adjust a single account by primary key (account name), not by source type —
// otherwise two accounts of the same type would both get overwritten.
function adjustBalance(account, delta) {
  const row = db.prepare('SELECT source, balance, available FROM balances WHERE account = ?').get(account);
  if (!row) throw new Error(`No account: ${account}`);
  db.prepare("UPDATE balances SET balance=?, available=?, manual=1, updated_at=datetime('now') WHERE account=?")
    .run(round2(row.balance + delta), round2(row.available + delta), account);
  return { account, source: row.source, balance: round2(row.balance + delta) };
}

// Fully disconnect: drop the access key, synced rows, and LIVE balances only —
// manual accounts (kind='manual') are user data and must survive.
function disconnect() {
  db.prepare("DELETE FROM config WHERE key LIKE 'simplefin_%'").run();
  const a = db.prepare("DELETE FROM transactions WHERE origin = 'simplefin'").run();
  db.prepare("DELETE FROM balances WHERE kind = 'live' OR kind IS NULL").run();
  return { disconnected: true, removedTransactions: a.changes };
}

function balances() {
  const accounts = db.prepare('SELECT account, source, balance, available, as_of, manual, kind FROM balances ORDER BY balance DESC').all();
  const liquidRows = accounts.filter((b) => ['checking', 'savings', 'cash'].includes(b.source));
  const card = accounts.find((b) => b.source === 'creditcard' || b.source === 'loan');
  return {
    hasBalances: accounts.length > 0,
    accounts,
    liquid: round2(liquidRows.reduce((s, b) => s + (b.available ?? b.balance), 0)),
    net: round2(accounts.reduce((s, b) => s + b.balance, 0)),
    card: card ? round2(card.balance) : null,
    asOf: accounts.length ? accounts.map((a) => a.as_of).filter(Boolean).sort().pop() : null,
  };
}

// Net-worth trend from the daily balance snapshots (card balances are signed,
// so summing all accounts gives net worth). Seeds today from live balances.
function netWorth() {
  const today = localDay();
  // Ensure today's point exists from the current live balances.
  const snap = db.prepare(`INSERT INTO balance_history (date, account, source, balance) VALUES (?, ?, ?, ?) ON CONFLICT(date, account) DO UPDATE SET balance=excluded.balance`);
  for (const b of db.prepare('SELECT account, source, balance FROM balances').all()) snap.run(today, b.account, b.source, b.balance);
  const rows = db.prepare('SELECT date, ROUND(SUM(balance),2) net FROM balance_history GROUP BY date ORDER BY date').all();
  const b = balances();
  return { history: rows, current: rows.length ? rows[rows.length - 1].net : b.liquid, liquid: b.liquid, card: b.card };
}

function status() {
  return {
    connected: isConnected(),
    claimedAt: (db.prepare("SELECT value FROM config WHERE key='simplefin_claimed_at'").get() || {}).value || null,
    syncedAt: (db.prepare("SELECT value FROM config WHERE key='simplefin_synced_at'").get() || {}).value || null,
    balances: db.prepare('SELECT account, source, balance, available, as_of FROM balances ORDER BY balance DESC').all(),
  };
}

module.exports = { claim, sync, status, balances, netWorth, adjustBalance, disconnect, isConnected, getAccessUrl };
