'use strict';

// Unified, severity-ranked alert feed assembled from the existing analyzers:
// the overdraft forecast, budget pace, balance levels, fee leaks, and untracked
// recurring charges. Read-only — pure derivation over data other modules own,
// so there's one place the UI asks "what should I worry about right now?".

const { db } = require('./db');
const forecast = require('./forecast');
const month = require('./month');
const detect = require('./detect');
const reconcile = require('./reconcile');

const { round2 } = require('./util');
const usd = (n) => `$${(round2(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Tunable thresholds — named so they're easy to find and adjust.
const LOW_BALANCE = 200;     // liquid available below this → warn
const LARGE_CHARGE = 75;     // upcoming single charge at/above this → flag
const UPCOMING_DAYS = 7;     // how far ahead "soon" is
const MAX_UNTRACKED = 3;     // cap untracked-recurring nudges so the feed stays calm

const RANK = { critical: 0, warning: 1, info: 2 };

function build() {
  const out = [];
  const push = (severity, id, title, detail, action) =>
    out.push({ severity, id, title, detail, action: action || null });

  // --- Cashflow: overdraft + low balance (from the forward forecast) ---
  let f = null;
  try { f = forecast.summary(); } catch { /* no balances yet */ }
  const bal = f && f.balances;
  if (bal && bal.hasBalances) {
    if (bal.overdraftDate) {
      // Id carries the date so a *new* overdraft (different date) re-surfaces
      // even if the user dismissed an earlier one — a stable 'overdraft' id let
      // a dismissal permanently hide all future overdraft warnings.
      push('critical', `overdraft:${bal.overdraftDate}`,
        'Overdraft projected',
        `Your balance is on track to go negative around ${bal.overdraftDate} (low point ${usd(bal.lowest)}). Move money or pause a charge.`,
        { tab: 'upcoming' });
    } else if (bal.leanOverdraftDate) {
      // Typical weeks look fine, but a run of lean paychecks (25th pct)
      // overdrafts — the failure mode salaried forecasts never see.
      push('warning', `overdraft-lean:${bal.leanOverdraftDate}`,
        'Overdraft risk on lean weeks',
        `Typical pay covers this window, but at lean-week pay (25th percentile) you'd go negative around ${bal.leanOverdraftDate} (low point ${usd(bal.lowestLean)}). Keep a buffer or trim a charge.`,
        { tab: 'upcoming' });
    } else if (bal.lowest != null && bal.lowest < LOW_BALANCE) {
      push('warning', `low-projected:${bal.lowestDate || ''}`,
        'Balance gets tight',
        `Lowest projected point is ${usd(bal.lowest)}${bal.lowestDate ? ` around ${bal.lowestDate}` : ''} — under your ${usd(LOW_BALANCE)} cushion.`,
        { tab: 'upcoming' });
    }
    if (bal.startingBalance != null && bal.startingBalance < LOW_BALANCE) {
      push('warning', 'low-now',
        'Low available balance',
        `You have ${usd(bal.startingBalance)} liquid right now — below your ${usd(LOW_BALANCE)} cushion.`,
        { tab: 'month' });
    }

    // Large charges landing in the next week.
    for (const e of (f.timeline || [])) {
      if (e.kind === 'income') continue;
      if (e.daysAway < 0 || e.daysAway > UPCOMING_DAYS) continue;
      if (e.amount < LARGE_CHARGE) continue;
      const when = e.daysAway === 0 ? 'today' : e.daysAway === 1 ? 'tomorrow' : `in ${e.daysAway} days`;
      push('info', `charge-${e.name}-${e.date}`,
        `${e.name} charges soon`,
        `${usd(e.amount)} expected ${when} (${e.date}).`,
        { tab: 'upcoming' });
    }
  }

  // --- Budgets: categories projected to blow their limit this month ---
  let m = null;
  try { m = month.summary(); } catch { /* ignore */ }
  if (m) {
    for (const c of m.spending.byCategory) {
      if (!c.overBudget) continue;
      push('warning', `budget:${m.month}:${c.category}`,
        `${c.category} over budget`,
        `On pace for ${usd(c.projected)} vs your ${usd(c.budget)} budget (so far ${usd(c.total)}).`,
        { tab: 'month' });
    }
  }

  // --- Subscription ↔ ledger reconciliation: rebills + stale subs ---
  let rec = null;
  try { rec = reconcile.report(); } catch { /* ignore */ }
  if (rec) {
    for (const rb of rec.rebills) {
      const last = rb.charges[rb.charges.length - 1];
      // Id carries the last charge date so a fresh rebill re-surfaces after a dismissal.
      push('critical', `rebill:${rb.name}:${last.date}`,
        `Cancelled sub charged again`,
        `${rb.name} was cancelled ${rb.cancelDate} but a matching charge (${usd(last.amount)}) landed ${last.date}. Check the autopay and dispute if needed.`,
        { tab: 'subscriptions' });
    }
    for (const d of rec.doubles) {
      push('warning', `double:${d.name}:${d.dates[d.dates.length - 1]}`,
        `${d.name} billed ${d.dates.length}× in close succession`,
        `${usd(d.amount)} charges on ${d.dates.join(', ')} — closer than its cycle allows. Duplicate charge or overlapping subs; check the vendor account.`,
        { tab: 'subscriptions' });
    }
    for (const s of rec.subs) {
      if (!s.stale) continue;
      push('warning', `stale-sub:${s.name}`,
        `${s.name} may have lapsed or moved`,
        `No matching charge since ${s.lastCharge.date} (${s.cycle} sub). Verify it still bills — then update or cancel it here.`,
        { tab: 'subscriptions' });
    }
  }

  // --- Untracked recurring charges (the auto-audit) ---
  let sug = [];
  try { sug = detect.suggestions(); } catch { /* ignore */ }
  for (const s of sug.slice(0, MAX_UNTRACKED)) {
    push('info', `untracked-${s.merchant}`,
      `Untracked recurring charge`,
      `${s.merchant} — ${usd(s.amount)}/${s.cycle}, seen ${s.count}×. Not in your subscriptions yet.`,
      { tab: 'subscriptions' });
  }

  // --- Fee leaks this month (overdraft / paid-item fees you can avoid) ---
  const ym = m ? m.month : null;
  if (ym) {
    const fees = db.prepare(
      `SELECT ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions
       WHERE counted = 1 AND category = 'Fees & Charges' AND substr(date,1,7) = ?`
    ).get(ym);
    if (fees && fees.n > 0 && fees.total > 0) {
      push('warning', `fees:${ym}`,
        'Bank fees this month',
        `${usd(fees.total)} in fees across ${fees.n} charge${fees.n > 1 ? 's' : ''} — often avoidable.`,
        { tab: 'insights' });
    }
  }

  out.sort((a, b) => (RANK[a.severity] - RANK[b.severity]));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const a of out) counts[a.severity]++;
  return { alerts: out, counts, total: out.length };
}

module.exports = { build };
