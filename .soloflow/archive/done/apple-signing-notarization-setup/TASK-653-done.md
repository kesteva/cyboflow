---
id: TASK-653
sprint: SPRINT-025
epic: apple-signing-notarization-setup
status: done
summary: "Removed dead electron-store@^11.0.0 dependency from main/package.json; refreshed lockfile; recorded removal in docs/packaging/root-deps-policy.md"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-653: Remove dead electron-store dependency

## Outcome

Pure dependency cleanup. Confirmed zero importers across `main/src`, `frontend/src`, `shared`, `scripts`. Removed the `electron-store@^11.0.0` line from `main/package.json`, regenerated `pnpm-lock.yaml` via `pnpm install`, and documented the removal in `docs/packaging/root-deps-policy.md`. All ACs met (criterion #7 — `pnpm --filter main test` — exits non-zero due to 5 pre-existing test failures unrelated to this task, confirmed reproducible on base SHA f2dc12e; logged as FIND-SPRINT-025-1 and FIND-SPRINT-025-2).

## Changes

- `main/package.json` — removed `"electron-store": "^11.0.0"` from `dependencies`
- `pnpm-lock.yaml` — regenerated (99 lines removed)
- `docs/packaging/root-deps-policy.md` — removed Dead deps bullet; added new `## Removed dependencies` section

## Commits

- `9a63d87` — `chore(TASK-653): remove dead electron-store dependency`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm install --frozen-lockfile: PASS
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
- test-writer: NO_TESTS_NEEDED (config/lockfile/doc changes have no test surface)

## Out-of-diff findings filed

- FIND-SPRINT-025-3 — plan AC contradiction (grep cannot pass after doc rewrite)
- FIND-SPRINT-025-4 — web-streams-polyfill@^3.3.3 is also dead (Node 22+ ships WHATWG streams natively)
- FIND-SPRINT-025-5 — dotenv@^16.4.7 is also dead (zero importers)
- FIND-SPRINT-025-6 — doc xref no longer resolves after this removal
