---
id: TASK-563
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Wired frontend vitest with jsdom + setupFiles so existing specs (including migrateLocalStorageKey) execute under pnpm --filter frontend test"
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-563 — Done

Created `frontend/vitest.config.ts` with `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`, and react plugin. devDeps (vitest, @vitest/ui, jsdom) and `test: "vitest run"` script were already present in `frontend/package.json` from TASK-402 scaffolding.

Initial pass used `globals: false` per the plan; verifier flagged that 13 sibling test files using `@testing-library/jest-dom` failed with `ReferenceError: expect is not defined` because the setup file's `expect.extend(...)` needs `expect` global. Retry adopted the canonical `main/vitest.config.ts` pattern (`globals: true` + `setupFiles`).

Result: `pnpm --filter frontend test` exits 0 with 191 tests across 14 files passing, including the 4 `migrateLocalStorageKey` cases AC4 targets.

Commits:
- `6fd75d4` — feat(TASK-563): add frontend/vitest.config.ts with jsdom environment
- `4d074fa` — fix(TASK-563): add setupFiles and globals:true to frontend vitest config
