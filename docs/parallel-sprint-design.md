# Parallel Sprint Execution — Architecture & Phase Plan

> **Status:** authoritative spec for the `feat/parallel-sprint` epic (phases P1–P6). Written by phase **P0**.
> Every later phase MUST re-verify the line references in the "Grounded anchors" tables against the live tree before editing — trust the actual file over this doc when they disagree, and update this doc if the anchor moved.

---

## 1. Goal

Today a "sprint" run executes **one** task end-to-end (implement → … → human review), one run per task, each with its own worktree and its own per-task human gate. We want to execute a **batch of tasks in parallel** with a **single human review at the very end of the whole sprint**.

Target behaviour:

- The user multi-selects up to **N** tasks in a pre-launch picker. **N = 15** for the `sdk` substrate, **N = 10** for `interactive` (a soft batch cap — protects context/host resources, NOT the concurrency limit).
- Parallel-agent **concurrency is a fixed constant `CAP = 5`** (at most 5 `task` runs executing simultaneously regardless of batch size or substrate).
- All work lands on **one shared integration branch** `sprint/<batchId>` cut off the project main branch. Per-task runs branch off the *current integration tip* and are merged back into the integration branch as each completes (rebase + ff-only).
- Ordering respects a **dependency DAG** computed once at sprint init by a dedicated sub-agent (`cyboflow-dependency-analyzer`). A task becomes runnable only when its in-batch blocking prerequisites are integrated.
- There is exactly **ONE human gate** for the whole sprint — at finalize (`AskUserQuestion` in the `sprint-finalize` run). The per-task runs have **no human gate** and **no session**.
- All state is **DB-canonical**; the scheduler rehydrates non-terminal batches on boot and resumes draining (mirrors `runRecovery.ts`).

Non-goals for this epic: cross-project batches, partial-batch merge to main, re-ordering a running batch, per-task human gates, Linear/multi-device sync.

---

## 2. Vocabulary & invariants

- **Batch** = one parallel sprint. Row in `sprint_batches`. Owns the integration branch and the lifecycle state machine.
- **Batch task** = one selected task's membership in a batch. Row in `sprint_batch_tasks`. Tracks the task's lifecycle *within this batch* (queued → running → integrated/failed) independent of the global board stage.
- **Per-task run** = a standalone `workflow_runs` row of the new `task` workflow, executing one batch task. Linked to the batch via `workflow_runs.batch_id`. **No `session_id`** (these are parentless flow runs).
- **Init run** = the single `sprint-init` run that drives dependency analysis.
- **Finalize run** = the single `sprint-finalize` run that drives full-suite verify + the one human gate + merge-to-main.
- **Integration branch** = `sprint/<batchId8>` (first 8 chars of the batch id), created off the project main branch at batch creation, deleted on successful completion, **left in place** on failure for inspection.

**Single-writer invariants preserved by this epic:**
- ALL idea/epic/task writes go through `TaskChangeRouter.applyChange` (per-project `PQueue`, concurrency 1). The scheduler NEVER raw-UPDATEs `ideas`/`epics`/`tasks`. **New dependency-edge writes (P3) go through a new `TaskChange` kind**, cycle-checked at the chokepoint alongside the existing lineage cycle guards.
- The new `sprint_batches` / `sprint_batch_tasks` tables are **batch-scheduler-owned** (not entity-model tables); the scheduler writes them directly under its own `PQueue` (no chokepoint), the same way `workflow_runs` is written directly by `RunLauncher`. Board-stage derivation of the underlying tasks still flows through the chokepoint.
- Review writes (if any finding is emitted by sprint-review) go through `ReviewItemRouter`.

---

## 3. Batch lifecycle state machine

```
                 createBatch
                     │
                     ▼
                ┌──────────┐   init run launched (cyboflow-dependency-analyzer)
                │ planning │ ──────────────────────────────────────────────┐
                └──────────┘                                                │
                     │ init run drains awaiting_review                      │ init run fails
                     │ (deps written to task_dependencies)                  │
                     ▼                                                       ▼
                ┌──────────┐   drain loop: ≤CAP ready task runs          ┌────────┐
                │ running  │ ◀──────────────────────────────────────┐   │ failed │
                └──────────┘                                         │   └────────┘
                     │ all batch tasks 'integrated'                  │
                     │                       per-task run: merge OK ─┘
                     │                       (batch_task → integrated, unblock dependents)
                     │                       per-task run: merge CONFLICT
                     │                       (batch_task → failed, slot freed, surface)
                     ▼
               ┌─────────────┐   finalize run launched (sprint-verify → sprint-review → human-review)
               │ finalizing  │
               └─────────────┘
                  │        │              │
   human approves │        │ verify fails │ human rejects
   merge integ→main│       └──────────────┴───────────────┐
   (ff-only)       │                                       ▼
                   ▼                                  ┌────────┐
             ┌───────────┐                            │ failed │  (integration branch LEFT for inspection)
             │ completed │                            └────────┘
             └───────────┘
        every batch task outcome='merged'
        → board stage 9 (Done); integration branch deleted
```

### `sprint_batches.status` enum
`'planning' | 'running' | 'finalizing' | 'completed' | 'failed' | 'canceled'`
Terminal: `completed | failed | canceled`.

