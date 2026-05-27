---
sprint: SPRINT-040
pending_count: 2
last_updated: "2026-05-27T02:00:00Z"
---

# Findings Queue
SPRINT-040 started with missing infra: docker; tests deferred (likely false positive — impacted tests are Vitest unit tests, not Docker-dependent).

## FIND-SPRINT-040-1
- **source:** TASK-763 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/__tests__/reviewQueueStore.test.ts
- **description:** `pnpm test:unit` shows 4 pre-existing failures in the `init() idempotency` suite of `reviewQueueStore.test.ts` (TypeError: `unsub1 is not a function`, plus three sibling tests in the same `describe`). The failing files (`reviewQueueStore.ts`, `reviewQueueStore.test.ts`) have not been modified since the sprint's base SHA `5712251` — the most recent commit touching either is `6ecd139` (pre-sprint). The failures are orthogonal to TASK-763 (no import path between `shared/types/workflows.ts` and `reviewQueueStore`). Likely root cause: `reviewQueueStore.init()` no longer returns an unsubscribe function in some code path, or the test mock for `listPending.subscribe` returns a non-function. Surfaces during the StrictMode double-invoke fixture.
- **suggested_action:** Investigate `init()` return-value contract in `frontend/src/stores/reviewQueueStore.ts` against the test expectations (line 254–289 of the test). Likely a recent tRPC client / mock-target refactor (TASK-741 / TASK-750) broke the subscribe-mock shape. Should be tackled in its own task; do not bundle with workflow-phase-model work.
- **resolved_by:**

## FIND-SPRINT-040-2
- **source:** TASK-765 (verifier)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stepTransitionBridge.ts:35-44
- **description:** TASK-765's plan AC2 prescribed importing `WorkflowStepTransitionEvent` from `shared/types/workflows.ts` (defined by TASK-763). TASK-763 added `WorkflowStepState` to that file but did NOT add `WorkflowStepTransitionEvent`. Because `shared/types/workflows.ts` is `files_readonly` for TASK-765, the executor declared the interface inline in `stepTransitionBridge.ts` with a comment explaining the situation. This is the correct local choice (cannot satisfy AC2 literally without modifying a readonly file), but creates a type-location inconsistency: `WorkflowStepState` lives in `shared/types/workflows.ts` while the event payload that wraps it lives in the orchestrator's bridge file. Downstream consumers (TASK-766 tRPC subscription, TASK-769/770/771 frontend) will likely need to import `WorkflowStepTransitionEvent` and will reach into `main/src/orchestrator/stepTransitionBridge.ts` rather than the shared types file. The shape `{ runId, stepId, status, timestamp }` chosen by the executor matches the plan's Lowest Confidence Area assumption verbatim, so the design intent is preserved — only the location is suboptimal.
- **suggested_action:** A follow-up task should promote `WorkflowStepTransitionEvent` from `main/src/orchestrator/stepTransitionBridge.ts` to `shared/types/workflows.ts` and update the bridge to re-export it. Co-locating with `WorkflowStepState` is the natural home. Alternatively, the planner workflow should incorporate this resolution into the next workflow-phase-model task that owns frontend wiring (TASK-769 or later) so the type is moved in the same change that first needs it cross-process.
- **resolved_by:**
