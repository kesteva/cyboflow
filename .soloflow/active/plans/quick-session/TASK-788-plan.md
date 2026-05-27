---
id: TASK-788
idea: IDEA-027
status: ready
created: 2026-05-27T17:30:00Z
files_owned:
  - main/src/ipc/session.ts
  - main/src/ipc/__tests__/sessionQuickCreate.test.ts
files_readonly:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/database/database.ts
  - main/src/database/models.ts
acceptance_criteria:
  - criterion: "sessions:create-quick calls ensureQuickWorkflow then createRun to insert a workflow_runs row"
    verification: "Read main/src/ipc/session.ts sessions:create-quick handler"
  - criterion: "The run is transitioned queued -> starting -> running before return"
    verification: "Read main/src/ipc/session.ts; after createRun, handler UPDATEs to starting then calls transitionToRunning"
  - criterion: "sessions.run_id is backfilled with the new runId"
    verification: "Read main/src/ipc/session.ts; UPDATE sessions SET run_id = runId WHERE id = session.id"
  - criterion: "permissionMode is no longer forwarded to taskQueue.createSession"
    verification: "grep -n 'permissionMode' in the sessions:create-quick handler shows no pass-through"
  - criterion: "Response includes runId"
    verification: "Return data includes runId alongside jobId, sessionId, worktreePath"
  - criterion: "All existing tests pass"
    verification: "pnpm test:unit exits 0"
depends_on: [TASK-787]
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "The workflow_runs wiring logic is complex enough to warrant new test coverage in the existing sibling test file."
  targets:
    - behavior: "Handler creates workflow_runs row via ensureQuickWorkflow + createRun, transitions to running, backfills run_id"
      test_file: "main/src/ipc/__tests__/sessionQuickCreate.test.ts"
      type: unit
---

# Wire sessions:create-quick to insert a workflow_runs row via sentinel workflow

## Objective

Modify the sessions:create-quick IPC handler so every quick session gets a workflow_runs row, enabling ApprovalRouter to work for quick sessions.

## Implementation Steps

1. Import transitionToRunning from ../services/cyboflow/transitions.
2. Destructure workflowRegistry from services.cyboflow.
3. Remove permissionMode from taskQueue.createSession call.
4. After session Promise resolves: call ensureQuickWorkflow(projectId), createRun(sentinelWorkflowId), transition queued->starting->running, backfill sessions.run_id.
5. Add runId to response data.
6. Update JSDoc.
7. Add tests to sessionQuickCreate.test.ts.

## Acceptance Criteria

See frontmatter.
