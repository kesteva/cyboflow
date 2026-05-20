---
id: TASK-635
sprint: SPRINT-024
epic: testing-infrastructure
status: done
summary: "Migrated 2 inline DDL sites (transitions.test.ts SCHEMA_DDL, mcpQueryHandler.test.ts MINIMAL_SCHEMA) to canonical GATE_SCHEMA; updated stale doc comments."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

Replaced inline `CREATE TABLE` blocks in `transitions.test.ts` (SCHEMA_DDL, 67 lines) and `mcpQueryHandler.test.ts` (MINIMAL_SCHEMA, 46 lines) with `db.exec(GATE_SCHEMA)`. Preserved `foreign_keys = OFF` pragma in `mcpQueryHandler.test.ts` per plan's hardest-call decision. Updated comment rationale. Code-reviewer flagged stale file-level JSDoc that still described the removed inline DDL; doc comments updated to reference the imported fixture.

## Verifier

APPROVED (both rounds) — all ACs met. Target tests 19/19 pass. Pre-existing failures in `runExecutor.test.ts` / `cyboflowSchema.test.ts` outside `files_owned` and tracked as FIND-SPRINT-024-1/2.

## Code review

Initial: IMPROVEMENTS_NEEDED (2 important findings: stale JSDoc comments contradicting the refactor). After fix: code review cap reached (1 round); fix applied via commit 398835a.

## Test-writer

NO_TESTS_NEEDED. Pure DDL refactor; existing assertions are the regression guard.

## Commits

- `140d3c5 refactor(TASK-635): migrate inline DDL in transitions and mcpQueryHandler tests to GATE_SCHEMA`
- `398835a refactor(TASK-635): update stale schema-fixture doc comments`
