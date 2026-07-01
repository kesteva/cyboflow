import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';

export interface Session {
  id: string;
  name: string;
  worktreePath: string;
  prompt: string;
  status: 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error';
  statusMessage?: string;
  pid?: number;
  createdAt: Date;
  lastActivity?: Date;
  output: string[];
  jsonMessages: unknown[];
  error?: string;
  isRunning?: boolean;
  lastViewedAt?: string;
  permissionMode?: 'approve' | 'ignore';
  runStartedAt?: string;
  isMainRepo?: boolean;
  displayOrder?: number;
  projectId?: number;
  folderId?: string;
  isFavorite?: boolean;
  autoCommit?: boolean;
  model?: string;
  toolType?: 'claude' | 'none';
  archived?: boolean;
  gitStatus?: GitStatus;
  baseCommit?: string;
  baseBranch?: string;
  commitMode?: 'structured' | 'checkpoint' | 'disabled';
  commitModeSettings?: string; // JSON string of CommitModeSettings
  runId?: string | null;
  /**
   * Persistent chat-sentinel gate vehicle (sessions.chat_run_id, migration 038),
   * DISTINCT from runId. runId is the latest FLOW run (Role-D: display/diff/
   * close-out); chatRunId is the never-clobbered `__quick__` sentinel chat turns
   * gate on (Role-G — approval subscription + the interactive REPL run id).
   * undefined/NULL until minted on the next chat turn. Mirror of
   * frontend/src/types/session.ts Session.
   */
  chatRunId?: string | null;
  /**
   * Which CLI substrate the session's claude panel runs on ('sdk'|'interactive').
   * Stamped by sessions:create-quick (sessions.substrate, migration 027);
   * undefined/NULL → sdk (legacy).
   */
  substrate?: CliSubstrate;
  /**
   * Agent effort the session was launched with ('ultracode' | undefined).
   * Stamped by sessions:create-quick (sessions.effort, migration 029) and
   * surfaced READ-ONLY in the unified chat composer. undefined/NULL → no effort
   * (default). Mirror of frontend/src/types/session.ts Session.
   */
  effort?: 'ultracode';
  /**
   * The per-session agent permission mode (4-mode: default|acceptEdits|auto|
   * dontAsk). Persisted to sessions.agent_permission_mode (migration 021), seeded
   * at create-quick and editable mid-session from the composer permission pill;
   * resolveSessionAgentPermissionMode re-reads it on each SDK spawn so a change
   * takes effect on the next turn. Mirror of frontend/src/types/session.ts.
   */
  agentPermissionMode?: PermissionMode;
  /**
   * Per-session MCP DENY list (migration 039) — parsed from
   * sessions.disabled_mcp_servers_json: the MCP server NAMES disabled for this
   * session. Enforced on BOTH substrates, each re-reading the column at spawn
   * (next-turn apply): SDK spawn (composeMcpServers delete + strictMcpConfig +
   * disallowedTools) and INTERACTIVE spawn (--disallowed-tools mcp__<srv> +
   * disabledMcpjsonServers). undefined/[] → nothing disabled (all servers load).
   * Mirror of frontend/src/types/session.ts Session.
   */
  disabledMcpServers?: string[];
  /**
   * Per-session plugin ALLOW list (migration 039) — parsed from
   * sessions.enabled_plugins_json: the plugin ids force-enabled for this session.
   * Read at spawn on BOTH substrates (SDK resolveSessionEnabledPlugins → inline
   * settings.enabledPlugins; interactive → enabledPlugins via `--settings`).
   * undefined/[] → inherit the user's file settings. Mirror of
   * frontend/src/types/session.ts Session.
   */
  enabledPlugins?: string[];
}

export interface GitStatus {
  state: 'clean' | 'modified' | 'untracked' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'unknown';
  ahead?: number;
  behind?: number;
  additions?: number; // Uncommitted additions
  deletions?: number; // Uncommitted deletions
  filesChanged?: number; // Uncommitted files changed
  lastChecked?: string;
  // Enhanced status information
  isReadyToMerge?: boolean; // True when ahead of base branch with no uncommitted changes and not diverged (not behind)
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  // Allow tracking multiple states for better clarity
  secondaryStates?: Array<'modified' | 'untracked' | 'ahead' | 'behind'>;
  // Commit statistics (for all commits ahead of main)
  commitAdditions?: number;
  commitDeletions?: number;
  commitFilesChanged?: number;
  // Total commits in branch (not just ahead of main)
  totalCommits?: number;
}

