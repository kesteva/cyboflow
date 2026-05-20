---
id: TASK-669
sprint: SPRINT-025
epic: stuck-detection-and-observability
status: done
summary: "setRunStatus terminal-status branch now co-evicts runStatusMap, runReasonMap, and runDetectedAtMap in a single atomic Zustand update; added pureSetRunStatusAllMaps helper exported alongside the existing single-map pureSetRunStatus"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-669: Co-evict runReasonMap and runDetectedAtMap on terminal status

## Outcome

When `setRunStatus` is called with a terminal status (`completed`, `canceled`, `failed`), it now deletes the entry from all three maps in a single atomic Zustand update. Previously only `runStatusMap` was evicted, leaving the reason/detectedAt entries unbounded. Audited all consumers (useStuckNotifications, PendingApprovalCard, ReviewQueueView) — none read these maps after a terminal transition (all are gated on `isStuck`). New `pureSetRunStatusAllMaps` exported alongside the original single-map helper. 10 new test cases (5 slice + 5 pure helper) cover the eviction semantics.

## Changes

- `frontend/src/stores/reviewQueueSlice.ts` — terminal-status branch co-evicts all three maps; JSDoc updated; new `pureSetRunStatusAllMaps` exported
- `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` — 10 new cases

## Commits

- `df427f7` — `feat(TASK-669): evict runReasonMap and runDetectedAtMap on terminal status in setRunStatus`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS (0 errors)
- pnpm test (frontend): 235/235 pass (reviewQueueSlice: 41 tests, +10 new)
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
- test-writer: NO_TESTS_NEEDED

## Out-of-diff findings filed

- FIND-SPRINT-025-10 — drift risk between `pureSetRunStatus` (single-map) and `pureSetRunStatusAllMaps`; original has zero production callers and could be removed in a follow-up cleanup; the new helper also lacks the no-op same-reference optimization the original documents
