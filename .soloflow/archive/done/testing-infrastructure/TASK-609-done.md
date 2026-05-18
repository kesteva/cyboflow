---
id: TASK-609
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Dropped pnpm --filter main exec indirection from test:gate; vitest now runs from repo root with the canonical config path"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-609 — Done

Single-line edit to `package.json:56`. Changed `test:gate` from `pnpm --filter main exec vitest run --config ../vitest.config.gate.ts` to `vitest run --config vitest.config.gate.ts`. The config path no longer needs the `../` adjustment now that cwd is repo root (which matches the `__dirname = repo root` assumption in the config). vitest binary resolves via root `node_modules/.bin/vitest` (hoisted).

`pnpm test:gate` exits 0 (1 test passed) when run from a tree with installed deps.

Commit: `59fd19f` — fix(TASK-609): drop pnpm --filter main exec indirection from test:gate script
