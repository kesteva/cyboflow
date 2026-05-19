---
id: TASK-597
sprint: SPRINT-020
epic: claude-agent-sdk-migration
status: done
summary: "Implemented ApprovalRouter.clearPendingForRun — resolves in-flight approval promises with synthetic deny and marks rows rejected when a Claude run terminates; was a stub since SPRINT-006"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-597 — Implement full clearPendingForRun body (TASK-304 approval-lifecycle cleanup)

Replaced the TASK-304 stub at `approvalRouter.ts` with a synchronous, non-queued cleanup that collects-then-mutates: resolves each matching `PendingEntry` with `{ behavior: 'deny', message: 'Run was terminated before approval could be processed' }`, runs a guarded `UPDATE approvals SET status='rejected' WHERE id=? AND status='pending'` (idempotent against concurrent `respond()`), swallows DB errors with console.warn (shutdown-safety), and removes entries from the in-memory `pending` map. `socketReply` is intentionally NOT invoked. Added one explanatory comment above the PreToolUse hook deny branch in `claudeCodeManager.ts` (no behavior change there).

Verifier: APPROVED (parallel mode → visual verify skipped).
Code reviewer: CLEAN (1 minor about deny-shape duplication, non-blocking).
Test writer: TESTS_WRITTEN (added Case 12: two pending entries for same runId; Case 13: DB error swallow path).
Tests: 13/13 approvalRouter tests pass; typecheck + lint green.

Findings: FIND-SPRINT-020-6 queued by code-reviewer (approvals.decided_by schema-comment observation, out of TASK-597's files_owned).
