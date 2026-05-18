---
id: TASK-603
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Extracted shared REGISTRY_SCHEMA / GATE_SCHEMA fixture module; replaced 4 inline DDL copies with imports; added ON DELETE CASCADE + dual source-of-truth docblock"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-603 — Done

Created `main/src/database/__test_fixtures__/registrySchema.ts` exporting `REGISTRY_SCHEMA` (workflows + workflow_runs, mirrors schema.sql verbatim) and `GATE_SCHEMA` (REGISTRY_SCHEMA + approvals + raw_events, mirrors migration 006). Replaced inline DDL in 4 test files (`workflowRegistry.test.ts`, `runLauncher.test.ts`, `cyboflow.test.ts`, `cyboflowTestHarness.ts`) with imports.

Code-reviewer flagged two gaps in initial pass (commit a9f0463):
- `approvals` and `raw_events` FK clauses were missing `ON DELETE CASCADE` (silent fixture-vs-runtime drift)
- Top docblock claimed schema.sql as sole source-of-truth but `approvals`/`raw_events` only live in migration 006

Retry (commit ed66991) added cascade on both FK clauses and rewrote the docblock to make dual source-of-truth explicit. 313 main tests pass.

Note: FIND-SPRINT-015-10 (out-of-scope inline DDL still in `transitions.test.ts:27` and `mcpQueryHandler.test.ts:32`) remains queued for compound — those files were not in `files_owned`.

Commits:
- `a9f0463` — refactor(TASK-603): extract shared REGISTRY_SCHEMA/GATE_SCHEMA fixture
- `ed66991` — fix(TASK-603): add ON DELETE CASCADE to GATE_SCHEMA FKs and fix dual source-of-truth docblock
