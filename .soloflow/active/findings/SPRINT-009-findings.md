---
sprint: SPRINT-009
pending_count: 1
last_updated: 2026-05-15T04:45:00Z
---

# Findings Queue

## Step 2.8 prerequisite override

TASK-355 prerequisite check `test -f main/dist/services/mcpPermissionBridge.js || test -f main/src/services/mcpPermissionBridge.ts` failed at sprint init (status: fail, blocking: true). However, TASK-353 (in this same sprint, scheduled before TASK-355 via dep chain 351→352→353→354→355) declares `main/src/services/mcpPermissionBridge.ts` in `files_owned` and creates it. The static pre-flight check cannot see this in-sprint forward dependency; the sprint's actual ordering guarantees the bridge source exists before TASK-355 executes.

Override decision: continue without gating TASK-355. If the bridge is somehow not created by TASK-353's executor, TASK-355's verifier will catch the regression naturally. Documented here for audit trail.

## FIND-SPRINT-009-1
- **source:** TASK-351 (verifier)
- **type:** anti-pattern
- **severity:** high
- **status:** open
- **location:** main/src/database/schema.sql:44-69 vs main/src/database/migrations/006_cyboflow_schema.sql:6-31
- **description:** `schema.sql` (applied first by `initializeSchema`) and migration `006_cyboflow_schema.sql` (applied by `runFileBasedMigrations`) both declare `workflows` and `workflow_runs` tables, with **incompatible column structures**. schema.sql uses `workflows.id INTEGER PRIMARY KEY AUTOINCREMENT` and `workflow_runs.workflow_id INTEGER`; migration 006 uses `workflows.id TEXT PRIMARY KEY`, `workflows.spec_json TEXT NOT NULL`, `workflow_runs.workflow_id TEXT`, `workflow_runs.policy_json TEXT NOT NULL`, `stuck_at`, `stuck_reason`, `started_at`, `ended_at`, plus a `status CHECK (...)` constraint. Because schema.sql runs first and both DDL blocks use `CREATE TABLE IF NOT EXISTS`, **migration 006's column structure is silently no-op'd on a fresh install** — the database carries the TASK-351 column shape, not the system-design shape. Existing tests do not catch this because the cyboflowSchema integration tests at lines 306-373 of `cyboflowSchema.test.ts` only probe table presence (`expect(tableRows).toHaveLength(5)`), not column structure. The TASK-351 plan explicitly acknowledges this as accepted scope ("the cyboflow-schema-migration epic ... will later land the full 5-table migration ... `IF NOT EXISTS` guards prevent duplicate-creation errors"), but the column-shape divergence — particularly the `id` type mismatch (INTEGER vs TEXT) and missing `spec_json` / `policy_json` / `stuck_*` columns — will silently break any later code that follows the system-design schema (e.g. anything in cyboflow_system_design.md §5.3 referencing `policy_json`). This is not a TASK-351 blocker (the plan called it out and the AC pass), but it is a latent integration hazard that should be reconciled before any task lands code that reads/writes those 006-only columns.
- **suggested_action:** Either (a) reconcile schema.sql's DDL with migration 006 so they declare identical column shapes, or (b) extend the cyboflowSchema integration test to assert specific column presence/types via `PRAGMA table_info(workflows)` so divergence fails CI loudly, or (c) document a deprecation path that removes the 006 DDL blocks for `workflows`/`workflow_runs` (keeping only the 3 net-new tables) and lifts spec_json/policy_json/stuck_* into a follow-up ALTER TABLE migration.
- **resolved_by:**
