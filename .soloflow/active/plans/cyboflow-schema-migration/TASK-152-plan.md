---
id: TASK-152
idea: IDEA-004
idea_id: IDEA-004
status: ready
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - shared/types/cyboflow.ts
files_readonly:
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/database/database.ts
  - main/src/database/schema.sql
  - shared/types/models.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "File `main/src/database/migrations/006_cyboflow_schema.sql` exists and creates exactly these 5 tables, in this order: workflows, workflow_runs, raw_events, messages, approvals. Every CREATE TABLE uses `IF NOT EXISTS`."
    verification: "grep -nE 'CREATE TABLE IF NOT EXISTS (workflows|workflow_runs|raw_events|messages|approvals)' main/src/database/migrations/006_cyboflow_schema.sql returns exactly 5 lines in the order listed."
  - criterion: "workflow_runs has a `status` column with a CHECK constraint accepting exactly these 8 values: queued, starting, running, awaiting_review, stuck, completed, failed, canceled."
    verification: "grep -nE \"status TEXT NOT NULL.*CHECK.*\\('queued',\\s*'starting',\\s*'running',\\s*'awaiting_review',\\s*'stuck',\\s*'completed',\\s*'failed',\\s*'canceled'\\)\" main/src/database/migrations/006_cyboflow_schema.sql returns one match."
  - criterion: "workflow_runs has the columns required for the state machine and stuck-state detection: id (TEXT PK), workflow_id (TEXT), project_id (INTEGER), worktree_path (TEXT), status, policy_json (TEXT), stuck_at (DATETIME), stuck_reason (TEXT), created_at, updated_at, started_at, ended_at."
    verification: "For each column listed, grep -nE '^\\s*<col>\\s+' inside the workflow_runs CREATE TABLE block returns a match."
  - criterion: "No foreign key clause references Crystal's `sessions` or `tool_panels` tables anywhere in the file. `FOREIGN KEY` is only used internally between the 5 new tables (e.g., raw_events.run_id → workflow_runs.id, approvals.run_id → workflow_runs.id, messages.run_id → workflow_runs.id)."
    verification: "grep -nE 'REFERENCES (sessions|tool_panels)' main/src/database/migrations/006_cyboflow_schema.sql returns 0 lines. grep -nE 'REFERENCES workflow_runs' returns at least 3 lines (one per dependent table)."
  - criterion: "Day-1 indexes are created: raw_events(run_id, id), raw_events(event_type, run_id), approvals(status, created_at), workflow_runs(status, created_at). All use `CREATE INDEX IF NOT EXISTS`."
    verification: "grep -cE 'CREATE INDEX IF NOT EXISTS .*ON (raw_events|approvals|workflow_runs)' main/src/database/migrations/006_cyboflow_schema.sql returns 4 or more."
  - criterion: "approvals table has columns: id (TEXT PK), run_id, tool_name (TEXT), tool_input_json (TEXT), tool_use_id (TEXT), rationale (TEXT), status (TEXT CHECK in pending/approved/rejected/timed_out), decided_at (DATETIME), decided_by (TEXT), created_at."
    verification: "grep -nE \"status TEXT NOT NULL DEFAULT 'pending' CHECK.*\\('pending',\\s*'approved',\\s*'rejected',\\s*'timed_out'\\)\" main/src/database/migrations/006_cyboflow_schema.sql returns one match inside the approvals block."
  - criterion: "TypeScript types for the new schema exist in `shared/types/cyboflow.ts`, exporting interfaces WorkflowRow, WorkflowRunRow, RawEventRow, MessageRow, ApprovalRow, plus a `WorkflowRunStatus` union type listing all 8 status values and an `ApprovalStatus` union of the 4 approval statuses."
    verification: "grep -nE 'export (interface|type) (WorkflowRow|WorkflowRunRow|RawEventRow|MessageRow|ApprovalRow|WorkflowRunStatus|ApprovalStatus)' shared/types/cyboflow.ts returns 7 lines."
  - criterion: "After running `pnpm --filter main test` in a clean tree, the file-runner test from TASK-151 plus an integration test that asserts the new tables and indexes exist after migration both pass."
    verification: vitest --run main/src/database/__tests__/cyboflowSchema.test.ts exits 0; the test queries sqlite_master and asserts presence of every table and index from this migration.
