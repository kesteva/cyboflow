---
id: TASK-728
sprint: SPRINT-033
epic: approval-router-and-permission-fix
status: done
summary: "Extract selectPendingApprovals helper so the tRPC router and bridge parity test share the same SQL"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-728 — Done

Extracted the `approvals + workflow_runs + workflows` SELECT JOIN + projection from `main/src/orchestrator/trpc/routers/approvals.ts` into a new standalone-typecheck-safe leaf module `main/src/orchestrator/approvalListing.ts`, exporting `selectPendingApprovals(db: DatabaseLike): Approval[]`. Reuses `truncatePayloadPreview` from `shared/utils/approvals` (no re-implemented 512-char slice). Internal `DbApprovalRow` helper relocated from the tRPC router (deleted there) into the new module as a non-exported type.

The tRPC `listPending` procedure is now a thin wrapper calling `selectPendingApprovals(ctx.db)`.

The 40-line `function listPending(db)` clone in `approvalCreatedBridge.test.ts` is deleted; the parity test now calls `selectPendingApprovals(adapter)` against the same `dbAdapter(db)` instance the bridge already uses. The round-trip-parity guarantee (`bridgeEvent.approval.workflowName === pending[0].workflowName`) becomes mechanical: any future SQL or projection change touches one place both consumers see.

5 new unit tests in `approvalListing.test.ts` cover empty table, `created_at ASC` ordering, 512-char truncation, `workflowName` JOIN resolution, and non-pending status exclusion. The existing `trpc/routers/__tests__/approvals.test.ts` (9 tests) and `approvalCreatedBridge.test.ts` (5 tests) continue to pass.

Closes FIND-SPRINT-031-8.

Commits:
- 024fba7 feat(TASK-728): extract selectPendingApprovals to eliminate SQL clone in bridge test
