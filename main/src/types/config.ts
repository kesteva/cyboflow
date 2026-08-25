import type { AgentProviderAccess, AgentRuntime } from '../../../shared/types/agentRuntime';
import type { AssistantContextRetention } from '../../../shared/types/agentThread';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { SprintMaxTasksOverrides } from '../../../shared/types/sprintBatch';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { FanOutDispatch } from '../../../shared/types/fanOutDispatch';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { VisualVerifyConfig } from '../../../shared/types/visualVerification';
import type { RunTypeDefaults } from '../../../shared/types/sessionDefaults';

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
  // Model alias for the global cyboflow assistant (the agent-rail chat), e.g.
  // 'sonnet' | 'opus' | 'fable'. Unset ⇒ falls back to defaultModel.
  assistantModel?: string;
  // Global assistant on/off; absent ⇒ enabled. When false the assistant spawns
  // no turns (zero tokens) — enforced authoritatively by AgentThreadService via
  // ConfigManager.isAssistantEnabled(), and the renderer hides the agent rail
  // (so the auto-digest, which lives inside the rail, cannot fire either).
  assistantEnabled?: boolean;
  // Extra folders the global cyboflow assistant may read via its scoped
  // filesystem tools (cyboflow_fs_read / _list / _grep), BEYOND the registered
  // project folders (which are always included). Read via
  // getAssistantFolderAccess() (trims entries, drops blanks, floors to []). NOT
  // seeded into constructor defaults, so existing config.json files stay
  // byte-identical for users who never grant extra folders.
  assistantFolderAccess?: string[];
  // How the assistant's standing conversation handles the local-day boundary
  // ('clear-daily' | 'compact-daily' | 'auto-compact'). Read via
  // getAssistantContextRetention(), which floors absent/invalid values to
  // 'clear-daily'. NOT seeded into constructor defaults (config.json stays
  // byte-identical for users who never touch it).
  assistantContextRetention?: AssistantContextRetention;
  // Registered project folders the user has EXCLUDED from the assistant's
  // read-only filesystem tools (each an exact `projects.path`). Absent/empty ⇒
  // every project folder is readable (the default). Read via
  // getAssistantExcludedProjectPaths() (trims, drops blanks, floors to []).
  // NOT seeded into constructor defaults (config.json stays byte-identical for
  // users who never exclude a folder).
  assistantExcludedProjectPaths?: string[];
  // Session-summary global on/off; absent ⇒ enabled. When false, the idle-
  // debounced scheduler and lazy catch-up kick fire no Haiku calls (zero
  // tokens) — enforced authoritatively via ConfigManager.isSessionSummaryEnabled(),
  // and the sessions:get-summary response carries enabled: false so the
  // renderer hides the summary card without a separate config fetch.
  sessionSummaryEnabled?: boolean;
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock: when true, every run/session is forced onto the interactive
  // PTY substrate and the SDK is disabled (the per-run picker is hidden). Applied
  // via getForcedSubstrate() — outranks the per-run choice and the global default.
  // Demo mode still pins 'sdk' and wins over this. Defaults to false (allow SDK).
  interactivePtyOnly?: boolean;
  // Per-provider access toggles ('claude' / 'codex'), written by BOTH Settings →
  // Integrations and the onboarding Connect step. Absent members floor to ENABLED
  // (see shared/types/agentRuntime.ts) and the field is NOT seeded into the
  // constructor defaults, so existing config.json files stay byte-identical. A
  // disabled provider is dropped from every runtime picker and rejected at the
  // launch seams (WorkflowRegistry.createRun / the quick-session IPC handler).
  agentProviderAccess?: AgentProviderAccess;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
  // Global default MODEL for launches — quick sessions AND flow runs alike. The
  // middle rung of resolveRunTypeLaunchDefaults (shared/types/sessionDefaults.ts):
  //   per-run-type stored value → defaultLaunchModel → DEFAULT_RUN_TYPE_MODEL_FLOORS.
  // DISTINCT from the legacy `defaultModel` above, which feeds the global assistant
  // fallback and the legacy panel backfill and is deliberately NEVER consulted by a
  // launch (see ConfigManager.getDefaultLaunchModel). Absent/blank ⇒ the per-kind
  // floor, so launches stay byte-identical until the user sets this. NOT seeded
  // into constructor defaults.
  defaultLaunchModel?: string;
  // Global default AGENT RUNTIME for launches — quick sessions AND flow runs alike
  // (one field for both surfaces). The middle rung of resolveRunTypeLaunchDefaults:
  //   per-run-type stored value → defaultAgentRuntime → undefined.
  // There is deliberately NO floor: an unresolved runtime must be OMITTED from a
  // launch payload rather than synthesized, which is what keeps an install that
  // never sets this byte-identical. Read via ConfigManager.getDefaultAgentRuntime()
  // (invalid values floor to undefined — config.json is user-editable). NOT seeded
  // into constructor defaults.
  defaultAgentRuntime?: AgentRuntime;
  // Global default execution model for new SDK workflow runs ('orchestrated' | 'programmatic').
  // The global-default rung of resolveExecutionModel; floors to 'programmatic' when unset (new
  // SDK flow runs default to the in-process host loop) and is ignored on the interactive substrate
  // (which hard-pins 'orchestrated'). NOT seeded into the constructor defaults, so existing
  // config.json files stay byte-identical.
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
  // to SPRINT_BATCH_MAX_TASKS_DEFAULTS for that substrate, so an install that never
  // touches the setting keeps the built-in 15 (sdk) / 10 (interactive). Read via
  // getSprintMaxTasks() and resolved with resolveSprintMaxTasks() — values are
  // clamped to [SPRINT_MAX_TASKS_MIN, SPRINT_MAX_TASKS_MAX] on read because
  // config.json is hand-editable. NOT seeded into the constructor defaults.
  sprintMaxTasks?: SprintMaxTasksOverrides;
  // Global default for where QUICK sessions work ('worktree' | 'in-place').
  // Read via getQuickSessionWorktreeMode() (floor 'worktree') by the
  // sessions:create-quick handler when the request omits worktreeMode. NOT
  // seeded into constructor defaults, so existing config.json files stay
  // byte-identical.
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global default CLI substrate for new QUICK sessions ('sdk' | 'interactive').
  // Read via getQuickSessionDefaultSubstrate() (floor 'interactive' — quick
  // sessions default to the interactive PTY) as the QUICK sentinel's global-default
  // rung in WorkflowRegistry.createRun, BELOW an explicit per-launch request and
  // BELOW the forced-substrate pins (demo / interactivePtyOnly), which still win.
  // Distinct from defaultSubstrate, which governs WORKFLOW runs. NOT seeded into
  // constructor defaults, so existing config.json files stay byte-identical.
  quickSessionDefaultSubstrate?: CliSubstrate;
  // Global on/off for the code-review eval (the K=3 Opus jury pass fired at the
  // sprint-review => human-review boundary). Absent/undefined = ENABLED (the eval
  // costs a real Opus jury pass per built-in flow run reaching human-review; users
  // may turn it off globally, or per-run via workflow_runs.eval_enabled). Read at
  // the trigger seam via configManager.getCodeReviewEvalEnabled(). NOT seeded into
  // constructor defaults, so existing config.json files stay byte-identical.
  codeReviewEvalEnabled?: boolean;
  // Kill switch for the final-gate auto-handover: chatting with a programmatic run
  // parked at its FINAL human gate (or resting for merge) auto-converts it to a
  // full orchestrated agent carrying the message as the agent's first request.
  // Absent/undefined = ENABLED (default true). Read via
  // configManager.getAutoHandoverAtFinalGateEnabled(). NOT seeded into constructor
  // defaults, so existing config.json files stay byte-identical.
  autoHandoverAtFinalGate?: boolean;
  // Global on/off for computing the run-summary cost from the run's token
  // breakdown and model pricing instead of displaying the provider-reported
  // cost. Absent/undefined = DISABLED (reported cost, preserving today's
  // display). Read via configManager.getComputeCostFromRates(). NOT seeded
  // into constructor defaults, so existing config.json files stay byte-identical.
  computeCostFromRates?: boolean;
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
  // and docs/proposals/visual-verification-design.md). Master switch defaults OFF. Like the
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
  /**
   * Aria mode — which OMP flavor this install runs.
   *
   * OFF (default): the LOCAL OMP runtimes (`omp-sdk` / `omp-pty`) are offered
   * and the fleet supervisor is hidden. ON: Cyboflow supervises a REMOTE OMP
   * fleet over the Prime bridge (`omp-fleet`) and the local runtimes are hidden.
   * The two are alternatives, not a stack — one panel is either a local OMP
   * process or a remote worker, never both.
   *
   * This is also the GRANT of the `omp:supervise` capability: spawning and
   * killing remote workers is authorized by the operator saying so here, not by
   * the bridge merely being reachable. `CYBOFLOW_OMP_SUPERVISE` remains an
   * override for headless/CI hosts that have no Settings UI.
   *
   * Read at boot when the fleet session manager is constructed, so a change
   * takes effect on the next launch (like `additionalPaths`). Independent of
   * the `omp` provider toggle in Settings -> Integrations, which still has to
   * be on for ANY OMP runtime to appear.
   */
  ariaMode?: boolean;
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
  };
  // Sparse per-launch-type defaults, keyed by `workflow:<workflowId>` or the
  // synthetic global `quick` key. Intentionally NOT seeded into ConfigManager's
  // constructor defaults, so config.json stays byte-identical for users who
  // never touch it. Writes use the dedicated IPC operation below, not the
  // generic UpdateConfigRequest, so the two channels cannot race on this field.
  runTypeDefaults?: Record<string, RunTypeDefaults>;
  // Cyboflow commit footer setting (enabled by default)
  enableCyboflowFooter?: boolean;
}

