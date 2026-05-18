---
id: TASK-616
sprint: SPRINT-017
epic: review-queue-ui
status: done
summary: "Introduced atomic rejectRestOfRun mutation mirroring approveRestOfRun; group-card Reject and keyboard n now decide atomically per-run"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Closed the approve/reject asymmetry for group cards. New shared types (`RejectRestOfRunInput`/`Result`), `rejectRestOfRunHandler` byte-symmetric with `approveRestOfRunHandler` (same withLock(`run:${runId}`) scope, same SELECT projection, same best-effort iteration with try/catch per row), and orchestrator NOT_IMPLEMENTED stub matching FIND-SPRINT-011-8 mitigation. PendingApprovalCard group `handleReject` and useReviewQueueKeyboard `case 'n'` group branch now call `rejectRestOfRun.mutate({ runId })` atomically — no more Promise.all fan-out. 3 new handler tests (per-run scoping, nonexistent-runId no-throw, sweep for global reject-all symbols) + frontend test updates. EPIC scope updated: reject-rest-of-run moved from Out-of-scope deferred to In-scope. 344 main + 208 frontend tests pass; typecheck clean.
