/**
 * Shared types for the native task backlog (Phase 0 + Phase 1).
 *
 * SINGLE SOURCE OF TRUTH: the SQL columns in
 * main/src/database/migrations/013_native_tasks.sql, the DB row interfaces in
 * main/src/database/models.ts, and the chokepoint output in
 * main/src/orchestrator/taskChangeRouter.ts must all match these shapes
 * field-for-field. The schema-parity test pins TaskRow <-> tasks columns.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */

// ---------------------------------------------------------------------------
// Scalar enums
// ---------------------------------------------------------------------------

export type TaskType = 'idea' | 'epic' | 'task';

export type Priority = 'P0' | 'P1' | 'P2';

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
 * The read-model item rendered by the backlog UI. Columns from `tasks` plus
 * the derived overlays computed on read (selectProjectBacklog / computeTaskOverlay).
 */
export interface BacklogTaskItem {
  id: string;
  project_id: number;
  type: TaskType;
  ref: string;
  title: string;
  summary: string | null;
  priority: Priority;
  repo: string | null;
  parent_epic_id: string | null;
  board_id: string;
  stage_id: string;
  version: number;
  // derived overlays (computed on read):
  inFlow: FlowOverlay[]; // MULTIPLE — parallel runs supported
  awaitingReview: boolean;
  isDone: boolean;
  children?: BacklogTaskItem[]; // for epics
  childCount?: number;
  pendingTasks?: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Chokepoint event payload
// ---------------------------------------------------------------------------

export type TaskChangeAction = 'created' | 'updated' | 'stageMoved' | 'deleted';

export interface TaskChangedEvent {
  projectId: number;
  taskId: string;
  action: TaskChangeAction;
  task: BacklogTaskItem;
}
