# Parallel Sprint — Single-Run Orchestrator Architecture

> **Status:** describes the SHIPPED architecture on `feat/parallel-sprint` (the
> "single-run lane model" redesign). The original multi-run scheduler design that
> previously lived in this file was built, then **replaced** before merge — see the
> [superseded-design appendix](#appendix--superseded-multi-run-scheduler-design)
> for what it was and why it lost.

---

## 1. Overview

A **sprint** executes N tasks in ONE session-hosted `sprint` run. There is no
scheduler service, no internal workflows, and no per-task runs: the sprint
**orchestrator agent** (one Claude session, one chat) owns the whole lifecycle —
it analyzes the dependency DAG itself, fans out per-task **subagents** with
bounded concurrency in the **shared session worktree**, and runs one holistic
verify → review → human gate at the end. Merging the sprint to main is the
normal session **Merge** close-out.

Per-task progress is persisted as **lanes** — `sprint_batch_tasks` rows
(migration 022, repurposed) written exclusively through the new
`cyboflow_update_sprint_task` MCP tool → `SprintLaneStore` chokepoint — and
rendered as swim lanes in the center pane (`SprintSwimlaneCanvas`, §7) plus a
compact summary in the run progress rail (`SprintLanesPanel`).

**N = 1 degenerates cleanly:** a single-task sprint is just a sprint with one
lane. Nothing about the flow, the data model, or the UI changes.

Selection caps: the picker allows up to `SPRINT_BATCH_MAX_TASKS[substrate]`
tasks (15 `sdk` / 10 `interactive` — a context/host-resource cap), enforced
client-side in the picker AND server-side in `runs.start`. Subagent
**concurrency** is `SPRINT_BATCH_CAP = 5`, substrate-independent, enforced by
prose in `sprint.md` (the orchestrator agent dispatches at most 5 task chains
at once). Both constants live in `shared/types/sprintBatch.ts`.

---

## 2. Launch path

```
TaskBatchPickerModal (multi-select ready tasks, cap N)
  → session wizard launches the 'sprint' workflow with taskIds
  → tRPC cyboflow.runs.start { workflowId, projectId, sessionId, taskIds, … }   (cap re-checked server-side)
  → RunLauncher.launch(…, seedTaskIds)                                          (9th trailing param)
      ├─ validates: workflow.name === 'sprint', ≥1 id, sprintLanes wired — BEFORE createRun
      ├─ SprintLaneStore.createForRun(projectId, resolvedSubstrate, taskIds)
      │     one txn: INSERT sprint_batches (status 'running', concurrency 5,
      │     integration_branch NULL) + one 'queued' sprint_batch_tasks row per task
      └─ UPDATE workflow_runs SET batch_id = <batchId>                          (the only stamp; immutable after)
  → RunExecutor.getPrompt() sees run.batch_id and prepends a `# Sprint tasks`
    block (one `## <ref>: <title>` section per seeded task with summary/body,
    resolved fail-soft per task) ahead of the sprint.md prompt body. The nudge
    and resume branches win over the seed block, so re-sends never duplicate it.
```

Key properties:

- The substrate recorded on `sprint_batches.substrate` is the **resolved** value
  returned by `WorkflowRegistry.createRun` (the resolver ladder's output), never
  the requested one.
- `seedTaskIds` is only valid for the `sprint` workflow; the launcher throws for
  any other workflow, for an empty array, and when no lane store is wired —
  all before `createRun`, so no half-created run row is left behind.
- A sprint launched **without** `taskIds` has no batch and no lanes (the MCP
  lane tool rejects it — §5); the batch picker is the supported entry point.

## 3. The `sprint` workflow definition

`shared/types/workflows.ts` — 3 phases, 5 steps, **no loopback fields**
(re-delegation to a fresh subagent is prose-driven in `sprint.md`, not
runner-driven):

| Phase | Step | Agent | Notes |
|---|---|---|---|
| `plan` (Plan, `#5a4ad6`) | `analyze-dependencies` | dependency-analyzer | retries 1 |
| `execute` (Execute, `#c96442`) | `execute-tasks` | executor | retries 3 — ONE step covering the whole fan-out; per-task progress lives in the lanes, not in step reports |
| `verify` (Sprint review, `#a87a2c`) | `sprint-verify` → `sprint-review` → `human-review` | verifier / code-reviewer / human | the single human gate (`human: true`) |

The old per-task steps (`implement`, `write-tests`, `code-review`,
`task-verify`, `visual-verify`) are no longer workflow steps — they survive as
the **lane step vocabulary** (`SPRINT_LANE_STEP_IDS`, §5) that each lane's
`current_step_id` walks through.

## 4. The orchestrator agent (`main/src/orchestrator/workflows/sprint.md`)

The orchestrator agent is the **single writer** of all cyboflow state for the
run. Heavy phases are delegated to `cyboflow-<phase>` subagents installed in
`.claude/agents/` (each runs in its own context window and returns a compact
`## Result`); subagents never call `cyboflow_*` tools or `AskUserQuestion`.

**Phase 1 — Plan.** Delegate to `cyboflow-dependency-analyzer` with every
seeded task's id/title/body/acceptance criteria/expected files; it returns
proposed `task → depends-on` blocking edges. The orchestrator writes each edge
via `cyboflow_add_task_dependency` (the `TaskChangeRouter` chokepoint
cycle-checks every edge; `dependency_cycle`/`invalid_dependency` rejects are
skipped so the DAG stays acyclic).

**Phase 2 — Execute.** Run the sprint as **DAG waves** over the recorded edges:

- A task is READY when all its blocking prerequisites are complete; dispatch at
  most **5** concurrently (parallel Agent tool calls in one message).
- **File-overlap serialization:** before each wave, tasks whose expected files
  overlap are serialized into later waves — two subagents never touch the same
  file concurrently.
- All work happens in the **shared session worktree** — no per-task branches or
  worktrees.
- Each task runs the per-task subagent chain `implement → write-tests →
  code-review → task-verify → visual-verify(optional)`, with prose-driven
  loopbacks (failing tests / blocking review defects / verify FAIL re-delegate
  to `cyboflow-implement`, up to 3 verify retries). On every implement
  re-delegation the orchestrator includes `attempt: <n>` (2 on the first
  re-delegate, 3 on the second) in the **same** `cyboflow_update_sprint_task`
  call that moves the lane's `current_step` back to `implement` — this feeds
  the lane's `attempts` counter (§5).
- **On task success:** ONE atomic git commit for that task's changes
  (referencing the task ref), lane → `integrated`, task → board stage 8
  ("Ready to merge") via `cyboflow_set_task_stage`.
- A failed lane **never stops the sprint** — remaining lanes keep running and
  the failure is surfaced at the human gate.
- Lane discipline: every transition goes through `cyboflow_update_sprint_task`
  at the moment it happens (`running` on dispatch, `current_step` per stage,
  `integrated`/`failed` at the end) — never batched or backfilled.

**Phase 3 — Sprint review** (entered once every lane is terminal):
`cyboflow-sprint-verify` runs the full suite ONCE over the combined state (on
FAIL, the offending lanes loop back through Phase 2, at most 2 such loops);
`cyboflow-sprint-review` does the holistic taste pass (findings via
`cyboflow_report_finding`); then the **inline human gate** — `AskUserQuestion`
("Approve sprint", Approve/Reject). On Approve the agent posts a per-lane
outcome table and stops; **it never merges to main itself** — the user merges
the session from the UI (§7).

## 5. Lanes — data model + chokepoint

### Persistence (migrations 022 + 023 + 025)

Migration `022_sprint_batches.sql` is **immutable** and retained from the
superseded design; its tables are repurposed as the lane substrate:

- **`sprint_batches`** — one row per sprint run, created `'running'` with
  `concurrency = 5` and `integration_branch = NULL` (no integration branch
  exists in this model; that column plus `init_run_id` / `finalize_run_id` are
  legacy, always NULL now). Terminal flip via `markBatchTerminal` only.
- **`sprint_batch_tasks`** — one **lane** per seeded task:
  `status IN ('queued','running','integrated','failed','blocked')` plus
  `current_step_id` (added by migration `023_sprint_lane_step.sql`, same
  duplicate-column idempotency pattern as 022) plus `attempts INTEGER NOT NULL
  DEFAULT 0` (migration `025_sprint_lane_attempts.sql`, same pattern). The
  attempts counter tracks the per-task implement→verify retry loop: **0 = first
  pass** (the UI renders nothing); the orchestrator reports `attempt: N`
  (2, 3, …) via `cyboflow_update_sprint_task` when it re-delegates implement
  after a task-verify FAIL or a blocking review defect.
- **`workflow_runs.batch_id`** — the soft run→batch link, stamped once by
  `RunLauncher` (no UPDATE path afterwards).

**`'integrated'` redefined:** in this model it means *task complete AND
committed in the session worktree* — there is no per-task branch or merge.
The lane step vocabulary is `SPRINT_LANE_STEP_IDS = ['implement',
'write-tests', 'code-review', 'task-verify', 'visual-verify']`
(`shared/types/sprintBatch.ts`, with `SprintLaneRow` /
`SprintLaneChangedEvent`).

### `SprintLaneStore` (`main/src/orchestrator/sprintLaneStore.ts`)

The **single write chokepoint** for lanes — a singleton mirroring
`TaskChangeRouter`'s lifecycle (`initialize(db, logger?)` from `index.ts` /
`getInstance()` / `_resetForTesting()`), orchestrator-layer (no `electron` /
`better-sqlite3` / services imports; `DatabaseLike` injected). Ownership
doctrine is migration 022's: `sprint_batches` / `sprint_batch_tasks` are NOT
entity-model tables and never route through `TaskChangeRouter`; the store
writes them directly with status-guarded UPDATEs, the way `RunLauncher` writes
`workflow_runs`. Board-stage derivation of the underlying tasks still flows
through the entity chokepoint.

