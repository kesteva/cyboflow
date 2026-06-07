import type { PermissionMode } from '../../../shared/types/workflows';

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
  projectId?: number;
  folderId?: string;
  baseBranch?: string;
  autoCommit?: boolean;
  model?: string;
  toolType?: 'claude' | 'none';
  commitMode?: 'structured' | 'checkpoint' | 'disabled';
  commitModeSettings?: string; // JSON string of CommitModeSettings
  claudeConfig?: {
    model?: string;
    permissionMode?: 'approve' | 'ignore';
    ultrathink?: boolean;
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
