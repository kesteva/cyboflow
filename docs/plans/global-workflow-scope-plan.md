# Global Workflow Scope Plan

**Status:** planned, not started. Branch `bajada-badlands` (Workflows + Agents pane,
pre-ship). Fixes the scoping flaw: standard flows are seeded **per project**, so the
gallery shows 3×{planner,sprint,compound} instead of one global set. See
`docs/plans/workflows-agents-pane-plan.md` and `custom-flow-execution-plan.md`.

## Goal

Make the standard flows (and new custom flows) **global by default — one shared set
across all projects** — while keeping **project scope** available as an explicit choice.

## Target model (settled)

- **Standard flows = global**, shown once. (Agents in the same pane already work this
  way — built-ins deduped to one card, `agent_overrides` as per-project specialization.
  This makes workflows consistent with that.)
- **New custom flows default to global.**
- **Save is an explicit choice** (the user's decision): the editor's Save offers
  **"Save globally"** (update the shared flow for all projects) vs **"Create a
  project-specific copy"** (fork to a project-scoped flow; pick the target project when
  in the All-projects view).
- **Launch** already takes an explicit `projectId`; a global flow just needs the project
  chosen at run time (the wizard already does this).

Scope = `workflows.project_id`: **NULL ⇒ global**, a value ⇒ project-scoped. (No separate
column needed.) Quick sentinel (`wf-<proj>-__quick__`) and a project copy stay
per-project; built-ins and global customs are `project_id NULL`.

## Verified facts (why this is tractable)

- **No code parses workflow IDs** to infer a project (grep found zero `id.split`/prefix
  extraction). The `wf-<projectId>-<name>` format is generation-only; changing built-in
  IDs to `wf-global-<name>` breaks nothing that reads them.
- **`workflow_runs.project_id` is its own NOT-NULL column** (`schema` / stamped at
  `workflowRegistry.ts:561`). Runs keep their project even when their workflow is global.
- **FK map to `workflows.id`:** only `workflow_runs.workflow_id` and
  `workflow_revisions.workflow_id` (both `ON DELETE CASCADE`). Everything else
  (`approvals`, `raw_events`, `questions`, `run_usage`, `tasks`, `review_items`) hangs off
  `run_id`, untouched. So the migration re-points exactly those two columns.
- **`reconcileBuiltIns(projectId, …)` runs on every `workflows.list`** and UPSERTs
  `wf-<proj>-<name>` — this is what creates the per-project copies and must stop.
- **Migration runner** (`database.ts:runFileBasedMigrations`) scans `NNN_*.sql`, runs in
  a txn, idempotent via `user_preferences` ledger, and honors `PRAGMA foreign_keys=OFF`.
  **Next free number on this branch is 029** (028 = `agent_overrides` here / `idea_attachments`
  on main). Table-rebuild precedent: migrations 010 and 020.
  **⚠️ 029 cross-branch collision:** the `ridge-ravine` branch (tabbed center pane) also
  plans `029_artifacts`, and `028` is already split (`agent_overrides` here vs
  `idea_attachments` on main). `029` is fine on this branch in isolation but is a
  merge-time renumber — resolve when these branches converge (mirror the 028 handling).
  **✅ Resolved 2026-06-19 on rebase onto main:** main owns `028_idea_attachments`, so this
  branch renumbered `028_agent_overrides → 029_agent_overrides` and
  `029_global_workflows → 030_global_workflows` (and `migration029.test.ts → migration030.test.ts`).
  ridge-ravine's `029_artifacts` collision is still open until that branch merges.

## Design

### 1. Schema — migration `030_global_workflows.sql`

Single transaction, `PRAGMA foreign_keys=OFF` (runner-managed):

1. **Rebuild `workflows`** with `project_id INTEGER` (nullable) + add the missing
   `FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE` (closes a known
   gap; NULL is allowed by the FK). Mirror the 010/020 rebuild (create `_new`, `INSERT
   SELECT`, drop, rename, recreate indices).
