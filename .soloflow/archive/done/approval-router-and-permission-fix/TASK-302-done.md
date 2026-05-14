---
id: TASK-302
sprint: SPRINT-006
epic: approval-router-and-permission-fix
status: done
summary: "Replace PermissionManager with ApprovalRouter: atomic co-write, per-run p-queue, status-guard race protection, exactly-once socketReply"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-302 — Done

## Summary

Built `ApprovalRouter` as the new approval primitive replacing Crystal's `PermissionManager`. `requestApproval` co-writes the `approvals` INSERT and `workflow_runs UPDATE … WHERE status='running'` inside a single `db.transaction()`. `respond` runs the guarded `WHERE id=? AND status='awaiting_review'` UPDATE and checks `info.changes > 0` before invoking `socketReply` — protecting against the cancel-race documented in design doc §5.7 / slice 6. All mutations go through the per-run `p-queue` from `RunQueueRegistry` (TASK-252) for in-run serialization. Code-review improvement moved the `pending` reservation inside the queue callback so `socketReply` is exactly-once even under concurrent `respond()` calls.

`CyboflowPermissionIpcServer` and `claudeCodeManager` no longer import `PermissionManager`. The legacy `PermissionManager` and `mcpPermissionServer.ts` remain on disk (dead code; cleanup is owned by `crystal-cuts-and-rebrand`).

## Changes

- `main/src/orchestrator/approvalRouter.ts` (new) — ApprovalRouter singleton with requestApproval/respond/clearPendingForRun-stub/getPending; atomic db.transaction with `AND status='running'` guard; respond uses `WHERE status='awaiting_review'` guard + changes>0 check; mutations go through `runQueues.getOrCreate(runId).add(...)`; `pending` reservation inside the queue callback for exactly-once `socketReply`
- `main/src/orchestrator/__tests__/approvalRouter.test.ts` (new, 8 tests)
- `main/src/services/cyboflowPermissionIpcServer.ts` (modified — swapped PermissionManager → ApprovalRouter)
- `main/src/services/panels/claude/claudeCodeManager.ts` (modified — swapped PermissionManager → ApprovalRouter)
- `main/src/services/cyboflowPermissionBridge.ts` (modified — `PermissionResponse` import → `ApprovalDecision` from approvalRouter; listed under both `files_owned` and `files_readonly` in the plan, owner edit accepted)
- `main/src/index.ts` (modified — `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues))` after orchestrator boot)

## Commits

- `61dc0d7 feat(TASK-302): implement ApprovalRouter replacing PermissionManager`
- `0018d49 fix(TASK-302): move respond() pending reservation inside per-run queue for exactly-once socketReply` (code-review improvement)
- `a74ce78 test(TASK-302): add coverage for allow happy-path, getPending lifecycle, approvalCreated event`

## Verification

- 8/8 acceptance criteria MET
- 8/8 approvalRouter tests pass; 213+ main suite tests pass overall
- `pnpm typecheck` exit 0 across all workspaces
- `pnpm --filter main lint` 0 errors / 229 warnings (baseline preserved)
- Code review: APPROVED on retry; race-protection contract strengthened in 0018d49
- Verifier APPROVED both rounds

## Open observations

- `mcpPermissionServer.ts` still imports `PermissionManager` but is orphan dead code (no callers); deletion is in scope of `crystal-cuts-and-rebrand`, not this epic.
- Plan frontmatter inconsistency noted: `cyboflowPermissionBridge.ts` appeared in both `files_owned` and `files_readonly`. Owner edit interpretation applied.
