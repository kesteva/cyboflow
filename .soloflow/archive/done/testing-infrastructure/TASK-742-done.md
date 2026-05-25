---
id: TASK-742
sprint: SPRINT-036
epic: testing-infrastructure
status: done
summary: "Rename root test script to test:e2e; disambiguate pnpm test prose across CLAUDE.md, ARCHITECTURE.md, AGENTS.md, CONTRIBUTING.md."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-742 — Done

## Summary
Removed `"test": "playwright test"` from `package.json` and added `"test:e2e"` as a portable POSIX-sh wrapper that strips pnpm's injected `--` separator before forwarding args to Playwright. Disambiguated `pnpm test` prose across four owned docs files (`pnpm test:e2e` for Playwright contexts; `CONTRIBUTING.md` split into separate `pnpm test:unit` + `pnpm test:e2e` examples). `pnpm test` is now intentionally undefined so muscle-memory invocations surface an explicit error rather than silently running the broken e2e bootstrap. Resolves the option (a) path of the compound proposal; option (b) (fix Playwright via `_electron.launch()`) remains deferred.

## Verification
- `pnpm test:unit` → exits 0 (645 main + 322 frontend + schema parity + build scripts).
- `pnpm test:e2e -- tests/smoke.spec.ts --list` → exits 0 (3 tests listed, no execution).
- `pnpm typecheck` → 0 errors.
- `pnpm lint` → 0 errors.
- AC7 verified: `.github/workflows/quality.yml` unchanged (uses `pnpm test:ci:minimal`).
- All seven acceptance criteria pass.
- Visual verification: not_applicable — script/docs change.

## Plan-vs-Implementation Deviation
Plan prescribed `"test:e2e": "playwright test"` literal; executor wrote a sh wrapper that strips pnpm's `--` separator. Empirically required: plain form failed AC5 because Playwright sees `--list` after `--` as a file glob. Verifier reproduced the plain-form failure and confirmed the wrapper is the correct fix. Logged as FIND-SPRINT-036-4 (type: claude-md) so the compounder can document the pnpm/Playwright `--` quirk in `docs/CODE-PATTERNS.md`.

## Code Review
CLEAN. Wrapper is portable POSIX-sh, correctly escaped, no injection surface (developer-typed args only).

## Commit
- `4a6c263` — `feat(TASK-742): rename root test script to test:e2e; disambiguate pnpm test prose`
