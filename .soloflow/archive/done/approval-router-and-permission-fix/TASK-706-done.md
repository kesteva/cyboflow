---
id: TASK-706
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Wire tRPC approvals router to ApprovalRouter + DB. Added db?: DatabaseLike to ContextDeps, threaded through createContext. Replaced 5 stubs (listPending, approve, reject, approveRestOfRun, rejectRestOfRun) with live implementations delegating to ApprovalRouter and existing batch handlers. ApprovalNotFoundError → TRPCError NOT_FOUND. 9 new integration tests."
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED (after one NEEDS_CHANGES round). 17 task-relevant tests pass. Typecheck + lint exit 0.

## Files changed (5 commits)
- main/src/orchestrator/trpc/context.ts (db?: DatabaseLike + createContext threading)
- main/src/index.ts (pass db into createContext)
- main/src/orchestrator/trpc/routers/approvals.ts (5 stubs → live implementations)
- main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts (new — 9 integration tests)
- main/src/utils/mutex.ts (typecheck regression fix — 2 unused decls removed)

## Findings emitted
- FIND-SPRINT-029-4: router.test.ts lines 113-127 have stale stub assertions; owned by TASK-695, must be updated in follow-up.
- FIND-SPRINT-029-5: mutex.ts had pre-existing unused declarations newly exposed by TASK-706's import chain. Fixed in this task (commit 4a121ad).

## Notes
- mutex.ts fix is out of declared files_owned but causally TASK-706's responsibility (AC #11 typecheck regression).