### `sprint_batch_tasks.status` enum
`'queued' | 'running' | 'integrated' | 'failed' | 'skipped'`
- `queued` — selected, not yet launched.
- `running` — a per-task run is in flight (`workflow_runs.batch_id` set, run non-terminal).
- `integrated` — the per-task run drained clean AND its branch merged into the integration branch. **This is the "satisfied" state for dependency gating** (NOT the global board stage 9, which only happens at finalize).
- `failed` — the per-task run failed OR its merge into the integration branch conflicted. Surfaced; does not crash the batch.
- `skipped` — reserved (e.g. an unreachable task whose only prereq failed). v1 may leave a task `queued` forever if a prereq fails; `skipped` lets a later phase mark it explicitly. Not auto-set in P1–P6 unless P4 chooses to.

> **Dependency satisfaction is batch-local.** A batch task is READY when every *in-batch* `blocking` prerequisite has `sprint_batch_tasks.status = 'integrated'`. Prereqs NOT in the batch are ignored (the user is responsible for selecting a closed set; out-of-batch prereqs already merged to main are visible because the integration branch is cut off main). Edges to out-of-batch tasks are dropped from the DAG at drain time.

---

## 4. Data model (migration 020)

New file: `main/src/database/migrations/020_sprint_batches.sql` (latest existing is 019). Also mirror the seed in `main/src/database/database.ts` if that file eagerly creates tables (verify: migrations are the canonical path; `seedDefaultBoard` is the board-only equivalent — there is no eager table-create for entity tables, so 020 is migration-only).

```sql
-- 020_sprint_batches.sql

CREATE TABLE IF NOT EXISTS sprint_batches (
  id                 TEXT PRIMARY KEY,                 -- uuid
  project_id         INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'planning'
                       CHECK (status IN ('planning','running','finalizing','completed','failed','canceled')),
  substrate          TEXT NOT NULL DEFAULT 'sdk'
                       CHECK (substrate IN ('sdk','interactive')),  -- batch-wide substrate (drives N cap + per-run substrate)
  integration_branch TEXT NOT NULL,                    -- 'sprint/<id8>'
  base_branch        TEXT,                             -- project main branch captured at create (triage)
  base_sha           TEXT,                             -- integration branch start sha (triage)
  init_run_id        TEXT,                             -- the sprint-init run (FK workflow_runs.id, soft)
  finalize_run_id    TEXT,                             -- the sprint-finalize run (soft)
  error_message      TEXT,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at         DATETIME,
  ended_at           DATETIME,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sprint_batches_status ON sprint_batches(status);

CREATE TABLE IF NOT EXISTS sprint_batch_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','integrated','failed','skipped')),
  run_id      TEXT,                                    -- the per-task run currently/last executing this task (soft)
  error_message TEXT,                                  -- merge-conflict / run-fail detail when status='failed'
  integrated_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, task_id),
  FOREIGN KEY (batch_id) REFERENCES sprint_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id)  REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sprint_batch_tasks_batch_id ON sprint_batch_tasks(batch_id);
CREATE INDEX IF NOT EXISTS idx_sprint_batch_tasks_task_id  ON sprint_batch_tasks(task_id);

ALTER TABLE workflow_runs ADD COLUMN batch_id TEXT;     -- soft link; NULL for every non-batch run
CREATE INDEX IF NOT EXISTS idx_workflow_runs_batch_id ON workflow_runs(batch_id);
```

Reuse of the **existing** `task_dependencies` table (migration 015, lines 175–184 — verified):
```
task_dependencies(id, task_id, depends_on_task_id, kind CHECK IN ('blocking','related'), UNIQUE(task_id, depends_on_task_id))
```
Semantics: a row `(task_id=A, depends_on_task_id=B, kind='blocking')` means **A is blocked by B / B must finish before A**. Currently UNUSED everywhere — this epic is its first consumer.

### Row types (TypeScript)
Add to a new `shared/types/sprintBatch.ts` (importable in both processes, no Node built-ins):
- `SprintBatchStatus`, `SprintBatchTaskStatus` string unions + `TERMINAL_BATCH_STATUSES` const array (mirror `TERMINAL_RUN_STATUSES`).
- `SprintBatchRow`, `SprintBatchTaskRow` interfaces matching the columns above.
- `SPRINT_BATCH_CAP = 5` (concurrency), `SPRINT_BATCH_MAX_TASKS = { sdk: 15, interactive: 10 } as const` (the N selection cap).
- `WorkflowRunRow.batch_id?: string | null` added in `shared/types/workflows.ts` (migration 020).

---

## 5. New workflows & sub-agent

### 5.1 `CYBOFLOW_WORKFLOW_NAMES` widening
`shared/types/workflows.ts` currently: `['planner','sprint'] as const`. Add the three new built-ins:
```ts
export const CYBOFLOW_WORKFLOW_NAMES = ['planner','sprint','task','sprint-init','sprint-finalize'] as const;
```
`WORKFLOW_DEFINITIONS` is `Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>>`, so the compiler will force a definition for each new key. `isCyboflowWorkflowName` keeps working. `resolveWorkflowDefinition` unchanged.

> **Decision (P2):** the new flows are NOT shown in the human `WorkflowPicker` (which is for planner/sprint launched by hand). They are scheduler-internal. Either (a) keep them in `CYBOFLOW_WORKFLOW_NAMES` and filter them out of the picker list (preferred — keeps `WORKFLOW_DEFINITIONS` typing honest), or (b) hold them in a sibling `SPRINT_INTERNAL_WORKFLOW_NAMES`. P2 picks (a) and adds a `pickerVisible`/internal filter in `WorkflowPicker.tsx`, mirroring how the `__quick__` sentinel is already filtered.

