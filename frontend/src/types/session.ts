import type { TextBlock, ToolUseBlock, ToolResultBlock } from '../../../shared/types/claudeStream';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { AgentProvider, SessionAgentRuntime } from '../../../shared/types/agentRuntime';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';

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
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'result' | 'thinking';
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
  [key: string]: unknown;
}

export interface Session {
  id: string;
  name: string;
  worktreePath: string;
  prompt: string;
  status: 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error';
  statusMessage?: string;
  createdAt: string;
  lastActivity?: string;
  output: string[];
  jsonMessages: ClaudeJsonMessage[];
  error?: string;
  isRunning?: boolean;
  lastViewedAt?: string;
  projectId?: number;
  folderId?: string;
  permissionMode?: 'approve' | 'ignore';
  runStartedAt?: string;
  isMainRepo?: boolean;
  /**
   * In-place session (sessions.in_place, migration 047): worktreePath IS the
   * project checkout — no dedicated git worktree exists. DISTINCT from
   * isMainRepo (the hidden singleton dashboard session): in-place sessions are
   * ordinary, list-visible quick sessions. They run on either substrate (the
   * interactive gate rides the inline `--settings` flag — no checkout writes)
   * and can never host a workflow run — launch surfaces must warn + redirect
   * the run into a fresh worktree-backed session. Mirror of
   * main/src/types/session.ts Session.
   */
  inPlace?: boolean;
  displayOrder?: number;
  isFavorite?: boolean;
  toolType?: 'claude' | 'none';
  archived?: boolean;
  gitStatus?: GitStatus;
  baseCommit?: string;
  baseBranch?: string;
  runId?: string | null;
  /**
   * Persistent chat-sentinel gate vehicle (sessions.chat_run_id, migration 038),
   * DISTINCT from runId. runId is the latest FLOW run (Role-D: display/diff/
   * close-out); chatRunId is the never-clobbered `__quick__` sentinel chat turns
   * gate on (Role-G — PendingApprovalsForRun + the interactive terminal run id).
   * undefined/NULL until minted on the next chat turn. Mirror of
   * main/src/types/session.ts Session.
   */
  chatRunId?: string | null;
  /**
   * Which CLI substrate the session's claude panel runs on ('sdk'|'interactive').
   * Stamped by sessions:create-quick (sessions.substrate, migration 027);
   * undefined/NULL → sdk (legacy). Mirror of main/src/types/session.ts Session.
   */
  substrate?: CliSubstrate;
  /**
   * Provider/runtime backing the session's default chat agent (migrations 059-061).
   * `substrate` remains as a Claude compatibility projection while the app moves
   * to provider/runtime. Mirror of main/src/types/session.ts Session.
   */
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  /** Provider-scoped model selection. undefined/NULL → selected runtime default. */
  agentModel?: string | null;
  /**
   * Agent effort the session was launched with ('ultracode' | undefined).
   * Stamped by sessions:create-quick (sessions.effort, migration 029) and shown
   * READ-ONLY in the unified chat composer. undefined/NULL → no effort (default).
   * Mirror of main/src/types/session.ts Session.
   */
  effort?: 'ultracode';
  /**
   * The per-session agent permission mode (4-mode: default|acceptEdits|auto|
   * dontAsk). Persisted to sessions.agent_permission_mode (migration 021), seeded
   * at create-quick and editable mid-session from the composer permission pill.
   * Mirror of main/src/types/session.ts Session.
   */
  agentPermissionMode?: PermissionMode;
  /**
   * Per-session MCP DENY list (migration 039) — the MCP server names disabled
   * for this session. Persisted to sessions.disabled_mcp_servers_json; enforced
   * on BOTH substrates at spawn (next-turn apply): SDK (composeMcpServers delete +
   * strictMcpConfig + disallowedTools) and interactive (--disallowed-tools
   * mcp__<srv> + disabledMcpjsonServers). Edited from the composer McpTogglePill
   * (which shows servers enabled-by-default and persists the unchecked complement).
   * undefined/[] → nothing disabled. Mirror of main/src/types/session.ts Session.
   */
  disabledMcpServers?: string[];
  /**
   * Per-session plugin selection (migration 039) — the plugin ids selected for
   * this session. Persisted to sessions.enabled_plugins_json; enforced
   * DETERMINISTICALLY (exclusive: selected on, other installed off) at spawn on
   * BOTH substrates (SDK inline settings.enabledPlugins; interactive enabledPlugins
   * via `--settings`). Edited from the composer PluginTogglePill. undefined/[] →
   * inherit file settings. Mirror of main/src/types/session.ts.
   */
  enabledPlugins?: string[];
  /**
   * Design Mode (design-mode.md) idea link — the idea a design session is
   * bound to. Snake-case to match the DB-row field name in
   * main/src/database/models.ts Session (`design_idea_id`) verbatim, unlike
   * the camelCase projections above; a later UI lane reads it directly off
   * this field. undefined/null → not a design session (or link broken).
   */
  design_idea_id?: string | null;
  /**
   * Idea this session is the persistent home for (sessions.home_idea_id,
   * migration 113; idea sessions feature). At most one live session per idea
   * holds this. undefined/null → not an idea-home session. Mirror of
   * main/src/types/session.ts Session.
   */
  homeIdeaId?: string | null;
  /**
   * Idea whose launch minted this session (sessions.origin_idea_id, migration
   * 112; sidebar nesting lineage). Many sessions may share the same origin —
   * it is lineage, not a claim. undefined/null → no recorded launch origin.
   * Mirror of main/src/types/session.ts Session.
   */
  originIdeaId?: string | null;
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

// NOTE: keep this interface in sync with main/src/types/session.ts CreateSessionRequest
// until shared/types/ipc.ts consolidates IPC request shapes. See FIND-SPRINT-037-5.
export interface CreateSessionRequest {
  prompt: string;
  worktreeTemplate?: string;
  count?: number;
  permissionMode?: 'approve' | 'ignore';
  /**
   * Per-session 4-mode agent-permission override (Session Start Wizard step 3 /
   * quick-session config). DISTINCT from the legacy `permissionMode` above. When
   * omitted the session inherits the global default. KEEP IN SYNC with the main
   * twin in main/src/types/session.ts (request-parity rule).
   */
  agentPermissionMode?: PermissionMode;
  /**
   * Opt-in CLI substrate for the quick session ('sdk'|'interactive'). When
   * omitted the session runs on the SDK substrate (legacy behavior). Persisted
   * to sessions.substrate by the create-quick handler (migration 027). KEEP IN
   * SYNC with the main twin in main/src/types/session.ts (request-parity rule,
   * FIND-SPRINT-037-5).
   */
  substrate?: CliSubstrate;
  /** Provider/runtime for the quick session's default chat agent. */
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  /** Provider-scoped model selection. Omitted → selected runtime default. */
  agentModel?: string | null;
  /**
   * Opt-in agent effort level for the quick session. The only value today is
   * 'ultracode' (the "Ultracode" wizard card), launching the interactive PTY
   * REPL with the ultracode setting. Omitted → no effort setting. KEEP IN SYNC with
   * the main twin in main/src/types/session.ts (request-parity rule).
   */
  effort?: 'ultracode';
  /**
   * Per-session MCP DENY list chosen at session start (the launch wizard's
   * Advanced section). Server names the session must NOT load; persisted to
   * sessions.disabled_mcp_servers_json by create-quick and enforced on BOTH
   * substrates at spawn: SDK (composeMcpServers delete + strictMcpConfig +
   * disallowedTools) and interactive (--disallowed-tools mcp__<srv> +
   * disabledMcpjsonServers). Omitted/empty → inherit all configured servers. KEEP
   * IN SYNC with the main twin in main/src/types/session.ts (request-parity rule).
   */
  disabledMcpServers?: string[];
  /**
   * Per-session plugin selection chosen at session start (Advanced section).
   * Persisted to sessions.enabled_plugins_json by create-quick and enforced
   * DETERMINISTICALLY (exclusive: selected on, other installed off) on BOTH
   * substrates (SDK inline settings.enabledPlugins; interactive enabledPlugins via
   * `--settings`). Omitted/empty → inherit the user's file plugins. KEEP IN SYNC
   * with the main twin in main/src/types/session.ts (request-parity rule).
   */
  enabledPlugins?: string[];
  /**
   * Where the quick session's working tree lives ('worktree' | 'in-place').
   * Omitted → the global Settings default (quickSessionWorktreeMode, floor
   * 'worktree'). 'in-place' skips worktree creation and works directly in the
   * project checkout (sessions.in_place = 1, migration 047); both substrates
   * support it (the interactive gate rides the inline `--settings` flag — no
   * checkout writes). Only honored by sessions:create-quick. Workflow-host
   * session creation (ensureSessionForLaunch) pins 'worktree' explicitly. KEEP
   * IN SYNC with the main twin in main/src/types/session.ts (request-parity rule).
   */
  worktreeMode?: QuickSessionWorktreeMode;
  /**
   * Design Mode: idea to link the design session to; forces SDK substrate +
   * Claude; see design-mode.md. Omitted for every non-design launch; the
   * server validates the idea (exists, owned by the project, not decomposed)
   * and stamps sessions.design_idea_id. KEEP IN SYNC with the main twin in
   * main/src/types/session.ts (request-parity rule).
   */
  designIdeaId?: string;
  projectId?: number;
  folderId?: string;
  baseBranch?: string;
  toolType?: 'claude' | 'none';
  claudeConfig?: {
    model?: string;
    permissionMode?: 'approve' | 'ignore';
    ultrathink?: boolean;
    /** Per-launch opt-in for Anthropic fast mode (premium, Opus-only). Default off. */
    fastMode?: boolean;
    /**
     * Per-agent reasoning-effort selection (IDEA-029), distinct from the
     * session-level `effort?: 'ultracode'` field above. KEEP IN SYNC with the
     * main twin in main/src/types/session.ts (request-parity rule).
     */
    reasoningEffort?: ReasoningEffort;
  };
  branchName?: string;
}

export interface SessionOutput {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: string | ClaudeJsonMessage;
  timestamp: string;
  panelId?: string;
}

export interface GitCommands {
  rebaseCommands: string[];
  squashCommands: string[];
  mergeCommands: string[];
  mainBranch?: string;
  originBranch?: string;
  currentBranch?: string;
  getPullCommand?: () => string;
  getPushCommand?: () => string;
  getRebaseFromMainCommand?: () => string;
  getSquashAndRebaseToMainCommand?: () => string;
}

/**
 * `sessions:open-idea-session` wire types (the backlog idea card's "Open").
 * RE-EXPORTED, never re-declared: the single declaration lives in
 * shared/types/ideaSession.ts so main and the renderer cannot drift a field
 * apart (docs/CODE-PATTERNS.md → "IPC / type-parity rules"). Surfaced here so
 * renderer code can keep importing session IPC shapes from one place.
 */
export type { OpenIdeaSessionRequest, OpenIdeaSessionResponse } from '../../../shared/types/ideaSession';

// Attachment types for Claude Code config
export interface AttachedImage {
  id: string;
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

export interface AttachedText {
  id: string;
  name: string;
  content: string;
  size: number;
  path?: string;
}
