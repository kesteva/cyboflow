---
id: TASK-351
idea: IDEA-008
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/database/schema.sql
  - shared/types/workflows.ts
files_readonly:
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - .soloflow/active/roadmaps/ROADMAP-001.md
  - docs/cyboflow_system_design.md
  - main/src/database/database.ts
  - main/src/services/sessionManager.ts
acceptance_criteria:
  - criterion: "`workflows` table has 5 rows after first call to `WorkflowRegistry.seed(projectId)` with `name` IN ('soloflow', 'planner', 'sprint', 'compound', 'prune')"
    verification: "Run unit test `workflowRegistry.test.ts > seed > inserts five workflows`; assert SELECT COUNT(*) FROM workflows WHERE project_id = ? returns 5 and names match the set."
  - criterion: "Re-calling `seed()` on the same project is idempotent — no duplicate rows, count stays at 5"
    verification: "Test `seed > is idempotent`: call seed twice; SELECT COUNT(*) stays at 5; existing IDs are preserved."
  - criterion: "Each seeded workflow row stores parsed `permission_mode` from the workflow `.md` frontmatter; if the field is absent, the stored value is the string `'default'`"
    verification: "Test `seed > parses permission_mode from frontmatter` uses three fixture .md strings (one with `permission_mode: acceptEdits`, one with `permission_mode: dontAsk`, one with no permission_mode key). Assert the corresponding rows store 'acceptEdits', 'dontAsk', 'default' respectively."
  - criterion: "The frontmatter parser does NOT require any third-party YAML library — it is a small inline parser scoped to a flat `key: value` block between leading `---` lines"
    verification: "grep -n 'js-yaml\\|yaml' main/src/orchestrator/workflowRegistry.ts returns 0 matches; package.json under main/ has no new yaml dependency added."
  - criterion: "`workflow_runs.permission_mode_snapshot` column is populated when `createRun(workflowId)` writes a new row — value is copied from the workflow row at run-start time"
    verification: "Test `createRun > snapshots permission_mode onto workflow_runs row`: insert workflow with permission_mode='acceptEdits'; call createRun; SELECT permission_mode_snapshot FROM workflow_runs WHERE id=? returns 'acceptEdits'."
  - criterion: "`schema.sql` declares the `workflows` and `workflow_runs` tables with the required columns and indexes specified in the implementation steps"
    verification: "grep -n 'CREATE TABLE IF NOT EXISTS workflows' main/src/database/schema.sql returns 1 match; grep -n 'CREATE TABLE IF NOT EXISTS workflow_runs' returns 1 match; grep -n 'permission_mode_snapshot' main/src/database/schema.sql returns 1 match."
  - criterion: "If a workflow `.md` file cannot be read at seed time, the registry logs WARN and inserts the row with `permission_mode='default'` rather than throwing"
    verification: "Test `seed > missing .md file falls back to default`: pass a workflow descriptor pointing at a non-existent path; seed completes; row is inserted with permission_mode='default'; logger.warn was called with the path."
depends_on: []
estimated_complexity: medium
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "Frontmatter parsing has explicit branches (key present, key absent, file missing); idempotency must be verified; snapshot semantics on createRun is a behavioral invariant the day-3 gate depends on."
  targets:
    - behavior: "seed inserts five workflows with correct names"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "seed is idempotent"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "frontmatter permission_mode parsing covers present / absent / file-missing cases"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "createRun snapshots permission_mode onto workflow_runs row"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
---

# Workflow Registry Seeded with 5 SoloFlow Workflows

## Objective

Establish the workflow registry as a first-class concept: a `workflows` table seeded with the five SoloFlow workflow definitions (`soloflow`, `planner`, `sprint`, `compound`, `prune`), each carrying a `permission_mode` parsed from the workflow's markdown frontmatter. Snapshot the parsed `permission_mode` onto every new `workflow_runs` row so the ApprovalRouter can consult per-run policy without re-reading the workflow file. This is the policy substrate the queue logic in epic 7 consumes — no parsing happens at approval time.

## Implementation Steps

