export interface AppConfig {
  verbose?: boolean;
  anthropicApiKey?: string;
  // Legacy fields for backward compatibility
  gitRepoPath?: string;
  systemPromptAppend?: string;
  runScript?: string[];
  // Custom claude executable path (for when it's not in PATH)
  claudeExecutablePath?: string;
  // Permission mode for all sessions
  defaultPermissionMode?: 'approve' | 'ignore';
  // Default model for new sessions
  defaultModel?: string;
  // Auto-check for updates
  autoCheckUpdates?: boolean;
  // Stravu MCP integration
  stravuApiKey?: string;
  stravuServerUrl?: string;
  // Theme preference
  theme?: 'paper' | 'light' | 'dark';
  // Notification settings
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  // Dev mode for debugging
  devMode?: boolean;
  // Additional paths to add to PATH environment variable
  additionalPaths?: string[];
  // Session creation preferences
  sessionCreationPreferences?: {
    sessionCount?: number;
    toolType?: 'claude' | 'none';
    selectedTools?: {
      claude?: boolean;
    };
    claudeConfig?: {
      model?: 'auto' | 'sonnet' | 'opus' | 'haiku';
      permissionMode?: 'ignore' | 'approve';
      ultrathink?: boolean;
    };
    showAdvanced?: boolean;
    baseBranch?: string;
    commitModeSettings?: {
      mode?: 'checkpoint' | 'incremental' | 'single';
      checkpointPrefix?: string;
    };
  };
  // Cyboflow commit footer setting (enabled by default)
  enableCyboflowFooter?: boolean;
  // PostHog analytics settings
  analytics?: {
    enabled: boolean;
    posthogApiKey?: string;
    posthogHost?: string;
    distinctId?: string; // Random UUID for anonymous user identification
  };
}

export interface UpdateConfigRequest {
  verbose?: boolean;
  anthropicApiKey?: string;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  autoCheckUpdates?: boolean;
  stravuApiKey?: string;
  stravuServerUrl?: string;
  theme?: 'paper' | 'light' | 'dark';
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  devMode?: boolean;
  additionalPaths?: string[];
  sessionCreationPreferences?: {
    sessionCount?: number;
    toolType?: 'claude' | 'none';
    selectedTools?: {
      claude?: boolean;
    };
    claudeConfig?: {
      model?: 'auto' | 'sonnet' | 'opus' | 'haiku';
      permissionMode?: 'ignore' | 'approve';
      ultrathink?: boolean;
    };
    showAdvanced?: boolean;
    baseBranch?: string;
    commitModeSettings?: {
      mode?: 'checkpoint' | 'incremental' | 'single';
      checkpointPrefix?: string;
    };
  };
  enableCyboflowFooter?: boolean;
  // PostHog analytics settings
  analytics?: {
    enabled: boolean;
    posthogApiKey?: string;
    posthogHost?: string;
    distinctId?: string; // Random UUID for anonymous user identification
  };
}
