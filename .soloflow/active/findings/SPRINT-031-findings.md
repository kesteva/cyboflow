---
sprint: SPRINT-031
pending_count: 1
last_updated: "2026-05-22T07:38:00.000Z"
---

# Findings Queue

## FIND-SPRINT-031-1
- **source:** TASK-720 (verifier)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/approvalRouter.ts:181-188, main/src/orchestrator/approvalCreatedBridge.ts:79
- **description:** Secondary data drift between the SSE bridge and listPending on the `createdAt` field, same family as the workflowName drift TASK-720 just fixed. `ApprovalRouter.requestApproval` computes two near-but-not-equal timestamps: `now = new Date().toISOString()` (stored in `approvals.created_at`) and `request.timestamp = Date.now()` (carried in the in-memory ApprovalRequest). The bridge then computes `new Date(request.timestamp).toISOString()` for the SSE event's `createdAt`, while listPending reads `a.created_at` directly. The two ISO strings differ by the few-microsecond gap between the two `Date.*` calls. Renderer reconcilers that key on `createdAt` (or any test that does byte-equality) will see a phantom mismatch between the SSE-pushed Approval and the listPending row for the same DB id.
- **suggested_action:** Either (a) populate `request.timestamp` from the same `now` value used in the INSERT (single source of truth), or (b) make the bridge re-read `a.created_at` from the DB along with the workflowName JOIN. Option (a) is the simpler fix and keeps the bridge pure. TASK-720 narrowly fixed workflowName; this is the sibling drift the same compound proposal could have caught.
- **resolved_by:**

