---
id: TASK-789
idea: IDEA-027
status: ready
created: 2026-05-27T17:00:00Z
files_owned:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/__tests__/cyboflowStore.test.ts
files_readonly:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/src/hooks/useQuickSession.ts
  - frontend/src/utils/cyboflowApi.ts
acceptance_criteria:
  - criterion: "CyboflowState exports activeQuickSessionRunId: string | null"
    verification: "grep -n 'activeQuickSessionRunId' frontend/src/stores/cyboflowStore.ts returns 3+ matches"
  - criterion: "setActiveQuickSession accepts optional runId parameter"
    verification: "grep 'setActiveQuickSession' shows (sessionId: string, runId?: string) => void"
  - criterion: "With runId, stream subscription is started"
    verification: "pnpm --filter frontend test -- --reporter=verbose 2>&1 | grep 'setActiveQuickSession with runId starts'"
  - criterion: "Without runId, no subscription started (backward-compatible)"
    verification: "pnpm --filter frontend test -- --reporter=verbose 2>&1 | grep 'does NOT call subscribeToStreamEvents'"
  - criterion: "setActiveRun clears activeQuickSessionRunId"
    verification: "pnpm --filter frontend test -- --reporter=verbose 2>&1 | grep 'clears activeQuickSessionRunId'"
  - criterion: "All pre-existing tests pass"
    verification: "pnpm --filter frontend test exits 0"
depends_on: [TASK-788]
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "Store subscription lifecycle is the correctness backbone for stream events. 7 new test cases needed."
  targets:
    - behavior: "setActiveQuickSession(id, runId) starts subscription and stores runId"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
    - behavior: "setActiveQuickSession(id) without runId does NOT start subscription"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
    - behavior: "setActiveRun clears activeQuickSessionRunId"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
    - behavior: "clearActiveQuickSession tears down subscription and clears runId"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
    - behavior: "Quick-to-workflow switch tears down quick subscription first"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
    - behavior: "Rapid quick session switches properly teardown/replace subscriptions"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
---

# Update cyboflowStore mutual-exclusion invariant for quick sessions with run_ids

## Objective

Add activeQuickSessionRunId field and enrich setActiveQuickSession to optionally start a stream subscription when a runId is provided. Keep activeQuickSessionId separate from activeRunId for incremental migration.

## Implementation Steps

1. Add activeQuickSessionRunId: string | null to interface and initial state.
2. Change setActiveQuickSession signature to (sessionId: string, runId?: string).
3. When runId provided, call _startSubscription(runId). Store activeQuickSessionRunId.
4. Update setActiveRun to clear activeQuickSessionRunId.
5. Update clearActiveRun and clearActiveQuickSession to clear activeQuickSessionRunId.
6. Update module-level JSDoc.
7. Add 7 new tests covering all subscription lifecycle paths.

## Acceptance Criteria

See frontmatter.
