---
id: TASK-775
sprint: SPRINT-041
epic: ask-user-question-roundtrip
status: done
summary: "Both stores' second-subscription onError now mirror first-subscription cleanup (dual unsubscribe + closure reset); regression tests added."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-775 — Second-subscription onError mirrors first-subscription cleanup

## Outcome

Closed FIND-SPRINT-039-8: reviewQueueStore + questionStore second-subscription onError handlers now unsubscribe both channels, reset `initialized=false`, and clear `cachedUnsubscribe=null`, matching the first-subscription pattern. Closure self-reference (`decidedSubscription.unsubscribe()` inside its own onError) is safe because `subscribe()` returns synchronously. Recovery via subsequent `init()` is now possible regardless of which channel drops.

## Changes

- `frontend/src/stores/reviewQueueStore.ts` — onApprovalDecided onError full cleanup mirror.
- `frontend/src/stores/questionStore.ts` — onQuestionAnswered onError full cleanup mirror.
- `frontend/src/stores/__tests__/reviewQueueStore.test.ts` — new regression test.
- `frontend/src/stores/__tests__/questionStore.test.ts` — new regression test.

## Commits

- `6c575b4` fix(TASK-775): mirror second-subscription onError cleanup in both stores
- `ed2f661` test(TASK-775): add regression tests for second-subscription onError recovery

## Tests

- pnpm --filter frontend test: 513/513 pass (40 files).
- typecheck: 0; lint: 0 errors.

## Findings

- None new.
