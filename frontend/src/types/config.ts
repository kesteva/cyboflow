import type { AgentProviderAccess, AgentRuntime } from '../../../shared/types/agentRuntime';
import type { AssistantContextRetention } from '../../../shared/types/agentThread';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { FanOutDispatch } from '../../../shared/types/fanOutDispatch';
import type { SprintMaxTasksOverrides } from '../../../shared/types/sprintBatch';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { VisualVerifyConfig } from '../../../shared/types/visualVerification';
import type { RunTypeDefaults } from '../../../shared/types/sessionDefaults';

export interface AppConfig {
  gitRepoPath: string;
  verbose?: boolean;
  systemPromptAppend?: string;
  runScript?: string[];
  claudeExecutablePath?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  // Sparse per-launch-type defaults, keyed by `workflow:<workflowId>` or the
  // synthetic global `quick` key. This field is intentionally NOT seeded into
  // ConfigManager's constructor defaults, so config.json stays byte-identical
  // for users who never touch it. It is omitted from UpdateConfigRequest:
  // writes use the dedicated IPC operation so the two channels cannot race.
  runTypeDefaults?: Record<string, RunTypeDefaults>;
  // Model alias for the global cyboflow assistant (the agent-rail chat), e.g.
  // 'sonnet' | 'opus' | 'fable'. Unset ⇒ falls back to the app's default model.
  assistantModel?: string;
  // Global assistant on/off; absent ⇒ enabled. When false the assistant spawns
  // no turns (zero tokens) and the rail is hidden.
  assistantEnabled?: boolean;
  // Extra folders the cyboflow assistant may read, beyond the app's registered
  // project folders (which are always readable regardless of this list).
  assistantFolderAccess?: string[];
  // How the assistant's standing conversation handles the local-day boundary
  // ('clear-daily' | 'compact-daily' | 'auto-compact'). Absent ⇒ 'clear-daily'.
  assistantContextRetention?: AssistantContextRetention;
  // Registered project folders the user has excluded from the assistant's
  // read-only filesystem tools (each an exact project path). Absent/empty ⇒
  // every project folder is readable (the default).
  assistantExcludedProjectPaths?: string[];
  // Session-summary global on/off; absent ⇒ enabled. When false, the idle-
  // debounced scheduler and lazy catch-up kick fire no Haiku calls (zero
  // tokens) and the session canvas hides the summary card.
  sessionSummaryEnabled?: boolean;
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock: when true, every run/session is forced onto the interactive
  // PTY substrate and the SDK is disabled (the per-run picker is hidden). Demo mode
  // still pins 'sdk' and wins. Defaults to false (allow SDK).
  interactivePtyOnly?: boolean;
  // Per-provider access toggles ('claude' / 'codex') — Settings → Integrations and
  // the onboarding Connect step write this SAME field. Absent members floor to
  // ENABLED (shared/types/agentRuntime.ts). A disabled provider is dropped from
  // every runtime picker and rejected at the backend launch seams.
  agentProviderAccess?: AgentProviderAccess;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
  // Global default MODEL for launches — quick sessions AND flow runs alike. The
  // middle rung of resolveRunTypeLaunchDefaults (shared/types/sessionDefaults.ts):
  //   per-run-type stored value → defaultLaunchModel → DEFAULT_RUN_TYPE_MODEL_FLOORS.
  // Absent/blank ⇒ the per-kind floor. Deliberately unrelated to the main-side
  // legacy `defaultModel`, which feeds the assistant fallback and never a launch.
  defaultLaunchModel?: string;
  // Global default AGENT RUNTIME for launches — quick sessions AND flow runs alike
  // (one field for both surfaces). The middle rung of resolveRunTypeLaunchDefaults:
  //   per-run-type stored value → defaultAgentRuntime → undefined.
  // There is deliberately NO floor: an unresolved runtime is OMITTED from the launch
  // payload rather than synthesized, keeping an unconfigured install byte-identical.
  defaultAgentRuntime?: AgentRuntime;
  // Global default execution model for new SDK workflow runs ('orchestrated' |
  // 'programmatic'). Floors to 'programmatic' when unset — new SDK flow runs
  // default to the in-process host loop; the interactive substrate always
  // hard-pins 'orchestrated' regardless of this value.
  defaultExecutionModel?: ExecutionModel;
  // Fan-out dispatch mode for orchestrated INTERACTIVE runs ('prose' | 'workflow').
  // 'workflow' dispatches each inner stage of a wave to a pre-installed dynamic
  // workflow script instead of the agent driving lanes by hand; the orchestrator
  // stays the single writer either way. Defaults to 'workflow' when unset, and is NOT
  // seeded into the constructor defaults so existing config.json files stay
  // byte-identical.
  fanOutDispatch?: FanOutDispatch;
  // Per-substrate override of the sprint task-selection cap N (how many tasks may
  // be multi-selected into ONE sprint batch). SPARSE: an absent member falls back
  // to SPRINT_BATCH_MAX_TASKS_DEFAULTS for that substrate. Always read through
  // resolveSprintMaxTasks() — never the raw map — so the picker's client-side cap
  // matches the server-side 400 in runs.start.
  sprintMaxTasks?: SprintMaxTasksOverrides;
  // Global default for where QUICK sessions work ('worktree' | 'in-place').
  // Floors to 'worktree' when unset. The launch wizard's Advanced "Workspace"
  // tri-state overrides it per launch; workflow-host sessions always pin
  // 'worktree' regardless (ensureSessionForLaunch).
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global default CLI substrate for new QUICK sessions ('sdk' | 'interactive').
  // Floors to 'interactive' (the PTY) when unset — quick sessions default to the
  // live terminal. Seeds the launch wizard's per-launch substrate picker for
  // quick/ultracode cards; distinct from defaultSubstrate, which governs workflow
  // runs. The forced pins (demo / interactivePtyOnly) still override per launch.
  quickSessionDefaultSubstrate?: CliSubstrate;
  // Global on/off for the code-review eval (the K=3 Opus jury pass fired at a
  // built-in flow's human-review step). Absent/undefined = ENABLED. A per-run
  // Configure override (workflow_runs.eval_enabled) outranks this; NULL inherits it.
  codeReviewEvalEnabled?: boolean;
  // Global run-summary cost display mode. When true, compute cost from the run's
  // token breakdown and model pricing; absent/false preserves the provider-
  // reported cost shown today.
  computeCostFromRates?: boolean;
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
  // Aria mode: supervise a REMOTE OMP fleet (`omp-fleet`) over the Prime bridge
  // instead of running the LOCAL OMP runtimes (`omp-sdk`/`omp-pty`). The two are
  // alternatives — the runtime picker offers one or the other, never both. Also
  // the grant of the `omp:supervise` capability. Read at boot when the fleet
  // session manager is built, so a change takes effect on the next launch.
  ariaMode?: boolean;
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
  };
  // Additional paths to add to PATH environment variable
  additionalPaths?: string[];
  // Cyboflow commit footer setting (enabled by default)
  enableCyboflowFooter?: boolean;
}
