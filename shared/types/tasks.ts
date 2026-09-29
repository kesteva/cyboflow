/**
 * Shared types for the native entity backlog (3-table model, migration 015;
 * archive-in-place `archived_at` added by migration 024).
 *
 * SINGLE SOURCE OF TRUTH: the SQL columns in
 * main/src/database/migrations/015_entity_model_rebuild.sql (+ the
 * 024_archive_in_place.sql ALTERs), the DB row interfaces in
 * main/src/database/models.ts (IdeaRow/EpicRow/TaskRow), and the
 * chokepoint output in main/src/orchestrator/taskChangeRouter.ts must all match
 * these shapes field-for-field. entitySchemaParity.test.ts pins each row
 * interface <-> its table.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */
import type { IdeaComponentState } from './ideaComponents';
import type { SprintBatchStatus } from './sprintBatch';
import type { ExperimentStatus } from './experiments';

// ---------------------------------------------------------------------------
// Scalar enums
// ---------------------------------------------------------------------------

/**
 * The entity-table discriminator. Table identity IS the type (the 3-table model
 * has no `type` column), so this is computed on read from WHICH table the row
 * came from and carried on the read-model item.
 */
export type TaskType = 'idea' | 'epic' | 'task';

/** The nullable idea size hint set at idea-spec time. */
export type IdeaScope = 'small' | 'large';

/** 7-level entity priority (migration 117 widen; was P0-P2 through migration 015). */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

/** Entity classification (migration 059), mirroring `Priority`'s shape. */
export type EntityCategory = 'feature' | 'bug' | 'chore';

/**
 * WHO performs a task (migration 137). TASKS ONLY — ideas and epics do not
 * execute, so they carry no executor column and read back 'agent'.
 *
 * 'human' marks work no agent can do (an account, a purchase, a physical
 * device, a legal sign-off, a credential the agent must never hold). A human
 * task is still a first-class backlog task with acceptance criteria, and agent
 * tasks may legitimately depend on its output — but it NEVER becomes a sprint
 * lane (SprintLaneStore.filterEligibleTaskIds excludes it), and a blocking edge
 * pointing at it does not gate its dependents' readiness. The work surfaces as
 * a standing non-blocking `human_task` review item instead.
 */
export type TaskExecutor = 'agent' | 'human';

/** Every {@link TaskExecutor}, for enum-shaped UI + zod schemas. */
export const TASK_EXECUTORS: readonly TaskExecutor[] = ['agent', 'human'];

/**
 * One user-attached file on an idea (migration 028) — any file type, not just
 * images. The file BYTES live on disk (CYBOFLOW_DIR/artifacts/ideas/<ideaId>/<file>,
 * written by the ideas:save-attachments IPC); only this metadata is persisted, as
 * a JSON array in the ideas.attachments column. `path` is the absolute on-disk
 * file path.
 */
export interface IdeaAttachment {
  id: string;
  /** Original filename (or a synthesized name for pasted/undownloadable files). */
  name: string;
  /** Absolute on-disk path to the saved file. */
  path: string;
  /** MIME type, e.g. 'image/png' or 'application/pdf'. */
  type: string;
  /** Byte size of the saved file. */
  size: number;
}

/**
 * AUTHORITY axis for a board stage:
 *  - 'asserted' = user/agent-settable planning stage.
 *  - 'derived'  = orchestrator-only execution stage (user/agent rejected).
 */
export type StageWritePolicy = 'asserted' | 'derived';

// ---------------------------------------------------------------------------
// Board / stage shapes (mirror board_stages + boards columns)
// ---------------------------------------------------------------------------

export interface BoardStage {
  id: string;
  label: string;
  color_oklch: string;
  hint: string | null;
  position: number;
  write_policy: StageWritePolicy;
  is_terminal: boolean;
  hidden_by_default: boolean;
}

export interface Board {
  id: string;
  project_id: number;
  name: string;
  kind: 'default' | 'custom';
  is_default: boolean;
  stages: BoardStage[];
}

// ---------------------------------------------------------------------------
// Derived read-side overlays
// ---------------------------------------------------------------------------

/**
 * One overlay per NON-TERMINAL run associated with a task — either a direct
 * task-link run OR a sprint-batch lane naming the task (migration 066: the
 * derived 'In development' board stage tracks the same association). Multiple
 * entries means parallel runs / competing approaches against the same task.
 * `inFlow.length > 0` now means "has a live run association", NOT "is actively
 * running" — check `runStatus === 'running'` for the latter (e.g. to drive a
 * breathing/pulsing visual).
 */
export interface FlowOverlay {
  agent: string;
  runId: string;
  stepId: string | null;
  /** The run's own status (non-terminal, since only those project into inFlow). */
  runStatus: string;
  /** `workflow_runs.session_id` — soft link, nullable (session rows can be deleted). */
  sessionId: string | null;
  /** The hosting session's display name (`sessions.name`), or null if unresolved. */
  sessionName: string | null;
  /**
   * `workflows.name` for the run (e.g. 'planner', 'ship'), via `workflow_runs.workflow_id`
   * (TASK-224). OPTIONAL: only the idea-seed overlay populates it today (where it also
   * restricts matches to Planner/Ship — see `gatherIdeaRunOverlayRows` in taskListing.ts /
   * taskChangeRouter.ts); the task/epic arm's FlowMarker never needed workflow identity, so
   * it is left `undefined` there rather than widening every existing FlowOverlay call site.
   */
  workflowName?: string | null;
}