depends_on:
  - TASK-151
estimated_complexity: medium
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "The 5-table schema is load-bearing for every downstream Cyboflow feature. A typo in a CHECK constraint or a missing index silently degrades the entire orchestrator. Schema-level tests catch this at migration time, not at first prod usage."
  targets:
    - behavior: "After DatabaseService.initialize(), all 5 tables (workflows, workflow_runs, raw_events, messages, approvals) exist with the expected column set."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
    - behavior: "All 4 day-1 indexes exist on the expected (table, column) tuples."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
    - behavior: "INSERTing a workflow_runs row with an invalid status value (e.g., 'foo') fails the CHECK constraint."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
    - behavior: "INSERTing an approvals row with an invalid status (e.g., 'maybe') fails the CHECK constraint."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
---
# Author 006_cyboflow_schema.sql with 5 Tables, State Columns, and Day-1 Indexes

## Objective

Create the single migration file that lands all 5 new Cyboflow tables along with the day-1 indexes and the full 8-state machine column set on `workflow_runs`. The migration must be self-contained (no FKs to Crystal tables), idempotent (`IF NOT EXISTS` everywhere), and complete in one diff. Co-locate the TypeScript row types in `shared/types/cyboflow.ts` so both `main/` and `frontend/` can import them. This task assumes TASK-151 has landed the file-based migration runner that will actually apply this `.sql` file.

## Implementation Steps

1. **Create new file `main/src/database/migrations/006_cyboflow_schema.sql`** with the following structure. Every CREATE statement uses `IF NOT EXISTS`. Use ISO timestamps via `DATETIME DEFAULT CURRENT_TIMESTAMP` to match Crystal's convention. No `REFERENCES sessions` or `REFERENCES tool_panels` — the new schema is strictly disjoint from Crystal's tables per system design §5.3. Tables are declared in dependency order so that `FOREIGN KEY (...) REFERENCES workflow_runs(id)` and `REFERENCES workflows(id)` resolve forward-only at parse time. The file:

   ```sql
   -- Migration 006: Cyboflow orchestrator schema (5 net-new tables)
   -- Strictly disjoint from Crystal's sessions/tool_panels — no cross-FK.
   -- See docs/cyboflow_system_design.md §5.3 for the authoritative spec.

   -- 1. workflows: user-authored workflow definitions
   CREATE TABLE IF NOT EXISTS workflows (
     id TEXT PRIMARY KEY,
     project_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     description TEXT,
     spec_json TEXT NOT NULL,           -- full workflow spec (prompt, policy, model, etc.)
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   );

   -- 2. workflow_runs: one row per execution attempt; carries the 8-state machine
   CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY,
     workflow_id TEXT NOT NULL,
     project_id INTEGER NOT NULL,
     worktree_path TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
     policy_json TEXT NOT NULL,         -- snapshot of approval/tool policy at start
     stuck_at DATETIME,                 -- nullable; populated by stuck-detector (epic 10)
     stuck_reason TEXT,                 -- nullable; short tag, e.g. 'no_progress', 'awaiting_input'
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     started_at DATETIME,
     ended_at DATETIME,
     FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
   );

   -- 3. raw_events: append-only event log per run (SDK messages, tool calls, status edges)
   CREATE TABLE IF NOT EXISTS raw_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     event_type TEXT NOT NULL,          -- 'sdk_message' | 'tool_call' | 'status_change' | ...
     payload_json TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
   );

   -- 4. messages: derived conversation view (assistant/user/tool, ordered by created_at)
   CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     role TEXT NOT NULL,                -- 'user' | 'assistant' | 'tool' | 'system'
     content_json TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
   );

   -- 5. approvals: one row per tool-call decision point
   CREATE TABLE IF NOT EXISTS approvals (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     tool_input_json TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     rationale TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
     decided_at DATETIME,
     decided_by TEXT,                   -- 'user' | 'auto-policy' | 'timeout'
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
   );

   -- Day-1 indexes (sized for the 115k-row/day projection in risks research §8)
   CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
   CREATE INDEX IF NOT EXISTS idx_raw_events_type_run ON raw_events(event_type, run_id);
   CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
   ```

   Order of declarations matters for the FK clauses to parse cleanly: `workflows` first (parent of `workflow_runs`), then `workflow_runs` (parent of `raw_events`, `messages`, `approvals`), then the three child tables, then the four indexes.

