import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';

export interface Project {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  default_permission_mode?: 'approve' | 'ignore';
  open_ide_command?: string | null;
  display_order?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_structured_prompt_template?: string;
  commit_checkpoint_prefix?: string;
}

export interface ProjectRunCommand {
  id: number;
  project_id: number;
  command: string;
  display_name?: string;
  order_index: number;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  project_id: number;
  parent_folder_id?: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  name: string;
  initial_prompt: string;
  worktree_name: string;
  worktree_path: string;
  status: 'pending' | 'running' | 'stopped' | 'completed' | 'failed';
  status_message?: string;
  created_at: string;
  updated_at: string;
  last_output?: string;
  exit_code?: number;
  pid?: number;
  archived?: boolean;
  last_viewed_at?: string;
  project_id?: number;
  folder_id?: string;
  claude_session_id?: string;
  permission_mode?: 'approve' | 'ignore';
  /**
   * Per-session 4-mode agent-permission override (migration 021), DISTINCT from
   * the legacy `permission_mode` above. NULL → inherit the global default
   * (Settings → Agent Permission Mode). Read by resolveSessionAgentPermissionMode
   * on quick/legacy SDK panel spawns; workflow runs use permission_mode_snapshot.
   */
  agent_permission_mode?: PermissionMode;
  run_started_at?: string;
  is_main_repo?: boolean;
  display_order?: number;
  is_favorite?: boolean;
  auto_commit?: boolean;
  tool_type?: 'claude' | 'none';
  base_commit?: string;
  base_branch?: string;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_mode_settings?: string; // JSON string of CommitModeSettings
  skip_continue_next?: boolean;
  run_id?: string | null;
  /** Set to true for sessions created outside any workflow flow (TASK-787 / IDEA-027). */
  is_quick?: boolean;
  /**
   * Which CLI substrate the session's claude panel runs on ('sdk'|'interactive').
   * Written by sessions:create-quick (migration 027); NULL → sdk (legacy).
   */
  substrate?: CliSubstrate;
  /**
   * Agent effort the session was launched with ('ultracode' | undefined).
   * Written by sessions:create-quick (migration 029); NULL → no effort.
   */
  effort?: 'ultracode';
}

export interface SessionOutput {
  id: number;
  session_id: string;
  type: 'stdout' | 'stderr' | 'system' | 'json' | 'error';
  data: string;
  timestamp: string;
  panel_id?: string;
}

