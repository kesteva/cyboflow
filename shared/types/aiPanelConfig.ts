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

/**
 * Factory for creating default configurations
 */
export class AIPanelConfigFactory {
  static createClaudeConfig(
    worktreePath: string,
    prompt: string,
    model?: string,
    permissionMode?: 'approve' | 'ignore'
  ): AIPanelConfig {
    return {
      worktreePath,
      prompt,
      model,
      permissionMode
    };
  }
}