2. **Create new file `shared/types/cyboflow.ts`** with the row-type interfaces and the two status unions. Use `string` for `DATETIME` columns (SQLite returns ISO strings via `better-sqlite3`). JSON columns stay as `string` at the row layer; callers parse with `JSON.parse` and a Zod schema higher up the stack. Exact content:

   ```ts
   // Row types for the Cyboflow orchestrator schema (migration 006).
   // JSON columns are kept as `string` here — parsing/validation happens at
   // the service boundary with the corresponding Zod schemas.

   export type WorkflowRunStatus =
     | 'queued'
     | 'starting'
     | 'running'
     | 'awaiting_review'
     | 'stuck'
     | 'completed'
     | 'failed'
     | 'canceled';

   export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

   export interface WorkflowRow {
     id: string;
     project_id: number;
     name: string;
     description: string | null;
     spec_json: string;
     created_at: string;
     updated_at: string;
   }

   export interface WorkflowRunRow {
     id: string;
     workflow_id: string;
     project_id: number;
     worktree_path: string;
     status: WorkflowRunStatus;
     policy_json: string;
     stuck_at: string | null;
     stuck_reason: string | null;
     created_at: string;
     updated_at: string;
     started_at: string | null;
     ended_at: string | null;
   }

   export interface RawEventRow {
     id: number;
     run_id: string;
     event_type: string;
     payload_json: string;
     created_at: string;
   }

   export interface MessageRow {
     id: string;
     run_id: string;
     role: 'user' | 'assistant' | 'tool' | 'system';
     content_json: string;
     created_at: string;
   }

   export interface ApprovalRow {
     id: string;
     run_id: string;
     tool_name: string;
     tool_input_json: string;
     tool_use_id: string;
     rationale: string | null;
     status: ApprovalStatus;
     decided_at: string | null;
     decided_by: string | null;
     created_at: string;
   }
   ```

   The grep gate from AC7 requires exactly 7 `export (interface|type)` lines: 5 interfaces + 2 unions.

3. **Create the integration test file `main/src/database/__tests__/cyboflowSchema.test.ts`.** Use the existing vitest harness and the same in-memory / temp-file SQLite pattern used by `databaseMigrations.test.ts` (or whichever harness TASK-151 establishes). Cover the four behaviors in `test_strategy.targets`:
   - `describe('006_cyboflow_schema')`
     - `it('creates all 5 tables')` — query `sqlite_master` `WHERE type='table' AND name IN (...)`; assert the returned set equals `{workflows, workflow_runs, raw_events, messages, approvals}`.
     - `it('creates all 4 day-1 indexes')` — query `sqlite_master` `WHERE type='index' AND name LIKE 'idx_%'`; assert presence of each of `idx_raw_events_run_id`, `idx_raw_events_type_run`, `idx_approvals_status_created`, `idx_workflow_runs_status_created`.
     - `it('rejects an invalid workflow_runs.status via CHECK')` — INSERT a row with `status='foo'`; expect the prepared-statement `.run()` to throw a SQLite constraint error containing `CHECK constraint failed`.
     - `it('rejects an invalid approvals.status via CHECK')` — INSERT a row with `status='maybe'`; expect the same constraint error.
   - Each test must first INSERT a parent `workflows` and `workflow_runs` row so the FK chain is satisfied before exercising the CHECK constraint on the child tables.

