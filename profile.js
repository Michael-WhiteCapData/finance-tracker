'use strict';

// Per-user profile (stored in the git-ignored config table, never in code).
// Keeps personal identifiers — your name, your account number patterns — out of
// the shared source so the app ships generic and each user configures their own.

const { db } = require('./db');

function get(key, def) {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return r && r.value != null && r.value !== '' ? r.value : def;
}
function set(key, value) {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value == null ? '' : String(value));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names/handles that identify YOU, for spotting payments to yourself (loading
// your own Cash App / Venmo). Empty by default — set it in your config.
function selfRegex() {
  const names = get('owner_names', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  return new RegExp(names.map(escapeRe).join('|'), 'i');
}

// Patterns that identify a CSV file (or SimpleFIN account name) as checking/savings.
// Generic defaults; override per-user via config for non-standard bank labels.
const checkingMatch = () => new RegExp(get('checking_match', 'check|chk'), 'i');
const savingsMatch = () => new RegExp(get('savings_match', 'sav'), 'i');

// Current raw settings (for the Settings UI). Empty string = using defaults.
function all() {
  return {
    owner_names: get('owner_names', ''),
    checking_match: get('checking_match', ''),
    savings_match: get('savings_match', ''),
    defaults: { checking_match: 'check|chk', savings_match: 'sav' },
  };
}

module.exports = { get, set, all, selfRegex, checkingMatch, savingsMatch };
