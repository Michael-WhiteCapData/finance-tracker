'use strict';

// Build the unified spending ledger from every source: bank checking/savings,
// PayPal, Venmo, Cash App. Money-out only. De-dupes platform payments against
// their bank funding lines (match by date±5d + amount) so a dollar that left the
// bank via PayPal/Venmo/Cash App is counted once — while balance- and credit-card-
// funded platform spend (no bank line) stays, correctly capturing spend the bank
// can't see. Idempotent: clears and rebuilds the transactions table.
//   node --experimental-sqlite scripts/import-spending.js

const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { categorize, merchant } = require('../categorize');
const profile = require('../profile');

const IMPORT = process.env.FINANCE_IMPORT || path.join(__dirname, '..', 'import');
const Q = '"';

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === Q) { if (text[i + 1] === Q) { f += Q; i++; } else q = false; } else f += c; }
    else if (c === Q) q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c === '\r') { /* skip */ }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const toNum = (s) => parseFloat(String(s).replace(/[^0-9.\-]/g, '')) || 0;
const tx = []; // { date, source, description, merchant, amount(+out), category, counted, note }

// Newest import/*.csv whose name matches a pattern — so a fresh monthly export
// just needs to be dropped in (filename date-stamps change every export).
function newestCsv(re) {
  if (!fs.existsSync(IMPORT)) return null;
  const matches = fs.readdirSync(IMPORT)
    .filter((f) => f.toLowerCase().endsWith('.csv') && re.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(IMPORT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return matches.length ? matches[0].f : null;
}

// ---------- Bank (checking + savings) ----------
function loadBank(pattern, source) {
  const file = newestCsv(pattern);
  if (!file) { console.warn(`No ${source} CSV found in import/ (pattern ${pattern})`); return; }
  const rows = parseCsv(fs.readFileSync(path.join(IMPORT, file), 'utf8'));
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = r[1], desc = (r[2] || '').trim(), dir = (r[4] || '').toLowerCase(), amt = toNum(r[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/debit/.test(dir) || amt <= 0) continue;
    // Internal transfers between your own accounts and card payments aren't spending.
    const isTransfer = /transfer (from|to) (savings|checking|x?-?\d{3,4})|online transfer|credit card (payment|pmt)|web pmt|bank transfer/i.test(desc);
    const isConduit = /paypal|venmo|cash ?app/i.test(desc);
    tx.push({
      date, source, description: desc, merchant: merchant(desc), amount: amt,
      category: isTransfer ? 'Transfer' : categorize(desc),
      counted: isTransfer ? 0 : 1,
      conduit: isConduit ? (/paypal/i.test(desc) ? 'paypal' : /venmo/i.test(desc) ? 'venmo' : 'cashapp') : null,
      note: null,
    });
  }
}

// ---------- PayPal (decoded .txt statements) ----------
function loadPaypal() {
  const dir = path.join(IMPORT, 'paypal');
  if (!fs.existsSync(dir)) return;
  const files = [];
  for (const y of fs.readdirSync(dir)) {
    const sub = path.join(dir, y);
    if (fs.statSync(sub).isDirectory()) for (const f of fs.readdirSync(sub)) if (f.endsWith('.txt')) files.push(path.join(sub, f));
  }
  for (const f of files) {
    let L = fs.readFileSync(f, 'utf8').split('\n');
    const M = [];
    for (let i = 0; i < L.length; i++) {
      let s = L[i].trim();
      if (/^\d{2}\/\d{2}\/\d{3}$/.test(s) && /^\d$/.test((L[i + 1] || '').trim())) { s += L[i + 1].trim(); i++; }
      M.push(s);
    }
    for (let i = 0; i < M.length; i++) {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(M[i])) continue;
      const [mm, dd, yy] = M[i].split('/');
      const type = M[i + 1] || '', name = (M[i + 2] || '').trim();
      let amt = null;
      for (let j = i + 3; j < Math.min(i + 11, M.length); j++) { const a = M[j].match(/^(-?\d+\.\d{2})$/); if (a) { amt = parseFloat(a[1]); break; } }
      if (amt === null || amt >= 0) continue; // only money out
      if (/credit card deposit|bank deposit|transfer|withdraw/i.test(type)) continue;
      tx.push({
        date: `${yy}-${mm}-${dd}`, source: 'paypal', description: `${name}`.trim(),
        merchant: merchant(name), amount: Math.abs(amt), category: categorize(name),
        counted: 1, conduit: null, note: 'PayPal', platform: 'paypal',
      });
    }
  }
}

// ---------- PayPal (activity CSV — the two-click export) ----------
// paypal.com → Activity → Download → CSV. Much easier to fetch monthly than the
// PDF statements the .txt path decodes, so this is the maintained route.
// Parsed by header name (PayPal shuffles columns between export flavors).
function loadPaypalCsv() {
  const dir = path.join(IMPORT, 'paypal');
  if (!fs.existsSync(dir)) return;
  const files = [];
  const collect = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) collect(p);
      else if (f.toLowerCase().endsWith('.csv')) files.push(p);
    }
  };
  collect(dir);
  if (!files.length) return;

  // Rows the .txt statements already loaded — a CSV covering the same period
  // must not double-count them.
  const seen = new Set(tx.filter((t) => t.source === 'paypal').map((t) => `${t.date}|${t.amount}`));

  for (const f of files) {
    // Real exports open with a UTF-8 BOM — strip it or the Date header is missed.
    const rows = parseCsv(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    if (rows.length < 2) continue;
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    const iDate = col('date'), iName = col('name'), iType = col('type'), iStatus = col('status'), iAmt = col('amount');
    if (iDate < 0 || iAmt < 0) continue; // not a PayPal activity export

    const loaded = [];   // rows from THIS file, so refunds can net them out
    const refunds = [];  // positive refund/reversal rows
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const m = String(r[iDate] || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) continue;
      const amt = toNum(r[iAmt]);
      const type = iType >= 0 ? String(r[iType]) : '';
      const date = `${m[3]}-${m[1]}-${m[2]}`;
      if (amt > 0 && /refund|reversal/i.test(type)) { refunds.push({ date, amount: amt }); continue; }
      if (amt >= 0) continue; // only money out
      // An authorization is a hold, not a payment — its capture row is the spend.
      if (/authorization|^order$/i.test(type)) continue;
      if (/card deposit|bank deposit|transfer|withdraw|currency conversion/i.test(type)) continue;
      if (iStatus >= 0 && r[iStatus] && !/complete/i.test(r[iStatus])) continue;
      const name = iName >= 0 ? String(r[iName] || '').trim() : '';
      const key = `${date}|${Math.abs(amt)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      loaded.push({
        date, source: 'paypal', description: name || type,
        merchant: merchant(name || type), amount: Math.abs(amt), category: categorize(name || type),
        counted: 1, conduit: null, note: 'PayPal', platform: 'paypal',
      });
    }
    // Net out refunded purchases: each refund cancels the nearest matching-amount
    // purchase within the prior 45 days — refunded money isn't spend.
    for (const rf of refunds) {
      const cand = loaded
        .filter((t) => Math.abs(t.amount - rf.amount) < 0.005 && t.date <= rf.date)
        .filter((t) => (new Date(rf.date) - new Date(t.date)) / 86400000 <= 45)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (cand) loaded.splice(loaded.indexOf(cand), 1);
    }
    tx.push(...loaded);
  }
}

// ---------- Venmo ----------
function loadVenmo() {
  const dir = path.join(IMPORT, 'venmo');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv')) continue;
    const rows = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const r of rows) {
      if (!r[1] || !/^\d{15,}$/.test(r[1])) continue; // real transaction rows have a long ID in col 1
      const dt = (r[2] || '').slice(0, 10), type = r[3] || '', status = r[4] || '', note = r[5] || '', to = r[7] || '', amtRaw = r[8] || '';
      if (!/complete/i.test(status)) continue;
      if (/transfer/i.test(type)) continue;            // cash-outs to bank
      if (!/-/.test(amtRaw)) continue;                  // only money out (minus sign)
      const amt = Math.abs(toNum(amtRaw));
      if (amt <= 0) continue;
      const vcat = categorize(`${note} ${to}`);
      tx.push({
        date: dt, source: 'venmo', description: `${to} — ${note}`.trim(),
        merchant: merchant(to || note), amount: amt,
        category: vcat === 'Other' ? 'P2P / People' : vcat,
        counted: 1, conduit: null, note: note || null, platform: 'venmo',
      });
    }
  }
}

// ---------- Cash App ----------
function loadCashApp() {
  const dir = path.join(IMPORT, 'cashapp');
  if (!fs.existsSync(dir)) return;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv')) continue;
    const rows = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const id = r[1], date = (r[0] || '').slice(0, 10), type = r[2] || '', amt = toNum(r[4]), status = r[10] || '', note = r[11] || '', who = r[12] || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!/complete/i.test(status)) continue;          // drop FAILED + pending
      if (amt >= 0) continue;                            // only money out
      if (id && seen.has(id)) continue; if (id) seen.add(id); // the two reports overlap
      const isCrypto = /bitcoin/i.test(type);
      if (/withdrawal|deposit/i.test(type) && !isCrypto) continue; // cash-outs / loads aren't spend
      let cat = isCrypto ? 'Crypto / Investment' : categorize(`${note} ${who}`);
      if (cat === 'Other' && /p2p|family/i.test(type)) cat = 'P2P / People'; // peer payment default
      tx.push({
        date, source: 'cashapp', description: `${who} — ${note}`.trim(),
        merchant: isCrypto ? 'Bitcoin' : merchant(who || note), amount: Math.abs(amt),
        category: cat, counted: 1, conduit: null, note: note || null, platform: 'cashapp',
      });
    }
  }
}

// ---------- De-dup: match each platform payment to a bank funding line ----------
function dedupe() {
  const bankConduits = tx.filter((t) => t.conduit && t.counted === 1);
  const used = new Set();
  for (const item of tx) {
    if (!item.platform) continue; // only platform-sourced payments
    // A funding line FOLLOWS its platform charge (typically 1–4 days), so prefer
    // the nearest line on/after the charge date; a line up to 1 day before is a
    // last-resort fallback (date skew between sources). Greedy first-match let a
    // later charge steal an earlier charge's funding line in same-amount clusters.
    let best = -1, bestScore = Infinity;
    for (let idx = 0; idx < bankConduits.length; idx++) {
      const b = bankConduits[idx];
      if (used.has(idx) || b.conduit !== item.platform) continue;
      if (Math.abs(b.amount - item.amount) >= 0.005) continue;
      const delta = (new Date(b.date) - new Date(item.date)) / 86400000;
      if (delta < -1 || delta > 5) continue;
      const score = delta >= 0 ? delta : 100 - delta; // following lines first, closest first
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    if (best >= 0) { used.add(best); bankConduits[best].counted = 0; bankConduits[best].note = `funds ${item.platform} payment (deduped)`; }
  }
}

// Categories kept in the ledger but not counted toward spending (cancelled /
// intentionally hidden). Reversible — drop one and re-run to bring it back.
const EXCLUDE_CATEGORIES = new Set(['Adult']);

// Pull already-synced SimpleFIN bank rows into the pipeline as the LIVE source of
// truth for the recent window. They keep origin='simplefin' in the DB; here we
// just re-derive their flags so they go through dedup/exclusions like CSV rows.
// Returns the earliest SimpleFIN date (the cutoff before which CSV bank history wins).
function loadSimpleFin() {
  const rows = db.prepare("SELECT date, source, description, amount, ext_id FROM transactions WHERE origin = 'simplefin'").all();
  let min = null, max = null;
  for (const r of rows) {
    const desc = r.description || '';
    const isTransfer = /transfer (from|to) (savings|checking|x?-?\d{3,4})|online transfer|credit card (payment|pmt)|web pmt|bank transfer/i.test(desc);
    const isConduit = /paypal|venmo|cash ?app/i.test(desc);
    tx.push({
      date: r.date, source: r.source, description: desc, merchant: merchant(desc), amount: r.amount,
      category: isTransfer ? 'Transfer' : categorize(desc),
      counted: isTransfer ? 0 : 1,
      conduit: isConduit ? (/paypal/i.test(desc) ? 'paypal' : /venmo/i.test(desc) ? 'venmo' : 'cashapp') : null,
      note: 'SimpleFIN (live)', sf: true, ext_id: r.ext_id,
    });
    if (!min || r.date < min) min = r.date;
    if (!max || r.date > max) max = r.date;
  }
  return { min, max };
}

function run() {
  tx.length = 0;
  loadBank(profile.checkingMatch(), 'checking');
  loadBank(profile.savingsMatch(), 'savings');
  loadPaypal();
  loadPaypalCsv();
  loadVenmo();
  loadCashApp();

  // SimpleFIN is the live bank truth for the range it actually covers. Drop CSV
  // bank rows only WITHIN [min,max] — keep CSV history before it and any CSV days
  // newer than SimpleFIN's latest (so a stale-by-a-few-days feed loses no data).
  const sf = loadSimpleFin();
  if (sf.min) {
    for (let i = tx.length - 1; i >= 0; i--) {
      const t = tx[i];
      if (!t.sf && (t.source === 'checking' || t.source === 'savings') && t.date >= sf.min && t.date <= sf.max) tx.splice(i, 1);
    }
  }

  dedupe();

  // Apply saved manual category fixes (by merchant), then exclusions.
  const overrides = new Map(
    db.prepare('SELECT merchant, category FROM category_overrides').all().map((o) => [o.merchant, o.category])
  );
  // Payments to yourself (loading your own Cash App / Venmo, Zelle to self) aren't
  // spending — they move money between your own accounts. Names come from your
  // local profile (config), never hardcoded.
  const SELF = profile.selfRegex();
  for (const t of tx) {
    if (overrides.has(t.merchant)) t.category = overrides.get(t.merchant);
    if (t.counted === 1 && SELF && SELF.test(`${t.merchant} ${t.description}`)) {
      t.category = 'Transfer'; t.counted = 0; t.note = (t.note ? t.note + ' | ' : '') + 'self-transfer';
    }
    if (EXCLUDE_CATEGORIES.has(t.category)) { t.counted = 0; t.note = (t.note ? t.note + ' | ' : '') + 'excluded category'; }
  }

  // Rebuild CSV rows; update SimpleFIN rows in place (they keep origin='simplefin'
  // and their ext_id, so the live sync can keep de-duping against them).
  // The DELETE is inside the transaction so a failed insert can't leave the
  // history permanently wiped (an unguarded DELETE auto-commits on its own).
  const ins = db.prepare(
    `INSERT INTO transactions (date, source, description, merchant, amount, category, counted, note, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import')`
  );
  const upd = db.prepare(
    `UPDATE transactions SET merchant = ?, category = ?, counted = ?, note = ? WHERE ext_id = ? AND origin = 'simplefin'`
  );
  db.exec('BEGIN');
  try {
    db.exec("DELETE FROM transactions WHERE origin = 'import' OR origin IS NULL");
    for (const t of tx) {
      if (t.sf) upd.run(t.merchant, t.category, t.counted, t.note, t.ext_id);
      else ins.run(t.date, t.source, t.description, t.merchant, Math.round(t.amount * 100) / 100, t.category, t.counted, t.note);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const counted = tx.filter((t) => t.counted === 1);
  const bySource = {};
  for (const t of counted) bySource[t.source] = (bySource[t.source] || 0) + 1;
  const liveCount = tx.filter((t) => t.sf && t.counted === 1).length;
  return {
    total: tx.length,
    counted: counted.length,
    bySource,
    deduped: tx.filter((t) => /deduped/.test(t.note || '')).length,
    overridesApplied: overrides.size,
    liveBankRows: liveCount,
    simplefinRange: sf.min ? `${sf.min}..${sf.max}` : null,
  };
}

module.exports = { run };

// Run directly from the CLI.
if (require.main === module) {
  const r = run();
  console.log(`Loaded ${r.total} transactions (${r.counted} counted as spend).`);
  console.log('Counted by source:', JSON.stringify(r.bySource));
  console.log('Deduped bank funding lines:', r.deduped, '| overrides applied:', r.overridesApplied);
}
