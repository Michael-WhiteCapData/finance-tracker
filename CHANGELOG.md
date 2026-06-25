# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-25

First public release.

### Added
- **Alerts** — a unified, severity-ranked feed (overdraft, tight/low balance,
  over-budget categories, large upcoming charges, untracked recurring charges,
  monthly fee leaks) with dismissals and opt-in desktop notifications.
- **Budgets** — per-category monthly limits with a one-click suggester that seeds
  them from your last 3 months' average spend.
- **Available vs. posted balances** — display and the overdraft forecast use your
  *available* (spendable) balance; net-worth history keeps posted balances.
- `npm run demo` — try the app instantly with realistic fake data (separate `demo.db`).
- Windows auto-start via a Scheduled Task (`scripts/install-autostart.ps1`).

### Changed
- Front-end controller split into focused `public/app-*.js` modules.
- Service worker is now network-first, so updates appear without a hard refresh.

### Security
- CSRF protection: cross-origin state-changing requests are blocked.
- Malformed `Host` headers no longer crash the server.
- SimpleFIN setup/access URLs are restricted to public HTTPS hosts (SSRF guard).
- The database backup endpoint is loopback-only (it embeds the SimpleFIN credential).
- Per-client rate limiting on all write endpoints; baseline security headers + CSP.

### Fixed
- Overdraft forecast now respects each income source's pay cadence and includes
  every income stream (previously assumed weekly and used only one source).
- Multi-source monthly income is summed correctly (was halved).
- Subscriptions with very old anchor dates no longer vanish from the forecast.
- `next_billing_date` is validated as `YYYY-MM-DD`.
