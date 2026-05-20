/**
 * Renderer-side type shapes for AI panel messages.
 *
 * The runtime parseJsonMessage / parseJsonMessages adapters originally
 * declared in this module were dead after TASK-637's fix commit bb926cd —
 * production now feeds UnifiedMessage[] straight through to
 * messageTransformer.transform() in MessagesView / RichOutputView.
 * The type aliases below remain in use; the runtime adapters were removed
 * in SPRINT-024 (compound A6). The IPC type declaration was corrected in
 * TASK-672 (aligning electron.d.ts getJsonMessages to UnifiedMessage[]).
 */

/**
 * Renderer-side shape for raw JSON messages displayed in MessagesView.
 */
export interface JSONMessage {
  type: 'json';
  data: string;
  timestamp: string;
}

/**
 * Renderer-side shape for user-prompt messages displayed in RichOutputView.
 */
export interface UserPromptMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
  timestamp: string;
}

/**
 * Renderer-side shape for session_info messages.
 */
export interface SessionInfo {
  type: 'session_info';
  initial_prompt?: string;
  claude_command?: string;
  worktree_path?: string;
  model?: string;
  permission_mode?: string;
  approval_policy?: string;
  timestamp: string;
}
