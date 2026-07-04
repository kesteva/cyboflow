/**
 * Unified configuration for AI panels (Claude, etc.)
 */
export interface AIPanelConfig {
  // Common configuration
  model?: string;
  prompt: string;
  worktreePath: string;

  // Claude-specific
  permissionMode?: 'approve' | 'ignore';
  /**
   * Opus fast-mode opt-in for the spawned turn. Persisted per-panel in
   * tool_panels.settings (wizard toggle / FastModePill); callers that respawn an
   * existing quick-session panel must read the persisted value and thread it
   * here, or the SDK spawn silently reverts to standard speed.
   */
  fastMode?: boolean;

  // Future extensibility - specific config values can be added here
  [key: string]: string | number | boolean | Array<unknown> | undefined;
}

/**
 * Configuration for starting a panel
 */
export interface StartPanelConfig extends AIPanelConfig {
  panelId: string;
  sessionId?: string;
}

/**
 * Configuration for continuing a panel conversation
 */
export interface ContinuePanelConfig extends AIPanelConfig {
  panelId: string;
  conversationHistory: Array<{id?: number; session_id?: string; message_type: 'user' | 'assistant'; content: string; timestamp?: string}>;
}

/**
 * Panel-specific state that can be stored
 */
export interface AIPanelState {
  isInitialized?: boolean;
  resumeId?: string;
  lastActivityTime?: string;
  lastPrompt?: string;
  config?: Partial<AIPanelConfig>;
}

