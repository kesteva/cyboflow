---
sprint: SPRINT-040
pending_count: 1
last_updated: "2026-05-27T01:00:00Z"
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