1. **Add tables to `main/src/database/schema.sql`.** Append (do not overwrite existing tables):
   ```sql
   CREATE TABLE IF NOT EXISTS workflows (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     workflow_path TEXT NOT NULL,
     permission_mode TEXT NOT NULL DEFAULT 'default',
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     UNIQUE(project_id, name)
   );
   CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

   CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY,
     workflow_id INTEGER NOT NULL,
     project_id INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     permission_mode_snapshot TEXT NOT NULL,
     worktree_path TEXT,
     branch_name TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (workflow_id) REFERENCES workflows(id)
   );
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
   ```

   Note: Crystal's `initializeSchema()` splits on `;` and runs each statement, so multiple `CREATE TABLE IF NOT EXISTS` statements in `schema.sql` will be applied on first boot. The cyboflow-schema-migration epic (a prerequisite of epic 7) will later land the full 5-table migration including `raw_events`, `messages`, and `approvals`; this task only depends on the two tables above being present. If that epic has already created those tables via `006_cyboflow_schema.sql`, the `IF NOT EXISTS` guards prevent duplicate-creation errors.

2. **Define shared types in `shared/types/workflows.ts`.** Export:
   ```ts
   export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk';
   export interface WorkflowRow { id: number; project_id: number; name: string; workflow_path: string; permission_mode: PermissionMode; created_at: string; }
   export interface WorkflowRunRow { id: string; workflow_id: number; project_id: number; status: 'queued'|'starting'|'running'|'awaiting_review'|'stuck'|'completed'|'failed'|'canceled'; permission_mode_snapshot: PermissionMode; worktree_path: string | null; branch_name: string | null; created_at: string; updated_at: string; }
   export const SOLOFLOW_WORKFLOW_NAMES = ['soloflow', 'planner', 'sprint', 'compound', 'prune'] as const;
   export type SoloFlowWorkflowName = typeof SOLOFLOW_WORKFLOW_NAMES[number];
   ```

3. **Create `main/src/orchestrator/workflowRegistry.ts`.** Export `class WorkflowRegistry` with these methods:
   - `constructor(db: DatabaseService, logger: Logger)` — accepts the existing better-sqlite3 wrapper.
   - `seed(projectId: number, workflowDescriptors: { name: SoloFlowWorkflowName; path: string }[]): void` — for each descriptor, read the .md file, parse frontmatter, INSERT OR IGNORE into `workflows`. On read failure, log WARN with the path and insert with `permission_mode='default'`.
   - `getById(workflowId: number): WorkflowRow | null`
   - `listByProject(projectId: number): WorkflowRow[]` — used by the frontend picker.
   - `createRun(workflowId: number): { runId: string; permissionMode: PermissionMode }` — read the workflow row, generate a 32-char hex runId via `randomUUID().replace(/-/g, '')`, INSERT a `workflow_runs` row with `permission_mode_snapshot` = workflow's permission_mode, status='queued', then return the runId + snapshot. Caller (epic-8 deterministic naming task) will later UPDATE worktree_path/branch_name.

4. **Implement the inline frontmatter parser** as a private method on `WorkflowRegistry`:
   ```ts
   private parseFrontmatter(md: string): Record<string, string> {
     // Match leading --- ... --- block at file start
     const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
     if (!match) return {};
     const out: Record<string, string> = {};
     for (const line of match[1].split(/\r?\n/)) {
       const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
       if (!m) continue;
       let val = m[2];
       // Strip surrounding quotes
       if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
         val = val.slice(1, -1);
       }
       out[m[1]] = val;
     }
     return out;
   }
   ```
   Then `extractPermissionMode(md: string): PermissionMode` returns the parsed value if it is one of `'default' | 'acceptEdits' | 'dontAsk'`, otherwise `'default'`.

5. **Wire workflow descriptors.** The 5 SoloFlow workflows are user-authored markdown files on the user's filesystem (e.g. `~/.claude/plugins/.../commands/sprint.md`). For v1 they are resolved via a default config object exported from `main/src/orchestrator/workflowRegistry.ts`:
   ```ts
   export const DEFAULT_SOLOFLOW_WORKFLOWS: { name: SoloFlowWorkflowName; pathFromHome: string }[] = [
     { name: 'soloflow', pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/idea-extractor.md' },
     { name: 'planner',  pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/planner.md' },
     { name: 'sprint',   pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/sprint.md' },
     { name: 'compound', pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/compound.md' },
     { name: 'prune',    pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/prune.md' },
   ];
   ```
   The caller resolves these against `os.homedir()` before passing to `seed()`. The descriptor list is exported so the integration task (TASK-355) can override it for tests. (Stable plugin-cache version paths are acceptable for v1; later work can read from a config knob.)

