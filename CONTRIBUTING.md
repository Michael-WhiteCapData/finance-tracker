# Contributing

Thanks for your interest! This is a small, local-first, zero-dependency app and
the goal is to keep it that way.

## Principles
- **No runtime dependencies.** It runs on Node's built-ins (`node:sqlite`, `http`).
  Please don't add npm packages without a strong reason.
- **No build step.** Plain HTML/CSS/JS in `public/`. If a change needs a bundler,
  it probably doesn't belong here.
- **Privacy first.** Never commit real financial data. `finance.db` and `import/`
  are git-ignored — keep it that way. Don't log secrets (access keys, tokens).
- **Many small files.** One concern per module; see `CLAUDE.md` for the map.

## Dev loop
```bash
npm start              # http://localhost:4317 (127.0.0.1 only)
npm test               # node --test: money math, net worth, dedup pipeline
node --experimental-sqlite scripts/seed-demo.js   # populate a demo dataset
```
Use `FINANCE_DB=/tmp/test.db npm start` to run against a throwaway database.
Tests are zero-dependency (`node:test`) and isolate themselves via `FINANCE_DB`
and `FINANCE_IMPORT`, so they never touch your real `finance.db` or `import/`.

## Before a PR
- `npm test` passes.
- `node --check` your changed `.js` files (no linter required, but keep it clean).
- Confirm a fresh clone with an empty DB still boots and shows the onboarding screen.
- Confirm no secrets or personal data are in the diff.

## Architecture
See `CLAUDE.md` — it maps every module, the data model, and the import pipeline.
