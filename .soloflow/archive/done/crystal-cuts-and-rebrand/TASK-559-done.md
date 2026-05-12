---
id: TASK-559
sprint: SPRINT-002
epic: crystal-cuts-and-rebrand
status: done
summary: "Deleted stale main/src/services/__tests__/gitStatusManager.test.ts (440 lines, 19/23 failing tests targeting private methods that no longer exist on the public API). User-visible coverage preserved via Playwright tests/git-status.spec.ts. Parsing logic test coverage deferred to a future epic targeting gitPlumbingCommands.ts."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-559 — Done

The Crystal-era `gitStatusManager.test.ts` had 19 of 23 tests failing because they targeted private methods (`executeGitCommand`, `getRevListCount`, `getDiffStats`, `getUntrackedFiles`, `checkMergeConflicts`, `fetchGitStatus`, `pollAllSessions`, internal `cache` property) that no longer exist on the current public API. Plan recommended DELETE rather than rewrite — confirmed:
- Parsing logic the tests used to indirectly exercise has been extracted to `main/src/services/gitPlumbingCommands.ts` (`fastCheckWorkingDirectory`, `fastGetAheadBehind`, `fastGetDiffStats`).
- User-visible behavior is covered by `tests/git-status.spec.ts` (Playwright E2E): asserts indicator renders with valid `data-git-state` enum value and exercises loading-state transitions.
- Asymmetric maintenance cost — a rewrite gets stale on every gitStatusManager refactor (28 methods, frequent changes), whereas Playwright coverage is decoupled from internal structure.

After deletion, `pnpm --filter main test` exits 0 (5/5 in crystalDirectory.test.ts pass). All 4 acceptance_criteria satisfied (AC2 trivially per the deletion-branch wording; AC3 commit message contains both "Playwright" and "tests/git-status.spec.ts").

Accepted risk per plan's Lowest Confidence Area: `gitPlumbingCommands.ts` parsing logic is now untested at unit level. A future epic touching git parsing should add `gitPlumbingCommands.test.ts`.

Commit: 4fe25c0 test(TASK-559): delete stale gitStatusManager.test.ts (covered by Playwright tests/git-status.spec.ts)
