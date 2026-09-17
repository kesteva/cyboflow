import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { AgentProvider, SessionAgentRuntime } from '../../../shared/types/agentRuntime';

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
  /** Detected default branch, persisted at create time (runtime re-detects live). */
  main_branch?: string | null;
  display_order?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  /**
   * Per-project trust for repo-supplied permission ALLOW rules (migration 127).
   * NULL = undecided (the trust prompt in projects:activate / projects:create
   * has not been answered yet); 'trusted' | 'untrusted' are terminal — see
   * main/src/orchestrator/permissionRules.ts's trust-model doc comment.
   */
  permission_trust?: 'trusted' | 'untrusted' | null;
  /**
   * How finished the software this project builds has to be (migration 135).
   * NULL = never established (no Launch run has cleared its approve-brief gate
   * for this project, or its brief carried no `THOROUGHNESS:` flag). Stamped by
   * the Launch approve-brief gate side effect; read back by the step-prompt
   * budget renderer and the session wizard's tuning-level default
   * (prototype→efficient, v1→standard, production→thorough). See
   * shared/types/thoroughness.ts.
   */
  solution_thoroughness?: 'prototype' | 'v1' | 'production' | null;
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
  /**
   * When the session last came to REST (migration 119), space-separated UTC as
   * written by datetime('now') — DISTINCT from `updated_at`, which any write to
   * the row bumps and so cannot serve as an activity clock. Written only inside
   * updateSession's status transition (see IDLE_SINCE_ON_STATUS_CHANGE in
   * database.ts) and by the boot sweep. NULL means the session is busy
   * (`running`/`pending`) or predates the column; readers COALESCE to
   * `updated_at`, which is the pre-migration behavior.
   */
  idle_since?: string | null;
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
  tool_type?: 'claude' | 'none';
  base_commit?: string;
  base_branch?: string;
  skip_continue_next?: boolean;
  run_id?: string | null;
  /**
   * Persistent chat-sentinel gate vehicle (migration 038), DISTINCT from run_id.
   * run_id keeps pointing at the latest FLOW run (Role-D: display/diff/close-out);
   * chat_run_id holds a never-clobbered `__quick__` sentinel that chat turns gate
   * on (Role-G). NULL for flow-only/legacy sessions until a sentinel is minted
   * ON READ at the gate-resolution chokepoint (chatSentinelProvider) on the next
   * chat turn.
   */
  chat_run_id?: string | null;
  /** Set to true for sessions created outside any workflow flow (TASK-787 / IDEA-027). */
  is_quick?: boolean;
  /**
   * In-place session (migration 047): worktree_path IS the project checkout —
   * no dedicated git worktree exists. DISTINCT from is_main_repo (the hidden
   * singleton dashboard session): in_place sessions are ordinary, list-visible
   * quick sessions. Worktree-mutating paths (sessions:delete cleanup, project
   * sweep) must skip these rows, and RunLauncher refuses to host workflow runs
   * in them.
   */
  in_place?: boolean;
  /**
   * Which CLI substrate the session's claude panel runs on ('sdk'|'interactive').
   * Written by sessions:create-quick (migration 027); NULL → sdk (legacy).
   */
  substrate?: CliSubstrate;
  /**
   * Provider/runtime backing the session's default chat agent (migrations 059-061).
   * Existing `substrate` stays as a Claude compatibility projection while callers
   * move to provider/runtime.
   */
  agent_provider?: AgentProvider;
  agent_runtime?: SessionAgentRuntime;
  /** Provider-scoped session default model. NULL → selected runtime default. */
  agent_model?: string | null;
  /**
   * Agent effort the session was launched with ('ultracode' | undefined).
   * Written by sessions:create-quick (migration 029); NULL → no effort.
   */
  effort?: 'ultracode';
  /**
   * Per-session MCP DENY list (migration 037) — JSON string[] of MCP server
   * NAMES disabled for this session. '[]'/NULL → nothing disabled (all servers
   * load). Read at SDK spawn by resolveSessionDisabledMcps; the 'cyboflow' entry
   * is never removable. Next-turn apply.
   */
  disabled_mcp_servers_json?: string;
  /**
   * Per-session plugin ALLOW list (migration 037) — JSON string[] of plugin ids
   * force-enabled for this session. '[]'/NULL → inherit file settings (no
   * enabledPlugins key emitted). Read at SDK spawn by resolveSessionEnabledPlugins.
   * Next-turn apply.
   */
  enabled_plugins_json?: string;
  /**
   * Design-session idea link (migration 082) — nullable pointer to ideas.id.
   * NO FK: integrity (project ownership, liveness, not-decomposed) is
   * enforced at the design-scoped MCP write chokepoints, not the database,
   * per design-mode.md "Idea link — integrity contract". NULL for every
   * non-design session and for a design session whose link has been broken.
   */
  design_idea_id?: string | null;
  /** Idea this session is the persistent home for (migration 113; idea sessions feature). NO FK. */
  home_idea_id?: string | null;
  /** Idea whose launch minted this session (migration 114; sidebar nesting lineage). NO FK. */
  origin_idea_id?: string | null;
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
  /**
   * The source transcript entry's own `uuid` (migration 084), set only for rows
   * ingested from a PTY session's Claude-CLI JSONL transcript
   * (main/src/services/ptyTranscriptIngest.ts). NULL for SDK-written rows. The
   * dedupe key behind idempotent re-ingestion (partial unique index on
   * (session_id, source_uuid)).
   */
  source_uuid?: string | null;
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
  /** In-place session (migration 047) — see Session.in_place. */
  in_place?: boolean;
  agent_provider?: AgentProvider;
  agent_runtime?: SessionAgentRuntime;
  agent_model?: string | null;
  display_order?: number;
  tool_type?: 'claude' | 'none';
  base_commit?: string;
  base_branch?: string;
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
  // null clears the column — used to invalidate a now-stale interactive resume id
  // when a fork-resume spawn's transcript never bound (avoids a silent rewind).
  claude_session_id?: string | null;
  run_started_at?: string;
  is_favorite?: boolean;
  agent_permission_mode?: PermissionMode;
  agent_provider?: AgentProvider;
  agent_runtime?: SessionAgentRuntime;
  agent_model?: string | null;
  disabled_mcp_servers_json?: string; // JSON string[] of disabled MCP server names (migration 037)
  enabled_plugins_json?: string; // JSON string[] of force-enabled plugin ids (migration 037)
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
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'; // migration 117 widen
  category: 'feature' | 'bug' | 'chore'; // 059 ALTER appends
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
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'; // migration 117 widen
  category: 'feature' | 'bug' | 'chore'; // 059 ALTER appends
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
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'; // migration 117 widen
  category: 'feature' | 'bug' | 'chore'; // 059 ALTER appends
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
  kind: 'finding' | 'permission' | 'decision' | 'human_task' | 'notification';
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

