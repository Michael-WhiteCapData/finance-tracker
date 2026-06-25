'use strict';

// Current-month tracker: pulls together this calendar month's income (paychecks),
// spending (the counted ledger), the net so far, and a simple end-of-month
// projection based on the pace through the month.

const { db } = require('./db');
const budgets = require('./budgets');

const { round2 } = require('./util');

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function summary(ym = currentMonth()) {
  const [year, mon] = ym.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();

  // How far into the month are we? Full month if it's already past.
  const today = new Date();
  const isCurrent = ym === currentMonth();
  const isFuture = new Date(year, mon - 1, 1) > today;
  const daysElapsed = isFuture ? 0 : isCurrent ? today.getDate() : daysInMonth;
  const daysLeft = Math.max(daysInMonth - daysElapsed, 0);

  // Income (paychecks) landing this month
  const incomeItems = db
    .prepare(
      `SELECT name, cost AS amount, next_billing_date AS date FROM income
       WHERE status = 'active' AND substr(next_billing_date,1,7) = ?
       ORDER BY next_billing_date DESC`
    )
    .all(ym);
  const incomeTotal = round2(incomeItems.reduce((s, r) => s + r.amount, 0));

  // Spending this month (counted only)
  const spendRow = db
    .prepare(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM transactions WHERE counted = 1 AND substr(date,1,7) = ?`)
    .get(ym);
  const spendTotal = round2(spendRow.total);

  const byCategory = db
    .prepare(
      `SELECT category, ROUND(SUM(amount),2) total, COUNT(*) n FROM transactions
       WHERE counted = 1 AND substr(date,1,7) = ? GROUP BY category ORDER BY total DESC`
    )
    .all(ym);

  const recent = db
    .prepare(
      `SELECT id, date, merchant, category, source, amount, note FROM transactions
       WHERE counted = 1 AND substr(date,1,7) = ? ORDER BY date DESC, id DESC LIMIT 30`
    )
    .all(ym);

  // Merge in budgets + a per-category month-end projection.
  const budgetMap = budgets.list();
  const projFactor = (isCurrent && daysElapsed > 0) ? daysInMonth / daysElapsed : 1;
  for (const c of byCategory) {
    c.budget = budgetMap[c.category] != null ? round2(budgetMap[c.category]) : null;
    c.projected = round2(c.total * projFactor);
    c.overBudget = c.budget != null && c.projected > c.budget;
  }
  // Show budgeted categories with no spend yet, too.
  for (const [cat, lim] of Object.entries(budgetMap)) {
    if (!byCategory.some((c) => c.category === cat)) {
      byCategory.push({ category: cat, total: 0, n: 0, budget: round2(lim), projected: 0, overBudget: false });
    }
  }

  const net = round2(incomeTotal - spendTotal);

  // Pace projection — only meaningful while the month is in progress. Project
  // both spending and income to month-end at the current daily pace, so the net
  // accounts for paychecks still expected before the month closes.
  const projecting = isCurrent && daysElapsed > 0 && daysLeft > 0;
  const toEnd = (v) => round2((v / daysElapsed) * daysInMonth);
  const projSpend = projecting ? toEnd(spendTotal) : spendTotal;
  const projIncome = projecting ? toEnd(incomeTotal) : incomeTotal;
  const projNet = round2(projIncome - projSpend);
  const dailyPace = daysElapsed > 0 ? round2(spendTotal / daysElapsed) : 0;

  // Prior 3 full months average spend, for comparison
  const avg = db
    .prepare(
      `SELECT ROUND(AVG(m),2) a FROM (
         SELECT SUM(amount) m FROM transactions
         WHERE counted = 1 AND substr(date,1,7) < ?
         GROUP BY substr(date,1,7) ORDER BY substr(date,1,7) DESC LIMIT 3)`
    )
    .get(ym).a || 0;

  return {
    month: ym,
    label: monthLabel(ym),
    daysInMonth, daysElapsed, daysLeft, isCurrent,
    income: { total: incomeTotal, count: incomeItems.length, items: incomeItems },
    spending: { total: spendTotal, count: spendRow.n, byCategory, recent },
    net,
    dailyPace,
    projection: { spending: projSpend, income: projIncome, net: projNet, projecting },
    avgSpending: round2(avg),
    budgetTotal: budgets.totalLimit(),
  };
}

module.exports = { currentMonth, summary };