### 5.2 `task` workflow definition (Phase-1 only)
A trimmed copy of `sprint`'s `execute` phase — the same five steps, **no `verify` phase, no human step**:
```
task:
  phases:
    - id: execute, label: Execute, color: '#c96442'
      steps:
        - implement     (agent: executor,        retries 3)
        - write-tests   (agent: test-writer,     retries 1)
        - code-review   (agent: code-reviewer,   retries 0)
        - task-verify   (agent: verifier,        retries 3, loopback: implement)
        - visual-verify (agent: visual-verifier, retries 1, optional)
```
Clean drain ⇒ `transitionRunningToAwaitingReview` ⇒ status `awaiting_review`. The scheduler treats `awaiting_review` as "task done, ready to integrate" (these runs have no human gate, so `awaiting_review` is purely a rest state). **The scheduler, not a human, closes the run.**

### 5.3 `sprint-init` workflow definition (planning)
A single-phase flow whose orchestrator (`sprint-init.md`) delegates to `cyboflow-dependency-analyzer`:
```
sprint-init:
  phases:
    - id: plan, label: Plan, color: '#5a4ad6'
      steps:
        - analyze-deps (agent: dependency-analyzer, retries 1)
```
On clean drain → `awaiting_review`; the scheduler observes that and flips the batch `planning → running`.

### 5.4 `sprint-finalize` workflow definition (Phase-2 only)
The `verify` phase lifted out of `sprint` — the single human gate lives here:
```
sprint-finalize:
  phases:
    - id: verify, label: Sprint review, color: '#a87a2c'
      steps:
        - sprint-verify (agent: verifier,      retries 1)
        - sprint-review (agent: code-reviewer, retries 0)
        - human-review  (agent: human, human: true, retries 0)   ← the ONE AskUserQuestion gate
```
`human: true` makes the run park at `awaiting_input` on the AskUserQuestion (existing QuestionRouter machinery). On approval the finalize orchestrator (or the scheduler on observing approval) merges integration → main.

### 5.5 Prompts & agents
New prompt bodies under `main/src/orchestrator/workflows/`:
- `task.md` — near-verbatim Phase-1 of `sprint.md` minus the verify phase. Reuses existing `sprint/agents/*.md` (`cyboflow-implement`, `-write-tests`, `-code-review`, `-task-verify`, `-visual-verify`). **No new agents needed for `task`.**
- `sprint-init.md` — orchestrator that reads the batch's selected tasks (their bodies + acceptance criteria + `task_files`), delegates to `cyboflow-dependency-analyzer`, and on the returned edges calls **`cyboflow_add_task_dependency`** once per blocking edge. Then reports done.
- `sprint-finalize.md` — orchestrator that runs `cyboflow-sprint-verify` → `cyboflow-sprint-review` → the inline `AskUserQuestion` human gate over the integration branch. Reuses existing `sprint/agents/sprint-verify.md` + `sprint-review.md`.
- New agent `main/src/orchestrator/workflows/sprint/agents/dependency-analyzer.md` (`cyboflow-dependency-analyzer`): reads the provided task summaries and proposes `{ task_id, depends_on_task_id, reason }[]` blocking edges. **It does NOT write state** — it returns a `## Dependencies` result; the orchestrator writes via MCP (single-writer rule, same pattern as every other agent per `sprint.md`). Its `tools:` allowlist EXCLUDES `cyboflow_*` write tools.

