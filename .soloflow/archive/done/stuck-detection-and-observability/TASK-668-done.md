---
id: TASK-668
sprint: SPRINT-025
epic: stuck-detection-and-observability
status: done
summary: "Promoted StuckEventsClient to shared/types/stuckDetection.ts; rewrote useStuckNotifications to observe runStatusMap via Zustand subscribe (single tRPC subscription chain via reviewQueueSlice)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-668: Single subscription chain for stuck-event notifications

## Outcome

Eliminated duplicate tRPC subscription to `onStuckDetected`. `StuckEventsClient` interface promoted to `shared/types/stuckDetection.ts`. `reviewQueueSlice` retains the sole tRPC subscription. `useStuckNotifications` rewired to observe `runStatusMap` via Zustand's `subscribe` callback, firing notifications only on first stuck transitions during the hook's lifetime (per-app-launch dedupe preserved via `notifiedRunsRef`).

## Changes

- `shared/types/stuckDetection.ts` — added `export interface StuckEventsClient`
- `frontend/src/stores/reviewQueueSlice.ts` — removed local interface, imports from shared
- `frontend/src/hooks/useStuckNotifications.ts` — removed tRPC subscription; observes slice state
- `frontend/src/hooks/__tests__/useStuckNotifications.test.ts` — rewired to drive via slice; Proxy-based tRPC stub

## Commits

- `0b8871e` — `feat(TASK-668): promote StuckEventsClient to shared/types/stuckDetection.ts`
- `4d928b8` — `feat(TASK-668): rewrite useStuckNotifications to observe slice runStatusMap`
- `3d219c7` — `test(TASK-668): rewire useStuckNotifications tests to drive via slice state`

## Verification

- pnpm typecheck: TASK-668's owned files clean (the 2 TS2307 errors were parallel-execution residue from TASK-659 hook absence — resolves at merge-back)
- pnpm lint: PASS (0 errors)
- pnpm test (frontend): 213/213 pass (including 31 reviewQueueSlice + 6 useStuckNotifications)
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
