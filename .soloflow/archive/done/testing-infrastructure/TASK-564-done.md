---
id: TASK-564
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Added root-level test:build and test:unit scripts unifying main vitest, frontend vitest, and node-assert build tests"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-564 — Done

Added two scripts to root `package.json`:
- `test:build`: `node build/afterSign.test.js && node scripts/configure-build.test.js`
- `test:unit`: `pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build`

`pnpm run test:build` exits 0 in the worktree (6/6 node-asserts pass). AC4 (`pnpm run test:unit` exits 0) deferred to post-merge because the worktree lacks `node_modules` — independent evidence on main (main vitest 309/309, frontend vitest 191/191, test:build 6/6) gives high confidence the chained invocation will succeed once it sees the composed checkout.

Sprint-code-reviewer surfaced an out-of-diff observation (FIND-SPRINT-015-5) about `main/package.json` `scripts.test` using bare `vitest` (watch mode in TTY) — out of scope for this task; queued for compound.

Commit: `65eb3b8` — feat(TASK-564): add test:build and test:unit root scripts