export interface ConversationMessage {
  id: number;
  session_id: string;
  message_type: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface CreateSessionData {
  id: string;
  name: string;
  initial_prompt: string;
  worktree_name: string;
  worktree_path: string;
  project_id: number;
  folder_id?: string;
  permission_mode?: 'approve' | 'ignore';
  is_main_repo?: boolean;
  display_order?: number;
  auto_commit?: boolean;
  tool_type?: 'claude' | 'none';
  base_commit?: string;
  base_branch?: string;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_mode_settings?: string; // JSON string of CommitModeSettings
  run_id?: string | null;
}

export interface UpdateSessionData {
  name?: string;
  status?: Session['status'];
  status_message?: string;
  last_output?: string;
  exit_code?: number;
  pid?: number;
  folder_id?: string | null;
  claude_session_id?: string;
  run_started_at?: string;
  is_favorite?: boolean;
  auto_commit?: boolean;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_mode_settings?: string; // JSON string of CommitModeSettings
  agent_permission_mode?: PermissionMode;
  skip_continue_next?: boolean;
}

export interface PromptMarker {
  id: number;
  session_id: string;
  prompt_text: string;
  output_index: number;
  output_line?: number;
  timestamp: string;
  completion_timestamp?: string;
}

export interface ExecutionDiff {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[]; // JSON array of changed file paths
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
  comparison_branch?: string;
  history_source?: 'remote' | 'local' | 'branch';
  history_limit_reached?: boolean;
}

export interface CreateExecutionDiffData {
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}

export interface CreatePanelExecutionDiffData {
  panel_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}

// ---------------------------------------------------------------------------
// Native entity backlog row interfaces (migration 015_entity_model_rebuild.sql).
//
// The unified `tasks` table is split into THREE dedicated entity tables —
// `ideas`, `epics`, `tasks` — each with its own columns plus a single markdown
// `body` and a `stage_id` onto the shared board. Table identity IS the type
// discriminator, so NONE of these carry a `type` column. The polymorphic
// `entity_events` log replaces task_events.
//
// These mirror the SQL columns 1:1. SQLite stores BOOLEAN as 0/1, so boolean
// columns surface as `number` (0|1) on read — consumers normalize to boolean.
// The shared READ-model + chokepoint types live in shared/types/tasks.ts; the
// entitySchemaParity test pins each row interface against its table columns.
// ---------------------------------------------------------------------------

export interface BoardRow {
  id: string; // 'board-{projectId}-default'
  project_id: number;
  name: string;
  kind: 'default' | 'custom';
  is_default: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface BoardStageRow {
  id: string; // 'stage-{boardId}-{position}'
  board_id: string;
  label: string;
  color_oklch: string;
  hint: string | null;
  position: number;
  write_policy: 'asserted' | 'derived';
  is_terminal: number; // 0 | 1
  hidden_by_default: number; // 0 | 1
}

/**
 * `ideas` row (migration 015). Table identity is the discriminator — NO `type`
 * and NO lineage column. `scope` is the nullable size hint set at idea-spec time.
 * `archived_at` (migration 024) is the archive-in-place stamp: NULL = active.
 */
export interface IdeaRow {
  id: string;
  project_id: number;
  ref: string;
  title: string;
  summary: string | null;
  body: string | null;
  scope: 'small' | 'large' | null;
  priority: 'P0' | 'P1' | 'P2';
  repo: string | null;
  board_id: string;
  stage_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null; // 024 ALTER appends — archive-in-place stamp
  attachments: string | null; // 028 ALTER appends — JSON IdeaAttachment[] (ideas-only); NULL = none
}

/**
 * `epics` row (migration 015). Same base as IdeaRow minus `scope`, plus the
 * `originating_idea_id` lineage FK->ideas(id). `archived_at` (migration 024)
 * is the archive-in-place stamp: NULL = active.
 */
export interface EpicRow {
  id: string;
  project_id: number;
  ref: string;
  title: string;
  summary: string | null;
  body: string | null;
  priority: 'P0' | 'P1' | 'P2';
  repo: string | null;
  board_id: string;
  stage_id: string;
  originating_idea_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null; // 024 ALTER appends — archive-in-place stamp
}

/**
 * `tasks` row (migration 015). Same base, plus the execution-entry capture
 * (`entry_stage_id`) and both lineage FKs: `parent_epic_id` (FK->epics) and
 * `originating_idea_id` (FK->ideas, set for the small-idea branch that skips
 * epics). `archived_at` (migration 024) is the archive-in-place stamp:
 * NULL = active.
 */
export interface TaskRow {
  id: string;
  project_id: number;
  ref: string;
  title: string;
  summary: string | null;
  body: string | null;
  priority: 'P0' | 'P1' | 'P2';
  repo: string | null;
  board_id: string;
  stage_id: string;
  entry_stage_id: string | null;
  parent_epic_id: string | null;
  originating_idea_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null; // 024 ALTER appends — archive-in-place stamp
}

export interface TaskRefCounterRow {
  project_id: number;
  type: string;
  next_seq: number;
}

/**
 * `entity_events` row (migration 015) — the polymorphic per-field delta log
 * that replaces task_events. The (entity_type, entity_id) pair is the soft
 * polymorphic link; seq is unique per-(entity_type, entity_id).
 */
export interface EntityEventRow {
  id: number;
  entity_type: 'idea' | 'epic' | 'task' | 'review_item';
  entity_id: string;
  seq: number;
  kind: string;
  actor: string; // 'user' | 'orchestrator' | 'agent:<role>' | 'linear'
  run_id: string | null;
  changes_json: string | null;
  created_at: string;
}

/**
 * `review_items` row (migrations 016 + 034) — the unified human-attention inbox.
 * The (entity_type, entity_id) pair is a SOFT polymorphic link (both nullable,
 * code-validated, NO hard FK). SQLite stores BOOLEAN as 0/1, so `blocking` and
 * `selected` surface as `number` (0|1) on read — consumers normalize to boolean.
 * `priority`/`staged_at`/`selected` (migration 034) are finding-triage columns:
 * meaningful only for kind='finding' (same convention as `severity`). The
 * shared READ-model + chokepoint types live in shared/types/reviews.ts; the
 * reviewItemSchemaParity test pins this interface against the table columns.
 */
export interface ReviewItemRow {
  id: string;
  project_id: number;
  run_id: string | null;
  entity_type: 'idea' | 'epic' | 'task' | null;
  entity_id: string | null;
  kind: 'finding' | 'permission' | 'decision' | 'human_task';
  status: 'pending' | 'resolved' | 'dismissed';
  blocking: number; // 0 | 1
  title: string;
  body: string | null;
  severity: 'info' | 'warning' | 'error' | null;
  priority: 'P0' | 'P1' | 'P2' | null; // migration 034 — NULL = un-prioritized
  staged_at: string | null; // migration 034 — non-NULL == approved into READY
  selected: number; // 0 | 1 (migration 034 — SQLite BOOLEAN-as-number, mirrors `blocking`)
  source: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_by: string | null;
  resolution: string | null;
}

export interface TaskAcceptanceCriterionRow {
  id: number;
  task_id: string;
  criterion: string;
  completed: number; // 0 | 1
  created_at: string;
}

export interface TaskDependencyRow {
  id: number;
  task_id: string;
  depends_on_task_id: string;
  kind: 'blocking' | 'related';
}

export interface TaskFileRow {
  id: number;
  task_id: string;
  file_path: string;
  ownership: 'owned' | 'readonly';
}

// Parallel-sprint batch row types (migration 022). The canonical definitions
// live in shared/types/sprintBatch.ts so both processes share one shape; re-export
// here so main-process DB callers can import row types from this barrel alongside
// the other table-row interfaces.
export type {
  SprintBatchRow,
  SprintBatchTaskRow,
  SprintBatchStatus,
  SprintBatchTaskStatus,
} from '../../../shared/types/sprintBatch';

export interface TaskExternalLinkRow {
  id: number;
  task_id: string;
  provider: string;
  external_id: string | null;
  external_url: string | null;
  synced_cursor: string | null;
  baseline_json: string | null;
}

/**
 * `run_usage` row (migration 026) — the durable per-run token/cost rollup, one
 * row per run (run_id PRIMARY KEY, hard-FK -> workflow_runs ON DELETE CASCADE).
 * Persisted twin of shared/types/insights.ts RunUsageRollup: insightsQueries
 * computes the rollup from raw_events and the Phase-2 writer upserts it here.
 * `total_tokens` is input + output. `cost_usd` / `num_turns` are nullable (NULL
 * when no terminal result payload carried them — SDK-only).
 */
export interface RunUsageRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number; // input + output
  cost_usd: number | null;
  num_turns: number | null;
  assistant_message_count: number;
  computed_at: string;
}

/**
 * `workflow_revisions` row (migration 026) — append-only snapshot of every
 * distinct spec_json a workflow has carried, keyed by (workflow_id, spec_hash).
 * Lets a run's frozen workflow_runs.spec_hash always resolve to the spec text
 * that produced it after the live workflow spec_json moves on. UNIQUE(workflow_id,
 * spec_hash) makes the writer's "record if new" an idempotent INSERT OR IGNORE;
 * hard-FK workflow_id -> workflows ON DELETE CASCADE.
 */
export interface WorkflowRevisionRow {
  id: number;
  workflow_id: string;
  spec_hash: string; // sha256 hex of spec_json (computeSpecHash)
  spec_json: string;
  created_at: string;
}

/**
 * `agent_overrides` row (migration 029) — a per-project override of a built-in
 * agent (`base_agent_key === agent_key`, `is_custom 0`) OR a brand-new custom
 * agent (`base_agent_key NULL`, `is_custom 1`). One row per (project_id,
 * agent_key). `name` is always the frontmatter name `cyboflow-<agent_key>` and is
 * never user-editable. `tools_json` is a JSON-encoded `CliTool[]`. There is NO
 * `enabled` column and NO model column — agents inherit the run's model.
 * Validation lives in code (mirrors migrations 016/026), not CHECK constraints.
 */
export interface AgentOverrideRow {
  id: string; // "ago_" + 10-byte hex
  project_id: number;
  agent_key: string;
  base_agent_key: string | null; // NULL = custom; else == agent_key (the builtin it shadows)
  name: string; // == "cyboflow-" + agent_key
  role: string | null;
  description: string;
  system_prompt: string;
  tools_json: string; // JSON-encoded CliTool[]
  enabled_mcps_json: string; // JSON-encoded string[] of MCP server names (migration 035); '[]' = none
  is_custom: number; // 0 | 1
  version: number;
  created_at: string;
  updated_at: string;
}
