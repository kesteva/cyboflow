---
id: TASK-774
sprint: SPRINT-041
epic: ask-user-question-roundtrip
status: done
summary: "Threaded questionRouter.clearPendingForRun through cancelAndRestartHandler symmetric with approvalRouter clear; 3 regression tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-774 — Wire questionRouter.clearPendingForRun into cancelAndRestartHandler

## Outcome

Closed the symmetry gap from FIND-SPRINT-039-15: cancelAndRestartHandler now clears pending question-gate entries adjacent to (and before) the PTY kill, matching the existing approvalRouter clear pattern. Direct deps-bag injection via `Pick<QuestionRouter, 'clearPendingForRun'>`; wiring from `main/src/index.ts` boot path; three regression tests lock in ordering, argument, and noOp behavior.

## Changes

- `main/src/orchestrator/cancelAndRestartHandler.ts` — added QuestionRouter type import, extended CancelAndRestartDeps, destructured + call between approval clear and PTY stop.
- `main/src/index.ts` — added `questionRouter: QuestionRouter.getInstance()` to `setCancelAndRestartDeps` call.
- `main/src/orchestrator/__tests__/cancelAndRestart.test.ts` — extended OrderSpy + makeDeps + 3 new regression tests; existing AC5 test relaxed to `indexOf > indexOf` to tolerate the new call between.

## Commits

- `0f5a13b` feat(TASK-774): wire questionRouter.clearPendingForRun into cancelAndRestartHandler

## Tests

- pnpm --filter main test: 736/736 (18 in cancelAndRestart.test.ts, +3 new).
- pnpm typecheck: 0.

## Findings

- None new.
