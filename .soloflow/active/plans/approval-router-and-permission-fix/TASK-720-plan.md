---
id: TASK-720
idea: SPRINT-029-compound
status: in-flight
source_sprint: SPRINT-029
created: "2026-05-21T00:00:00.000Z"
files_owned:
  - main/src/index.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/types.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - shared/types/approvals.ts
  - shared/types/approval.ts
  - .soloflow/active/findings/SPRINT-029-findings.md
  - .soloflow/active/compound/SPRINT-029-proposal.md
acceptance_criteria:
  - criterion: "The hardcoded `workflowName: ''` AND its TODO comment in main/src/index.ts are removed."
    verification: "grep -nE \"workflowName:\\s*''\" main/src/index.ts returns 0 matches AND grep -n 'TODO(approval-router): resolve via workflows-table lookup' main/src/index.ts returns 0 matches"
  - criterion: "New helper file main/src/orchestrator/approvalCreatedBridge.ts exports buildApprovalCreatedEvent(request, db): ApprovalCreatedEvent that resolves workflowName via a SELECT JOIN."
    verification: "test -f main/src/orchestrator/approvalCreatedBridge.ts AND grep -nE 'export (function|const) buildApprovalCreatedEvent' main/src/orchestrator/approvalCreatedBridge.ts returns at least 1 match"
  - criterion: The approvalCreated listener in index.ts delegates to buildApprovalCreatedEvent.
    verification: "grep -nE 'buildApprovalCreatedEvent\\(' main/src/index.ts returns at least 1 match inside the approvalCreated callback."
  - criterion: "Missing-row fallback: bridge degrades to workflowName='' with console.warn rather than throwing."
    verification: "grep -nE 'console\\.warn' main/src/orchestrator/approvalCreatedBridge.ts returns at least 1 match."
  - criterion: "Unit test asserts round-trip parity: bridge.workflowName === listPending.workflowName for the same seeded approval."
    verification: "grep -nE 'parity|round.trip' main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts returns at least 1 match AND pnpm --filter main test approvalCreatedBridge exits 0"
  - criterion: pnpm typecheck and pnpm lint and pnpm --filter main test exit 0.
    verification: "pnpm typecheck && pnpm lint && pnpm --filter main test"
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: FIND-SPRINT-029-8 is a cross-task data-drift bug that only the sprint-code-reviewer caught. The fix sticks only if a single test exercises both the SSE bridge AND listPending against the same seeded DB row and asserts workflowName is byte-identical. Without it the same per-task review blindspot re-emerges.
  targets:
    - behavior: "Round-trip parity: bridge.workflowName === listPending.workflowName for same approval"
      test_file: main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
      type: unit
    - behavior: "Positive resolution: bridge returns workflowName='parity-workflow' when workflow row exists"
      test_file: main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
      type: unit
    - behavior: "Missing-row fallback: returns workflowName='' with console.warn, does not throw"
      test_file: main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
      type: unit
---
# Fix workflowName data drift between SSE bridge and listPending

## Objective

Resolve the `workflowName: ''` hardcode in the SSE bridge (main/src/index.ts) so the SSE-pushed cards and listPending-hydrated cards agree on `workflowName`. Extract the JOIN logic into a pure helper for unit-testability.

## Implementation Steps

1. **Create main/src/orchestrator/approvalCreatedBridge.ts** with `buildApprovalCreatedEvent(request, db)`:
   ```ts
   export function buildApprovalCreatedEvent(request: ApprovalRequest, db: DatabaseLike): ApprovalCreatedEvent {
     let workflowName = '';
     try {
       const row = db.prepare(`SELECT w.name AS name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`).get(request.runId) as { name: string } | undefined;
       if (row && typeof row.name === 'string') workflowName = row.name;
       else console.warn(`[approvalCreatedBridge] No workflow row found for runId=${request.runId}`);
     } catch (err) {
       console.warn(`[approvalCreatedBridge] workflowName lookup threw for runId=${request.runId}: ${err}`);
     }
     const payloadJson = JSON.stringify(request.input);
     const payloadPreview = payloadJson.length > 512 ? payloadJson.slice(0, 512) : payloadJson;
     return { approval: { id: request.id, runId: request.runId, workflowName, toolName: request.toolName, payloadPreview, rationale: null, createdAt: new Date(request.timestamp).toISOString(), status: 'pending' } };
   }
   ```

2. **Edit main/src/index.ts approvalCreated listener** to call `buildApprovalCreatedEvent(request, db)` instead of constructing the event inline. Remove the TODO comment.

3. **Add unit tests** at main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts:
   - Positive resolution (real workflow row → returns name)
   - Missing-row fallback (no workflow row → returns '', logs warn, does not throw)
   - Round-trip parity (bridge.workflowName === listPending.workflowName for same approval)
   - Field completeness (id, runId, toolName, payloadPreview, status all populated)

4. Run pnpm typecheck && pnpm lint && pnpm --filter main test. All exit 0.

## Hardest Decision

JOIN at bridge (chosen) vs JOIN inside ApprovalRouter.requestApproval. Bridge-side keeps the in-memory ApprovalRequest shape lean for the SDK PreToolUse hook (which never reads workflowName) and matches symmetry with listPending. Router-side widens the load-bearing ApprovalRequest contract for a UI-string concern.

## Rejected Alternatives

- Router-side JOIN: widens ApprovalRequest, couples requestApproval transaction to workflows table.
- Inline JOIN in index.ts: untestable (only test for index.ts is hasCwdString — too Electron-coupled).
- Make workflowName optional in Approval: loosens wire-stable UI type.
- Drop SSE payload, force renderer to re-call listPending: doubles RTT.

## Lowest Confidence Area

Missing-row fallback semantics — warn + emit vs silently drop. Chose emit because silent drop creates an invisible-discard mode that's harder to debug. If the warn fires in production, that's a finding worth follow-up.

## Coordination with B4

B4 (TASK-721) will extract truncatePayloadPreview + PAYLOAD_PREVIEW_MAX_LEN into shared/utils/approvals.ts. This task inlines its own 512 literal for now; after B4 lands, the helper here is updated to import from shared/utils/approvals.
