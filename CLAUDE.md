# Finance Tracker — project guide

Local-first personal finance tracker. Zero runtime dependencies (Node 22.5+ built-in
`node:sqlite`), one SQLite file, plain DOM front-end. Runs with `npm start`.

## Run
```bash
npm start            # node --experimental-sqlite server.js  → http://localhost:4317
```
Windows: double-click `start-finance.bat`. Server binds **127.0.0.1 only** (financial
data, no auth) — set `HOST=0.0.0.0` to expose on LAN (don't, unless you mean it).

**Auto-start (survives reboots):** `powershell -File scripts/install-autostart.ps1`
registers a hidden **Scheduled Task** (`FinanceTracker`, runs at logon) so the server
is always up. Remove with `schtasks /Delete /TN FinanceTracker /F`. Without this the
server only lives as long as the process you launched by hand — a reboot kills it.

## Architecture
- `server.js` — tiny zero-framework HTTP server: JSON API under `/api/*` + static `public/`.
- `db.js` — single SQLite connection + schema (tables created idempotently).
- Per-domain repos, each owns its table and business rules:
  - `subscriptions.js` — recurring subs (active/paused/cancelled). Cancelled are hidden in UI.
  - `income.js` — paycheck **ledger** (each row = one paycheck; `next_billing_date` = pay date).
  - `spending.js` — reads the `transactions` ledger; category/merchant/month rollups.
  - `month.js` — current-month view (income, spend, budgets, pace projection).
  - `forecast.js` — projects upcoming sub charges vs paychecks (the "Upcoming" tab).
  - `insights.js` — month-over-month, P2P recipients, fee/leak finder.
  - `alerts.js` — unified, severity-ranked alert feed (`/api/alerts`). Pure derivation
    over `forecast`/`month`/`detect` + the ledger; the UI's "what to worry about now".
  - `budgets.js` — per-category monthly limits + `suggest()` (3-month-average starter set).
  - `transactions.js` (category overrides), `categorize.js` (keyword rules).
- `util.js` — shared helpers (`round2`, money/date) used across modules; don't re-define them locally.
- `scripts/import-spending.js` — parses all sources → `transactions`. Exports `run()`;
  the server calls it for the in-app **Refresh** button (POST `/api/reimport`).
- `public/app-*.js` — the front-end controller, split into classic scripts loaded
  **in order** (shared global scope): `app-core` (helpers/format/render/modal/income) →
  `app-views` (this-month/spending/profit/upcoming) → `app-features` (simplefin/settings/
  theme/onboarding/alerts) → `app-extra` (budgets/filters/goals/net-worth/insights/tabs) →
  `app-boot` (all immediate wiring — must load last). Each tab has a `refreshX()`.
  `public/sw.js` — service worker; **network-first** for the app shell so front-end
  edits show up on the next load (bump `CACHE` only if you change the offline shell list).

## Data model (SQLite, `finance.db` — git-ignored, never commit)
- `subscriptions`, `income` — curated, user-editable. Shared columns; `cost`=amount,
  `billing_cycle`=frequency, `next_billing_date` repurposed per table.
- `transactions` — derived spending ledger. `counted=0` = excluded (transfers, failed,
  deduped bank funding lines, excluded categories like Adult). Amount = positive outflow.
- `category_overrides` (merchant→category, re-applied every import) and `budgets`.

## Import pipeline (`scripts/import-spending.js`)
Sources in `import/`: bank CSVs (auto-detected by name pattern), `paypal/*/**.txt`
(decoded from PDF, +14 CID cipher), `venmo/*.csv`, `cashapp/*.csv`.
Key rules: **dedup** platform payments against their bank funding line (date±5d + amount)
so each dollar counts once; exclude internal transfers, self-payments, failed txns.
Re-applies `category_overrides` so manual fixes survive. Idempotent (DELETE + reload).

## Conventions
- No build step, no framework, no deps. Keep it that way unless there's a strong reason.
- New tab = table + repo + `/api/*` route + a `refreshX()` in the right `app-*.js` + a `.panel`.
- Money is dollars; normalize cycles via the `CYCLE_TO_MONTHLY` factor.
- After schema/route changes, restart the server. Front-end changes are hot (static).
- **Never commit `finance.db` or `import/`** — they hold real financial data (see `.gitignore`).

## Delivered (was roadmap)
- **Real-time data via SimpleFIN** — live balances + spending; auto-syncs on startup and every 4h. Replaced the "manual exports only" model.
- **Credit cards** — counted when the card is connected via SimpleFIN (balance feeds net worth, spend feeds the ledger). A card you *don't* connect is still invisible (the UI discloses this).
- **Balance-aware forecast** — the overdraft forecast uses the live `balances` table, not just pace.
- **Alerts feed** (`alerts.js`, `/api/alerts`) — global severity-ranked bar: overdraft, low/tight balance, over-budget categories, large charges in the next 7 days, untracked recurring charges, monthly fee leaks. Dismissible (localStorage) + opt-in desktop notifications for criticals.
- **Budgets, activated** — `budgets.suggest()` (`GET /api/budgets/suggest`) seeds per-category limits from the last 3 months' average in one click, lighting up the pace/over-budget UI and the budget alerts.

### Balances: available vs posted (important)
The `balances` table stores both `balance` (posted) and `available` (after pending
holds/transfers). **Display + the overdraft forecast use `available`** (what you can
actually spend today). **Net-worth history (`balance_history`, `netWorth()`) uses
posted `balance`** on purpose — a settled daily series. Don't "fix" one to match the
other; the split is deliberate. Liquid totals net out either way.

## Known gaps / roadmap
- "Other" spending bucket now only holds genuinely un-named PayPal lines (just "PAYPAL" with no merchant — no signal to categorize). Zelle in all common forms (`ZEL `, `ZEL*`, `ZELLE`, `QUICKPAY`) now lands in P2P. Re-categorization applies on the next import/auto-sync.
- Tests live in `test/` (`npm test`): categorization, cycle math, net worth, savings goals, the SimpleFIN-only import pipeline, and `analytics.test.js` — available-vs-posted forecast, overdraft detection, budget pace, the 3-month budget suggester, and the alert feed.
- Open-source readiness: git history is clean (no `finance.db`/`import/`/CSVs ever committed; verified). See `docs/RELEASE-AUDIT.md` for the dual-engine audit and the remaining release checklist.