4. **Run the verification grep gates locally before marking the task done:**
   - `grep -nE 'CREATE TABLE IF NOT EXISTS (workflows|workflow_runs|raw_events|messages|approvals)' main/src/database/migrations/006_cyboflow_schema.sql` — must return 5 lines in declared order.
   - `grep -nE "status TEXT NOT NULL.*CHECK.*\\('queued',\\s*'starting',\\s*'running',\\s*'awaiting_review',\\s*'stuck',\\s*'completed',\\s*'failed',\\s*'canceled'\\)" main/src/database/migrations/006_cyboflow_schema.sql` — 1 match.
   - `grep -nE 'REFERENCES (sessions|tool_panels)' main/src/database/migrations/006_cyboflow_schema.sql` — 0 lines.
   - `grep -nE 'REFERENCES workflow_runs' main/src/database/migrations/006_cyboflow_schema.sql` — at least 3 lines.
   - `grep -cE 'CREATE INDEX IF NOT EXISTS .*ON (raw_events|approvals|workflow_runs)' main/src/database/migrations/006_cyboflow_schema.sql` — >= 4.
   - `grep -nE 'export (interface|type) (WorkflowRow|WorkflowRunRow|RawEventRow|MessageRow|ApprovalRow|WorkflowRunStatus|ApprovalStatus)' shared/types/cyboflow.ts` — exactly 7.
   - `pnpm --filter main test -- cyboflowSchema` — exits 0.
   - `pnpm typecheck` — exits 0 (catches a typo or missing export in `shared/types/cyboflow.ts`).

## Acceptance Criteria

All 8 frontmatter ACs gate this task. Restated as verification narrative:

1. **Five tables, exact order, all idempotent.** The grep against `CREATE TABLE IF NOT EXISTS (workflows|workflow_runs|raw_events|messages|approvals)` returns five lines in that order — declaring `workflow_runs` before `workflows` would break the FK from `workflow_runs.workflow_id`.
2. **workflow_runs.status CHECK on exactly 8 values.** The regex pins the value set and the order; if a future edit drops `'stuck'` or reshuffles the tokens, the grep fails and CI blocks the merge.
3. **workflow_runs has every state-machine column.** Twelve columns: `id`, `workflow_id`, `project_id`, `worktree_path`, `status`, `policy_json`, `stuck_at`, `stuck_reason`, `created_at`, `updated_at`, `started_at`, `ended_at`. Each must grep cleanly inside the `workflow_runs` CREATE block.
4. **No FK leakage into Crystal tables.** `REFERENCES sessions` and `REFERENCES tool_panels` must each return zero matches; `REFERENCES workflow_runs` must return three (one each from `raw_events`, `messages`, `approvals`).
5. **Day-1 indexes present.** All four `CREATE INDEX IF NOT EXISTS` statements land in this migration, not deferred to a later one.
6. **approvals.status CHECK on exactly 4 values, default `'pending'`.** The default matters — the orchestrator INSERTs without specifying a status when routing a tool call for review.
7. **TypeScript types co-located.** Seven exports in `shared/types/cyboflow.ts`: five row interfaces plus `WorkflowRunStatus` and `ApprovalStatus` unions. Both `main/` and `frontend/` import from this path.
8. **Integration test passes on a clean tree.** `cyboflowSchema.test.ts` asserts table presence, index presence, and CHECK-rejection on both `workflow_runs.status` and `approvals.status`. Runs green after `pnpm install`.

## Test Strategy

Integration-only — the 4 targets from frontmatter live in one vitest file (`main/src/database/__tests__/cyboflowSchema.test.ts`) backed by an in-memory or temp-file SQLite instance driven through the same `DatabaseService.initialize()` entry point production uses. No unit tests: there is no business logic in this task — only schema. The value of testing here is catching CHECK-constraint typos and index-name regressions, both of which are pure schema concerns and only observable post-migration.

