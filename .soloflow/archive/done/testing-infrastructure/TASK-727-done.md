---
id: TASK-727
sprint: SPRINT-033
epic: testing-infrastructure
status: done
summary: "Extract shared seedApproval fixture and consolidate 6 divergent approval seeding helpers"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-727 — Done

Extracted the canonical `seedApproval(db, overrides)` helper to `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (alongside `seedRun`), with a `SeedApprovalOverrides` interface, sensible defaults (`status='pending'`, `tool_name='bash'`, `tool_input_json='{}'`, `tool_use_id={id}`, `created_at=ISO-now`), and required `runId`.

Migrated 6 test files (`runRecovery`, `approvalCreatedBridge`, `inspectorQueries`, `stuckDetector`, `trpc/routers/__tests__/approvals`, `trpc/__tests__/approvals`) off their local helpers. `stuckDetector.test.ts` keeps a small `ageMsToIso` arrow at file scope to make the age math explicit per call site. `trpc/__tests__/approvals.test.ts` also dropped its private `createTestDb` (which read `006_cyboflow_schema.sql` from disk) in favor of the shared GATE_SCHEMA fixture.

Production approval-INSERT sites (`approvalRouter.ts`, `transitions.ts`) and the 4 specialized readonly test files (`mcpQueryHandler.test.ts`, `approvalRouter.test.ts`, `transitions.test.ts`, `cyboflowSchema.test.ts`) are intentionally NOT migrated — deferred per the plan's scope.

Updated `docs/CODE-PATTERNS.md` "Database seed helpers" section to document `seedApproval` alongside `seedRun` and dropped the stale FIND-SPRINT-018-12 reference. Added 5+ fixture unit tests in `orchestratorTestDb.test.ts`, plus a `created_at` within-1s assertion to lock the default-now behavior.

Closes FIND-SPRINT-031-7.

Commits:
- efa1ac4 feat: add seedApproval fixture and unit tests
- 6ecf871 feat: migrate 6 test files from local helpers
- 90e26a3 docs: update CODE-PATTERNS.md Database seed helpers section
- 0839190 fix: inline seedPendingApprovals in trpc/__tests__/approvals.test.ts
- 92e7730 test: assert seedApproval default created_at within 1s of now
