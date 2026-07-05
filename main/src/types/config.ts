import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ExecutionModel } from '../../../shared/types/executionModel';

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
  // Global default execution model for new SDK workflow runs ('orchestrated' | 'programmatic').
  // The global-default rung of resolveExecutionModel; floors to 'orchestrated' when unset and is
  // ignored on the interactive substrate (which hard-pins 'orchestrated'). NOT seeded into the
  // constructor defaults, so existing config.json files stay byte-identical.
  defaultExecutionModel?: ExecutionModel;
  // Global on/off for the code-review eval (the K=3 Opus jury pass fired at the
  // sprint-review => human-review boundary). Absent/undefined = ENABLED (the eval
  // costs a real Opus jury pass per built-in flow run reaching human-review; users
  // may turn it off globally, or per-run via workflow_runs.eval_enabled). Read at
  // the trigger seam via configManager.getCodeReviewEvalEnabled(). NOT seeded into
  // constructor defaults, so existing config.json files stay byte-identical.
  codeReviewEvalEnabled?: boolean;
  // On-disk location for COMMITTED-artifact manifests (FEATURE #3 durability
  // snapshot). Relative paths resolve against the project ROOT; absolute paths
  // are used verbatim. Floors to DEFAULT_ARTIFACT_COMMIT_DIR ('.cyboflow/artifacts')
  // when unset. Intentionally NOT seeded into constructor defaults (byte-identical).
  artifactCommitDir?: string;
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
  // Telemetry settings (opt-OUT model: both flags default true). Privacy: source
  // code, file paths, repo names, and LLM prompts are NEVER sent — error/usage
  // payloads are scrubbed before transmission. SDKs are silent no-ops when the
  // matching flag is false OR the credential env var (SENTRY_DSN / APTABASE_APP_KEY)
  // is absent. installId is a random uuid v4 minted once on first boot.
  telemetry?: {
    errorReportingEnabled: boolean;  // Sentry; DEFAULT on for .dmg (opt-out), off for pnpm builds
    usageMetricsEnabled: boolean;    // Aptabase; DEFAULT on for .dmg (opt-out), off for pnpm builds
    installId: string;               // random uuid v4, generated once on first boot, persisted
  };
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
  // Global default execution model for new SDK workflow runs ('orchestrated' | 'programmatic').
  defaultExecutionModel?: ExecutionModel;
  // Global on/off for the code-review eval (see AppConfig.codeReviewEvalEnabled).
  codeReviewEvalEnabled?: boolean;
  // On-disk location for COMMITTED-artifact manifests (see AppConfig.artifactCommitDir).
  artifactCommitDir?: string;
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
  // Telemetry settings (see AppConfig.telemetry). Opt-OUT model: both flags default
  // true. Privacy: source code, file paths, repo names, and LLM prompts are NEVER
  // sent — payloads are scrubbed before transmission.
  telemetry?: {
    errorReportingEnabled: boolean;  // Sentry; DEFAULT on for .dmg (opt-out), off for pnpm builds
    usageMetricsEnabled: boolean;    // Aptabase; DEFAULT on for .dmg (opt-out), off for pnpm builds
    installId: string;               // random uuid v4, generated once on first boot, persisted
  };
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