// NOTE: keep this interface in sync with frontend/src/types/session.ts CreateSessionRequest
// until shared/types/ipc.ts consolidates IPC request shapes. See FIND-SPRINT-037-5.
export interface CreateSessionRequest {
  prompt: string;
  worktreeTemplate?: string;
  count?: number;
  permissionMode?: 'approve' | 'ignore';
  /**
   * Per-session 4-mode agent-permission override (Session Start Wizard step 3 /
   * quick-session config). DISTINCT from the legacy `permissionMode` above. When
   * omitted the session inherits the global default. Persisted to
   * sessions.agent_permission_mode by the create-quick handler. KEEP IN SYNC with
   * the frontend twin in frontend/src/types/session.ts (request-parity rule).
   */
  agentPermissionMode?: PermissionMode;
  /**
   * Opt-in CLI substrate for the quick session ('sdk'|'interactive'). When
   * omitted the session runs on the SDK substrate (legacy behavior). Persisted
   * to sessions.substrate by the create-quick handler (migration 027). KEEP IN
   * SYNC with the frontend twin in frontend/src/types/session.ts
   * (request-parity rule, FIND-SPRINT-037-5).
   */
  substrate?: CliSubstrate;
  /**
   * Opt-in agent effort level for the quick session. The only value today is
   * 'ultracode' (the "Ultracode" wizard card), which launches the interactive
   * PTY REPL with the ultracode setting so Claude Code fans work out as dynamic
   * background workflows. Omitted → no effort flag (default). KEEP IN SYNC with
   * the frontend twin in frontend/src/types/session.ts (request-parity rule).
   */
  effort?: 'ultracode';
  /**
   * Per-session MCP DENY list chosen at session start (the launch wizard's
   * Advanced section). Server names the session must NOT load; persisted to
   * sessions.disabled_mcp_servers_json by create-quick and enforced on BOTH
   * substrates: SDK spawn (composeMcpServers delete + strictMcpConfig +
   * disallowedTools) and INTERACTIVE spawn (--disallowed-tools mcp__<srv> +
   * disabledMcpjsonServers). Omitted/empty → inherit all configured servers. KEEP
   * IN SYNC with the frontend twin in frontend/src/types/session.ts
   * (request-parity rule).
   */
  disabledMcpServers?: string[];
  /**
   * Per-session plugin ALLOW list chosen at session start (Advanced section).
   * Persisted to sessions.enabled_plugins_json by create-quick and force-enabled
   * on BOTH substrates (SDK inline settings.enabledPlugins; interactive
   * enabledPlugins via `--settings`). Omitted/empty → inherit the user's file
   * plugins. KEEP IN SYNC with the frontend twin in frontend/src/types/session.ts
   * (request-parity rule).
   */
  enabledPlugins?: string[];
  projectId?: number;
  folderId?: string;
  baseBranch?: string;
  autoCommit?: boolean;
  toolType?: 'claude' | 'none';
  commitMode?: 'structured' | 'checkpoint' | 'disabled';
  commitModeSettings?: string; // JSON string of CommitModeSettings
  claudeConfig?: {
    model?: string;
    permissionMode?: 'approve' | 'ignore';
    ultrathink?: boolean;
    /** Per-launch opt-in for Anthropic fast mode (premium, Opus-only). Default off. */
    fastMode?: boolean;
  };
  branchName?: string;
}

export interface SessionUpdate {
  status?: Session['status'];
  statusMessage?: string;
  lastActivity?: Date;
  error?: string;
  run_started_at?: string | null;
  model?: string;
  gitStatus?: GitStatus;
  skip_continue_next?: boolean;
}

import type { TextBlock, ToolUseBlock, ToolResultBlock } from '../../../shared/types/claudeStream';

// Claude message content types
/** @deprecated import { TextBlock } from 'shared/types/claudeStream' directly. */
export type TextContent = TextBlock;

/** @deprecated import { ToolUseBlock } from 'shared/types/claudeStream' directly. */
export type ToolUseContent = ToolUseBlock;

/** @deprecated import { ToolResultBlock } from 'shared/types/claudeStream' directly. */
export type ToolResultContent = ToolResultBlock;

export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

// Tool definition interface
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

// MCP server definition interface  
export interface McpServerDefinition {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

// JSON message structure from Claude
export interface ClaudeJsonMessage {
  id?: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'result' | 'thinking' | 'session';
  role?: 'user' | 'assistant' | 'system';
  content?: string | MessageContent[];
  message?: { 
    content?: string | MessageContent[];
    [key: string]: unknown;
  };
  timestamp: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  session_id?: string;
  text?: string;
  subtype?: string;
  cwd?: string;
  model?: string;
  tools?: ToolDefinition[];
  mcp_servers?: McpServerDefinition[];
  permissionMode?: string;
  summary?: string;
  error?: string;
  details?: string;
  raw_output?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  cost_usd?: number;
  thinking?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionOutput {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: unknown; // Can be string for stdout/stderr, or JSON object for json/error types
  timestamp: Date;
  panelId?: string;
}
