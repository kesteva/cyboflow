import type { CliSubstrate } from '../../../shared/types/substrate';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { VisualVerifyConfig } from '../../../shared/types/visualVerification';

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
  // Global default execution model for new SDK workflow runs ('orchestrated' |
  // 'programmatic'). Floors to 'orchestrated' when unset; the interactive
  // substrate always hard-pins 'orchestrated' regardless of this value.
  defaultExecutionModel?: ExecutionModel;
  // Global default for where QUICK sessions work ('worktree' | 'in-place').
  // Floors to 'worktree' when unset. The launch wizard's Advanced "Workspace"
  // tri-state overrides it per launch; workflow-host sessions always pin
  // 'worktree' regardless (ensureSessionForLaunch).
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global on/off for the code-review eval (the K=3 Opus jury pass fired at a
  // built-in flow's human-review step). Absent/undefined = ENABLED. A per-run
  // Configure override (workflow_runs.eval_enabled) outranks this; NULL inherits it.
  codeReviewEvalEnabled?: boolean;
  // A/B testing slice C sub-toggle: whether variant / experiment-arm runs are
  // auto-graded (per-arm rubric eval + the pairwise judge) at their terminal
  // status, on top of the global codeReviewEvalEnabled toggle above. Absent =
  // ENABLED (see ConfigManager.getAutoGradeVariantRuns). Turn off to activate
  // rotation / run side-by-side experiments without incurring judge cost.
  autoGradeVariantRuns?: boolean;
  // On-disk location for COMMITTED-artifact manifests (FEATURE #3 durability
  // snapshot). Relative paths resolve against the project ROOT; absolute paths
  // are used verbatim. Floors to '.cyboflow/artifacts' when unset.
  artifactCommitDir?: string;
  // Layered visual verification settings (see shared/types/visualVerification.ts).
  // Master switch defaults OFF; the ConfigManager getter applies floors.
  visualVerify?: VisualVerifyConfig;
  // Auto-surface idle PTY quick sessions into the human review queue. A blocking
  // human_task is minted for an interactive quick session that finished a turn
  // and has sat unviewed longer than thresholdMinutes. Absent members floor to
  // { enabled: true, thresholdMinutes: 5 } on the main side.
  idleSessionReview?: {
    enabled?: boolean;
    thresholdMinutes?: number;
  };
  theme?: 'paper' | 'light' | 'dark';
  notifications?: {
    enabled: boolean;
    playSound: boolean;
    notifyOnStatusChange: boolean;
    notifyOnWaiting: boolean;
    notifyOnComplete: boolean;
  };
  devMode?: boolean;
  // DEV-ONLY testing affordance: forces the next AskUserQuestion gate to fail so
  // the durable recovery gate can be exercised live. Only takes effect in dev
  // (unpackaged) runs; never fires in a packaged release.
  forceAskUserQuestionGateFailure?: boolean;
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
      model?: 'auto' | 'fable' | 'sonnet' | 'opus' | 'haiku';
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
