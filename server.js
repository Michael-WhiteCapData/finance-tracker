'use strict';

// Tiny zero-dependency HTTP server: a JSON REST API for subscriptions plus
// static hosting for the front-end in ./public. No framework, no build step.

const http = require('http');
const fs = require('fs');
const path = require('path');
const repo = require('./subscriptions');
const income = require('./income');
const spending = require('./spending');
const month = require('./month');
const budgets = require('./budgets');
const insights = require('./insights');
const forecast = require('./forecast');
const simplefin = require('./simplefin');
const detect = require('./detect');
const alerts = require('./alerts');
const profile = require('./profile');
const goals = require('./goals');
const accounts = require('./accounts');
const { DB_PATH } = require('./db');
const { round2 } = require('./util');
const transactions = require('./transactions');
const importSpending = require('./scripts/import-spending');

const PORT = Number(process.env.PORT) || 4317;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

// Tiny in-memory rate limiter. Keyed per client+resource so one caller can't
// exhaust another's allowance. The bucket holds only timestamps within the
// window (older ones are filtered on each hit); at loopback scale the map holds
// a key or two, so unbounded growth isn't a concern.
const rlHits = new Map();
function rateLimited(key, max = 10, windowMs = 60000) {
  const now = Date.now();
  const arr = (rlHits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  rlHits.set(key, arr);
  return arr.length > max;
}

// True only for requests originating from this machine's loopback interface.
// Used to keep credential-bearing endpoints (DB backup) off the LAN even when
// the operator opted into HOST=0.0.0.0.
function isLoopbackClient(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}

// Pull spending filters from query params (search, date range, amount, etc.).
function parseFilters(u) {
  const g = (k) => { const v = u.searchParams.get(k); return v == null || v === '' ? null : v; };
  const num = (k) => { const v = g(k); return v == null ? null : Number(v); };
  return {
    limit: num('limit') || 100,
    category: g('category'), merchant: g('merchant'), source: g('source'),
    search: g('search'), from: g('from'), to: g('to'),
    minAmount: num('minAmount'), maxAmount: num('maxAmount'),
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const resource = parts[1];
  const id = parts[2] ? Number(parts[2]) : null;

  // Throttle writes, keyed per client IP. A general cap covers every mutating
  // endpoint (not just simplefin/reimport), with tighter caps for the sensitive
  // connect/sync/reimport paths.
  const ip = req.socket.remoteAddress || 'local';
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    if (rateLimited(`${ip}:write`, 120)) {
      return sendJson(res, 429, { error: 'Too many requests — slow down a moment.' });
    }
  }
  if (req.method === 'POST' && /^(simplefin|reimport)$/.test(resource)) {
    if (rateLimited(`${ip}:${resource}`, resource === 'reimport' ? 20 : 8)) {
      return sendJson(res, 429, { error: 'Too many requests — slow down a moment.' });
    }
  }

  try {
    if (resource === 'summary' && req.method === 'GET') {
      return sendJson(res, 200, repo.summary());
    }

    if (resource === 'income-summary' && req.method === 'GET') {
      return sendJson(res, 200, income.summary());
    }

    if (resource === 'spending-summary' && req.method === 'GET') {
      return sendJson(res, 200, spending.summary());
    }

    if (resource === 'month' && req.method === 'GET') {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const m = u.searchParams.get('m');
      return sendJson(res, 200, month.summary(m || undefined));
    }

    if (resource === 'insights' && req.method === 'GET') {
      return sendJson(res, 200, insights.summary());
    }

    if (resource === 'forecast' && req.method === 'GET') {
      return sendJson(res, 200, forecast.summary());
    }

    if (resource === 'alerts' && req.method === 'GET') {
      return sendJson(res, 200, alerts.build());
    }

    // SimpleFIN real-time data. parts: ['api','simplefin', <action>]
    if (resource === 'simplefin') {
      const action = parts[2];
      if (action === 'status' && req.method === 'GET') return sendJson(res, 200, simplefin.status());
      if (action === 'claim' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await simplefin.claim(body.token);
        return sendJson(res, 200, r);
      }
      if (action === 'sync' && req.method === 'POST') {
        const r = await simplefin.sync({ days: 120 });
        return sendJson(res, 200, r);
      }
      if (action === 'disconnect' && req.method === 'POST') {
        return sendJson(res, 200, simplefin.disconnect());
      }
    }

    // First-run / onboarding state.
    if (resource === 'status' && req.method === 'GET') {
      const sub = repo.summary().counts.total;
      const inc = income.listIncome().length;
      const txn = spending.summary().counts.transactions;
      return sendJson(res, 200, {
        connected: simplefin.isConnected(),
        hasData: sub + inc + txn > 0,
        counts: { subscriptions: sub, income: inc, transactions: txn },
      });
    }

    if (resource === 'networth' && req.method === 'GET') {
      return sendJson(res, 200, simplefin.netWorth());
    }

    // Manual accounts (investments, cash, un-connected card) for full net worth.
    if (resource === 'accounts') {
      if (req.method === 'GET') return sendJson(res, 200, accounts.list());
      if (req.method === 'POST') { const b = await readBody(req); return sendJson(res, 201, accounts.add(b)); }
      if (req.method === 'DELETE') {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const acct = decodeURIComponent(parts[2] || u.searchParams.get('account') || '');
        return accounts.remove(acct) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Account not found' });
      }
    }

    if (resource === 'detect-subscriptions' && req.method === 'GET') {
      return sendJson(res, 200, detect.suggestions());
    }

    if (resource === 'goals') {
      if (req.method === 'GET') return sendJson(res, 200, goals.list());
      if (req.method === 'POST') { const b = await readBody(req); return sendJson(res, 201, goals.create(b)); }
      if (req.method === 'DELETE' && id != null) {
        return goals.remove(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Goal not found' });
      }
    }

    // Export transactions (CSV or JSON) and back up the database file.
    if (resource === 'export' && req.method === 'GET') {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const rows = spending.listTransactions({ limit: 100000 });
      if (u.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="transactions.json"' });
        return res.end(JSON.stringify(rows, null, 2));
      }
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const cols = ['date', 'merchant', 'category', 'source', 'amount', 'description'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="transactions.csv"' });
      return res.end(csv);
    }
    if (resource === 'backup' && req.method === 'GET') {
      // The DB embeds the SimpleFIN access credential, so never hand it to a
      // non-loopback client even if the server was bound to the LAN.
      if (!isLoopbackClient(req)) return sendJson(res, 403, { error: 'Backup is only available from this machine.' });
      // Checkpoint the WAL into the main file so the copy is complete and consistent.
      require('./db').db.exec('PRAGMA wal_checkpoint(FULL)');
      const data = fs.readFileSync(DB_PATH);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="finance-backup.db"' });
      return res.end(data);
    }

    if (resource === 'profile') {
      if (req.method === 'GET') return sendJson(res, 200, profile.all());
      if (req.method === 'PUT') {
        const body = await readBody(req);
        // Validate regex patterns before saving — an invalid one would otherwise
        // crash every later sync/reimport.
        for (const k of ['checking_match', 'savings_match']) {
          if (body[k]) { try { new RegExp(String(body[k]), 'i'); } catch { return sendJson(res, 400, { error: `${k}: invalid pattern` }); } }
        }
        for (const k of ['owner_names', 'checking_match', 'savings_match']) {
          if (body[k] !== undefined) profile.set(k, String(body[k]).slice(0, 300));
        }
        // re-apply to the ledger so changes take effect immediately
        importSpending.run();
        return sendJson(res, 200, profile.all());
      }
    }

    if (resource === 'balances') {
      if (req.method === 'GET') return sendJson(res, 200, simplefin.balances());
      // Hand-adjust one account by a signed delta (e.g. reflect a pending transfer).
      if (req.method === 'POST') {
        const body = await readBody(req);
        const account = String(body.account || '').trim();
        const delta = Number(body.delta);
        if (!account || !Number.isFinite(delta)) {
          return sendJson(res, 400, { error: 'account (name) and numeric delta required' });
        }
        return sendJson(res, 200, simplefin.adjustBalance(account, delta));
      }
    }


    if (resource === 'budgets') {
      if (req.method === 'GET' && parts[2] === 'suggest') return sendJson(res, 200, budgets.suggest());
      if (req.method === 'GET') return sendJson(res, 200, budgets.list());
      if (req.method === 'PUT') {
        const body = await readBody(req);
        return sendJson(res, 200, budgets.set(body.category, body.monthly_limit));
      }
    }

    // Refresh everything: pull the live bank feed (SimpleFIN) first, then rebuild
    // the unified ledger. No server restart needed.
    if (resource === 'reimport' && req.method === 'POST') {
      let live = null;
      if (simplefin.isConnected()) {
        try { live = await simplefin.sync({ days: 120 }); } catch (e) { live = { error: e.message }; }
      }
      const stats = importSpending.run();
      return sendJson(res, 200, { ok: true, live, ...stats });
    }

    // Manual category fix for a transaction (applies to all rows from that merchant).
    if (resource === 'transactions' && req.method === 'PUT' && id != null) {
      const body = await readBody(req);
      const result = transactions.setCategory(id, body.category);
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: 'Transaction not found' });
    }
    if (resource === 'categories' && req.method === 'GET') {
      return sendJson(res, 200, transactions.CATEGORIES);
    }

    if (resource === 'spending' && req.method === 'GET') {
      const u = new URL(req.url, `http://${req.headers.host}`);
      return sendJson(res, 200, spending.listTransactions(parseFilters(u)));
    }

    if (resource === 'spending-detail' && req.method === 'GET') {
      const u = new URL(req.url, `http://${req.headers.host}`);
      return sendJson(res, 200, spending.detail(parseFilters(u)));
    }

    // Profit = income − ALL spending (run-rate). Spending already includes
    // subscriptions, so we surface subs as a sub-component, not double-counted.
    if (resource === 'profit' && req.method === 'GET') {
      const inMonthly = income.monthlyTotal();
      const spendMonthly = spending.monthlyTotal();
      const subsMonthly = repo.summary().monthly;
      const net = round2(inMonthly - spendMonthly);
      // Monthly trend: actual income vs spending per month.
      const incM = income.byMonth();
      const spendM = {};
      for (const m of spending.summary().byMonth) spendM[m.month] = m.total;
      const months = [...new Set([...Object.keys(incM), ...Object.keys(spendM)])].sort().slice(-12);
      const trend = months.map((m) => {
        const i = incM[m] || 0, s = spendM[m] || 0;
        return { month: m, income: round2(i), spending: round2(s), net: round2(i - s), rate: i > 0 ? Math.round(((i - s) / i) * 100) : null };
      });
      return sendJson(res, 200, {
        income: { weekly: round2((inMonthly * 12) / 52), monthly: round2(inMonthly), yearly: round2(inMonthly * 12) },
        expenses: { weekly: round2((spendMonthly * 12) / 52), monthly: round2(spendMonthly), yearly: round2(spendMonthly * 12) },
        subscriptions: { monthly: round2(subsMonthly) },
        net: { weekly: round2((net * 12) / 52), monthly: net, yearly: round2(net * 12), daily: round2((net * 12) / 365) },
        savingsRate: inMonthly > 0 ? Math.round((net / inMonthly) * 100) : null,
        trend,
      });
    }

    if (resource === 'subscriptions') {
      if (req.method === 'GET' && id == null) {
        return sendJson(res, 200, repo.listSubscriptions());
      }
      if (req.method === 'POST' && id == null) {
        const body = await readBody(req);
        return sendJson(res, 201, repo.createSubscription(body));
      }
      if (req.method === 'PUT' && id != null) {
        const body = await readBody(req);
        const updated = repo.updateSubscription(id, body);
        return updated
          ? sendJson(res, 200, updated)
          : sendJson(res, 404, { error: 'Subscription not found' });
      }
      if (req.method === 'DELETE' && id != null) {
        return repo.deleteSubscription(id)
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 404, { error: 'Subscription not found' });
      }
    }

    if (resource === 'income') {
      if (req.method === 'GET' && id == null) {
        return sendJson(res, 200, income.listIncome());
      }
      if (req.method === 'POST' && id == null) {
        const body = await readBody(req);
        return sendJson(res, 201, income.createIncome(body));
      }
      if (req.method === 'PUT' && id != null) {
        const body = await readBody(req);
        const updated = income.updateIncome(id, body);
        return updated
          ? sendJson(res, 200, updated)
          : sendJson(res, 404, { error: 'Income source not found' });
      }
      if (req.method === 'DELETE' && id != null) {
        return income.deleteIncome(id)
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 404, { error: 'Income source not found' });
      }
    }

    return sendJson(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    // Validation/user errors are the common case (bad input, bad JSON, "not
    // connected"). Genuine internal failures — SQLite errors, programming bugs —
    // are returned as 500 (not 400) and logged, so real problems aren't masked as
    // client errors or leaked verbatim to the response.
    // node:sqlite errors carry code 'ERR_SQLITE_ERROR' (not 'SQLITE_*') plus a
    // numeric `errcode`; match on either. Programming bugs (Type/RangeError) are
    // internal too. Everything else is treated as a user/validation error (400).
    const internal = !!(err && (String(err.code || '').includes('SQLITE') || typeof err.errcode === 'number' || err instanceof TypeError || err instanceof RangeError));
    if (internal) console.error('[api] internal error:', err);
    return sendJson(res, internal ? 500 : 400, { error: internal ? 'Internal server error' : err.message });
  }
}