/**
 * A task->task dependency edge surfaced on the read model. `taskId` is the OTHER
 * endpoint (the prerequisite for `blockedBy`, the related peer for `relatedTo`);
 * `ref`/`title` are denormalized from that task for display without a second
 * round-trip. Computed on read from `task_dependencies` (migration 015).
 */
export interface TaskDependencyRef {
  taskId: string;
  ref: string;
  title: string;
}

/**
 * One EXACT sprint-batch or experiment membership a task participates in right
 * now (IDEA-053, TASK-202). Computed on read from `sprint_batch_tasks` +
 * `sprint_batches` (sprint) and `experiment_seed_tasks` + `experiments`
 * (experiment) — a pure view projection, never stored. `id` is the stable
 * `sprint_batches.id` / `experiments.id`; `label` is a DERIVED display string
 * (see loadMembershipsForTaskIds in taskListing.ts for the exact fallback
 * chain) — there is no user-editable membership name. Entries are immutable
 * (`Readonly<...>`) so a consumer cannot accidentally mutate a shared array
 * element in place.
 */
export type BacklogMembership =
  | Readonly<{
      kind: 'sprint';
      /** `sprint_batches.id` — restricted to planning/running/finalizing batches. */
      id: string;
      label: string;
      status: SprintBatchStatus;
    }>
  | Readonly<{
      kind: 'experiment';
      /** `experiments.id` — restricted to running/grading experiments. */
      id: string;
      label: string;
      status: ExperimentStatus;
    }>;

/**
 * The read-model item rendered by the backlog UI. Columns from `tasks` plus
 * the derived overlays computed on read (selectProjectBacklog / computeTaskOverlay).
 */