The four assertions:
1. `sqlite_master` lists all 5 tables by name after `initialize()`.
2. `sqlite_master` lists all 4 expected indexes by name.
3. An attempted INSERT into `workflow_runs` with `status='foo'` throws a `SqliteError` whose `message` contains `CHECK constraint failed`.
4. An attempted INSERT into `approvals` with `status='maybe'` throws the same kind of constraint error.

The CHECK assertions are the most load-bearing: a silent typo (e.g. `'cancelled'` vs `'canceled'`) would not surface until the orchestrator first tried to transition a run, weeks into self-host. Testing them at migration time fails fast.

## Hardest Decision

**Whether to declare inline `FOREIGN KEY` clauses between the 5 new tables given SQLite's lazy FK enforcement.** SQLite does not enforce foreign keys unless the connection has `PRAGMA foreign_keys = ON`, which Crystal does not currently set globally. Two options: (a) declare the FKs anyway as documentation + future-proofing (turning the pragma on later is then a one-liner), or (b) omit them since they're inert today and risk giving false confidence. Chosen (a): declare them, in the order `workflows` → `workflow_runs` → `{raw_events, messages, approvals}`. The FK clauses are 4 lines of SQL each; they double as machine-readable schema documentation, they satisfy AC4's positive check (`REFERENCES workflow_runs` >= 3 matches), and turning on `PRAGMA foreign_keys=ON` in a later task is then a trivial behavior change with no schema migration needed. The table ordering inside the file is forced by this choice — parent tables must be declared before children for the parser to resolve the references at `CREATE TABLE` time.

## Rejected Alternatives

- **Split the 5 tables into 5 separate numbered migrations (`006_workflows.sql`, `007_workflow_runs.sql`, …).** Rejected because the orchestrator cannot boot with only a partial subset of these tables — the schema ships as one feature. A failed apply mid-sequence would leave the database in a state that neither the new code nor the old code can handle. One file = one atomic diff, one review surface, one rollback unit.
- **Skip foreign-key declarations entirely.** SQLite without `PRAGMA foreign_keys=ON` ignores FK clauses at runtime, so declaring them is "free" in the lax sense. Rejected because the FKs are real documentation of the data model, they satisfy AC4's positive check, and turning on the pragma later becomes a one-line change instead of a schema-rewriting migration.
- **Use INTEGER autoincrement PKs everywhere instead of TEXT (UUID) PKs.** Cheaper storage, smaller indexes, faster joins. Rejected because the orchestrator emits run IDs and approval IDs before they hit the DB (the tRPC contract from epic IDEA-006 returns them synchronously), which is incompatible with `lastInsertRowid`-style autoincrement keys. TEXT UUIDs let the caller generate the ID, write it, and return it without a round-trip — load-bearing for the `awaiting_review` co-write helper in IDEA-004 slice 4.

## Lowest Confidence Area

**Whether the existing migration runner from TASK-151 actually picks up `006_cyboflow_schema.sql` on a fresh install in numeric order, not lexicographic.** This task assumes TASK-151 already shipped a file-runner that sorts numerically (`003 < 004 < 005 < 006`) — but the IDEA-004 open question explicitly flagged that Crystal's original `runMigrations()` may have sorted lexicographically. If TASK-151's runner is correct, this task is mechanical; if not, the migration will not apply at all and every downstream test will fail mysteriously with "no such table: workflows". Verification path: after landing this file, drop the local SQLite at `~/.cyboflow/sessions.db`, restart the app in dev mode, run `sqlite3 ~/.cyboflow/sessions.db ".tables"`, and confirm the 5 new tables are present. If they are not, the bug is in TASK-151's sort order, not in this file — re-open TASK-151 before touching anything here. **ESCALATE TO HUMAN** if the migration runner from TASK-151 turns out not to exist yet (dependency violation).

   