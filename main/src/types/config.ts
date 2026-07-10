import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { VisualVerifyConfig } from '../../../shared/types/visualVerification';

/**
 * Auto-surface idle PTY quick sessions into the human review queue. Stored
 * partial (members floor on read) so config.json stays byte-identical for users
 * who never opt in. See ConfigManager.getIdleSessionReviewConfig().
 */
export interface IdleSessionReviewConfig {
  /** Master switch. Absent → floors to IDLE_SESSION_REVIEW_DEFAULTS.enabled (true). */
  enabled?: boolean;
  /**
   * Minutes an interactive quick session may sit finished-and-unviewed before a
   * blocking human_task is minted. Absent/non-positive → floors to
   * IDLE_SESSION_REVIEW_DEFAULTS.thresholdMinutes (5).
   */
  thresholdMinutes?: number;
}

/** Fully-resolved idle-session-review config (every member present). */
export interface ResolvedIdleSessionReviewConfig {
  enabled: boolean;
  thresholdMinutes: number;
}

/** Floor values applied on read for any omitted IdleSessionReviewConfig member. */
export const IDLE_SESSION_REVIEW_DEFAULTS: ResolvedIdleSessionReviewConfig = {
  enabled: true,
  thresholdMinutes: 5,
};

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
  // Global default for where QUICK sessions work ('worktree' | 'in-place').
  // Read via getQuickSessionWorktreeMode() (floor 'worktree') by the
  // sessions:create-quick handler when the request omits worktreeMode. NOT
  // seeded into constructor defaults, so existing config.json files stay
  // byte-identical.
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global on/off for the code-review eval (the K=3 Opus jury pass fired at the
  // sprint-review => human-review boundary). Absent/undefined = ENABLED (the eval
  // costs a real Opus jury pass per built-in flow run reaching human-review; users
  // may turn it off globally, or per-run via workflow_runs.eval_enabled). Read at
  // the trigger seam via configManager.getCodeReviewEvalEnabled(). NOT seeded into
  // constructor defaults, so existing config.json files stay byte-identical.
  codeReviewEvalEnabled?: boolean;
  // Sub-toggle of the code-review eval (A/B testing slice C): whether variant- and
  // experiment-tagged runs are auto-graded (per-arm K=3 eval AND the pairwise
  // judge). Absent/undefined = ENABLED (default ON). OFF => per-arm eval is
  // skipped and the pairwise judge behaves as eval-disabled (status='skipped',
  // diffs still captured for manual compare). Guards against silent Opus spend
  // from merely activating two variants. Read at the widened trigger seam via
  // configManager.getAutoGradeVariantRuns(). NOT seeded into constructor defaults,
  // so existing config.json files stay byte-identical.
  autoGradeVariantRuns?: boolean;
  // On-disk location for COMMITTED-artifact manifests (FEATURE #3 durability
  // snapshot). Relative paths resolve against the project ROOT; absolute paths
  // are used verbatim. Floors to DEFAULT_ARTIFACT_COMMIT_DIR ('.cyboflow/artifacts')
  // when unset. Intentionally NOT seeded into constructor defaults (byte-identical).
  artifactCommitDir?: string;
  // Layered visual verification settings (see shared/types/visualVerification.ts
  // and docs/visual-verification-design.md). Master switch defaults OFF. Like the
  // other globals, intentionally NOT seeded into constructor defaults so existing
  // config.json files stay byte-identical; the ConfigManager getter applies floors.
  visualVerify?: VisualVerifyConfig;
  // Auto-surface idle PTY quick sessions into the human review queue (see
  // IdleSessionReviewConfig). A blocking human_task is minted for an interactive
  // quick session that finished a turn and has sat unviewed longer than
  // thresholdMinutes, so a session waiting on the user surfaces even if the agent
  // never filed a finding. Absent members floor to IDLE_SESSION_REVIEW_DEFAULTS
  // (enabled: true, thresholdMinutes: 5) via getIdleSessionReviewConfig(). NOT
  // seeded into constructor defaults, so existing config.json files stay
  // byte-identical.
  idleSessionReview?: IdleSessionReviewConfig;
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
  // DEV-ONLY testing affordance: when true (and the app is unpackaged), the NEXT
  // AskUserQuestion gate is failed on purpose so the durable recovery gate can be
  // exercised live. Mirrors the CYBOFLOW_DEV_FORCE_GATE_STREAM_CLOSED env var.
  // Floored to false when unset; never fires in a packaged release.
  forceAskUserQuestionGateFailure?: boolean;
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
  // Global default for where QUICK sessions work (see AppConfig.quickSessionWorktreeMode).
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global on/off for the code-review eval (see AppConfig.codeReviewEvalEnabled).
  codeReviewEvalEnabled?: boolean;
  // Auto-grade variant & experiment runs sub-toggle (see AppConfig.autoGradeVariantRuns).
  autoGradeVariantRuns?: boolean;
  // On-disk location for COMMITTED-artifact manifests (see AppConfig.artifactCommitDir).
  artifactCommitDir?: string;
  // Layered visual verification settings (see AppConfig.visualVerify).
  visualVerify?: VisualVerifyConfig;
  // Idle PTY quick-session auto-review settings (see AppConfig.idleSessionReview).
  idleSessionReview?: IdleSessionReviewConfig;
  theme?: 'paper' | 'light' | 'dark';
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  devMode?: boolean;
  // DEV-ONLY testing affordance (see AppConfig.forceAskUserQuestionGateFailure).
  forceAskUserQuestionGateFailure?: boolean;
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
