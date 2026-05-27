---
id: TASK-764
sprint: SPRINT-040
epic: workflow-phase-model
status: done
summary: "Add migration 011_workflow_step_tracking.sql (current_step_id TEXT) and extend WorkflowRunRow with current_step_id?: string | null."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-764 done report

## Summary
Added file-based migration `011_workflow_step_tracking.sql` (`ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT`) and extended `WorkflowRunRow` with the optional `current_step_id?: string | null` field. Sibling integration test `migration011.test.ts` mirrors `migration007.test.ts` — 3 tests (PRAGMA shape, NULL/string round-trip, duplicate-column idempotency).

## Acceptance criteria
All 7 ACs MET. Migration filename matches the runner's PREFIX_RE; no BEGIN/COMMIT/PRAGMA toggle; `current_step_id?` declared between `error_message?` and `started_at?` (mirrors SQL column ordering); `pnpm --filter main test -- --run main/src/database/__tests__/migration011.test.ts` passes; `pnpm typecheck` exit 0; `pnpm build:main` copies 011_*.sql into `dist/`.

## Verification
- 706 unit tests passing across 78 files; 3 new migration011 tests green
- `pnpm typecheck` PASS, exit 0
- `pnpm lint` PASS (0 errors)
- Visual verify: not_applicable (schema + type only)

## Commits
- `f4c220a feat(TASK-764): add migration 011_workflow_step_tracking.sql and extend WorkflowRunRow`