- `createForRun(projectId, substrate, taskIds)` — one txn, batch + queued
  lanes; dedupes ids; rejects an empty selection (`bad_request`).
- `updateLane({ runId, batchId, taskId, status?, currentStepId?, attempt? })` —
  validates the status domain + step vocabulary + at-least-one-field
  (`SprintLaneError` `'bad_request'` / `'lane_not_found'`); `attempt` must be
  an integer >= 1 (`bad_request` otherwise) and is written verbatim to the
  `attempts` column. Stamps `integrated_at` on `'integrated'`, then emits a
  `SprintLaneChangedEvent` — carrying the row's current `attempts` — on
  `sprintLaneEvents` channel `sprintLaneChannel(runId)` (`'sprint-lane-<runId>'`).
- `listLanes(batchId)` — lanes in insertion order, `ref`/`title` resolved
  fail-soft via LEFT JOIN on `tasks` (null when missing). Each `SprintLaneRow`
  also carries **`blockedByRefs: string[]`** — display refs (task ref, falling
  back to the raw task id) of the lane's IN-BATCH blocking prerequisites
  (`task_dependencies` `kind='blocking'`) whose own lane in the SAME batch is
  not yet `'integrated'`; `[]` when none. Computed on read via one extra query
  (`blockedByRefsForBatch`) — **NOT stored**.