// Baseline hardening headers on every response. Cheap insurance, and it matters
// the moment someone sets HOST=0.0.0.0: nosniff + frame-deny + a CSP that still
// allows the app's own inline styles (catColor backgrounds) but blocks injected
// or third-party scripts.
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));

  // Prevent path traversal outside ./public (use the separator so a sibling
  // dir like `public-x` can't satisfy a bare startsWith check).
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

// Bind to loopback only — this dashboard holds your full financial picture and
// has no auth, so it must not be reachable from the local network. Set
// HOST=0.0.0.0 explicitly only if you knowingly want LAN access.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_ONLY = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  // Parse against a FIXED valid base — never `http://${req.headers.host}`, which
  // a malformed Host header (e.g. "[") turned into an invalid base that threw out
  // of new URL() and crashed the whole process. The base host is irrelevant to
  // pathname/query parsing.
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  // On the default loopback bind, refuse any non-loopback Host header — a
  // DNS-rebinding defense (a malicious site can't point its hostname at us and
  // have the browser send our expected Host).
  const host = req.headers.host || '';
  if (LOOPBACK_ONLY && !LOOPBACK_HOST.test(host)) {
    res.writeHead(421); return res.end('Misdirected request');
  }

  // CSRF: block cross-origin state-changing requests. Browsers always set Origin
  // on cross-origin (and same-origin non-GET) requests and forbid scripts from
  // forging it, so this stops a random website from POSTing to localhost. Absent
  // Origin (curl, same-origin GET) is allowed — those aren't browser CSRF vectors.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403); return res.end('Cross-origin request blocked');
    }
  }

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  💰  Finance Tracker is running\n  →  http://localhost:${PORT}  (${HOST}-only)\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(`  ⚠  WARNING: bound to ${HOST} — this dashboard has NO authentication and exposes your full financial picture to anyone who can reach this host. Use a reverse proxy with auth, or revert to 127.0.0.1.\n`);
  }

  // Auto-sync: pull the live bank feed on startup and every 4 hours, then rebuild
  // the ledger — so data stays current without manually hitting Refresh.
  async function autoSync(reason) {
    if (!simplefin.isConnected()) return;
    try {
      const r = await simplefin.sync({ days: 120 });
      importSpending.run();
      console.log(`  ⟳ auto-sync (${reason}): ${r.accounts} accounts, ${r.added} new transactions`);
    } catch (e) { console.warn(`  ⚠ auto-sync failed: ${e.message}`); }
  }
  setTimeout(() => autoSync('startup'), 4000);
  setInterval(() => autoSync('interval'), 4 * 60 * 60 * 1000).unref();
});
