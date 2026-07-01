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

export type Priority = 'P0' | 'P1' | 'P2';

/**
 * One user-attached image on an idea (migration 028). The image BYTES live on
 * disk (CYBOFLOW_DIR/artifacts/ideas/<ideaId>/<file>, written by the
 * ideas:save-attachments IPC); only this metadata is persisted, as a JSON array
 * in the ideas.attachments column. `path` is the absolute on-disk file path.
 */
export interface IdeaAttachment {
  id: string;
  /** Original filename (or a synthesized name for pasted images). */
  name: string;
  /** Absolute on-disk path to the saved image file. */
  path: string;
  /** MIME type, e.g. 'image/png'. */
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
 * One overlay per active (running) run on a task. Multiple entries means
 * parallel runs / competing approaches against the same task.
 */
export interface FlowOverlay {
  agent: string;
  runId: string;
  stepId: string | null;
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
   * class — see CLAUDE.md IPC/type-parity rules).
   */
  decomposed_at: string | null;
  /**
   * EPIC/TASK plan-approval stamp (migration 042): ISO timestamp when the plan
   * was approved; null = PENDING (backend-invisible + sprint-ineligible until
   * approval). Read back as null on ideas (no `approved_at` column). REQUIRED —
   * same silent-drop rationale as `decomposed_at`.
   */
  approved_at: string | null;
  version: number;
  // derived overlays (computed on read):
  /** The position of the item's current stage on its board (cross-project bucketing key). */
  stage_position: number;
  inFlow: FlowOverlay[]; // MULTIPLE — parallel runs supported
  awaitingReview: boolean;
  isDone: boolean;
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

export interface TaskChangedEvent {
  projectId: number;
  taskId: string;
  action: TaskChangeAction;
  task: BacklogTaskItem;
}
