---
epic: cyboflow-schema-migration
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-004]
---

# Cyboflow Schema Migration

## Objective

Land the 5 new Cyboflow tables (`workflows`, `workflow_runs`, `raw_events`, `messages`, `approvals`) as a single numbered migration with day-1 indexes, the full 8-state machine column set, and an atomic transaction helper for `awaiting_review` co-writes. The Crystal fork's existing migration infrastructure is hybrid-inline-only — the numbered `.sql` files under `main/src/database/migrations/` are reference documents that no loop currently executes. This epic both authors the migration content and adds the missing file-runner that will actually apply it.

## Scope

- In scope:
  - File-based migration runner in `database.ts` that loads `NNN_*.sql` files in numeric order after the inline migration block, with idempotency tracking
  - `006_cyboflow_schema.sql` creating all 5 tables with `IF NOT EXISTS` guards
  - State machine columns on `workflow_runs`: `status` (8-state CHECK constraint), `stuck_at`, `stuck_reason`, `policy_json`, `worktree_path`, `project_id`, `workflow_id`, timestamps
  - Day-1 indexes: `raw_events(run_id, id)`, `raw_events(event_type, run_id)`, `approvals(status, created_at)`, `workflow_runs(status, created_at)`
  - Atomic co-write transaction helper for `awaiting_review` transitions (`BEGIN IMMEDIATE` + `AND status='running'` status guard)
  - State machine transition validator (rejects `completed→*`, `failed→*`, `canceled→*`, `queued→awaiting_review`, etc.)
- Out of scope:
  - Foreign keys to Crystal's `sessions` / `tool_panels` tables (strict separation; `workflow_runs` and friends stand alone)
  - The `checkpoints` table (MVP+1, per system design §5.3)
  - Stuck-state detection logic (lives in epic 10; this epic only adds the columns)
  - The `ApprovalRouter` business logic (separate epic); this epic only provides the DB primitives
  - Migrating any Crystal data into the new tables (none to migrate — these are net-new)

## Success Signal

On fresh install, `sqlite3 ~/.cyboflow/sessions.db ".schema"` lists all 5 new tables with the expected columns and indexes. The inline migration runner and the new file runner both report completion in the log without errors. A unit test for the transition helper proves that `transitionToAwaitingReview(runId, approval)` rolls back atomically when the run's status is not `'running'` (UPDATE affects 0 rows). The state validator rejects every forbidden transition from §5.3 of the system design.
