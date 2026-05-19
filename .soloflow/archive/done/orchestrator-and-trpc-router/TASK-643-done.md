---
id: TASK-643
sprint: SPRINT-018
epic: orchestrator-and-trpc-router
status: done
summary: "Pure permissionModeMapper: 'dontAsk' → undefined (no hook), 'default' → ApprovalRouter routing, 'acceptEdits' → fast-path Edit/Write/MultiEdit + defer rest."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-643 — Done

Added `main/src/orchestrator/permissionModeMapper.ts` exporting
`buildPreToolUseHook(mode, runId, logger?)` and the
`ACCEPT_EDITS_AUTO_APPROVE_TOOLS = ['Edit','Write','MultiEdit']` const.
Three-branch switch with exhaustiveness check; safety-net try/catch around
the ApprovalRouter call returns `permissionDecision: 'deny'` with
`'Internal approval-router error'`. Mirrors the existing
`claudeCodeManager.makePreToolUseHook` shape byte-for-byte (only the log
prefix differs), preserving the standalone-typecheck invariant.

Tests: 7 unit cases at
`main/src/orchestrator/__tests__/permissionModeMapper.test.ts` covering
all plan ACs plus deny-without-message and allow-with-updatedInput
threading. Full main suite 379/379 green.

Code-reviewer queued FIND-SPRINT-018-4 (medium): the
`deferToApprovalRouter` body and `claudeCodeManager.makePreToolUseHook`
share a body — consolidation opportunity for a future task since
`claudeCodeManager.ts` is in this task's `files_readonly`.
