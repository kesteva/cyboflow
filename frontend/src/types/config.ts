import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';

export interface AppConfig {
  gitRepoPath: string;
  verbose?: boolean;
  systemPromptAppend?: string;
  runScript?: string[];
  claudeExecutablePath?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock: when true, every run/session is forced onto the interactive
  // PTY substrate and the SDK is disabled (the per-run picker is hidden). Demo mode
  // still pins 'sdk' and wins. Defaults to false (allow SDK).
  interactivePtyOnly?: boolean;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
  // On-disk location for COMMITTED-artifact manifests (FEATURE #3 durability
  // snapshot). Relative paths resolve against the project ROOT; absolute paths
  // are used verbatim. Floors to '.cyboflow/artifacts' when unset.
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
  // Demo mode: throwaway demo database + sandbox repo with scripted agent runs.
  // Read once at startup — toggling relaunches the app.
  demoMode?: boolean;
  // Telemetry settings (opt-OUT model: both flags default true). Privacy: source
  // code, file paths, repo names, and LLM prompts are NEVER sent — error/usage
  // payloads are scrubbed before transmission. SDKs are silent no-ops when the
  // matching flag is false OR the credential env var (SENTRY_DSN / APTABASE_APP_KEY)
  // is absent. installId is a random uuid v4 minted once on first boot.
  telemetry?: {
    errorReportingEnabled: boolean;  // Sentry; DEFAULT true (opt-out model)
    usageMetricsEnabled: boolean;    // Aptabase; DEFAULT true (opt-out model)
    installId: string;               // random uuid v4, generated once on first boot, persisted
  };
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
  // Additional paths to add to PATH environment variable
  additionalPaths?: string[];
  // Cyboflow commit footer setting (enabled by default)
  enableCyboflowFooter?: boolean;
}
