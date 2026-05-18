---
id: TASK-608
sprint: SPRINT-017
epic: orchestrator-and-trpc-router
status: done
summary: "Moved WorkflowRegistry/RunLauncher construction into AppServices; removed lazy singletons; cyboflow.test.ts no longer needs vi.resetModules"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Removed the module-level lazy singleton pattern in cyboflow.ts. WorkflowRegistry + RunLauncher are now eagerly constructed in main/src/index.ts's initializeServices() (after databaseService.initialize()) and exposed through `services.cyboflow.{workflowRegistry, runLauncher}` per the AppServices DI pattern other ipc/*.ts files follow. Extracted makeLoggerLike to a shared `main/src/orchestrator/loggerAdapter.ts` (B13 context-forwarding preserved). cyboflow.test.ts rewritten to use static imports + per-test makeServices factory — no more vi.resetModules. Bootstrap ordering verified: DB → services → IPC. 339 tests pass; typecheck clean.