/**
 * `tracker_connections` row (migration 093) — one row per Linear/Plane
 * connection. Secrets are NOT modeled as plaintext: `secret_ciphertext` is an
 * Electron `safeStorage`-encrypted blob, decrypted only in the main process
 * (docs/proposals/tracker-sync-integration.md "Auth & secrets"). SQLite
 * BOOLEANs surface as 0|1 (`mirror_subissues`), matching the
 * `blocking`/`selected` convention on ReviewItemRow above. `source_json` /
 * `selection_json` / `state_mapping_json` / `last_sync_log_json` are
 * sync-engine-owned opaque JSON blobs, not modeled column-by-column here.
 *
 * The three `*_mode` columns (migration 094) are the per-direction cadences
 * that REPLACED 093's single `two_way` flag — see TrackerDirectionMode in
 * shared/types/trackerSync.ts. `two_way` itself survives as a dead column (094
 * backfills the modes from it and nothing reads it again), so it is
 * deliberately absent from this shape: a row type is what the code may read.
 */
export interface TrackerConnectionRow {
  id: string;
  project_id: number;
  provider: 'linear' | 'plane' | 'dart' | 'beads';
  status: 'active' | 'paused' | 'disconnected';
  workspace_id: string | null;
  workspace_name: string | null;
  actor_label: string | null;
  base_url: string | null;
  secret_ciphertext: Buffer | null;
  source_json: string | null;
  selection_mode: 'all' | 'assignee' | 'manual';
  selection_json: string | null;
  state_mapping_json: string;
  /**
   * CADENCE of the status flow for LINKED items, BOTH directions (stage
   * write-back + remote state apply). Two-state; the direction's OFF switch is
   * the separate `status_sync_enabled` below.
   */
  status_sync_mode: 'auto' | 'manual';
  /**
   * 0 | 1 (migration 130) — does the status direction run AT ALL? Off means
   * neither half of it does, and the write-back declines its intents at the
   * ENQUEUE (invariant 5), exactly like content/archive 'off'.
   *
   * A SECOND COLUMN rather than a third value on `status_sync_mode` because
   * 105 and 129 both recreate this table with that column CHECKed to
   * ('auto','manual') and both run before 130 — a stored 'off' fails 105 on a
   * ledger-wiped replay and blocks boot. See the migration header. It also
   * mirrors push (`push_mode` cadence + `push_target` consent) and means
   * toggling status sync off and back on RESTORES the auto/manual choice.
   *
   * Nothing above the store reads the pair: `effectiveStatusSyncMode()` folds
   * them into the one three-state `TrackerStatusSyncMode` value.
   */
  status_sync_enabled: number; // 0 | 1
  /** Importing NEW remote issues as ideas. */
  pull_mode: 'auto' | 'manual';
  /** Creating a TOP-LEVEL tracker issue for a NEW cyboflow idea. */
  push_mode: 'auto' | 'manual';
  /**
   * 0 | 1 (migration 110) — may THIS mapping row create new tracker issues?
   * Several sibling rows can map different tracker groups onto one cyboflow
   * project; exactly one per provider carries a 1, or a locally filed idea
   * would enqueue a create per sibling and duplicate remotely.
   */
  push_target: number; // 0 | 1
  /**
   * Field write-back ("Sync task fields": title/description/priority/category)
   * for LINKED items, OUTBOUND only (migration 118). A SEPARATE three-state
   * schema from pull_mode/push_mode above, which stay two-state because
   * neither writes to the tracker on its own — see TrackerContentSyncMode in
   * shared/types/trackerSync.ts.
   * Defaults 'off': an existing connection never consented to write-back.
   */
  content_sync_mode: 'auto' | 'manual' | 'off';
  /** Remote trash/archive on a local archive/delete (migration 118). Same three-state shape as content_sync_mode, same default reasoning. */
  archive_sync_mode: 'auto' | 'manual' | 'off';
  /**
   * The persisted OVERLAY half of priorityMapping.ts's seed-then-overlay
   * contract (migration 118) — `{}` until the wizard's mapping table (Phase 6)
   * writes one. See PriorityMappingOverlay / resolveEffectivePriorityMapping.
   */
  priority_mapping_json: string;
  /** categoryMapping.ts's overlay, same shape and default as priority_mapping_json. */
  category_mapping_json: string;
  /**
   * Counter (migration 129), bumped on any mapping/state-mapping/selection
   * change. Consumed by `tracker_reconciliation_ledger`: a ledger row stamped
   * at an older generation is treated as absent, so a config change
   * re-evaluates every previously-skipped remote id exactly once. Read by
   * providers declaring `requiresIdReconciliation` (beads today); the three
   * HTTP providers bump and ignore it.
   */
  config_generation: number;
  mirror_subissues: number; // 0 | 1
  conflict_mode: 'auto' | 'manual';
  cursor_updated_at: string | null;
  cursor_external_id: string | null;
  last_sync_at: string | null;
  last_sync_log_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `entity_external_links` row (migration 093) — generalizes the dormant
 * task-only `task_external_links` (migrations 014/015, dropped by 093) to
 * link BOTH ideas and tasks to a tracker issue. Two independent UNIQUE
 * constraints: an entity maps to at most one issue per provider
 * (entity_type, entity_id, provider), and an external issue maps to at most
 * one entity per connection (connection_id, external_id). `baseline_json` is
 * the last-synced field snapshot the conflict engine three-way-merges
 * against (tracker-sync-integration.md "Conflict resolution").
 * `orphaned_at` is set when the linked entity was archived by a remote
 * deletion (Auto conflict mode) — the link itself is kept for history.
 */
export interface EntityExternalLinkRow {
  id: number;
  connection_id: string;
  entity_type: 'idea' | 'epic' | 'task';
  entity_id: string;
  provider: 'linear' | 'plane' | 'dart' | 'beads';
  external_id: string;
  external_identifier: string | null;
  external_url: string | null;
  external_parent_id: string | null;
  baseline_json: string | null;
  orphaned_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `tracker_outbox` row (migration 093) — the durable pre-write record for
 * every remote write, written BEFORE the API call is attempted
 * (tracker-sync-integration.md "Durability & failure semantics" #1). The
 * inbound cursor cannot advance past an item with an unresolved outbox
 * entry, so a half-created sub-issue can never be double-created or
 * re-imported. `client_key` is the client-generated idempotency key: Linear's
 * `issueCreate` accepts it directly; Plane has no such key, so an ambiguous
 * create is reconciled by listing the parent's sub-issues and matching
 * against this record instead.
 *
 * `create_issue` (migration 094) is the PUSH kind: a TOP-LEVEL issue minted in
 * the connection's source container for a locally-created idea, as opposed to
 * `create_sub_issue`'s mirrored child of an existing issue.
 *
 * `update_content` / `archive_issue` (migration 118) are the field write-back
 * and archive/trash kinds (docs/proposals/tracker-field-writeback.md Phase 5
 * drains them; Phase 3 only widens the CHECK and the row type — a claimed row
 * of either kind terminally fails with a "no handler until Phase 5" error
 * rather than falling through to the state-write dispatch, per that plan's
 * invariant 8).
 */
export interface TrackerOutboxRow {
  id: number;
  connection_id: string;
  kind:
    | 'create_sub_issue'
    | 'create_issue'
    | 'update_state'
    | 'close_parent'
    | 'update_content'
    | 'archive_issue';
  entity_type: string | null;
  entity_id: string | null;
  external_id: string | null;
  client_key: string | null;
  payload_json: string;
  state: 'pending' | 'in_flight' | 'done' | 'failed' | 'ambiguous';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `tracker_conflicts` row (migration 093) — Manual-mode conflict queue rows
 * plus Auto-mode remote-deletion records (tracker-sync-integration.md
 * "Conflict resolution"). `link_id` is a NULLABLE FK ON DELETE SET NULL (not
 * CASCADE): a conflict row survives its link being removed so the history
 * stays inspectable.
 */
export interface TrackerConflictRow {
  id: number;
  connection_id: string;
  link_id: number | null;
  kind: 'field_conflict' | 'remote_deleted';
  field: string | null;
  local_value: string | null;
  remote_value: string | null;
  payload_json: string | null;
  state: 'open' | 'resolved';
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * `tracker_reconciliation_ledger` row (migration 123) — the durable record of
 * a reconciliation sweep's SKIPPED decisions, one row per (connection, remote
 * id). Written only by providers declaring
 * `TrackerAdapterCapabilities.requiresIdReconciliation` (beads today).
 *
 * WHY IT EXISTS: the sweep's ground truth is the FULL remote id set, so every
 * id it does not already link would be point-fetched on every sweep — hundreds
 * of CLI spawns per pass on a workspace dominated by closed or unmapped issues.
 * A ledger row says "this id was considered and resolved without a link", so a
 * repeat sweep can skip it for free. An IMPORTED id gets no row: its link IS
 * the record.
 *
 * `last_seen_revision` is the adapter-derived content fingerprint the sweep
 * already carries per id, so "did this skipped issue change?" costs a string
 * compare rather than a lookup — without it a backdated remote edit that makes
 * a skipped issue eligible would be suppressed forever.
 * `config_generation` is `tracker_connections.config_generation` AS OF this
 * row's write; a row behind the connection's current generation is treated as
 * absent, which is what makes a mapping change re-consider every skipped id
 * exactly once.
 */
export interface TrackerReconciliationLedgerRow {
  id: number;
  connection_id: string;
  external_id: string;
  /** Why the id resolved without a link — see ReconciliationSkipReason in inboundSync.ts. */
  reason: string;
  last_seen_revision: string | null;
  config_generation: number;
  seen_at: string;
}

/**
 * `run_usage` row (migration 026) — the durable per-run token/cost rollup, one
 * row per run (run_id PRIMARY KEY, hard-FK -> workflow_runs ON DELETE CASCADE).
 * Persisted token/cost subset of shared/types/insights.ts RunUsageRollup:
 * insightsQueries computes the rollup from raw_events and the Phase-2 writer
 * upserts it here.
 * `total_tokens` is input + output. `cost_usd` / `num_turns` are nullable (NULL
 * when no terminal result payload carried them — SDK-only). Model identity is
 * intentionally NOT persisted here; selectRunUsageRollups resolves model(s)
 * from assistant-side raw_events at read time.
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
 * `run_evals` row (migration 043) — one durable LLM-judge evaluation rollup per
 * (workflow_run, rubric_version). The EvalWorker snapshots the frozen diff + run
 * provenance AT TRIGGER (the sprint/ship "human-review begins" step transition),
 * then writes the K-sample verdict back onto the same row. Composite PRIMARY KEY
 * (run_id, rubric_version) + INSERT OR IGNORE gives re-fire dedup; hard-FK
 * run_id -> workflow_runs ON DELETE CASCADE (the rollup dies with its run). All
 * verdict columns stay NULL until eval_status = 'complete'.
 */
export interface RunEvalRow {
  run_id: string;
  rubric_version: string;
  eval_status: 'pending' | 'running' | 'complete' | 'failed';
  base_sha: string | null;
  diff_text: string | null;
  diff_stats_json: string | null;
  gate_results_json: string | null;
  human_influenced: number; // 0 at first trigger; 1 if human-review re-fires
  snapshot_at: string; // ISO timestamp of the trigger capture
  overall_score: number | null; // 0-100; NULL until complete
  band: string | null; // Excellent / Good / Fair / Poor
  ci_low: number | null;
  ci_high: number | null;
  gated: number; // deterministic-gate-failure sentinel
  security_flag: number; // confirmed high/critical security soft-cap fired
  requirements_unmet: number; // SCP-1 unimplemented-AC cap fired
  cap_triggers_json: string | null; // catastrophic-cap trigger tokens JSON; NULL when none
  dimensions_json: string | null;
  per_sample_json: string | null;
  jury_json: string | null; // per-slot heterogeneous-jury provenance; NULL on legacy rows
  judge_model: string | null; // concrete id, e.g. 'claude-opus-4-8'
  sample_count: number | null; // K actually completed
  prompt_hash: string | null; // sha256 of judge prompt (computeSpecHash precedent)
  judge_build_id: string | null; // app version string from package.json
  workflow_id: string;
  workflow_name: string; // denormalized at trigger
  spec_hash: string | null;
  run_model: string | null; // NULL/'auto' = SDK default
  subagent_models_json: string | null;
  difficulty_proxy_prerun: number | null; // reserved; NULL in v1
  error: string | null;
  created_at: string;
  updated_at: string;
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
 * `workflow_variants` row (migration 048) — a named A/B variant of a workflow
 * that snapshots a frozen resolved spec_json + optional per-agent deltas + model
 * / execution-model defaults. The canonical shape lives in
 * `shared/types/experiments.ts` (cross-slice contract); re-exported here so DB-row
 * consumers can import it alongside the other `*Row` interfaces. The four sibling
 * `workflow_runs` tagging cells (experiment_id / experiment_arm / variant_id /
 * variant_label) also land in migration 048 and are declared on `WorkflowRunRow`
 * (shared/types/workflows.ts).
 */
export type { WorkflowVariantRow } from '../../../shared/types/experiments';

/**
 * `experiments` row (migration 049) — a side-by-side head-to-head umbrella that
 * owns `base_branch`/`base_sha` (pinned once) and links its two arm runs +
 * sessions + per-arm hidden seed-idea clones back via soft columns. The canonical
 * shape lives in `shared/types/experiments.ts` (cross-slice contract); re-exported
 * here so DB-row consumers can import it alongside the other `*Row` interfaces.
 * The sibling entity columns (ideas/epics/tasks `experiment_id` + `caused_by_run_id`)
 * and `workflow_runs.merge_sha` also land in migration 049.
 */
export type { ExperimentRow } from '../../../shared/types/experiments';

/**
 * `experiment_rotation_arms` row (migration 058) — one arm-set snapshot row per arm
 * of a ROTATION experiment (the live baseline + active variants), captured at open.
 * `label`/`weight_at_open` are denormalized so the snapshot survives a later variant
 * delete/re-weight. The canonical shape lives in `shared/types/experiments.ts`
 * (cross-slice contract); re-exported here so DB-row consumers can import it
 * alongside the other `*Row` interfaces.
 */
export type { ExperimentRotationArmRow } from '../../../shared/types/experiments';

/**
 * `experiment_comparisons` row (migration 050) — one self-contained pairwise
 * A/B verdict per side-by-side experiment (v1: 2 arms => 1 comparison). Freezes
 * both arms' diffs + seed context on the row so the pairwise judge survives
 * worktree teardown and does not depend on per-arm run_evals rows. The canonical
 * shape lives in `shared/types/experiments.ts` (cross-slice contract); re-exported
 * here so DB-row consumers can import it alongside the other `*Row` interfaces.
 * `decision_review_item_id` is written by slice C's pairwise worker and resolved
 * by slice B's experiments.decide.
 */
export type { ExperimentComparisonRow } from '../../../shared/types/experiments';

/**
 * `agent_overrides` row (migration 029) — a per-project override of a built-in
 * agent (`base_agent_key === agent_key`, `is_custom 0`) OR a brand-new custom
 * agent (`base_agent_key NULL`, `is_custom 1`). One row per (project_id,
 * agent_key). `name` is always the frontmatter name `cyboflow-<agent_key>` and is
 * never user-editable. `tools_json` is a JSON-encoded `CliTool[]`. There is NO
 * `enabled` column. `model` (migration 036, nullable) pins the agent's model to
 * an `AGENT_MODEL_ALIASES` value; NULL means inherit the run's model. `runtime`
 * (migration 070, nullable) pins the CLI runtime to a `WORKFLOW_AGENT_RUNTIMES`
 * value; NULL means inherit the run-level provider/runtime. `codex_model`
 * (migration 070, nullable) is the free-form Codex model id used only when
 * `runtime === 'codex-sdk'`; NULL means the Codex runtime default.
 * `provider_model` (migration 104, nullable) generalizes `codex_model` to any
 * resolved non-Claude provider; `codex_model` stays as a read-compat column —
 * code writes BOTH on every save, and reads COALESCE(provider_model,
 * codex_model) (an explicit `provider_model` wins).
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
  enabled_mcps_json: string; // JSON-encoded string[] of MCP server names (migration 036); '[]' = none
  is_custom: number; // 0 | 1
  version: number;
  model: string | null; // migration 036: AGENT_MODEL_ALIASES value, or NULL = inherit run model
  runtime: string | null; // migration 070: WORKFLOW_AGENT_RUNTIMES value, or NULL = inherit run runtime
  codex_model: string | null; // migration 070: free-form Codex model id (runtime='codex-sdk'), or NULL = Codex default
  provider_model: string | null; // migration 104: free-form model id for the resolved non-Claude provider, or NULL = default
  created_at: string;
  updated_at: string;
}

/**
 * `design_spec_drafts` row (migration 082) — the durable, versioned
 * design-spec markdown a design session maintains across chat turns
 * (design-mode.md "Design-spec draft — the authoritative Approve input").
 * UNIQUE(session_id, draft_revision) makes draft_revision a per-session
 * monotonic counter. bound_artifact_id/bound_artifact_revision are NULL
 * until a prototype exists to describe; once set, Approve's CAS check
 * compares bound_artifact_revision against the artifact's CURRENT
 * `artifacts.revision` (migration 082) to reject a stale draft.
 */
export interface DesignSpecDraftRow {
  id: string;
  session_id: string;
  idea_id: string;
  draft_revision: number;
  spec_markdown: string;
  bound_artifact_id: string | null;
  bound_artifact_revision: number | null;
  created_at: string;
}

/**
 * State column of `design_handoffs` (migration 082) — the Approve
 * intent-first recoverable state machine's CHECK-constrained values, in
 * forward-path order: intent -> snapshotted -> folded -> complete, with
 * superseded/failed as the off-happy-path terminals (design-mode.md
 * "Approve — intent-first recoverable state machine").
 */
export type DesignHandoffState = 'intent' | 'snapshotted' | 'folded' | 'complete' | 'superseded' | 'failed';

/**
 * `design_handoffs` row (migration 082) — the durable record of one Approve
 * invocation, persisted at state='intent' BEFORE any side effect so recovery
 * (boot, or re-invocation with the same idempotency key) always has a row to
 * resume from. expected_idea_version is the CAS material for the idea-body
 * fold step; a stale value flips state to 'superseded' rather than retrying
 * past a concurrent edit. snapshot_path is filled once step 1 (prototype
 * snapshot) lands. NO FK out to sessions/ideas/artifacts (see migration
 * 082's file-header comment) — this row must survive their deletion.
 */
export interface DesignHandoffRow {
  id: string;
  session_id: string;
  idea_id: string;
  project_id: number;
  draft_revision: number;
  prototype_artifact_id: string;
  prototype_revision: number;
  expected_idea_version: number;
  state: DesignHandoffState;
  error: string | null;
  snapshot_path: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `approved_designs` row (migration 082) — the "current approved design for
 * an idea" read model: current == WHERE idea_id=? AND superseded_at IS NULL.
 * A re-approve supersedes the prior row (stamps superseded_at) in the same
 * transaction as the new row's insert (write logic lands in a later lane).
 * NO FK out to sessions/handoffs/artifacts — snapshot_path holds the durable
 * bytes on disk, so this row stays resolvable even after the run/artifact
 * rows that produced it are gone (migration 082's file-header comment).
 */
export interface ApprovedDesignRow {
  id: string;
  idea_id: string;
  project_id: number;
  /**
   * The `design_handoffs` row this approval came from — NULL for a
   * `source='flow'` row (migration 134): a Launch/Planner/Ship gate approval has
   * no draft, no CAS target, and therefore no handoff.
   */
  handoff_id: string | null;
  /** The Design Mode session — NULL for a `source='flow'` row (migration 134). */
  session_id: string | null;
  draft_revision: number;
  prototype_artifact_id: string;
  prototype_revision: number;
  snapshot_path: string;
  approved_at: string;
  superseded_at: string | null;
  /**
   * Which pathway approved this design (migration 134). 'design-mode' is the
   * Approve state machine; 'flow' is a Launch/Planner/Ship run whose
   * approve-design / approve-ideas gate cleared. A 'design-mode' row always
   * outranks a flow prototype — the flow binder skips an idea whose current row
   * is design-mode rather than superseding it.
   */
  source: 'design-mode' | 'flow';
  /** The workflow run that bound a `source='flow'` row; NULL for design-mode. */
  source_run_id: string | null;
}

/**
 * `idea_components` row (migration 101) — one row per (idea, component) pair
 * tracking the idea component ledger's HYBRID truth model: when present, this
 * row is authoritative; a (idea, component) pair with NO row falls back to
 * derivation from the DB (body headings, approved_designs, child entities),
 * which can only ever yield 'complete'|'incomplete' — never 'skipped', since
 * that state is unfalsifiable from absence and only ever set explicitly (see
 * migration 101's header comment). `source` therefore only ever persists
 * 'flow'|'manual' here; 'derived' is a read-time-only marker for a component
 * with no row (shared/types/ideaComponents.ts `IdeaComponentSource`).
 * `stale_at` carries "reset means re-verify, NOT discard": non-NULL means
 * prior work exists but needs re-verification against the idea's current
 * `built_against_version`, rather than a fourth state.
 */
export interface IdeaComponentRow {
  idea_id: string;
  project_id: number;
  component: 'idea-spec' | 'prototype' | 'architecture' | 'epics' | 'stories';
  state: 'complete' | 'incomplete' | 'skipped';
  source: 'flow' | 'manual';
  source_run_id: string | null;
  source_session_id: string | null;
  built_against_version: number | null;
  stale_at: string | null;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `session_summaries` row (migration 083) — one row per session, upserted in
 * place by the idle-gated quick-session summarizer
 * (docs/proposals/session-summary-plan.md §4). `summary` is the current
 * 1-2 sentence rolling summary. `last_turn_id` is the content watermark —
 * the highest `conversation_messages.id` already folded into the summary
 * (§2.4); 0 means never summarized. `calls_count` / `cost_usd_total`
 * accumulate across every summarizer call for the session (§3). Deleting the
 * owning session cascades this row.
 */
export interface SessionSummary {
  session_id: string;
  summary: string;
  last_turn_id: number;
  calls_count: number;
  cost_usd_total: number;
  updated_at: string;
  /**
   * Review-home board triage verdict (migration 121). Normalized at the read
   * boundary in database.ts — only 'working' | 'complete' | 'needs_input'
   * survive; any other value (including a not-yet-summarized row, or a
   * future/bogus value written some other way) reads as null.
   */
  state: string | null;
  /**
   * One-sentence "what it asked you", shown on the board for a 'needs_input'
   * row (migration 121). Normalized at the read boundary: trimmed, blank
   * becomes null, and anything over 300 chars is truncated to it.
   */
  waiting_on: string | null;
}

/**
 * `session_summary_entries` row (migration 083) — one append-only "past
 * sitting" history sentence per row, oldest first via `id ASC`. Deleting the
 * owning session cascades these rows.
 */
export interface SessionSummaryEntry {
  id: number;
  session_id: string;
  entry: string;
  created_at: string;
}
