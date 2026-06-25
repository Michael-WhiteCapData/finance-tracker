# Release Audit — FinanceTracker (2026-06-25)

Dual-engine audit (Codex/GPT-5.5 + 3 Claude reviewers), cross-checked and verified,
then remediated. **Status: Phases 1–3 complete; Phase 4 = fresh-clone smoke passed,
commit/push pending owner go.**

## Verified-good
Git history clean (no db/csv/import ever committed). SQL parameterized, `escapeHtml`
consistent, SimpleFIN credential never logged, available-vs-posted split correct,
empty DB boots to onboarding.

## Resolved false alarms (verified)
- Committed screenshots were **demo data** (seed-demo merchants), not real PII — recaptured anyway.
- "CLAUDE.md says history contains personal data" — **false**; claim removed.

## Phase 1 — Correctness  ✅
- [x] forecast income: respect `billing_cycle`, iterate all income sources
- [x] forecast: split the shared `guard` counter (old subs vanished)
- [x] income.monthlyTotal(): correct multi-source sum (was halving)
- [x] alert dismissals: content-specific ids + 30-day TTL (critical re-surfaces)
- [x] validate `next_billing_date` as YYYY-MM-DD (income + subscriptions)
- [x] tests: multi-source income, biweekly cadence, old-anchor, date validation, alert id

## Phase 2 — Security  ✅
- [x] CSRF/Origin guard on state-changing requests (verified: evil.com POST → 403)
- [x] malformed `Host` header no longer crashes the server (verified: → 421, stays up)
- [x] restrict SimpleFIN claim/access URLs to https + non-private hosts (SSRF)
- [x] `/api/backup` is loopback-only (embeds the SimpleFIN credential)
- [x] per-IP rate limit covering all write endpoints (+ map-leak fix)
- [x] `.env*` added to `.gitignore`; path-traversal guard hardened; one innerHTML escaped

## Phase 3 — OSS prep  ✅
- [x] scrubbed real names/merchants/location from tests + a comment (PII scan clean)
- [x] removed false "history contains personal data" claim
- [x] de-hardcoded `start-finance.bat` (%~dp0) + `install-autostart.ps1` ($PSScriptRoot)
- [x] README: macOS/Linux + Windows always-on; privacy wording fixed (SimpleFIN clarified)
- [x] `package.json` metadata (repo/homepage/bugs/keywords/author/license; dropped `private`; v1.0.0)
- [x] `npm run demo` (separate demo.db); recaptured screenshots showing Alerts + Budgets
- [x] CHANGELOG, `.editorconfig`, `.github/` templates + CI workflow

## Phase 4 — Release
- [x] fresh-clone smoke: empty DB → onboarding (not connected, no data, alerts empty), `/` 200
- [ ] **commit the coherent tree; push** — requires explicit owner go (outward-facing)
- [ ] confirm the GitHub repo URL in `package.json` (currently `Michael-WhiteCapData/finance-tracker` — a guess)

## Deferred (documented, not doing now)
- Money as integer cents instead of REAL — larger migration; `round2` is adequate for a
  personal local tool. Revisit if precision issues surface.
- Credit-card/liability sign normalization + same-day net-worth freshness (MEDIUM, Codex) —
  only affects multi-account net worth; tracked for a follow-up.
