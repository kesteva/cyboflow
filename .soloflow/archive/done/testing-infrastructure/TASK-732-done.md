---
id: TASK-732
sprint: SPRINT-035
epic: testing-infrastructure
status: done
summary: "Extend createTestDb with disableForeignKeys + includeStuckDetectedAt options; sweep 6+1 inline INSERT INTO approvals sites to canonical seedApproval."
executor_loops: 1
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-732 — Done

Extended `createTestDb` with optional `CreateTestDbOptions` (`disableForeignKeys`, `includeStuckDetectedAt`) — options layered on top of GATE_SCHEMA so the parity test stays green. Swept the 6 plan-prescribed inline `INSERT INTO approvals` sites to canonical `seedApproval`. Verifier flagged a 7th site introduced mid-sprint by sibling tasks TASK-709/710 (`runs.test.ts:seedPendingApproval`); swept on retry. Grep-gate invariant now true: `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` returns 0 matches.

## Outcomes
- Executor: COMPLETED (commits `c704419`, `63da719` — fix round 1 for the 7th site).
- Verifier (round 1): NEEDS_CHANGES (7th site uncaught); round 2: APPROVED.
- Code-reviewer: CLEAN — no findings.

## Files
- Updated: `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`
- Updated: `main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts`
- Updated: `main/src/database/__tests__/cyboflowSchema.test.ts`
- Updated: `main/src/services/cyboflow/__tests__/transitions.test.ts`
- Updated: `main/src/orchestrator/__tests__/approvalRouter.test.ts`
- Updated: `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` (AC5-prescribed sweep of 7th site)