// `runTypeDefaults` is deliberately absent from this generic payload: its
// dedicated IPC operation is the exclusive write channel, preventing races.
export interface UpdateConfigRequest {
  verbose?: boolean;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  // Model alias for the global cyboflow assistant (see AppConfig.assistantModel).
  assistantModel?: string;
  // Global assistant on/off (see AppConfig.assistantEnabled).
  assistantEnabled?: boolean;
  // Extra folders the global assistant may read (see AppConfig.assistantFolderAccess).
  assistantFolderAccess?: string[];
  // Assistant day-boundary context strategy (see AppConfig.assistantContextRetention).
  assistantContextRetention?: AssistantContextRetention;
  // Project folders excluded from the assistant's fs tools (see AppConfig.assistantExcludedProjectPaths).
  assistantExcludedProjectPaths?: string[];
  // Session-summary global on/off (see AppConfig.sessionSummaryEnabled).
  sessionSummaryEnabled?: boolean;
  // Default CLI substrate for new workflow runs ('sdk' | 'interactive'). IDEA-013 / TASK-806.
  defaultSubstrate?: CliSubstrate;
  // Global hard lock — force the interactive PTY substrate and disable the SDK
  // (see AppConfig.interactivePtyOnly). Demo mode still wins with 'sdk'.
  interactivePtyOnly?: boolean;
  // Per-provider access toggles (see AppConfig.agentProviderAccess).
  agentProviderAccess?: AgentProviderAccess;
  // Global default agent permission mode for workflow runs on both substrates ('default' | 'acceptEdits' | 'auto' | 'dontAsk'). Floors to 'default' when unset.
  defaultAgentPermissionMode?: PermissionMode;
  // Global default launch MODEL for quick sessions AND flow runs (see
  // AppConfig.defaultLaunchModel). Separate from `defaultModel` above.
  defaultLaunchModel?: string;
  // Global default launch AGENT RUNTIME for quick sessions AND flow runs (see
  // AppConfig.defaultAgentRuntime).
  defaultAgentRuntime?: AgentRuntime;
  // Global default execution model for new SDK workflow runs ('orchestrated' | 'programmatic').
  defaultExecutionModel?: ExecutionModel;
  // Fan-out dispatch mode for orchestrated INTERACTIVE runs ('prose' | 'workflow').
  // 'workflow' dispatches each inner stage of a wave to a pre-installed dynamic
  // workflow script instead of the agent driving lanes by hand; the orchestrator
  // stays the single writer either way. Defaults to 'workflow' when unset, and is NOT
  // seeded into the constructor defaults so existing config.json files stay
  // byte-identical.
  fanOutDispatch?: FanOutDispatch;
  // Per-substrate override of the sprint task-selection cap (see AppConfig.sprintMaxTasks).
  sprintMaxTasks?: SprintMaxTasksOverrides;
  // Global default for where QUICK sessions work (see AppConfig.quickSessionWorktreeMode).
  quickSessionWorktreeMode?: QuickSessionWorktreeMode;
  // Global default CLI substrate for new QUICK sessions (see AppConfig.quickSessionDefaultSubstrate).
  quickSessionDefaultSubstrate?: CliSubstrate;
  // Global on/off for the code-review eval (see AppConfig.codeReviewEvalEnabled).
  codeReviewEvalEnabled?: boolean;
  // Final-gate auto-handover kill switch (see AppConfig.autoHandoverAtFinalGate).
  autoHandoverAtFinalGate?: boolean;
  // Global run-summary computed-cost toggle (see AppConfig.computeCostFromRates).
  computeCostFromRates?: boolean;
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
  // Aria mode (see AppConfig.ariaMode) — applied on next launch.
  ariaMode?: boolean;
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
  };
  enableCyboflowFooter?: boolean;
}