> **Agent-name note (verify in P5):** the workflow defs use bare agent ids (`executor`, `test-writer`, …) while the installed agent files are `cyboflow-<phase>.md` and `sprint.md` delegates with `subagent_type: "cyboflow-<phase>"`. P5 must follow the *existing* mapping convention (the agent file name / `subagent_type`, not the def's `agent` field) when adding `cyboflow-dependency-analyzer`. Confirm against `workflowBundle.ts` / `builtInWorkflows.ts` how agents are installed into `.claude/agents/`.

### 5.6 Step-reporting append
`main/src/orchestrator/prompts/step-reporting-instructions.ts` `buildStepReportingAppend(def)` is **definition-driven** — it already enumerates the resolved def's steps. The new flows get their step-reporting block for free once their `WorkflowDefinition`s exist. Verify no flow-name allowlist gates it.

---

## 6. New MCP tool — `cyboflow_add_task_dependency`

Registered in `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` (tool list ~line 147+) and handled in `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` (alongside `cyboflow_set_task_stage` ~line 566).

Input schema:
```jsonc
{
  task_id:            string,   // the blocked task (required)
  depends_on_task_id: string,   // the prerequisite (required)
  kind:               'blocking' | 'related',  // optional, default 'blocking'
}
```
Handler: resolve run context (`resolveTaskRunContext`, same guards as the other task writes), then route the write through a **new `TaskChangeRouter` path** — NOT a raw INSERT. Add a `TaskChange` kind `'add-dependency'` (P3) carrying `{ dependsOnTaskId, dependencyKind }`. The chokepoint:
1. validates both tasks exist + same project,
2. rejects self-edges (`task_id === depends_on_task_id`),
3. **detects cycles** in `task_dependencies` (DFS over existing `blocking` edges + the proposed edge) — mirrors `validateParentEpic`'s lineage cycle guard (`taskChangeRouter.ts` ~847–873). New error code `'dependency_cycle'`,
4. INSERTs `OR IGNORE` (the `UNIQUE(task_id, depends_on_task_id)` makes re-adds idempotent),
5. emits an `entity_events` row (`kind:'dependency-added'`) so the change is in the faithful changelog.

Surfaced MCP errors: `not_found | invalid_dependency | dependency_cycle`.

> Only `blocking` edges participate in DAG ordering; `related` edges are advisory metadata.

---

## 7. Integration / merge strategy

### 7.1 Branch topology
```
main ──●──────────────────────────────────────────●  (ff-only at finalize)
        \                                          /
         sprint/<id8> ●──●(taskA)──●(taskB)──●────●   (per-task merges, rebase+ff-only)
                       \         /
                        taskA-run-branch  (cyboflow/task/<runId8>, cut off integ tip)
```
- At **createBatch**: create `sprint/<id8>` off the project main branch (`git branch sprint/<id8> <mainBranch>` in the project repo; no worktree needed for the branch itself).
- Each **per-task run** is launched with `baseBranch = integration_branch` so `createDeterministicWorktree(projectPath, 'task', runId, integrationBranch)` (the `baseBranch` 4th arg already exists, `worktreeManager.ts:181–197`, currently always `undefined`) cuts the run's worktree branch off the **current integration tip** — so a dependent task sees its already-integrated prereqs' changes.
- On per-task clean drain: rebase the run branch onto the integration branch and ff-only merge **into the integration branch** (not main). This needs a new `worktreeManager` method `mergeWorktreeToBranch(projectPath, worktreePath, targetBranch)` — a generalization of `mergeWorktreeToMain` (lines 744+) parameterized on the target instead of hardcoding main. Same rebase + `--ff-only` + throw-on-conflict semantics. **P4 adds it; do NOT special-case main in the new method.**
- On per-task merge **conflict**: the new method throws (existing behavior). The scheduler catches, marks the `sprint_batch_tasks` row `failed` with the git output, removes the run's worktree, marks the run terminal (`outcome='failed'` via the existing close-out path or a direct transition), frees the slot, and continues draining other ready tasks. **The batch does NOT crash.**
- At **finalize approval**: ff-only merge `sprint/<id8>` → main using `mergeWorktreeToMain`/a branch-to-branch merge. Because every per-task merge was rebase+ff-only onto the integration branch, and the integration branch was cut off main, the integration→main merge is a clean ff in the common case. On conflict (main moved underneath), surface and set batch `failed`, leave the branch.
- On **completed**: delete `sprint/<id8>` (`deleteBranch(projectPath, integrationBranch, {force:true})`).
- On **failed**: LEAVE `sprint/<id8>` for inspection.

### 7.2 Per-task run close-out
The scheduler owns close-out for per-task runs (there is no human Merge button). It mirrors the existing `runs.ts merge` mutation logic (~749–827) but merges into the *integration* branch and stamps a NEW outcome value:
- `outcome='integrated'` — add `'integrated'` to `WorkflowRunRow.outcome` union in `shared/types/workflows.ts` (P3) and to any `outcome` CHECK if one exists (verify migration 014 — `outcome` may be unconstrained TEXT; if so, no migration change needed, just the TS union).
- After merge-into-integration, the scheduler derives the underlying **task → board stage 8 (Ready to merge)** via the chokepoint (`recomputeTaskExecutionStage` or an explicit `set-task-stage`), NOT stage 9 — stage 9 is reserved for the finalize merge-to-main. Verify the derived-stage logic: stage 8 is `derived` (`database.ts:1677`), so only the orchestrator actor may set it.
- At finalize success, stamp every batch task's run `outcome='merged'` and derive the task → stage 9 (Done), reusing `stampOutcomeAndDeriveTask` (runs.ts ~825).

---

## 8. Scheduler design — `SprintBatchScheduler`

New service `main/src/orchestrator/sprintBatchScheduler.ts` (orchestrator layer — standalone-typecheck invariant: NO `electron` import, all collaborators injected, same discipline as `RunLauncher`). Owns one `PQueue` per batch (concurrency 1) for **its own** batch-row state writes so drain decisions never race; task runs themselves run on their existing per-run `PQueue`s via `RunLauncher`.

### 8.1 Collaborators (constructor-injected)
- `db: DatabaseLike`
- `runLauncher: RunLauncher` (to launch init/task/finalize runs)
- `worktreeManager: WorktreeManager` (create integration branch, merge-to-branch, delete)
- `taskChangeRouter: TaskStageDeriverLike` (board-stage derivation through the chokepoint)
- `logger: LoggerLike`
- a run-closeout helper (the same bag `runs.ts` close-out uses, or a thin shared module factored out in P4)

### 8.2 Public API
- `createBatch({ projectId, taskIds, substrate }): Promise<{ batchId }>` — insert `sprint_batches` (`planning`) + one `sprint_batch_tasks` per task (`queued`); create the integration branch; launch the `sprint-init` run (`runLauncher.launch('sprint-init', projectPath, substrate)` with `batch_id` stamped on the run). Enforce `taskIds.length <= SPRINT_BATCH_MAX_TASKS[substrate]`.
- `onRunStatusChanged({ runId, status })` — the hook. See §8.4.
- `rehydrate()` — boot recovery. See §8.5.
- internal `drain(batchId)` — the core scheduler step. See §8.3.

### 8.3 Drain (`running` state)
```
drain(batchId):
  batch = load sprint_batches; if status != 'running' return
  tasks = load sprint_batch_tasks WHERE batch_id = batchId
  if all tasks 'integrated':            → finalize(batchId); return
  if any non-terminal task but 0 ready and 0 running and ≥1 failed:
        → batch stuck (no progress possible); leave 'running', surface a warning (v1: no auto-fail)
  running = count(tasks.status == 'running')
  slots = CAP(5) - running
  ready = tasks where status=='queued'
            AND every in-batch blocking prereq has status=='integrated'
  for t in ready[:slots]:
     launch a 'task' run: runLauncher.launch('task', projectPath, batch.substrate, taskId=t.task_id, baseBranch=batch.integration_branch)
       → stamp workflow_runs.batch_id = batchId  (RunLauncher gains an optional batchId arg, P4)
     set sprint_batch_tasks: status='running', run_id=<runId>
```
DAG construction: read `task_dependencies` for the batch's task ids, keep only `kind='blocking'` edges where **both** endpoints are in the batch (drop edges to out-of-batch tasks). Readiness = all such prereqs `integrated`. (The init run already cycle-checked the edges at the chokepoint, so the DAG is acyclic.)

### 8.4 `runStatusEvents` hook (`onRunStatusChanged`)
Subscribe to the module-level `runStatusEvents` emitter (`events.ts:94`; emitted from `index.ts:682` on every executor transition). The scheduler registers a listener at boot (`runStatusEvents.on('changed', handler)`), wired in `index.ts` next to the existing emit adapter. The handler:
```
onRunStatusChanged({runId, status}):
  run = SELECT batch_id, workflow_id(name), task_id FROM workflow_runs WHERE id=runId
  if !run.batch_id: return                      // not a batch run, ignore
  batchId = run.batch_id
  enqueue on batch PQueue:
    switch (workflow name):
      'sprint-init':
        if status == 'awaiting_review':         // deps written, init drained clean
            close init run (outcome='integrated' / 'merged'-style no-op close — it made no commits)
            batch 'planning' → 'running'; drain(batchId)
        if status in terminal(failed/canceled):
            batch → 'failed' (init failed); surface
      'task':
        if status == 'awaiting_review':          // task drained clean → integrate
            try: worktreeManager.mergeWorktreeToBranch(projectPath, run.worktree, integration_branch)
                 close run (outcome='integrated'); remove worktree; delete run branch
                 sprint_batch_tasks → 'integrated' (integrated_at=now)
                 derive task → stage 8 via chokepoint
            catch (merge conflict):
                 sprint_batch_tasks → 'failed' (error=git output); close run terminal; remove worktree
            drain(batchId)                        // unblock dependents / fill freed slot
        if status in terminal(failed/canceled):
            sprint_batch_tasks → 'failed'; drain(batchId)
      'sprint-finalize':
        if status == 'awaiting_input':            // parked at human-review gate — nothing to do; the gate is user-driven
            (no-op; the QuestionRouter answer path drives the merge — see §8.6)
        if status == 'awaiting_review' (approved & drained):
            (handled by the finalize completion path §8.6)
        if status in terminal(failed/canceled):
            batch → 'failed'; surface; leave integration branch
```
> **Idempotency:** every state mutation is status-guarded (`WHERE status = <expected>`), so a duplicate event (e.g. a redelivered `awaiting_review`) is a no-op. The batch `PQueue` serializes the handler so two events for the same batch never interleave.

### 8.5 Finalize (`finalizing` state) & §8.6 the human gate
- `drain` flips `running → finalizing` when all tasks `integrated`, then launches the single `sprint-finalize` run over a worktree on the integration branch (`runLauncher.launch('sprint-finalize', projectPath, batch.substrate, baseBranch=integration_branch)`, `batch_id` stamped, `finalize_run_id` recorded).
- The finalize run runs sprint-verify → sprint-review → parks at `awaiting_input` on the `human-review` `AskUserQuestion`.
- **§8.6 Human approval → merge to main.** Two viable wirings (P6 picks one and documents it):
  - (i) **Orchestrator-driven:** the finalize prompt, after the human answers "approve", performs the integration→main merge itself via a git/bash step and reports done; the scheduler then observes `awaiting_review` and runs the completion bookkeeping (outcome stamping, stage-9 derivation, branch delete, batch `completed`).
  - (ii) **Scheduler-driven (preferred for safety):** the human answer resolves the question (QuestionRouter), the finalize run drains to `awaiting_review`; the scheduler, on observing the finalize run `awaiting_review`, performs `mergeWorktreeToMain` itself, stamps outcomes, derives stages, deletes the branch, sets batch `completed`. This keeps the destructive main merge in TS (testable) rather than in a prompt. **Default to (ii).** On the human answering "reject", the finalize run drains (no merge); the scheduler sets batch `failed` and leaves the integration branch.

### 8.5 Boot rehydration (`rehydrate`)
Mirror `runRecovery.ts` pattern, wired in `index.ts` right after `recoverActiveStateOrphans` (~968). Note: `recoverActiveStateOrphans` will mark any in-flight per-task/init/finalize run as `failed('app_restart')` because no executor exists post-crash. `rehydrate` runs AFTER that and must reconcile:
```
rehydrate():
  for batch in sprint_batches WHERE status NOT IN ('completed','failed','canceled'):
    reconcile sprint_batch_tasks whose run_id was just failed by recoverActiveStateOrphans:
       running task whose run is now 'failed' → mark batch_task 'failed' (crash) OR re-queue (v1: mark failed, surface)
    switch batch.status:
      'planning':  if init run failed → batch 'failed'; else (rare) re-launch init
      'running':   drain(batch.id)          // re-launch ready tasks, fill slots
      'finalizing':if finalize run failed → re-launch finalize (idempotent: integration branch intact)
```
> **Decision:** v1 marks a crashed in-flight task `failed` rather than auto-restarting it (its half-done worktree is gone after `recoverActiveStateOrphans` left the run `failed`; a clean re-run would need a fresh worktree). The user can re-select the failed task into a new batch. P4 may upgrade this to auto-requeue if the worktree survived.

---

## 9. Substrate-cap plumbing

- `substrate` is chosen **once per batch** in the picker and stored on `sprint_batches.substrate`. It drives BOTH the selection cap `N` (`SPRINT_BATCH_MAX_TASKS[substrate]`) and the per-run substrate threaded into every `runLauncher.launch(... , batch.substrate, ...)`.
- The per-run substrate is still resolved + stamped immutably by `WorkflowRegistry.createRun` via `substrateResolver` (`workflowRegistry.ts:378–413`) — the scheduler just forwards `batch.substrate` as the highest-precedence `requestedSubstrate`, exactly like the manual launch path.
- `CAP = 5` is a hard constant (`SPRINT_BATCH_CAP`), substrate-independent.
- The picker enforces `N` client-side AND `createBatch` enforces it server-side (defense in depth): selecting > N disables the launch button and `createBatch` throws `BAD_REQUEST` if violated.

---

## 10. Frontend

- **Picker** (`frontend/src/components/cyboflow/` — new `SprintBatchPickerModal.tsx`, modeled on `IdeaPickerModal.tsx`): multi-select up to N ready tasks (stage 6 "Ready for development"), substrate toggle (mirrors `WorkflowPicker.tsx` substrate state), shows the live `N` cap, "Launch sprint" → new tRPC `sprintBatches.create` mutation.
- **tRPC router** (`main/src/orchestrator/trpc/routers/sprintBatches.ts`, registered in the root router): `create`, `list` (per project), `get` (batch + its tasks + per-task run status), `cancel`. Service injected via a `setSprintBatchDeps`/boot-wiring seam in `index.ts` (mirror `setStartRunDeps` ~991). Keep request/response interface parity (explicit `T` on every IPCResponse / tRPC output; subscription `onData` payloads from `AppRouter` inference, never a local mirror).
- **Observation:** a `sprintBatches.onBatchChanged` subscription (new EventEmitter `sprintBatchEvents` in `events.ts`, emitted by the scheduler on every batch/task transition) feeds a `sprintBatchStore` (modeled on `activeRunsStore.ts`) so the UI shows batch progress (X/N integrated, which are running, which failed) without polling.
- No `localStorage` key renames expected; if any picker remembers last-substrate, use `migrateLocalStorageKey.ts`.

---

## 11. Per-phase plan (P1–P6)

Each phase ends green (`pnpm typecheck && pnpm lint` + touched-workspace unit tests) and is its own atomic commit. P0 (this doc) is committed alone.

### P1 — DB & shared types (foundation)
- `main/src/database/migrations/020_sprint_batches.sql` — `sprint_batches`, `sprint_batch_tasks`, `workflow_runs.batch_id`.
- `shared/types/sprintBatch.ts` — status unions, terminal-status const, row types, `SPRINT_BATCH_CAP`, `SPRINT_BATCH_MAX_TASKS`.
- `shared/types/workflows.ts` — add `batch_id?: string|null` to `WorkflowRunRow`; add `'integrated'` to `outcome` union.
- Migration-parity test + a schema-shape unit test. Verify the migration runner picks up 020 (mirror an existing migration test).
- **Touches:** `main/src/database/migrations/020_*.sql`, `shared/types/sprintBatch.ts`, `shared/types/workflows.ts`, `main/src/database/__tests__/*`.

### P2 — Workflow definitions + prompts + agent
- `shared/types/workflows.ts` — widen `CYBOFLOW_WORKFLOW_NAMES` to add `task`, `sprint-init`, `sprint-finalize`; add their three `WorkflowDefinition`s to `WORKFLOW_DEFINITIONS`.
- Prompts: `main/src/orchestrator/workflows/{task.md,sprint-init.md,sprint-finalize.md}`; agent `sprint/agents/dependency-analyzer.md`.
- Picker filter so the three internal flows are hidden in `WorkflowPicker.tsx`.
- Confirm `builtInWorkflows.ts` / `workflowBundle.ts` install the new prompts + agent into the bundle; update any flow-name allowlist there.
- Unit: `WORKFLOW_DEFINITIONS` resolves all 5; `isCyboflowWorkflowName` for new names; step-reporting append covers the new steps.
- **Touches:** `shared/types/workflows.ts`, `main/src/orchestrator/workflows/*.md`, `sprint/agents/dependency-analyzer.md`, `builtInWorkflows.ts`/`workflowBundle.ts`, `frontend/src/components/cyboflow/WorkflowPicker.tsx`, relevant `__tests__`.

### P3 — Dependency-edge write path (chokepoint + MCP tool)
- `taskChangeRouter.ts` — new `TaskChange` kind `'add-dependency'` (fields `dependsOnTaskId`, `dependencyKind`); validate existence/same-project/self-edge; **DFS cycle detection** over `task_dependencies` blocking edges; `INSERT OR IGNORE`; emit `entity_events` (`dependency-added`); new error code `'dependency_cycle'`.
- `cyboflowMcpServer.ts` — register `cyboflow_add_task_dependency` tool.
- `mcpQueryHandler.ts` — handler routing through the new chokepoint path with the standard run-context guards.
- Unit: add edge, idempotent re-add, self-edge rejected, cycle rejected, cross-project rejected.
- **Touches:** `main/src/orchestrator/taskChangeRouter.ts`, `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts`, `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`, their `__tests__`.

### P4 — Scheduler service + worktree branch-merge + launcher batch link
- `worktreeManager.ts` — `mergeWorktreeToBranch(projectPath, worktreePath, targetBranch)` (generalize `mergeWorktreeToMain`); branch-create helper for the integration branch if not already expressible via `createDeterministicWorktree`'s `baseBranch`.
- `runLauncher.ts` — optional `batchId` arg threaded to stamp `workflow_runs.batch_id`; optional `baseBranch` arg forwarded into `createDeterministicWorktree`.
- `main/src/orchestrator/sprintBatchScheduler.ts` — the full scheduler (createBatch, drain, onRunStatusChanged, finalize, rehydrate) per §8. Pure orchestrator layer, injected collaborators, batch `PQueue`.
- Unit (heaviest phase): DAG readiness, drain ≤CAP, integrate-on-awaiting_review, conflict→failed-no-crash, finalize trigger, rehydrate reconcile. Fake `runLauncher`/`worktreeManager`/`runStatusEvents`.
- **Touches:** `main/src/services/worktreeManager.ts`, `main/src/orchestrator/runLauncher.ts`, `main/src/orchestrator/sprintBatchScheduler.ts`, `__tests__`.

### P5 — Boot wiring + tRPC router + events
- `events.ts` — `sprintBatchEvents` EventEmitter + `onBatchChanged` subscription (payload typed via `AppRouter` inference).
- `sprintBatches.ts` router (`create`/`list`/`get`/`cancel`) + register in root router; `setSprintBatchDeps` seam.
- `index.ts` — instantiate `SprintBatchScheduler`, inject deps, register `runStatusEvents.on('changed', scheduler.onRunStatusChanged)`, call `scheduler.rehydrate()` after `recoverActiveStateOrphans`, wire `setSprintBatchDeps`. Thread `batchId`/`baseBranch` into the `RunLauncher` construction if signatures changed.
- Confirm the dependency-analyzer agent name matches the install convention from P2/P5 verification.
- Unit: router input validation, dep-injection guard (throws METHOD_NOT_SUPPORTED until wired), event payload shape.
- **Touches:** `main/src/orchestrator/trpc/routers/events.ts`, `main/src/orchestrator/trpc/routers/sprintBatches.ts`, root router file, `main/src/index.ts`, `__tests__`.

### P6 — Frontend picker + store + finalize human-gate wiring
- `SprintBatchPickerModal.tsx`, `sprintBatchStore.ts` (modeled on `activeRunsStore.ts`), launch surface entry point (a "Parallel sprint" action near the existing workflow launch).
- Subscribe `onBatchChanged`; render X/N progress + per-task status + failures.
- Finalize human-gate UX: the single `AskUserQuestion` already surfaces via the existing question/review UI; confirm the approval answer drives §8.6 (default scheduler-driven merge). Add an "approve & merge to main / reject" affordance if the generic question UI is insufficient.
- Frontend unit tests (vitest) for the store reducer + picker cap enforcement.
- **Touches:** `frontend/src/components/cyboflow/SprintBatchPickerModal.tsx`, `frontend/src/stores/sprintBatchStore.ts`, launch surface component, `frontend/src/stores/__tests__/*`, possibly `ensureSessionForLaunch.ts` (NOTE: batch runs are session-less — do NOT route through session creation).

---

## 12. Grounded anchors (verify line refs before editing)

| Concern | File | Anchor (verified this pass) |
| --- | --- | --- |
| Run statuses + terminal set | `shared/types/cyboflow.ts` | 9-status `WorkflowRunStatus` (incl. `awaiting_review`, `awaiting_input`); `TERMINAL_RUN_STATUSES = ['canceled','failed','completed']` (l.24); `RunStatusChangedEvent` (l.41) |
| Clean Phase-1 drain | `main/src/services/cyboflow/transitions.ts` | `transitionRunningToAwaitingReview` (l.181) — running→awaiting_review, NO approval row |
| runStatusEvents emitter | `main/src/orchestrator/trpc/routers/events.ts` | `runStatusEvents` (l.94); `onRunStatusChanged` subscription (l.292) |
| runStatusEvents emit site | `main/src/index.ts` | `runStatusEvents.emit('changed', event)` (l.682) |
| task_dependencies table | `main/src/database/migrations/015_entity_model_rebuild.sql` | l.175–184: `(id, task_id, depends_on_task_id, kind 'blocking'|'related', UNIQUE(task_id,depends_on_task_id))` |
| Latest migration | `main/src/database/migrations/` | latest `019_workflow_run_session_id.sql` → add **020** |
| Single write chokepoint | `main/src/orchestrator/taskChangeRouter.ts` | `applyChange` (l.310); per-project PQueue concurrency 1 (l.281); lineage cycle guard `validateParentEpic` (l.853–873) — add dep-cycle alongside; `TaskChange` union (l.132); `TaskFieldChanges` (l.114) |
| Board stages | `main/src/database/database.ts` | `seedDefaultBoard` (l.1666); stage 8 'Ready to merge' **derived** (l.1677), stage 9 'Done' asserted terminal (l.1678); `DONE_POSITION=9` (taskChangeRouter l.228) |
| Workflow defs | `shared/types/workflows.ts` | `CYBOFLOW_WORKFLOW_NAMES` (l.123); `WORKFLOW_DEFINITIONS` (l.237); `sprint` def with `execute`(5 steps)+`verify`(sprint-verify,sprint-review,human-review) (l.313–398); `WorkflowDefinition`/`WorkflowPhase`/`WorkflowStep` (l.143–202); `WorkflowRunRow.outcome` union (l.69) |
| Prompts + agents | `main/src/orchestrator/workflows/` | `sprint.md`, `planner.md`; `sprint/agents/{implement,write-tests,code-review,task-verify,visual-verify,sprint-verify,sprint-review}.md`; `builtInWorkflows.ts`, `workflowBundle.ts` |
| Step reporting | `main/src/orchestrator/prompts/step-reporting-instructions.ts` | `buildStepReportingAppend` (def-driven) |
| Prompt assembly seam | `main/src/orchestrator/runExecutor.ts` | `getPrompt` (l.553); seed_idea inject (l.575–605) |
| Launch | `main/src/orchestrator/runLauncher.ts` | `launch(workflowId, projectPath, substrate?, taskId?, ideaId?, sessionId?)` (l.158); enqueue via RunQueueRegistry (l.292) |
| Run create + substrate stamp | `main/src/orchestrator/workflowRegistry.ts` | `createRun(workflowId, substrate?, sessionId?)` (l.378); `resolveSubstrate` (l.400); INSERT (l.403) |
| Substrate type/resolver | `shared/types/substrate.ts`, `main/src/orchestrator/substrateResolver.ts` | `CliSubstrate='sdk'|'interactive'`, `DEFAULT_SUBSTRATE='sdk'`; `resolveSubstrate` (l.66) |
| Worktree create w/ baseBranch | `main/src/services/worktreeManager.ts` | `createDeterministicWorktree(projectPath, workflowName, runId, baseBranch?)` (l.181–197) — baseBranch supported, currently undefined |
| Merge (rebase+ff-only) | `main/src/services/worktreeManager.ts` | `squashAndMergeWorktreeToMain` (l.628), `mergeWorktreeToMain` (l.744); `removeWorktreeByPath` (l.234), `deleteBranch` (l.268), `getProjectMainBranch` (l.366), `getHeadCommit` (l.396) — **add `mergeWorktreeToBranch`** |
| Run merge mutation | `main/src/orchestrator/trpc/routers/runs.ts` | `merge` (l.749–827); `stampOutcomeAndDeriveTask` (l.825); `start` mutation (l.542–586) scalar taskId/ideaId/sessionId/substrate |
| Boot wiring | `main/src/index.ts` | `setStartRunDeps` (l.991); `recoverActiveStateOrphans` (l.968); `new RunLauncher` (l.786); `WorkflowRegistry` (l.535); `TaskChangeRouter.initialize` (l.544) |
| Boot recovery pattern | `main/src/orchestrator/runRecovery.ts` | `recoverActiveStateOrphans(db, runQueues)` — running/starting orphans → failed('app_restart') |
| MCP tools | `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` | tool registrations (l.147+: list_pending_approvals…set_task_stage l.228, report_finding l.242) — **add `cyboflow_add_task_dependency`** |
| MCP handler | `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` | task writes via `TaskChangeRouter.applyChange` (l.552,713,763,805); `resolveTaskRunContext` (l.597); review via `ReviewItemRouter` (l.1019) |
| Read projection | `main/src/orchestrator/taskListing.ts`, `shared/types/tasks.ts` | `BacklogTaskItem` (l.80) |
| Frontend launch | `frontend/src/components/cyboflow/{WorkflowPicker,IdeaPickerModal}.tsx`, `frontend/src/utils/ensureSessionForLaunch.ts` | substrate state + `runs.start.mutate`; picker model |
| Run observation store | `frontend/src/stores/activeRunsStore.ts` | `onRunStatusChanged` etc. — model `sprintBatchStore` on it |

---

## 13. Open questions / decisions deferred to implementing phases

1. **§8.6 finalize merge owner** — default **scheduler-driven (ii)**; P6 confirms whether the generic AskUserQuestion answer path can carry the approve/reject decision or needs a dedicated affordance.
2. **Crashed in-flight task on rehydrate** — v1 marks `failed` (worktree gone post-`recoverActiveStateOrphans`); auto-requeue deferred.
3. **`outcome` CHECK constraint** — VERIFIED: `workflow_runs.outcome` is plain `TEXT` (migration 014 l.176, comment-documented domain `'merged'|'pr_open'|'dismissed'|'failed'|'canceled'|NULL`, NO SQL CHECK). So adding `'integrated'` is a **TypeScript-union-only** change in `shared/types/workflows.ts` — no migration change needed.
4. **Internal flow visibility** — the three new flows stay in `CYBOFLOW_WORKFLOW_NAMES` (typing honesty) and are filtered out of the human picker (P2).
5. **No-progress batch** (all remaining tasks blocked by a `failed` prereq) — v1 leaves the batch `running` and surfaces a warning; no auto-fail. P4 may add a deadlock detector that flips such a batch to `failed`.