2. **Create one global row per built-in:** `id = 'wf-global-' || name`, `project_id NULL`,
   `spec_json '{}'`, `workflow_path`/`permission_mode` sourced from any existing
   per-project row (they're uniform). `INSERT OR IGNORE`.
3. **Re-point history** to the global rows (SQLite `||`, correlated subquery for portability):
   `UPDATE workflow_runs SET workflow_id='wf-global-'||name …` and the same for
   `workflow_revisions`, for every per-project built-in row.
4. **Delete the redundant per-project built-in rows that were never edited**
   (`name IN (planner,sprint,compound) AND project_id IS NOT NULL AND spec_json='{}'`).
   **Keep** edited ones (non-empty `spec_json`) — they survive as project-scoped flows
   (the user's "project copy"), disambiguated in the UI by the project chip. (No renaming
   of user data.)

`shared/types/workflows.ts`: `WorkflowRow.project_id: number | null`. Audit consumers to
tolerate null (see §3).

### 2. Registry (`workflowRegistry.ts`) — stop per-project seeding; union on read

- **Replace per-project `reconcileBuiltIns`** with `ensureGlobalBuiltIns()`: UPSERT the
  single `wf-global-<name>` row per built-in (project_id NULL), refreshing
  `workflow_path`/`permission_mode` from `buildBuiltInWorkflows()`. Call it once per
  `workflows.list` (project-independent). **No more `wf-<proj>-<name>` creation.**
- **`listByProject(projectId)`** → `WHERE (project_id = ? OR project_id IS NULL) AND name
  NOT IN (<quick>, <legacy>)`. Each project sees the global built-ins + its own
  customs/overrides. (Keep the `resolveWorkflowDefinition`-null post-filter.)
- **`createCustom(projectId | null, name, …)`** gains scope: default **global**
  (`project_id NULL`, id `wf-global-custom-<hex>`); project copy → `project_id` set, id
  `wf-<proj>-custom-<hex>`. Name-uniqueness check widens to "no collision with a global
  flow, and none within the target project"; keep the reserved-name guard.
- **`createRun`/launch project stamping (load-bearing):** `createRun` currently stamps
  `workflow_runs.project_id` from `workflow.project_id` (`:561`) — now NULL for globals.
  Thread the **explicit launch `projectId`** (already on `runs.start`) through
  `runLauncher.launch` → `createRun`, and stamp THAT. Likewise `sprintLanes.createForRun`
  (`runLauncher.ts:332`) must use the run's project, not `workflow.project_id`.

### 3. Frontend

- **Gallery dedup:** the store fans out one `workflows.list` per project; global rows now
  repeat across projects' lists. **Dedupe workflows by `row.id`** in `workflowsStore`
  (exactly as agents are already deduped by key) so a global flow shows once. Project
  chip shown only for `project_id !== null` rows (or a "Global" chip for NULL).
- **Save dialog (the decision):** the editor's Save presents **Save globally** vs
  **Create a project-specific copy**. "Save globally" → `updateSpec` on the global row.
  "Create a project-specific copy" → `createCustom(targetProjectId, …)` with a project
  picker when no project is in context (All-projects view); otherwise the filtered
  project. Default highlighted action: Save globally.
- **New custom flow** (GalleryNew / blank/template): defaults to global; offer a scope
  control (Global / a project).
- **Run:** unchanged contract (`runs.start({workflowId, projectId})`); when launching a
  global flow from All-projects, the wizard must collect a project (it already has a
  project step / `lockProjectId`). Verify the preselect path supplies a project for a
  global flow.

## Implementation steps (atomic commits)

1. `feat: migration 030 — global built-in workflows + re-point run history` (the SQL +
   `migration030.test.ts`).
2. `refactor: WorkflowRow.project_id nullable + tolerate global scope` (type + consumer
   audit; `runLauncher`/`createRun`/`sprintLanes`/insights/agentOverride reads).
3. `feat: seed built-ins once as global; listByProject unions global + project` (registry
   `ensureGlobalBuiltIns` + query + tests).
4. `feat: createCustom scope (global default | project copy) + launch projectId stamping`.
5. `feat: gallery dedupes global flows; Save offers global vs project copy` (store dedup +
   editor Save dialog + GalleryNew scope + chip).
6. **Gate** — `pnpm rebuild better-sqlite3` → typecheck + `test:unit` + lint, then
   `pnpm dev` smoke.

## Tests

- **migration030.test.ts:** per-project built-ins collapse to `wf-global-*`; runs +
  revisions re-pointed (no orphaned history); edited per-project rows preserved; unedited
  ones gone; `project_id` nullable; projects FK present.
- **registry:** `ensureGlobalBuiltIns` idempotent; `listByProject` returns global +
  project rows; `createCustom` global vs project (ids + uniqueness); run stamps the launch
  project, not the (NULL) workflow project.
- **store:** global flows deduped to one entry across the cross-project fan-out.
- Regression: built-in `resolveWorkflowDefinition`, run launch, quick session unaffected.

## Smoke (`pnpm dev` + CDP)

All-projects view shows **one** planner/sprint/compound (no chip) + per-project customs
(chip); run a global planner against a chosen project (no throw, correct worktree, run's
`project_id` correct); edit → **Save globally** changes it everywhere; edit → **Create
project copy** yields a project-scoped flow leaving the global intact.

## Honest limits / edge cases

- **Edited per-project built-ins** (rare; non-empty `spec_json`) are preserved as
  project-scoped flows rather than auto-migrated to the new "project copy" naming — they
  show alongside the global one, disambiguated by the chip. No user data renamed.
- **Custom agents / `agent_overrides` stay per-project** (out of scope). Built-in agents
  are already global (store dedup), so the pane is internally consistent after this; a
  later pass could give custom agents the same global-default treatment.
- **Migration is one-directional** in practice (re-point + delete unedited). Rollback =
  re-seed per-project rows + re-point back (a follow-up migration); Phase-1 data is not
  lost since edited rows + all history are preserved.

## Risk / rollback

Medium blast radius (schema rebuild + registry + store + editor), but bounded: no ID
parsing to break, history re-pointed not orphaned, built-in *definitions* (WORKFLOW_DEFINITIONS
+ .md) unchanged. The migration is the only irreversible-ish step and is guarded
(re-point before delete, keep edited rows). Per-commit gating; revert is commit-by-commit
except the applied migration (reversible via a follow-up).
