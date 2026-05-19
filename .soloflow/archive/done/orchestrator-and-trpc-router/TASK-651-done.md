---
id: TASK-651
sprint: SPRINT-021
epic: orchestrator-and-trpc-router
status: done
summary: "Extract routePreToolUseThroughApprovalRouter into shared helper; both call sites (permissionModeMapper + claudeCodeManager) now delegate; canonical safe-deny literal lives in one place."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-651 — Done report

## Outcome
- NEW `main/src/orchestrator/preToolUseHookHelper.ts` exposes `routePreToolUseThroughApprovalRouter(pretool, callerId, callerLabel, logger?)` with allow / deny-with-msg / deny-key-absent / updatedInput / safe-deny semantics.
- `main/src/orchestrator/permissionModeMapper.ts` delegates to helper; stale `ApprovalRouter` import removed.
- `main/src/services/panels/claude/claudeCodeManager.ts` delegates via `makeLoggerLike(this.logger)` (uses project-conventional adapter, not hand-rolled).
- NEW `main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts` (6 vitest cases).

## Commits
- `5bd8def` feat(TASK-651): add routePreToolUseThroughApprovalRouter helper
- `2645fcb` refactor(TASK-651): delegate permissionModeMapper.deferToApprovalRouter to shared helper
- `0477d52` refactor(TASK-651): delegate claudeCodeManager.makePreToolUseHook to shared helper
- `6523e1a` fix(TASK-651): add Logger-to-LoggerLike adapter (superseded by fc4d78f)
- `5d8bc64` test(TASK-651): add 6-case unit test suite for routePreToolUseThroughApprovalRouter
- `fc4d78f` refactor(TASK-651): use makeLoggerLike instead of hand-rolled Logger adapter

## Verifier verdict
APPROVED (first pass) and APPROVED on follow-up. 0 findings.

## Code-reviewer verdict
Round 1: IMPROVEMENTS_NEEDED (Important — hand-rolled Logger→LoggerLike adapter duplicated existing `makeLoggerLike`, re-introducing the drift surface FIND-017-5 was created to eliminate).
Round 2: CLEAN.
