---
id: TASK-639
sprint: SPRINT-024
epic: testing-infrastructure
status: done
summary: "Added scripts/verify-schema-parity.js (schema.sql ↔ migrations drift check) with env-var overrides + 3 integration tests; wired into test:unit; documented migration 006 as canonical DDL source."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

CI guard against the FIND-SPRINT-015-21 drift class (schema.sql ↔ migrations divergence). The script applies schema.sql + migrations (path-1) vs migrations-only (path-2) in two in-memory SQLite DBs and asserts intersection-table column/FK parity. Asymmetric design tolerates legacy Crystal tables that exist only in schema.sql. SCHEMA_PATH/MIGRATIONS_DIR env-var overrides drive 3 integration tests covering happy path + 2 drift directions.

Verifier independently reproduced the negative path. Code-reviewer CLEAN with 3 minor categorical observations (default/FK-action signature coverage, applySql wrapper, path-1/path-2 90% duplication) — none blocking.

## Commits

- `02ad3cf feat(TASK-639): add scripts/verify-schema-parity.js with env-var override support`
- `b25eca4 chore(TASK-639): wire verify:schema into package.json test:unit chain`
- `e0e464b docs(TASK-639): document migration 006 as canonical DDL source in CODE-PATTERNS.md`
- `b66ccfd test(TASK-639): add integration tests for verify-schema-parity.js; wire into test:unit`