- `markBatchTerminal(batchId, 'completed' | 'failed')` — status-guarded: only a
  non-terminal batch transitions; a late second call is a logged no-op.

## 6. MCP tool — `cyboflow_update_sprint_task`

Registered in `cyboflowMcpServer.ts`, handled in `mcpQueryHandler.ts`
(`handleUpdateSprintTask`). Input: `task_id` (required) plus at least one of
`status` (the `SprintBatchTaskStatus` enum) / `current_step` (the
`SPRINT_LANE_STEP_IDS` enum), and optionally `attempt` (integer >= 1, validated
in the `CallTool` case like the other args; passed through to `updateLane`,
which writes it verbatim to the `attempts` column — the at-least-one rule on
`status`/`current_step` is unchanged MCP-side). Success data includes the
lane's current `attempts`. The handler resolves the run context with the
same guards as the other task-scoped writes, then requires the calling run's
`workflow_runs.batch_id` to be non-null — a run without a batch (quick session,
planner, a sprint launched without seed tasks) is rejected with
`sprint_lane_requires_batch_run`. The write itself is
`SprintLaneStore.getInstance().updateLane(...)`; `SprintLaneError` codes map to
designed MCP rejections. Lane updates never move the task on the board (board
stages are orchestrator-`derived` via `cyboflow_set_task_stage`) and never
pause the run.

