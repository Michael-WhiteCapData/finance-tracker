'use strict';

// Manual category editing. Setting a category saves an override keyed by the
// transaction's merchant and re-labels every transaction from that merchant, so
// one fix cleans up all of them and survives future re-imports.
const { db } = require('./db');

const CATEGORIES = [
  'Food & Dining', 'Groceries', 'Gas & Auto', 'Shopping', 'Gaming', 'Entertainment',
  'Subscriptions', 'Health', 'Education', 'Bills & Utilities', 'P2P / People',
  'Crypto / Investment', 'Gambling', 'Fees & Charges', 'Cash & ATM', 'Transfer', 'Adult', 'Other',
];

const EXCLUDED = new Set(['Adult', 'Transfer']);

function setCategory(id, category) {
  const cat = String(category || '').trim();
  if (!CATEGORIES.includes(cat)) throw new Error('Unknown category');
  const t = db.prepare('SELECT merchant FROM transactions WHERE id = ?').get(id);
  if (!t) return null;
  const counted = EXCLUDED.has(cat) ? 0 : 1;
  // 'Unknown' is the catch-all label for un-named merchants — many unrelated
  // transactions share it, so scope the fix to this one row and don't save an
  // override that would relabel every unknown transaction.
  if (!t.merchant || t.merchant === 'Unknown') {
    db.prepare('UPDATE transactions SET category = ?, counted = ? WHERE id = ?').run(cat, counted, id);
    return { merchant: t.merchant || null, category: cat, updated: 1, scopedToRow: true };
  }
  db.prepare(
    `INSERT INTO category_overrides (merchant, category) VALUES (?, ?)
     ON CONFLICT(merchant) DO UPDATE SET category = excluded.category, updated_at = datetime('now')`
  ).run(t.merchant, cat);
  // Re-label all rows from this merchant, keeping `counted` consistent.
  const info = db.prepare('UPDATE transactions SET category = ?, counted = ? WHERE merchant = ?').run(cat, counted, t.merchant);
  return { merchant: t.merchant, category: cat, updated: info.changes };
}

module.exports = { CATEGORIES, setCategory };