export interface BacklogTaskItem {
  id: string;
  project_id: number;
  /** Computed from the source table (ideas|epics|tasks) — the 3-table model has no `type` column. */
  type: TaskType;
  ref: string;
  title: string;
  summary: string | null;
  /** Single markdown body. Present on every entity; null when unset. */
  body: string | null;
  priority: Priority;
  /** Entity classification (migration 059). */
  category: EntityCategory;
  /**
   * WHO performs this task (migration 137). REQUIRED on every constructor —
   * same silent-drop rationale as `decomposed_at`/`approved_at`/`sort_order`:
   * the picker EXCLUDES human tasks and the card badges them, so an emit path
   * that omitted it would silently turn a human task back into an agent task on
   * a live upsert. Ideas/epics have no executor column and always read 'agent'.
   */
  executor: TaskExecutor;
  repo: string | null;
  /** Lineage: only ever set on type='task' (FK->epics). */
  parent_epic_id: string | null;
  /** Lineage: set on epics + tasks (FK->ideas). null on ideas (the root). */
  originating_idea_id: string | null;
  /** Idea size hint ('small'|'large'). Only meaningful on type='idea'; null otherwise. */
  scope: IdeaScope | null;
  board_id: string;
  stage_id: string;
  /** ISO timestamp when the item was archived in place; null = not archived. */
  archived_at: string | null;
  /**
   * IDEA-only retire stamp (migration 042): ISO timestamp when the idea was
   * decomposed OFF the board (reachable only via its children), else null. Read
   * back as null on epics/tasks (no `decomposed_at` column). REQUIRED on every
   * constructor: the frontend visibility selectors compare `!== null`, so an
   * `undefined` from an emit path silently flips visibility (the silent-drop
   * class — see docs/CODE-PATTERNS.md IPC/type-parity rules).
   */
  decomposed_at: string | null;
  /**
   * EPIC/TASK plan-approval stamp (migration 042): ISO timestamp when the plan
   * was approved; null = PENDING (backend-invisible + sprint-ineligible until
   * approval). Read back as null on ideas (no `approved_at` column). REQUIRED —
   * same silent-drop rationale as `decomposed_at`.
   */
  approved_at: string | null;
  /**
   * Side-by-side experiment tag (migration 049): the experiment whose sandbox this
   * entity belongs to, or null for a normal board entity. Read back as null on any
   * pre-049 DB. OPTIONAL for cross-process shape parity (mirrors `blockedBy?` /
   * `relatedTo?`) so a partial emit compiles — but the MAIN read/emit constructors
   * (selectProjectBacklog's projectTaskItem + TaskChangeRouter.buildBacklogTaskItem)
   * ALWAYS populate it, and the server excludes tagged rows from the board by
   * default (selectProjectBacklog), so a non-null value only reaches the compare
   * view. Slice C's client `isExperimentSandboxed` selector reads `?? null`.
   */
  experiment_id?: string | null;
  /**
   * User-controlled manual rank (migration 057): a REAL used to order items
   * within the board/list ahead of the created_at/ref fallback; null = unranked
   * (sorts after every ranked item). REQUIRED — same silent-drop rationale as
   * `decomposed_at`/`approved_at`: the frontend orders by it, so an emit path
   * that omits it would silently reset dragged order on every live upsert.
   */
  sort_order: number | null;
  version: number;
  // derived overlays (computed on read):
  /** The position of the item's current stage on its board (cross-project bucketing key). */
  stage_position: number;
  inFlow: FlowOverlay[]; // MULTIPLE — parallel runs / batch lanes supported
  awaitingReview: boolean;
  isDone: boolean;
  /**
   * True when this task is the ORIGINAL seed of a LIVE (non-settled) A/B
   * experiment — its per-arm clones carry the runs (hidden by their experiment
   * tag), so it has no run of its own. The board derives BOTH its "In development"
   * column placement (effectiveBoardPosition) AND the "In experiment" card badge
   * from this flag, purely on READ — its DB stage is never written, so it is
   * correct for every experiment and reverts the instant the experiment settles.
   * A pure DISPLAY hint (NOT a visibility/eligibility gate), so it is OPTIONAL for
   * shape parity — an undefined from a partial emit path simply hides both.
   */
  experimentSeed?: boolean;
  /**
   * Blocking prerequisites of this task (task_dependencies kind='blocking').
   * Optional for shape parity across processes; absent ⇒ not computed/empty.
   */
  blockedBy?: TaskDependencyRef[];
  /** Advisory related-to peers (task_dependencies kind='related'). */
  relatedTo?: TaskDependencyRef[];
  /**
   * True when this task has no blocking prerequisites, OR every blocking
   * prerequisite has reached the Done stage (board position 9). Optional for
   * shape parity; consumers should treat `undefined` as "unknown / not gated".
   */
  readyToWork?: boolean;
  /**
   * Refs of this task's blocking prerequisites whose own executor is 'human'
   * (migration 137). Such an edge is board TRUTH but not a gate: it stays in
   * `blockedBy` and does NOT clear `readyToWork`, because nothing in a sprint
   * will ever move a human task to Done — pinning its dependents to "blocked"
   * forever would be a lie the picker, the board, and every agent reading
   * `cyboflow_list_tasks` would all repeat. Consumers render it as neutral
   * "waits on TASK-009 (human)" text, never the orange blocked chip. Optional
   * for shape parity with `blockedBy`/`readyToWork`; absent ⇒ not computed.
   */
  waitingOnHuman?: string[];
  /**
   * Exact sprint-batch / experiment memberships this task belongs to RIGHT NOW
   * (IDEA-053, TASK-202) — [] when none apply. REQUIRED on every constructor
   * (full read AND live event), same silent-drop rationale as `decomposed_at`/
   * `approved_at`/`sort_order` above: an omitted (undefined) array would break
   * a consumer that filters/badges off it on a live upsert. Only ever computed
   * for `type === 'task'`; ideas/epics always read back `[]`.
   */
  memberships: readonly BacklogMembership[];
  /**
   * The idea component ledger (migration 101, shared/types/ideaComponents.ts)
   * — one entry per tracked component, hybrid-resolved: an authoritative
   * ledger row when one exists, else a derived 'complete'/'incomplete' entry
   * synthesized from the DB. Populated for type='idea' ONLY; optional for
   * shape parity across processes — same convention as `blockedBy`/
   * `readyToWork` above, consumers should treat `undefined` as "not computed",
   * not "no components".
   */
  components?: IdeaComponentState[];
  children?: BacklogTaskItem[]; // for epics
  childCount?: number;
  pendingTasks?: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Chokepoint event payload
// ---------------------------------------------------------------------------

/**
 * `decomposed` is emitted when an idea retires to the Decomposed terminal stage
 * (its epics/tasks carry the flow). It is a specialization of a stage move so
 * the renderer can surface the retirement distinctly from an ordinary move.
 */
export type TaskChangeAction = 'created' | 'updated' | 'stageMoved' | 'decomposed' | 'deleted';

/**
 * Who authored an entity write. Lives HERE rather than beside the chokepoint
 * because it rides on {@link TaskChangedEvent}, which crosses into the renderer;
 * main/src/orchestrator/taskChangeRouter.ts re-exports it so every existing
 * import site is unchanged.
 */
export type TaskActor =
  | 'user'
  | 'orchestrator'
  | `agent:${string}`
  | 'linear'
  | 'plane'
  | 'dart'
  | 'beads';

export interface TaskChangedEvent {
  projectId: number;
  taskId: string;
  action: TaskChangeAction;
  task: BacklogTaskItem;
  /**
   * Who authored the write this event announces — the `actor` the chokepoint
   * already held at the emit site.
   *
   * OPTIONAL for shape parity: hand-built events (designHandoffService's idea
   * broadcast, test fixtures) carry none, and a consumer must treat `undefined`
   * as "unattributed", never as any particular actor. Consumers that gate a
   * user-authored-only behaviour therefore test `=== 'user'` rather than
   * `!== 'linear'` — see TrackerSyncService.handleLocalRemoval, where a staged
   * unlink ruling is a HUMAN's dialog answer and only a human's removal may
   * spend it.
   */
  actor?: TaskActor;
}