`cyboflow_add_task_dependency` (the Plan-phase edge write through
`TaskChangeRouter`, with DFS cycle detection and `entity_events` logging)
carries over unchanged from the previous design.

## 7. Observation + close-out

**Read/observe path:** `cyboflow.runs.sprintLanes` (query, `runId` →
`run.batch_id` → `SprintLaneStore.listLanes`, `[]` for a batch-less run; dep-bag
injected via `setSprintLaneDeps` at boot) and `cyboflow.runs.onSprintLaneChanged`
(subscription bridging `sprintLaneEvents` / `sprintLaneChannel(runId)` via
`eventToAsyncIterable`, modeled on `onStepTransition`; the event payload carries
the lane's current `attempts`).

**Center pane — `SprintSwimlaneCanvas` (the "Swim lanes" view).** For
batch-carrying runs the center pane replaces the generic `WorkflowCanvas` with
a per-task swim-lane canvas:

- **One lane per task**, each rendering the 5 lane-step cards (`implement →
  write-tests → code-review → task-verify → visual-verify`) with live per-step
  status driven by the lane's `current_step_id` + `status`.
- **Lane chips** map lane state to a single badge: `integrated` → **MERGED**;
  `running` → **RUNNING**; `failed` → **ESCALATED** (failed lanes surface at
  the human gate by design); status `'blocked'` OR (`queued` AND
  `blockedByRefs.length > 0`) → **BLOCKED** "waiting on \<refs\>"; `queued`
  otherwise → **QUEUED** "waiting for worker slot".
- **Attempt loop edge:** a running lane with `attempts >= 2` draws a dashed
  loop edge back to its implement card, labeled "ATTEMPT n/3"; an integrated
  lane with `attempts >= 2` shows "n attempts"; a failed lane shows
  "3/3 failed". `attempts === 0` (first pass) renders nothing.
- **Layout:** the collapsed plan card sits left of the lanes; the verify
  column (sprint-verify → sprint-review → human-review) plus the merge-gate
  bar sit right.

The right-rail `SprintLanesPanel` **remains** as the compact summary — one row
per lane showing ref/title, status, and the current per-task step — alongside
the run's step timeline.

**Merge close-out = the normal session Merge.** When the user merges the
session (`sessions:squash-and-rebase-to-main` or `sessions:rebase-to-main`,
`main/src/ipc/git.ts`), `finalizeSprintLanesOnSessionMerge(sessionId)` runs on
the success path: for every batch-linked run hosted by the session, each
`'integrated'` lane's task moves to the done stage (board position 9) through
`TaskChangeRouter.applyChange` (actor `'orchestrator'`, kind
`'execution-stage'` — mirroring `recomputeTaskExecutionStage`'s
`outcome='merged'` arm), then the batch is marked `'completed'`. Entirely
fail-soft per task and per batch: a close-out failure is logged and never
affects the (already-succeeded) git merge. Failed/blocked/queued lanes are left
alone — their tasks follow the normal stage rules.

**Failure seam:** when a batch-carrying run reaches phase `failed` or
`canceled`, `RunExecutor.deriveTaskStageForPhase` calls
`markBatchTerminal(batch_id, 'failed')` (it fires before the `task_id`
early-return, since sprint runs carry `batch_id` but usually no `task_id`).

## 8. Deferred follow-ups

- **Per-task child worktrees with merge-back** — re-introduce isolation for
  tasks whose file sets cannot be cleanly serialized: each task chain gets a
  child worktree cut off the session branch and is merged back as it completes.
  The shared-worktree + file-overlap-serialization model ships first; the
  `worktreeManager` merge primitives (`mergeWorktreeToBranch`,
  `createBranchRef`, …) built for the superseded design are retained for this.
- **Richer lane log streaming** — lanes currently carry status, current step,
  and the attempts counter only; streaming each subagent's transcript tail into
  its lane (per-lane log panes) is deferred.
- **Per-lane rev counter** — the per-task commit sha is not captured (lanes
  record that a task was committed via `'integrated'`, not *which* commit); a
  per-lane "rev" pointer for the swim-lanes canvas is deferred.

---

## Appendix — superseded multi-run scheduler design

The first implementation of this epic (commits `3762f9e..425503a`) was a
**multi-run scheduler** model: a `SprintBatchScheduler` service launched 2+N
session-less runs per batch — one `sprint-init` run (dependency analysis), N
per-task `task` runs (Phase-1-only, each in its own worktree cut off a shared
`sprint/<id8>` integration branch, rebase+ff-merged back per task), and one
`sprint-finalize` run (full-suite verify + the single human gate + the
integration→main merge). It was driven by `runStatusEvents`, drained ready
tasks up to CAP=5, and exposed `runs.startBatch` / `runs.batchProgress`.

**Why it was replaced.** The model worked but cost the product its core UX:

- **Lost single-session UX** — a batch fanned out into 2+N parentless,
  session-less runs, so there was no session to open, watch, or Merge; the
  close-out had to be scheduler-driven instead of the user's normal Merge flow.
- **No single chat** — each run was its own Claude conversation; there was
  nowhere to watch the sprint think, intervene mid-flight, or answer the gate
  in context.
- **No single orchestrating mind** — ordering/recovery logic lived in a TS
  scheduler reacting to status events, while the judgment calls (loopbacks,
  failure triage, scope guards) were sliced across N isolated agents. The
  redesign puts one agent in charge of both.

**What survived** (repurposed, not reverted):

- Migration 022 (`sprint_batches` / `sprint_batch_tasks` /
  `workflow_runs.batch_id`) — immutable, now the **lane** substrate; the
  integration-branch / init-run / finalize-run columns are legacy always-NULL.
- `task_dependencies` writes: the `add-dependency` `TaskChange` kind, DFS cycle
  guard, and the `cyboflow_add_task_dependency` MCP tool.
- The `cyboflow-dependency-analyzer` subagent (now delegated by the sprint
  orchestrator instead of a `sprint-init` run).
- `TaskBatchPickerModal` + the substrate-keyed selection caps
  (`SPRINT_BATCH_CAP` / `SPRINT_BATCH_MAX_TASKS`).
- The `worktreeManager` merge primitives (`mergeWorktreeToBranch` etc.) —
  generic, tested, retained for the per-task-child-worktree follow-up.

**What was deleted:** `sprintBatchScheduler.ts` (+ tests), the internal
`task` / `sprint-init` / `sprint-finalize` workflows and their prompt bodies,
the `internal?` workflow flag / `isInternalWorkflowName`, `runs.startBatch` /
`runs.batchProgress`, `SprintBatchProgress`, and the batch progress badge UI.