6. **Idempotency.** Use `INSERT OR IGNORE` on the `(project_id, name)` unique constraint. Do not UPDATE existing rows on re-seed — once a workflow is registered, its permission_mode is treated as authoritative. (Migrating an existing permission_mode is out of scope for v1.)

7. **Write the test file `main/src/orchestrator/__tests__/workflowRegistry.test.ts`.** Use vitest. Construct an in-memory better-sqlite3 instance (`new Database(':memory:')`), apply the schema.sql, then instantiate `WorkflowRegistry`. Stub workflow files via `vi.mock('fs')` or by writing temp files under `os.tmpdir()`. Cover the 5 behaviors named in `test_strategy.targets`.

## Acceptance Criteria

See frontmatter. Each criterion is verified by either a unit test or a `grep -n` invariant; no manual inspection.

## Test Strategy

- `seed inserts five workflows with correct names`: pass `DEFAULT_SOLOFLOW_WORKFLOWS` with temp file paths each containing a minimal frontmatter; assert 5 rows exist with the expected names.
- `seed is idempotent`: call `seed()` twice on the same project + descriptors; assert `SELECT COUNT(*)` stays at 5; IDs of existing rows are unchanged.
- `frontmatter permission_mode parsing`: three fixture cases — `permission_mode: acceptEdits`, `permission_mode: dontAsk`, no permission_mode key — assert stored values match `acceptEdits | dontAsk | default`.
- `createRun snapshots permission_mode onto workflow_runs row`: seed with a known permission_mode; call `createRun(workflowId)`; SELECT the row and assert `permission_mode_snapshot` matches.
- `missing .md file falls back to default`: pass a descriptor with a path that does not exist; assert `seed()` does not throw, the row is inserted with `permission_mode='default'`, and `logger.warn` is called with the path.

## Hardest Decision

Whether to require `permission_mode` in workflow frontmatter or treat its absence as a soft default. The SoloFlow workflows that ship today (`sprint.md`, `prune.md`, etc.) do NOT have `permission_mode` in their frontmatter — they have `description`, `argument-hint`, `allowed-tools`. The system design §5.7 names the per-workflow `permission_mode` field as if it existed, but the actual files do not declare it. Approach chosen: parse `permission_mode` opportunistically and default to `'default'` (everything prompts) when absent. This unblocks v1 without requiring a coordinated edit of the SoloFlow workflows themselves — those edits can land later as a follow-up. The day-3 gate test does not depend on specific per-workflow policy because it uses two runs where both will trigger approvals at the first tool use.

## Rejected Alternatives

- **Hard-fail when `permission_mode` is missing.** Rejected because the actual SoloFlow .md files do not declare the field today; this would block the registry from seeding at all. Could revisit in v1.1 if all workflows have been migrated to declare it.
- **Use `js-yaml` for frontmatter parsing.** Rejected per IDEA-008 assumption #2: "Frontmatter parsing is straightforward YAML; doesn't need a fancy parser." A flat `key: value` regex parser is ~15 lines and avoids a dependency. Would change the decision if frontmatter ever needed nested values or arrays (none of the SoloFlow workflows do).
- **Foreign key from `workflow_runs.workflow_id` to `workflows.id`.** Kept the FK declaration but `PRAGMA foreign_keys` is not enabled by default in Crystal's database setup (per the architecture research). The FK serves as documentation; runtime enforcement comes in a later epic if needed.

## Lowest Confidence Area

The exact location of the SoloFlow workflow `.md` files is a moving target — the path embeds a plugin-cache version number (`soloflow-dev/0.9.12`). If the user updates SoloFlow, the path drifts. For v1 this is acceptable because the registry's `pathFromHome` is a default; the descriptor list can be overridden. A more robust resolver (glob for the latest version directory) is a Phase 2 follow-up.
