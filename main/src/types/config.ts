import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';

export interface AppConfig {
  verbose?: boolean;
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
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock: when true, every run/session is forced onto the interactive
  // PTY substrate and the SDK is disabled (the per-run picker is hidden). Applied
  // via getForcedSubstrate() — outranks the per-run choice and the global default.
  // Demo mode still pins 'sdk' and wins over this. Defaults to false (allow SDK).
  interactivePtyOnly?: boolean;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
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
  // Demo mode: boots the app against a throwaway demo database + sandbox repo
  // with scripted agent runs. Read ONCE at startup — toggling relaunches the app.
  demoMode?: boolean;
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
}

export interface UpdateConfigRequest {
  verbose?: boolean;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock — force the interactive PTY substrate and disable the SDK
  // (see AppConfig.interactivePtyOnly). Demo mode still wins with 'sdk'.
  interactivePtyOnly?: boolean;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
  theme?: 'paper' | 'light' | 'dark';
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  devMode?: boolean;
  // Demo mode (see AppConfig.demoMode) — applied on next launch.
  demoMode?: boolean;
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
}
