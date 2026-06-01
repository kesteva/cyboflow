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
// Native task backlog row interfaces (migration 013_native_tasks.sql).
//
// These mirror the SQL columns 1:1. SQLite stores BOOLEAN as 0/1, so boolean
// columns surface as `number` (0|1) on read — consumers normalize to boolean.
// The shared READ-model + chokepoint types live in shared/types/tasks.ts; the
// schema-parity test pins TaskRow field names against the `tasks` columns.
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

export interface TaskRow {
  id: string;
  project_id: number;
  type: 'idea' | 'epic' | 'task';
  ref: string;
  parent_epic_id: string | null;
  board_id: string;
  stage_id: string;
  entry_stage_id: string | null;
  title: string;
  summary: string | null;
  priority: 'P0' | 'P1' | 'P2';
  repo: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRefCounterRow {
  project_id: number;
  type: string;
  next_seq: number;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  seq: number;
  kind: string;
  actor: string; // 'user' | 'orchestrator' | 'agent:<role>' | 'linear'
  run_id: string | null;
  changes_json: string | null;
  created_at: string;
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

export interface TaskExternalLinkRow {
  id: number;
  task_id: string;
  provider: string;
  external_id: string | null;
  external_url: string | null;
  synced_cursor: string | null;
  baseline_json: string | null;
}
