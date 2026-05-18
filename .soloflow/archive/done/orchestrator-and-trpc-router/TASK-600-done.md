---
id: TASK-600
sprint: SPRINT-017
epic: orchestrator-and-trpc-router
status: done
summary: "Locked raw IPC as the live cyboflow.* transport; tRPC routers annotated as accurate per-proc STUBs; transport map documented in ARCHITECTURE.md"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Resolved the dual-surface ambiguity for cyboflow.* procs by documenting the actual transport split. Raw-IPC live: cyboflow:listWorkflows, cyboflow:startRun, cyboflow:mcp-health (called from cyboflowApi.ts; mcp-health has no v2 tRPC counterpart). Raw-IPC stub: cyboflow:approveRun (NOT_IMPLEMENTED). tRPC live with real body: runs.cancelAndRestart. tRPC stub with active renderer callers: runs.getStuckInspection (StuckInspectorModal), all approvals.* procs (PendingApprovalCard / useReviewQueueKeyboard / reviewQueueStore). Each stub now carries an accurate per-proc annotation naming its migration owner.
