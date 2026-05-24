---
id: TASK-737
sprint: SPRINT-036
epic: testing-infrastructure
status: done
summary: "Restore Migration-007 idempotency tests via dedicated migration007.test.ts that reads the SQL file from disk."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-737 — Done

## Summary
Created `main/src/database/__tests__/migration007.test.ts` (102 LOC, 3 tests) that reads `006_cyboflow_schema.sql` and `007_add_stuck_reason.sql` from disk via `readFileSync`, applies them in order to an in-memory DB, and asserts: (1) `stuck_detected_at` INTEGER column on `workflow_runs`, (2) `idx_workflow_runs_status_stuck_at` index, (3) idempotency of the `CREATE INDEX IF NOT EXISTS` clause. Does not import `createTestDb` from the orchestrator fixture (the whole point is to exercise the on-disk SQL file, not the inline `ALTER` in the fixture).

## Verification
- `pnpm --filter main test` → 656/656 pass; `migration007.test.ts (3 tests)` passing in the suite.
- `pnpm typecheck` → 0 errors.
- `pnpm lint` → 0 errors.
- All six acceptance criteria pass.
- Visual verification: not_applicable — backend test file.

## Code Review
CLEAN. Uses dedicated `TableInfoRow` / `SqliteMasterRow` interfaces (no `any`).

## Commit
- `78b83c9` — `test(TASK-737): add migration007.test.ts validating 007_add_stuck_reason.sql from disk`
