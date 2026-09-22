// FIRST import, deliberately: the timer census can only attribute timers
// scheduled AFTER it patches the globals, and several services schedule one at
// module-import time. A no-op unless CYBOFLOW_PERF_TRACE=1.
import { installTimerCensus } from './services/timerCensus';
installTimerCensus();

import { app, BrowserWindow, ipcMain, screen, shell, dialog, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { TaskQueue } from './services/taskQueue';
import { SessionManager } from './services/sessionManager';
import { ConfigManager, readTelemetryConfigSync } from './services/configManager';
import { WorktreeManager } from './services/worktreeManager';
import { GitDiffManager } from './services/gitDiffManager';
import { GitStatusManager } from './services/gitStatusManager';
import { ExecutionTracker } from './services/executionTracker';
import { ModelAvailabilityService, isModelUsable } from './services/modelAvailabilityService';
import { DatabaseService } from './database/database';
import { RunCommandManager } from './services/runCommandManager';
import { Logger } from './utils/logger';
import { startPerfTracer, perfBump } from './services/perfTracer';
import { ingestPtyTranscript } from './services/ptyTranscriptIngest';
import { ArchiveProgressManager } from './services/archiveProgressManager';
import { setCyboflowDirectory, getCyboflowSubdirectory, getCyboflowDirectory, appIconBasename } from './utils/cyboflowDirectory';
import { initTelemetry, trackUsage, captureSeamError } from './services/telemetry';
import { drainQueuedBugReports } from './services/telemetry/bugReport';
import { detectArchMismatch, formatArchMismatchLog, formatArchMismatchDialog } from './services/archGuard';
import { setTelemetrySink, setSeamErrorSink } from './orchestrator/telemetrySink';
import { getCurrentWorktreeName } from './utils/worktreeUtils';
import { installApplicationMenu } from './menu';
import {
  attachWindowStatePersistence,
  clampWindowBounds,
  defaultWindowBounds,
  loadWindowState,
  type WindowRect,
  type WindowStatePersistence,
} from './utils/windowState';
import { registerIpcHandlers } from './ipc';
import { QUICK_PTY_BRIEFING } from './ipc/quickSessionBriefings';
import { restInteractiveSessionIdle } from './ipc/interactiveSessionRest';
import { registerArtifactImageHandlers } from './ipc/artifactImages';
import { registerArtifactHtmlHandlers, loadCanonicalPrototypeHtml } from './ipc/artifactHtml';
import {
  shouldBlockArtifactFrameNavigation,
  isExternallyOpenable,
  isSafeExternalOpenTarget,
  shouldBlockScriptedFrameNavigationFromRegistry,
} from './ipc/artifactFrameGuard';
import { registerDesignPrototypeServerHandlers } from './ipc/designPrototypeServer';
import { DesignPrototypeServerManager } from './services/designPrototypeServer';
import {
  DesignFrameWatchdog,
  DESIGN_PROTO_SERVER_EVENT_CHANNEL,
  type FrameLike,
} from './services/designFrameWatchdog';
import { setupEventListeners } from './events';
import { AppServices } from './ipc/types';
import {
  CliManagerFactory,
  isCodexPtyManagerLike,
  isCodexSdkManagerLike,
  isOmpPtyManagerLike,
  isPiPtyManagerLike,
  isPiSdkManagerLike,
  isOmpSdkManagerLike,
  type CodexPtyManagerLike,
  type OmpPtyManagerLike,
  type PiPtyManagerLike,
  type PiSdkManagerLike,
} from './services/cliManagerFactory';
import { AbstractCliManager } from './services/panels/cli/AbstractCliManager';
import { panelManager } from './services/panelManager';
import { resolvePanelLane, type PanelLane } from './services/panelLane';
import { ClaudeCodeManager } from './services/panels/claude/claudeCodeManager';
import { InteractiveClaudeManager } from './services/panels/claude/interactiveClaudeManager';
import { resolveRunEffectiveAgents } from './services/panels/claude/agentOverlayWriter';
import { bareModelId, resolveModelAlias } from '../../shared/agents/modelContext';
import { resolveClaudeExecutablePath } from './services/panels/claude/claudeExecutablePath';
import { loadSdkQuery } from './utils/lazyAgentSdk';
import { makeSessionSummarizer } from './orchestrator/sessionSummary/sessionSummaryQuery';
import {
  makeSessionSummaryScheduler,
  type SessionSummarySchedulerLike,
} from './orchestrator/sessionSummary/sessionSummaryScheduler';
import { wireSessionSummaryScheduler } from './orchestrator/sessionSummary/wireSessionSummaryScheduler';
import { ClaudeModelCatalogService } from './services/claudeModelCatalogService';
import {
  SubstrateDispatchFacade,
  resolveLaneManager,
  type ManagerRegistration,
} from './services/substrateDispatchFacade';
import { setupConsoleWrapper } from './utils/consoleWrapper';
import { Orchestrator } from './orchestrator/Orchestrator';
import { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import { ApprovalRouter } from './orchestrator/approvalRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { ReviewItemRouter, reviewItemChangeEvents, reviewItemProjectChannel } from './orchestrator/reviewItemRouter';
import { humanPrerequisiteSink } from './orchestrator/humanPrerequisites';
import { AgentOverrideRouter } from './orchestrator/agentOverrideRouter';
import { FleetRegistryReader } from './orchestrator/omp/fleetRegistryReader';
import { OmpBridgeCommandAdapter } from './orchestrator/omp/ompBridgeCommandAdapter';
import { OmpBridgeHttpClient } from './orchestrator/omp/ompBridgeClient';
import { resolveOmpBridgeCommandConfig } from './orchestrator/omp/ompBridgeConfig';
import { resolveOmpPrincipal } from './orchestrator/omp/ompPrincipal';
import { OmpCommandStub } from './orchestrator/omp/ompCommandStub';
import type { OmpCommandAdapter, OmpPrincipal } from '../../shared/types/ompCommand';
import { OmpSessionManager } from './orchestrator/omp/ompSessionManager';
import { OmpSupervisedAdapter, type OmpSupervisedAuditEntry } from './orchestrator/omp/ompSupervisedAdapter';
import { hasSupervise } from '../../shared/types/ompCommand';
import { FeedbackRouter } from './orchestrator/feedbackRouter';
import { IdeaComponentRouter } from './orchestrator/ideaComponents/ideaComponentRouter';
import { setRevisionLauncher } from './orchestrator/sendFeedbackHandler';
import { runRevisionBatch } from './orchestrator/feedback/revisionWorker';
import { makeRevisionQuery } from './orchestrator/feedback/revisionQuery';
import {
  DesignFeedbackOutbox,
  setDesignBatchNotifier,
} from './orchestrator/feedback/designFeedbackOutbox';
import { ArtifactRouter } from './orchestrator/artifactRouter';
import { setRunArtifactsDirResolver } from './orchestrator/autoMintArtifacts';
import { resolveArtifactCommitDir } from './orchestrator/artifactSnapshot';
import { DesignHandoffService } from './orchestrator/design/designHandoffService';
import { GateSideEffects } from './orchestrator/gateSideEffects';
import { recoverDesignHandoffs } from './orchestrator/design/designHandoffRecovery';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { DefaultProgrammaticRunner } from './orchestrator/programmatic/defaultProgrammaticRunner';
import { buildReviewQueueHumanGate } from './orchestrator/humanGateWiring';
import { ReviewQueueBlockingItemsGate } from './orchestrator/programmatic/blockingItemsGate';
import { buildSystemicPauseGate } from './orchestrator/systemicPauseGateWiring';
import { SchedulerVisualVerifyGate } from './orchestrator/programmatic/visualVerifyGate';
import {
  DefaultMonitorSession,
  DefaultHistoryReader,
  MonitorRegistry,
  type MonitorActionResult,
  type MonitorContext,
  type MonitorSession,
} from './orchestrator/programmatic/monitor';
import { retryRunHandler, type RetryRunDeps } from './orchestrator/retryRunHandler';
import { rewindRunHandler, type RewindRunDeps } from './orchestrator/rewindRunHandler';
import { laneRewindHandler, type LaneRewindDeps } from './orchestrator/laneRewindHandler';
import { makeSdkStructuredQuery, makeSdkTextQuery } from './orchestrator/programmatic/monitorQuery';
import { StepResultStore } from './orchestrator/stepResultStore';
import { DynamicWorkflowTracker } from './orchestrator/dynamicWorkflows';
import { dockBadgeService } from './services/dockBadgeService';
import { appRouter } from './orchestrator/trpc/router';
import { createContext } from './orchestrator/trpc/context';
import type { VerifyHostProbesLike, VerifyRunbookStatusLike } from './orchestrator/trpc/context';
import type { SessionGitOpsLike } from './orchestrator/trpc/contracts/sessionGitOps';
import type { SessionOpsLike } from './orchestrator/trpc/contracts/sessionOps';
import { createConfigOps } from './ipc/configOps';
import { createGitPrerequisiteOps } from './ipc/gitPrerequisite';
import { createClaudeAuthOps } from './ipc/claudeAuth';
import { createFileOps } from './ipc/fileOps';
import { createGitOps } from './ipc/gitOps';
import { createSessionOps } from './ipc/sessionOps';
import { attachOrchestratorTrpc } from './orchestrator/trpc/ipcAdapter';
import { setCancelAndRestartDeps, setCancelRunDeps, setPauseRunDeps, setResumeRunDeps, setReopenRunDeps, setRetryRunDeps, setRewindRunDeps, setStartRunDeps, setRunCloseoutDeps, setNudgeRunDeps, setQueueInputDeps, setRelayDeps, setRunShellDeps, setSprintLaneDeps, setSetPermissionModeDeps, setSessionSettleDeps } from './orchestrator/trpc/routers/runs';
import type { SessionAgentPermissionModeDeps } from './orchestrator/sessionPermissionMode';
import { nudgeRunHandler } from './orchestrator/nudgeRunHandler';
import { RunShellManager } from './services/runShellManager';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { SprintLaneStore } from './orchestrator/sprintLaneStore';
import { VerificationScheduler, verificationEvents, verificationChannel } from './orchestrator/verify/verificationScheduler';
import type { ClaudePanelState } from '../../shared/types/panels';
import { providerForRuntime } from '../../shared/types/agentRuntime';
import { setAgentProviderAccessResolver } from '../../shared/agents/agentProviderGuard';
import { PrototypeServerReaper } from './services/prototypeServerReaper';
import { runQuitDrain } from './services/quitDrain';
import { terminalPanelManager } from './services/terminalPanelManager';
import { CodexBrokerReaper } from './services/codexBrokerReaper';
import { VitestOrphanReaper } from './services/vitestOrphanReaper';
import { McpOrphanTripwire } from './services/mcpOrphanTripwire';
import { TrackerSyncService } from './services/trackerSync/trackerSyncService';
import { DatabaseBackupService } from './services/databaseBackupService';
import { setTrackerSyncFacade } from './orchestrator/trackerSyncBridge';
import { FsBaselineStore } from './services/visualVerify/baselineStore';
import { execFileSync } from 'node:child_process';
import { setHealthProvider } from './orchestrator/trpc/routers/health';
import { setProviderUsageSource } from './orchestrator/trpc/routers/providerUsage';
import { initProviderUsageStore, tryGetProviderUsageStore } from './services/providerUsage/providerUsageStore';
import { ProviderUsagePoller } from './services/providerUsage/providerUsagePoller';
import { pollClaudeUsage, pollCodexRateLimits } from './services/providerUsage/providerUsagePollAdapters';
import {
  setReviewItemsRunProbe,
  setResolveVerdictNudgeDeps,
} from './orchestrator/trpc/routers/reviewItems';
import { setMonitorRehydrator, setFinalGateHandover } from './orchestrator/trpc/routers/monitor';
import { createFinalGateHandover } from './orchestrator/finalGateHandover';
import { createMonitorRehydrator } from './orchestrator/programmatic/monitorRehydration';
import { composeMonitorReviewQueueActions } from './monitorReviewQueueComposition';
import {
  addTaskToRun,
  removeTaskFromRun,
  editRunTask,
  type TaskMutationDeps,
  type TaskMutationResult,
  type TaskMutationNoOpReason,
} from './orchestrator/taskMutationHandler';
import {
  buildGateEscalationSinks,
  buildLaneTriageActions,
  buildMonitorFindingSink,
  buildSetAsideFindingSink,
  type GateEscalationSinks,
  type LaneTriageActions,
  type MonitorActionSinkDeps,
} from './orchestrator/monitorActionSinks';
import { resolveWorkflowDefinition } from '../../shared/types/workflows';
import { handoverRunHandler, type HandoverRunDeps } from './orchestrator/handoverRunHandler';
import { OrchestratorHealth } from './orchestrator/health';
import { McpServerLifecycle } from './orchestrator/mcpServer/mcpServerLifecycle';
import { resolveMcpServerScriptPath } from './orchestrator/mcpServer/scriptPath';
import { OrchSocketServer } from './orchestrator/mcpServer/orchSocketServer';
import { orchSocketEndpoint } from './orchestrator/mcpServer/orchSocketEndpoint';
import { approvalEvents, questionEvents, runStatusEvents, stuckEvents } from './orchestrator/trpc/routers/events';
import { EvalWorker } from './orchestrator/eval/evalWorker';
import { PairwiseJudgeWorker } from './orchestrator/eval/pairwiseJudgeWorker';
import { resolveRunFrozenSpec } from './orchestrator/runFrozenSpec';
import type { WorktreeStatusPayload } from '../../shared/types/runFiles';
import type { RunStatusChangedEvent } from '../../shared/types/cyboflow';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../shared/types/cyboflow';
import { cancelRunHandler } from './orchestrator/cancelRunHandler';
import { randomUUID } from 'node:crypto';
import { AgentThreadDbStore } from './orchestrator/agentThread/agentThreadDbStore';
import { AgentThreadService } from './orchestrator/agentThread/agentThreadService';
import {
  setProposalExecutorDeps,
  reconcileOrphanedExecutingProposals,
  executeProposal,
  getProposalExecutorDeps,
  type ProposalExecutorDeps,
  type TaskFieldsSnapshot,
} from './orchestrator/agentThread/proposalExecutor';
import { prepareProposal, createPrepareProposalDeps } from './orchestrator/agentThread/prepareProposal';
import { buildProposalExecutorLaunchDeps } from './orchestrator/agentThread/proposalExecutorLaunchDeps';
import { buildProposalExecutorReviewDeps } from './orchestrator/agentThread/proposalExecutorReviewDeps';
import { buildProposalExecutorQuickSessionDeps } from './orchestrator/agentThread/proposalExecutorQuickSessionDeps';
import { generateQuickWorktreeBranchName } from './ipc/session';
import { reportEagerSpawnFailure } from './ipc/eagerSpawnFailure';
import { buildProposalExecutorWorkflowDeps } from './orchestrator/agentThread/proposalExecutorWorkflowDeps';
import { CustomViewsDbStore } from './orchestrator/customViews/customViewsStore';
import { createCustomViewsService, type CustomViewsServiceLike } from './orchestrator/customViews/customViewsService';
import { CATALOG_WIDGET_SPECS } from '../../shared/customViews/catalogSpecs';
import { WIDGET_THEME_TOKENS } from '../../shared/customViews/theme';
import { CustomWidgetServerManager } from './services/customWidgetServer';
import {
  DESIGN_MODE_KICKOFF_PROMPT,
  finishDesignSessionCreate,
  type DesignSessionLaunchDeps,
} from './orchestrator/designSessionLaunch';
import { validateDesignIdeaLink } from './services/designIdeaValidation';
import {
  runClaudeSdkSessionPreflights,
  type ClaudeSdkPreflightFailure,
} from './services/claudeSdkSessionPreflight';
import { findIdeaBusyReason } from './orchestrator/ideaBusy';
import { setOpenIdeaSessionDeps } from './services/openIdeaSessionCore';
import { agentThreadEvents } from './orchestrator/trpc/routers/agentThread';
import type { ApprovalRequest } from './orchestrator/approvalRouter';
import type { QuestionRequest } from './orchestrator/questionRouter';
import type { ApprovalDecidedEvent } from '../../shared/types/approvals';
import type { QuestionAnsweredEvent } from '../../shared/types/questions';
import type { ClaudeStreamEvent, StreamEnvelope } from '../../shared/types/claudeStream';
import { buildApprovalCreatedEvent } from './orchestrator/approvalCreatedBridge';
import { buildQuestionCreatedEvent } from './orchestrator/questionCreatedBridge';
import { WorkflowRegistry } from './orchestrator/workflowRegistry';
import { buildBuiltInWorkflows } from './orchestrator/workflows/builtInWorkflows';
import { makeChatSentinelProvider } from './orchestrator/chatSentinelProvider';
import { RunLauncher } from './orchestrator/runLauncher';
import type { StreamEventPublisher, OrchSocketProvider, BridgeScriptResolver, NodeResolver } from './orchestrator/runLauncher';
import { VariantResolver } from './orchestrator/variantResolver';
import { McpConfigWriter } from './orchestrator/mcpConfigWriter';
import { RunExecutor } from './orchestrator/runExecutor';
import type { LifecycleTransitionsLike, StepTransitionEmitterLike, IdeaBodyReaderLike, WorkflowPromptReaderLike } from './orchestrator/runExecutor';
import { buildSeedTasksBlock } from './orchestrator/seedTasksBlock';
import { listRunOwnedIdeaIds } from './orchestrator/runEntityOwnership';
import { readRunDigest } from './orchestrator/runDigestReader';
import { selectTaskById, selectIdeaAttachments } from './orchestrator/taskListing';
import { createSeededFindingReader } from './orchestrator/seededFindingReader';
import { buildStepTransitionEvent, resolveRunLevelStepId } from './orchestrator/stepTransitionBridge';
import {
  transitionToRunning,
  transitionRunningToAwaitingReview,
  transitionToFailed,
  transitionToCanceled,
} from './services/cyboflow/transitions';
import { readWorkflowPromptForRow, resolveRunPromptContext } from './orchestrator/workflowPromptReaderAdapter';
import { makeLoggerLike, makeDatabaseLike } from './orchestrator/loggerAdapter';
import {
  recoverActiveStateOrphans,
  recoverArchivedSessionRunOrphans,
  backfillArchivedSessionReviewItems,
  backfillInterruptedOutcomes,
  backfillTerminalOutcomes,
  backfillRunUsageRollups,
  stampSessionRunsOutcome,
} from './orchestrator/runRecovery';
import { setExperimentsDeps } from './orchestrator/trpc/routers/experiments';
import {
  recoverExperiments,
  dismissAndSweepHalfCreatedExperiment,
  reconcileAllRotationExperiments,
} from './orchestrator/experimentStore';
import {
  createQuickSessionCore,
  resolveNonClaudeSessionRuntime,
  stampQuickSessionRuntimeConfig,
} from './services/createQuickSessionCore';
import * as fs from 'fs';
import { getDevDebugLogPath, appendDevDebugLog, formatConsoleArgs, flushDevDebugLogs } from './utils/devDebugLog';
import type { DevLogLevel } from './utils/devDebugLog';
import { getBootDatabasePath, getDemoBootEnvironment, getDemoBootError } from './services/demo/demoBootstrap';
import { runGitAsync, END_OF_OPTIONS, assertNotOptionLike } from './utils/runGit';
import { resolveGitCommand } from './utils/gitExeFinder';
import { setStreamParserPerfBump } from '../../shared/streamParser';
import { setProjectPermissionTrustResolver } from './orchestrator/permissionRules';
import { composeVerification } from './verifyComposition';
import { composeEvalWorkers } from './evalComposition';

// Wire the shared/streamParser module's perf-counter hook to the real perfTracer
// (perfBump is a no-op unless CYBOFLOW_PERF_TRACE=1, so unconditional wiring is
// correct). shared/ must not import from main/src/services directly.
setStreamParserPerfBump(perfBump);

export let mainWindow: BrowserWindow | null = null;
// Geometry persistence for the CURRENT main window (utils/windowState.ts).
// Module-level so the 'Quit Anyway' app.exit() path can flush it; re-bound on
// every createWindow (the previous controller disposes itself on 'closed').
let windowStatePersistence: WindowStatePersistence | null = null;

/**
 * Design-mode-FORK wording for each rung of the shared SDK-pinned pre-flight
 * ladder (services/claudeSdkSessionPreflight.ts). Deliberately terser than the
 * `sessions:create-quick` handler's copy — this fork has no renderer client, so
 * the text lands in a review-queue finding rather than a toast. Kept
 * byte-identical to what createDesignSession threw before the ladder was
 * extracted.
 */
const DESIGN_FORK_PREFLIGHT_MESSAGES: Readonly<Record<ClaudeSdkPreflightFailure, string>> = {
  provider_disabled: 'Design sessions require Claude, which is turned off in Settings → Integrations.',
  claude_not_detected:
    'Design sessions require the Claude SDK substrate — Claude credentials/binary not detected.',
  interactive_pty_only:
    'Design sessions cannot run on the interactive substrate, but this app is locked to interactive-PTY-only mode.',
};

// Strip PER-RUN cyboflow env inherited from a HOSTING cyboflow session
// (dogfooding: `pnpm dev` launched from a shell inside another cyboflow
// instance). These vars are only meaningful when stamped per spawned agent by
// the panel managers; inherited values are ALWAYS stale here — and because dev
// instances share ~/.cyboflow_dev, a leaked CYBOFLOW_RUN_ID can even RESOLVE
// (to the hosting session's run), silently misdirecting any child process that
// spreads process.env without re-stamping (e.g. terminal panels, shell hooks).
// runShellManager.ts deletes CYBOFLOW_RUN_ID for its own spawns for exactly
// this reason; this boot-time strip closes every other path at the source.
// Deliberately NOT stripped: user-facing config/kill-switch vars
// (CYBOFLOW_DIR, CYBOFLOW_DISABLE_WARM_SDK, CYBOFLOW_DEV_FORCE_GATE_STREAM_CLOSED).
for (const key of [
  'CYBOFLOW_RUN_ID',
  'CYBOFLOW_SESSION_ID',
  'CYBOFLOW_ORCH_SOCKET',
  // A hosting instance's bearer token is not only stale here, it is a live
  // credential for ANOTHER app instance's run — strip it hardest of all.
  'CYBOFLOW_ORCH_TOKEN',
  'CYBOFLOW_RUN_ARTIFACTS_DIR',
  'CYBOFLOW_SUBSTRATE',
  'CYBOFLOW_EXECUTION_MODEL',
]) {
  delete process.env[key];
}

// Set by the boot-time schema-version gate when the user picked "Check for
// Updates" on a database that a newer build advanced. Consumed once by the
// renderer (Sidebar) on mount to auto-open Settings → Updates.
let pendingOpenUpdateSettings = false;

/**
 * Set the application title based on development mode and worktree
 */
function setAppTitle() {
  // A verification instance's window title IS its identity — it is the
  // native-screen window-identity attestation channel of
  // .cyboflow/verify-runbook.json — so it outranks both the worktree and the
  // default title. The override lives HERE, at the single seam that
  // programmatically sets the title, rather than only at the createWindow call
  // site: setAppTitle() runs again once the renderer has loaded, and would
  // otherwise reset the verify title back to plain 'Cyboflow'.
  const verifyToken = process.env.CYBOFLOW_VERIFY_TOKEN;
  if (verifyToken) {
    const title = `Cyboflow — verify ${verifyToken}`;
    if (mainWindow) {
      mainWindow.setTitle(title);
    }
    return title;
  }

  if (!app.isPackaged) {
    const worktreeName = getCurrentWorktreeName(process.cwd());
    if (worktreeName) {
      const title = `Cyboflow [${worktreeName}]`;
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
      return title;
    }
  }

  // Default title
  const title = 'Cyboflow';
  if (mainWindow) {
    mainWindow.setTitle(title);
  }
  return title;
}
let taskQueue: TaskQueue | null = null;
let orchestrator: Orchestrator | null = null;
// Read-only OMP fleet adapter — ONE module-scope instance shared by the
// Orchestrator (dep bag) and the tRPC context, so both layers observe the same source.
const fleetRegistryReader = new FleetRegistryReader();

/**
 * The OMP command principal and audit sink, at module scope so the tRPC context
 * and the fleet session manager share ONE identity and ONE trail.
 *
 * Resolved lazily rather than as a module-scope const: the supervise capability
 * comes from Aria mode (`configManager.getAriaMode()`), and configManager is not
 * constructed at module-evaluation time.
 *
 * Every consumer takes this FUNCTION, never a snapshot of its result — the tRPC
 * context calls it per request, and both `OmpSupervisedAdapter` instances hold
 * the thunk and resolve per command. So flipping Aria mode takes effect on the
 * next call in either direction, with no relaunch: granting it makes fleet
 * sessions launchable, revoking it forbids the very next command.
 */
function currentOmpPrincipal(): OmpPrincipal {
  // Guarded: a caller before initializeServices() gets the fail-closed answer
  // rather than a crash.
  let ariaMode = false;
  try {
    ariaMode = configManager.getAriaMode();
  } catch {
    ariaMode = false;
  }
  return resolveOmpPrincipal(ariaMode);
}
const auditOmp = (entry: OmpSupervisedAuditEntry): void => {
  logger.info(
    `omp:audit ${entry.outcome} ${entry.verb} op=${entry.operationId} by=${entry.principal} ${entry.detail}`,
  );
};

/**
 * Build the privileged OMP command adapter: a real bridge client when the
 * bridge is configured, else the fail-closed stub. Always wrapped in
 * `OmpSupervisedAdapter`, so the capability gate and the audit trail hold for
 * every caller rather than only for the ones that remember to check.
 */
function buildOmpCommandAdapter(): OmpCommandAdapter {
  const config = resolveOmpBridgeCommandConfig();
  if (config === undefined) {
    logger.info('omp:command adapter unconfigured — commands will return unavailable');
    return new OmpCommandStub();
  }
  logger.info(`omp:command adapter configured for session ${config.sessionId}`);
  return new OmpSupervisedAdapter(
    new OmpBridgeCommandAdapter(new OmpBridgeHttpClient(config.url, config.token, config.sessionId)),
    // The THUNK, not a snapshot: this adapter is built once per window attach
    // and retained, so a captured principal would freeze the capability at
    // whatever Aria mode was when the window opened.
    currentOmpPrincipal,
    auditOmp,
  );
}
// OMP fleet runtime manager (omp-phase4-coexistence-adr.md increment 4). Built
// fail-closed in initializeServices(): present ONLY when the bridge command
// config resolved at boot; `undefined` means OMP is not launchable and both the
// dispatch seams and the picker omit it (never a fallback to a local provider).
let ompSessionManager: OmpSessionManager | undefined;

let runQueues: RunQueueRegistry;
let workflowRegistry: WorkflowRegistry;
let runLauncher: RunLauncher;
// Module-scoped so the tRPC boot wiring block (setNudgeRunDeps) can reach the
// same RunExecutor instance built in initializeServices().
let runExecutor: RunExecutor;
// Global-agent chat thread (migration 071). Both are built in
// initializeServices() (the store BEFORE the OrchSocketServer so its
// McpQueryHandler gets it; the service under the ClaudeCodeManager instanceof
// narrowing) and read later in app.whenReady()'s createContext + proposal-executor
// wiring — hence module scope. The service is null when the default CLI manager is
// not a ClaudeCodeManager (the isolation spawn fields require it); the router
// guards on it.
let agentThreadStore: AgentThreadDbStore;
let agentThreadService: AgentThreadService | null = null;
// The in-app Claude sign-in runner (main/src/ipc/claudeAuth.ts). Module-level
// so before-quit can kill a `claude auth login` still waiting on its stdin.
let claudeAuthOps: ReturnType<typeof createClaudeAuthOps> | null = null;
// Custom Views (migration 132, docs/proposals/CUSTOM-VIEWS.md §9 row S3).
// Built in initializeServices() right after agentThreadStore (same cyboflowDb,
// same "store before anything reaches for it" ordering) and read later by the
// tRPC createContext block + the widget server's loadWidget — hence module
// scope. customViewsService closes over agentThreadStore/agentThreadService
// LAZILY (ensureGlobalThreadId reads the module var at call time), so it is
// safe to construct before agentThreadService exists.
let customViewsStore: CustomViewsDbStore | null = null;
let customViewsService: CustomViewsServiceLike | null = null;
// Monitor-actuation seam (retry_step): bound in the tRPC dep-wiring block —
// where db/runQueues/runExecutor are all live — to the SAME retryRunHandler
// chokepoint the runs.retryStep mutation uses. The monitorFactory (built earlier,
// in initializeServices) closes over this holder so a monitor session can execute
// a validated retry at any point in a run's life. Null until wired → the action
// reports "not wired" instead of acting.
let monitorRetryStep: ((runId: string, stepId?: string) => Promise<MonitorActionResult>) | null =
  null;
// Monitor-actuation seam (switch_to_orchestrated): same late-binding pattern as
// monitorRetryStep — bound in the tRPC dep-wiring block to the handoverRunHandler
// chokepoint (the one-way programmatic -> orchestrated handover). Null until
// wired → the action reports "not wired" instead of acting.
let monitorSwitchToOrchestrated:
  | ((runId: string, reason: string) => Promise<MonitorActionResult>)
  | null = null;
// Monitor-actuation seam (the 10 confirm-gated steering actions: add/remove/edit
// task, skip/unskip/steer step, the whole-run rewind, the PER-LANE rewind,
// resolve review item, file note). Same late-binding pattern as the two above —
// bound in the tRPC dep-wiring block where db / runExecutor / the routers are all
// live. Grouped into one holder object (rather than 10 separate module vars)
// since they share a wiring site. Null until wired → each action reports "not available yet"
// instead of acting.
interface MonitorSteeringActions {
  addTask(runId: string, input: { title: string; body?: string; priority?: string }): Promise<MonitorActionResult>;
  removeTask(runId: string, input: { taskRef: string }): Promise<MonitorActionResult>;
  editTask(
    runId: string,
    input: { taskRef: string; title?: string; body?: string; priority?: string },
  ): Promise<MonitorActionResult>;
  skipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  unskipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  steerStep(
    runId: string,
    input: { stepId: string; guidance: string; taskRef?: string },
  ): Promise<MonitorActionResult>;
  rewindToStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  rewindLaneToStep(
    runId: string,
    input: { taskRef: string; stepId: string },
  ): Promise<MonitorActionResult>;
  resolveReviewItem(
    runId: string,
    input: { reviewItemId: string; outcome?: 'approve' | 'reject' | 'revise'; resolution?: string },
  ): Promise<MonitorActionResult>;
  fileNote(runId: string, input: { title: string; body?: string }): Promise<MonitorActionResult>;
}
let monitorSteeringActions: MonitorSteeringActions | null = null;

/**
 * Composition-root collaborators for the monitor's AUTONOMOUS actions — lane
 * triage, the supervised review loop, the gate escalation review. Built in
 * `monitorActionSinks.ts` (see its header); late-bound like
 * `monitorSteeringActions`, and null until that block runs ⇒ the host behaves
 * exactly as it does with nothing wired, which is the safe default.
 */
let laneTriageActions: LaneTriageActions | null = null;
let monitorFindingSink: ReturnType<typeof buildMonitorFindingSink> | null = null;
let setAsideFindingSink: ReturnType<typeof buildSetAsideFindingSink> | null = null;
let gateEscalationSinks: GateEscalationSinks | null = null;
/** Fallback when a steering action fires before the dep-wiring block ran. */
const STEERING_NOT_WIRED: MonitorActionResult = {
  ok: false,
  message: "That action isn't available yet — try again in a moment.",
};
// Monitor-session construction closure (monitor lazy-rehydration): assigned when
// the monitorFactory is built in initializeServices() and reused by the lazy
// rehydrator wired in the tRPC dep-wiring block, so a session REVIVED after an
// app restart (monitorRehydration.ts) is byte-identical in shape — same query
// fns, history reader, and actuation bag — to one built at run start. Null until
// initializeServices runs (the rehydrator is wired later, so it never observes
// null in practice; its wiring throws defensively if it does).
let buildMonitorSession:
  | ((
      ctx: MonitorContext,
      injectEvent: ((event: ClaudeStreamEvent) => void) | undefined,
    ) => MonitorSession)
  | null = null;
// Module-scoped (permission-mode redesign §3d / Slice 5) so the tRPC boot wiring
// block (setSetPermissionModeDeps) can reach the SAME shared session-mode write
// chokepoint deps the RunLauncher was constructed with in initializeServices().
let sessionPermissionModeDeps: SessionAgentPermissionModeDeps;
let orchestratorHealth: OrchestratorHealth;
// Promoted to module scope (IDEA-030 / TASK-817) so the run dep-bag wiring in
// the app.whenReady() block can reach it for the live-input relay. Assigned in
// initializeServices(); the in-function usages (RunExecutor source/spawner +
// pty-output fan-in) read the same instance.
let substrateFacade: SubstrateDispatchFacade;
/** Narrowed interactive PTY manager, shared with the experiments arm wiring. */
let interactiveReplManager: InteractiveClaudeManager;
// Session Dismiss → cancel hosted runs. Declared at module scope because the
// services bag (initializeServices) defers to it while the REAL implementation
// is assigned in app.whenReady()'s orchestrator wiring block (it needs
// substrateFacade + the routers). A pre-boot call is a logged no-op.
let cancelHostedRunsImpl: ((sessionId: string) => Promise<void>) | null = null;
// Idle-debounced quick-session summarizer (session-summary-plan.md §5). Declared
// at module scope so the before-quit handler can dispose its pending timers; the
// instance is built + wired in app.whenReady() where the substrate managers exist.
let sessionSummaryScheduler: SessionSummarySchedulerLike | undefined;

// Service instances
let configManager: ConfigManager;
let logger: Logger;
let sessionManager: SessionManager;
let worktreeManager: WorktreeManager;
let cliManagerFactory: CliManagerFactory;
let defaultCliManager: AbstractCliManager;
let codexPtyManager: CodexPtyManagerLike;
let ompPtyManager: OmpPtyManagerLike;
let piPtyManager: PiPtyManagerLike;
let piSdkManager: PiSdkManagerLike;
let gitDiffManager: GitDiffManager;
let gitStatusManager: GitStatusManager;
let executionTracker: ExecutionTracker;
let databaseService: DatabaseService;
let runCommandManager: RunCommandManager;
let archiveProgressManager: ArchiveProgressManager;
// Run user-shells (worktree-terminal feature). Module-level so the before-quit
// handler (outside the orchestrator-setup block) can destroyAll() on app quit.
let runShellManager: RunShellManager | null = null;

// Reaper for the detached `python3 -m http.server` prototype servers the
// Planner/Ship ui-prototype subagent starts (TASK-057). Module-level so the
// run close-out / cancel dep bags, the boot sweep, and the before-quit handler
// all share ONE instance. Stateless (ps + process.kill) — safe to construct at
// module load; the logger is optional, so no whenReady wiring is required.
const prototypeServerReaper = new PrototypeServerReaper();

// Design Mode v1 interactive prototype server + frame watchdog (design-mode.md
// "Process isolation"). Module-level so the initializeServices construction, the
// main-window 'closed' handler, and the before-quit teardown all share ONE
// instance. Constructed in initializeServices (its HTML loader needs `services`),
// so it is null until boot finishes wiring.
let designPrototypeServerManager: DesignPrototypeServerManager | null = null;
// Custom Views tier-3 widget document server (docs/proposals/CUSTOM-VIEWS.md
// §5.4) — a single PROCESS-GLOBAL server, unlike the per-run prototype server
// above. Constructed alongside it (same watchdog) so both share one frame
// watchdog instance; stopped at the same two teardown sites.
let customWidgetServerManager: CustomWidgetServerManager | null = null;

// Design Mode v1 design-feedback delivery pipeline (design-mode.md "Design
// feedback v1 — acknowledged durable outbox"). Module-level so the deferred boot
// recovery scan (runDeferredStartupWork) can reach the SAME instance the
// sendDesignBatch poke drives. Constructed in initializeServices — its
// dispatchTurn seam needs the Claude panel manager, which only exists once
// registerIpcHandlers has run — so it is null until boot finishes wiring.
let designFeedbackOutbox: DesignFeedbackOutbox | null = null;

// Reaper for the detached `openai-codex` plugin broker daemons a Codex-using
// session leaks into a worktree (see CodexBrokerReaper). Stateless (ps +
// process.kill + fs.existsSync) — safe to construct at module load. Wired into
// WorktreeManager (reap on worktree removal) and the boot sweep below.
const codexBrokerReaper = new CodexBrokerReaper();

// Reaper for abandoned vitest fork-pool workers (see VitestOrphanReaper). A gate
// whose root was hard-killed — an agent Bash timeout, a stopped session, run
// teardown — leaves its pool spinning at full CPU forever. Stateless (ps +
// process.kill), so safe to construct at module load; boot-swept and then swept on
// an interval below, and stopped in before-quit.
const vitestOrphanReaper = new VitestOrphanReaper();

// Observe-only tripwire (Phase 3 of the cyboflowMcpServer spawner-death fix,
// see parentWatchdog.ts) for orphaned cyboflowMcpServer subprocesses. Has NO
// kill authority — it exists solely to prove the Phase 1 ppid-watchdog fix is
// still working, since a CLI-spawned server's own stderr is unreachable once
// its parent is dead.
//
// Null until boot wires it, like trackerSyncService below: its entire output is
// log lines, so it MUST be constructed with the real application logger, and
// that does not exist at module load. (Constructing it here with no logger
// silently produced a tripwire that observed correctly and reported to nobody —
// a verification channel verifying nothing, which is the exact failure it is
// meant to catch elsewhere. The logger is now a required constructor arg so
// that instance no longer type-checks.)
let mcpOrphanTripwire: McpOrphanTripwire | null = null;

// Issue-tracker sync loop — Linear/Plane (docs/proposals/tracker-sync-integration.md).
// Module-level so the before-quit handler can stop it; constructed + started in
// initializeServices (it needs the sqlite handle plus TaskChangeRouter), so it is
// null until boot finishes wiring.
let trackerSyncService: TrackerSyncService | null = null;

// Daily sessions.db backup service (7-day retention). Module-level so the
// before-quit handler can stop it; constructed + started in initializeServices
// (it needs the open sqlite handle), so it is null until boot finishes wiring,
// and stays null in demo mode (demo.db is reset every launch — nothing worth
// backing up).
let databaseBackupService: DatabaseBackupService | null = null;

// Store original console methods before overriding
// These must be captured immediately when the module loads
const originalLog: typeof console.log = console.log;
const originalError: typeof console.error = console.error;
const originalWarn: typeof console.warn = console.warn;
const originalInfo: typeof console.info = console.info;

const isDevelopment = process.env.NODE_ENV !== 'production' && !app.isPackaged;

// Reset debug log files at startup in development mode
if (isDevelopment) {
  const frontendLogPath = getDevDebugLogPath('frontend');
  const backendLogPath = getDevDebugLogPath('backend');

  try {
    fs.writeFileSync(frontendLogPath, '');
    fs.writeFileSync(backendLogPath, '');
  } catch (error) {
    // Don't crash if we can't reset the log files
    console.error('Failed to reset debug log files:', error);
  }
}

// Set up console wrapper to reduce logging in production
setupConsoleWrapper();

// Global crash guards. Two independent failure modes were surfacing the native
// Electron crash dialog:
//   1. An async 'error' event on process.stdout/stderr (EPIPE when the pipe on
//      the other end closes — e.g. a parent/sibling process that spawned us via
//      piped stdio exits) has no default listener and is thrown as an
//      uncaughtException.
//   2. Any other uncaught error / unhandled rejection in the main process (there
//      was previously NO top-level handler) tore the whole app down.
// Neither should kill the app. Swallow EPIPE quietly; log everything else via the
// ORIGINAL console (the logger may itself be mid-failure) and keep running.
const swallowStreamError = (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return; // pipe closed on the other end — nothing to do
  try {
    originalError('[Main] stdout/stderr stream error:', err);
  } catch {
    // console itself is broken; nothing more we can safely do
  }
};
process.stdout.on('error', swallowStreamError);
process.stderr.on('error', swallowStreamError);

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return; // broken pipe — non-fatal, do not crash
  try {
    originalError('[Main] Uncaught exception (kept alive):', err);
  } catch {
    // swallow — crashing here would defeat the purpose
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    originalError('[Main] Unhandled promise rejection (kept alive):', reason);
  } catch {
    // swallow
  }
});

// Route node's process warnings (DeprecationWarning, ExperimentalWarning, a
// MaxListenersExceededWarning) to WARN instead of ERROR. Node's own default
// 'warning' listener prints them with console.error, and createWindow maps
// console.error -> logger.error, so a deprecation notice from a dependency
// landed in the on-disk log at ERROR. That channel is what post-hoc triage reads
// first — the 2026-08-06 smoke run found DEP0180 sitting as one of the log's two
// ERROR lines and filed it, which is the correct read of a level that was wrong.
// A warning is not an app fault; it belongs at WARN, where it still persists
// (Logger.shouldPersist keeps WARN unconditionally) without costing signal.
//
// removeAllListeners is required, not merely tidy: node ATTACHES its default
// listener at bootstrap and adding ours would print every warning twice, once at
// each level. Done here at module scope, before app code registers anything on
// this channel. console.warn is resolved at emit time, so warnings raised after
// createWindow's overrides install still reach the logger.
process.removeAllListeners('warning');
process.on('warning', (warning: Error & { code?: string; detail?: string }) => {
  try {
    const code = warning.code ? ` [${warning.code}]` : '';
    const detail = warning.detail ? `\n${warning.detail}` : '';
    console.warn(`(node:${process.pid})${code} ${warning.name}: ${warning.message}${detail}`);
  } catch {
    // swallow — a broken console must not turn a warning into a crash
  }
});

// Parse command-line arguments for custom Cyboflow directory
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // Support --cyboflow-dir=/path, --cyboflow-dir /path (canonical) and --crystal-dir (deprecated alias)
  if (arg.startsWith('--cyboflow-dir=') || arg.startsWith('--crystal-dir=')) {
    const flagName = arg.startsWith('--cyboflow-dir=') ? '--cyboflow-dir=' : '--crystal-dir=';
    const dir = arg.substring(flagName.length);
    setCyboflowDirectory(dir);
    console.log(`[Main] Using custom Cyboflow directory: ${dir}`);
    if (flagName === '--crystal-dir=') {
      console.warn('[Main] --crystal-dir is deprecated; use --cyboflow-dir');
    }
  } else if ((arg === '--cyboflow-dir' || arg === '--crystal-dir') && i + 1 < args.length) {
    const dir = args[i + 1];
    setCyboflowDirectory(dir);
    console.log(`[Main] Using custom Cyboflow directory: ${dir}`);
    if (arg === '--crystal-dir') {
      console.warn('[Main] --crystal-dir is deprecated; use --cyboflow-dir');
    }
    i++;
  }
}

// Install Devtron in development
if (isDevelopment) {
  // Devtron can be installed manually in DevTools console with: require('devtron').install()
}

// Chromium's network service can crash and restart during the initial dev-server
// load (observed on macOS: "Network service crashed, restarting service" →
// ERR_FAILED (-2) loading http://localhost:<vite port>). The service comes back
// within a second, so retry the load rather than leaving a blank window with a
// dead tRPC transport. Only the initial in-flight load is the casualty; a short
// retry recovers.
async function loadDevUrlWithRetry(win: BrowserWindow, url: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL(url);
      return;
    } catch (err) {
      const isLast = i === attempts - 1;
      console.warn(`[Main] dev renderer load failed (attempt ${i + 1}/${attempts}): ${String(err)}`);
      if (isLast) throw err;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

// Dogfood prerequisite (verification-setup-flow.md §5.4): a verification
// instance of cyboflow launches with CYBOFLOW_VITE_PORT=$VERIFY_PORT and
// CYBOFLOW_CDP_PORT=$VERIFY_DRIVER_PORT (plus its own CYBOFLOW_DIR) so it
// never contends with the developer's own `pnpm dev` instance for the
// renderer port or the debug-port singleton — mirrors the leased-port
// parameterization already applied to the `electron-dev` script and
// vite.config.ts. Defaults reproduce the historical hardcoded values exactly.
const DEV_RENDERER_PORT = process.env.CYBOFLOW_VITE_PORT ?? '4521';

/** Human label for the running kind, used only in the already-running dialog. */
function describeInstanceKind(dataDir: string): string {
  if (dataDir.endsWith('.cyboflow_dev_dmg')) return 'Cyboflow Dev';
  if (dataDir.endsWith('.cyboflow_dev')) return 'Cyboflow (dev server)';
  return 'Cyboflow';
}

// Single-instance-per-kind guard (OS-backed). Each kind (stable / pnpm dev / Dev
// DMG) resolves its own data dir; pointing Electron's userData under that dir
// makes app.requestSingleInstanceLock() — whose lock is keyed on the userData
// path — atomically per-kind. So one of each kind runs in parallel while a second
// instance of the SAME kind is blocked race-free (replacing a hand-rolled PID
// lockfile that had a create/inspect/delete TOCTOU: two near-simultaneous
// launches could both acquire). Runs at module load, before app 'ready' and
// before anything touches userData, as setPath('userData') and the lock both
// require. The data dir is read AFTER arg parsing so a --cyboflow-dir override is
// honored. The only app code that reads app.getPath('userData') is the bug
// reporter's offline queue, which WANTS to land under the kind's data dir, so
// relocating it is side-effect-free beyond Electron's own state isolation.
// (Window geometry deliberately does NOT go through userData — it resolves the
// kind's data dir itself, so it stays isolated even if this setPath fails.)
const kindDataDir = getCyboflowDirectory();
try {
  const electronUserData = path.join(kindDataDir, 'electron');
  fs.mkdirSync(electronUserData, { recursive: true });
  app.setPath('userData', electronUserData);
} catch (err) {
  console.error('[Main] Failed to set per-kind userData path:', err);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance of this kind already owns the data dir. Inform + quit; the
  // dialog needs the app ready, so defer it and exit unconditionally after.
  console.warn(`[Main] Another instance is already running against ${kindDataDir} — exiting this instance`);
  app
    .whenReady()
    .then(() => {
      const kind = describeInstanceKind(kindDataDir);
      dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Cyboflow',
        message: `${kind} is already running`,
        detail:
          `Another ${kind} instance is already using its data directory:\n${kindDataDir}\n\n` +
          'Only one instance of each kind can run at a time. Switch to the running ' +
          'window, or quit it first if it is stuck.',
      });
    })
    .finally(() => app.exit(0));
}

/**
 * Late-bound host-capability probes for the phase-3 verify health panel (§6).
 *
 * Set inside initializeServices() from composeVerification()'s result
 * (verifyComposition.ts, where the Playwright / Peekaboo backends and the
 * injected driver-CLI path live); read LAZILY by the per-request
 * context factory below (same shape as the proposal-executor holder). Undefined
 * before services come up, which the `hostProbes` procedure reports as
 * PRECONDITION_FAILED rather than as a host with nothing installed.
 */
let verifyHostProbes: VerifyHostProbesLike | undefined;

/**
 * The health panel's runbook-status resolver — the SAME closure the scheduler's
 * `runbookStatus` dependency gets (both come out of composeVerification() in
 * verifyComposition.ts and are assigned together at the call site below).
 *
 * One implementation, deliberately: the panel's badge and the §3.2 degrade gate
 * answer the same question, and a second read of `verify_runbook_local.status`
 * is how they came to disagree — a record marked proven whose portable half sits
 * on an unmerged branch made the gate skip every request while the panel showed
 * "Set up". See {@link ContextDeps.verifyRunbookStatus}.
 */
let verifyRunbookStatus: VerifyRunbookStatusLike | undefined;

/**
 * The `cyboflow.sessionGit` router's ops implementation (slice 3 of the
 * IPC→tRPC migration), built inside initializeServices from the SAME AppServices
 * object `registerIpcHandlers` receives — that object is assembled there and is
 * not in scope here, and its close-out seams (`endLiveSession` in particular)
 * must be the very instances the rest of the IPC layer uses, so a module-scope
 * holder is how attachOrchestratorTrpcToWindow reaches it.
 *
 * Read LAZILY by the per-request context factory below (same shape as the
 * host-probe holder above), so a window attached before initializeServices
 * finished still sees the ops once they exist. Undefined before then, which the
 * router reports as PRECONDITION_FAILED.
 */
let sessionGitOps: SessionGitOpsLike | undefined;

/**
 * The `cyboflow.sessions` router's ops implementation (batch 1 of the
 * session-surface IPC→tRPC migration) — the exact twin of the sessionGit holder
 * above, and for the same reason: createSessionOps needs the full AppServices
 * object, which is assembled inside initializeServices and is not in scope
 * here. Read LAZILY by the per-request context factory below, so a window
 * attached before initializeServices finished still sees the ops once they
 * exist. Undefined before then, which the router reports as
 * PRECONDITION_FAILED.
 */
let sessionOps: SessionOpsLike | undefined;

/**
 * Resolve a caller-supplied ref (branch, tag, sha) to a concrete commit sha for
 * the run-scoped `gitDiff` context closure (TASK-211), or `null` when the ref is
 * falsy or fails to resolve. Mirrors GitDiffManager's private
 * `resolveRefForDiff` (TASK-208 ref-safety discipline) rather than reaching into
 * that class's internals: `END_OF_OPTIONS` forces the ref into a value position
 * and `^{commit}` forces a commit-ish resolution that an option-like string can
 * never satisfy.
 */
async function resolveGitRefToSha(worktreePath: string, ref: string | undefined): Promise<string | null> {
  if (!ref) return null;
  try {
    assertNotOptionLike(ref, 'diff ref');
    const resolved = (
      await runGitAsync(worktreePath, ['rev-parse', '--verify', END_OF_OPTIONS, `${ref}^{commit}`])
    ).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * A `WorktreeStatusPayload` stub for callers that capture a `RunGitDiff` but
 * have no meaningful worktree status to report (e.g. the eval snapshot's
 * fail-soft closure, TASK-211). Still declares all four `DiffGroupScope`
 * groups (zeroed) per WorktreeStatusPayload's fixed-shape doc comment, rather
 * than an empty `groups` array.
 */
const EMPTY_WORKTREE_STATUS: WorktreeStatusPayload = {
  entries: [],
  groups: [
    { scope: 'unstaged', files: [], additions: 0, deletions: 0 },
    { scope: 'staged', files: [], additions: 0, deletions: 0 },
    { scope: 'untracked', files: [], additions: 0, deletions: 0 },
    { scope: 'committed', files: [], additions: 0, deletions: 0 },
  ],
  committedUnavailable: true,
};

/**
 * Bind the single orchestrator tRPC IPC handler to a BrowserWindow.
 *
 * Called from createWindow() BEFORE the renderer loads (the first window) and
 * again on the macOS 'activate' re-created window. The adapter creates the
 * global trpc-electron handler exactly once and only attachWindow()s thereafter
 * (see ipcAdapter.ts), so the initial and re-created windows call this the same
 * way. Requires initializeServices() to have run — createWindow is only ever
 * invoked after it, so databaseService / configManager / workflowRegistry /
 * gitDiffManager and the AgentOverrideRouter singleton are all live here.
 */
function attachOrchestratorTrpcToWindow(win: BrowserWindow): void {
  const db = makeDatabaseLike(databaseService);
  // Privileged OMP commands: a real bridge adapter when configured, else the
  // fail-closed stub — supervise-gated and audited either way by the wrapper
  // buildOmpCommandAdapter applies. The capability is OFF unless the operator
  // set CYBOFLOW_OMP_SUPERVISE, so every command is FORBIDDEN by default.
  const ompCommand = buildOmpCommandAdapter();
  const configOps = createConfigOps({ configManager, claudeCodeManager: defaultCliManager });
  const gitPrerequisiteOps = createGitPrerequisiteOps();
  claudeAuthOps = createClaudeAuthOps({
    getConfiguredClaudePath: () => configManager.getConfig()?.claudeExecutablePath,
    log: (message) => logger.info(message),
  });
  const workspaceFileOps = createFileOps({ sessionManager, databaseService, gitStatusManager, configManager });
  attachOrchestratorTrpc({
    window: win,
    router: appRouter,
    createContext: () =>
      createContext({
        db,
        configOps,
        gitPrerequisiteOps,
        claudeAuthOps: claudeAuthOps ?? undefined,
        workspaceFileOps,
        setDockBadge: (count) => dockBadgeService.setBadgeCount(count),
        workflowRegistry,
        agentOverrideRouter: AgentOverrideRouter.getInstance(),
        getForcedSubstrate: () => configManager.getForcedSubstrate(),
        omp: fleetRegistryReader,
        ompCommand,
        // The THUNK, not a snapshot: createContext resolves it per request, so
        // granting or revoking Aria mode takes effect on the next call in both
        // directions — no relaunch (the frozen-value bug this PR fixes).
        principal: currentOmpPrincipal,
        auditOmp,
        // The manager exists iff the BRIDGE is configured — a boot-time,
        // env-driven fact, so the picker asks whether it exists rather than
        // re-deriving the config. The other half of `launchable` is the live
        // `hasSupervise(ctx.principal)` check in the availability query, which
        // is what makes the Aria toggle take effect without a relaunch.
        ompFleetLaunchable: () => ompSessionManager !== undefined,
        ompAriaMode: () => configManager.getAriaMode(),
        // The per-substrate sprint task-cap override (Settings → Sessions), read
        // LIVE per request so raising the cap takes effect without a restart —
        // runs.start layers it over the built-in defaults.
        getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
        // Run-scoped Diff tab: closure over GitDiffManager keeps the standalone
        // runs router free of a services/* import. Narrow the GitDiffResult down
        // to the RunGitDiff wire shape (diff + stats + changedFiles + resolvedBase
        // + worktree). `comparisonRef` (TASK-211) takes priority over `baseRef`
        // when both are supplied.
        gitDiff: async (worktreePath: string, baseRef?: string, comparisonRef?: string) => {
          // Resolve whichever ref was requested to a concrete sha FIRST, so
          // `resolvedBase` and the diff/groups below are all computed against the
          // exact same base by construction.
          const resolvedBase = await resolveGitRefToSha(worktreePath, comparisonRef ?? baseRef);
          // With a resolved ref, diff the working tree against it so commits made
          // since launch (e.g. sprint/ship merging task lanes) show too; without
          // one, fall back to the working-directory diff (vs HEAD).
          const [result, entries, diffGroups] = await Promise.all([
            resolvedBase
              ? gitDiffManager.captureDiffAgainstRef(worktreePath, resolvedBase)
              : gitDiffManager.captureWorkingDirectoryDiff(worktreePath),
            gitDiffManager.getWorktreeStatus(worktreePath),
            gitDiffManager.getDiffGroups(worktreePath, resolvedBase),
          ]);
          return {
            diff: result.diff,
            stats: result.stats,
            changedFiles: result.changedFiles,
            resolvedBase,
            worktree: {
              entries,
              groups: diffGroups.groups,
              committedUnavailable: diffGroups.committedUnavailable,
            },
          };
        },
        // Global-agent chat thread (migration 074). The service is null only when
        // the default CLI manager is not a ClaudeCodeManager; the router guards on
        // it. The store is the SAME instance the MCP propose handler + executor
        // use. The executor invoker reads the setProposalExecutorDeps holder
        // lazily at confirm-time (wired in the whenReady dep block, which runs
        // before createWindow), so referencing it here is safe.
        agentThreadService: agentThreadService ?? undefined,
        agentThreadStore,
        agentProposalExecutor: {
          execute: (proposalId: string) => executeProposal(getProposalExecutorDeps(), proposalId),
        },
        // Read from the module-scope holder at REQUEST time, so a window
        // attached before initializeServices finished still sees the probes
        // once they exist.
        verifyHostProbes,
        verifyRunbookStatus,
        // Same lazy module-scope read as the probes above — createGitOps needs
        // the full AppServices object, which only exists inside
        // initializeServices.
        sessionGitOps,
        sessionOps,
        // Custom Views (migration 132). Built in initializeServices(), read
        // from the module-scope holder at REQUEST time — same lazy pattern as
        // sessionGitOps/sessionOps above.
        customViews: customViewsService ?? undefined,
        // Custom Views tier-3 widget document server — built alongside the
        // design-prototype server below (module-scope holder read lazily, same
        // pattern). CustomWidgetServerManager.ensure/stop already match
        // CustomWidgetServerLike's shape, so no adapter is needed.
        customWidgetServer: customWidgetServerManager ?? undefined,
      }),
  });
}

// Deferrable (non-first-paint) startup work, kicked off once the main window's
// first frame is painted ('ready-to-show') rather than on the critical path to
// first paint. Idempotent: the macOS 'activate' re-created window fires
// 'ready-to-show' again, and these sweeps / git polling must run only once.
let deferredStartupWorkStarted = false;
function runDeferredStartupWork(): void {
  if (deferredStartupWorkStarted) return;
  deferredStartupWorkStarted = true;

  // Git status polling is comparatively expensive (spawns git per session), so it
  // is held back until the window is visible instead of started during init.
  gitStatusManager.startPolling();

  // Bug reports use their own Sentry client, built lazily on first submission, so
  // a report the offline transport queued in an earlier session would otherwise
  // sit on disk until the user happened to file another one. This constructs that
  // client (which flushes its queue at startup) only when the queue is non-empty.
  // Deliberately outside the telemetry toggle: bug reporting is decoupled from it.
  drainQueuedBugReports();

  // Boot sweep (TASK-057): kill detached ui-prototype `http.server` processes
  // pointing under THIS instance's artifacts/runs root that a prior session or a
  // crash left behind. LIVE-RUN-AWARE backstop: after an unclean shutdown a run
  // left non-terminal (e.g. awaiting_review) still has its server up, and killing
  // it would leave the prototype tab dead when the user reopens to review — so a
  // server whose runId still has a NON-terminal workflow_runs row is spared. The
  // clean-quit path is already fully covered by the before-quit sweep. DB error →
  // treat as not-live (reap) so a crashed-DB boot never strands servers.
  // Fire-and-forget — never block on `ps`.
  void prototypeServerReaper
    .sweepOrphans(getCyboflowSubdirectory('artifacts', 'runs'), (runId) => {
      try {
        return !!databaseService
          .getDb()
          .prepare(
            `SELECT 1 FROM workflow_runs WHERE id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
          )
          .get(runId);
      } catch {
        return false;
      }
    })
    .catch((err) => {
      console.error('[Main] prototype-server boot sweep failed:', err);
    });

  // Boot sweep: kill detached `openai-codex` plugin broker trees whose worktree
  // (`--cwd`) no longer exists on disk — orphans a prior session or a crash left
  // behind (the plugin's own SessionEnd reaper never fires under cyboflow's
  // hard-kill teardown, and the broker has no idle TTL). A broker for a still-live
  // worktree is spared automatically (its cwd still exists). Fire-and-forget —
  // never block on `ps`.
  void codexBrokerReaper.sweepOrphans().catch((err) => {
    console.error('[Main] codex-broker boot sweep failed:', err);
  });

  // Boot sweep + periodic sweep: kill vitest pool workers whose root has died.
  // Unlike the codex-broker sweeps this needs no worktree scoping and is safe
  // mid-session — `ppid === 1` on a worker is a proof of abandonment, not a guess
  // (a live worker always has its root as parent), and a detached `nohup` gate
  // reparents the ROOT, which is never matched. Mid-session sweeping is the point:
  // sprint lanes are where abandoned forks come from. Fire-and-forget.
  void vitestOrphanReaper.sweep().catch((err) => {
    console.error('[Main] vitest-orphan boot sweep failed:', err);
  });
  vitestOrphanReaper.start();

  // Observe-only tripwire for orphaned cyboflowMcpServer subprocesses (Phase 3
  // of the spawner-death fix — see McpOrphanTripwire's docstring for why this is
  // periodic, and why it confirms across scans rather than gating on age).
  // Constructed here rather than at module load because it reports exclusively
  // through the logger, which does not exist until boot. start() is idempotent
  // and fires one scan immediately, then hourly; scan() is fail-soft, so no
  // .catch() is needed.
  mcpOrphanTripwire = new McpOrphanTripwire({ logger: makeLoggerLike(logger) });
  mcpOrphanTripwire.start();

  // Design Mode v1 boot recovery (design-mode.md "Design feedback v1"): re-drive
  // every design-feedback batch a crash left queued/dispatching/dispatched.
  // Guards are re-validated first (a failure lands the batch in the visible
  // 'blocked' state), and a possibly-delivered batch is re-delivered under the
  // SAME batch id with a NEW attempt id — never as if it were fresh.
  //
  // Deliberately NOT the FeedbackRouter.sweepInterruptedBatches seam next to it
  // at boot: that sweep FAILS interrupted batches, which is right for the
  // document path's 'pending' but would discard recoverable design feedback.
  // Fire-and-forget — recoverOnBoot never rejects.
  void designFeedbackOutbox?.recoverOnBoot();

  // Boot sweep #2: the same brokers, but in worktrees that STILL EXIST. The sweep
  // above spares those (their `--cwd` resolves) and WorktreeManager's reap only
  // fires on removal — so a broker whose session ended days ago but whose worktree
  // was never dismissed leaks indefinitely (no idle TTL). There is no idle signal
  // to test for (broker.log is 0 bytes, mtime frozen at spawn), so this is scoped
  // to THIS install's worktree roots instead: at boot no cyboflow session is live
  // yet, making any broker under those roots a previous-lifetime leftover, while
  // brokers from other tools (Warp / plain terminal) sit outside them and are
  // never matched. Fire-and-forget — never block on `ps` or the projects query.
  void (async () => {
    let roots: string[];
    try {
      roots = databaseService.getAllProjects().flatMap((project) => {
        const projectPath = project.path?.trim();
        if (!projectPath) return [];
        const folder = (project.worktree_folder || '').trim() || 'worktrees';
        // Both layouts WorktreeManager creates: the per-project worktree folder
        // and the nested `.cyboflow/worktrees/<workflow>/<runId8>` run layout.
        return [
          path.join(projectPath, folder),
          path.join(projectPath, '.cyboflow', 'worktrees'),
        ];
      });
    } catch (err) {
      // A crashed/locked DB at boot must not strand the sweep's siblings.
      console.error('[Main] codex-broker worktree-root sweep: project lookup failed:', err);
      return;
    }
    await codexBrokerReaper.sweepForWorktreeRoots(roots);
  })().catch((err) => {
    console.error('[Main] codex-broker worktree-root sweep failed:', err);
  });
}

async function createWindow() {
  // Window geometry (see utils/windowState.ts): restore the previous session's
  // bounds from <dataDir>/window-state.json, or — when nothing trustworthy is
  // saved (first run, corrupt file) — size to the display the cursor is on.
  // Restored bounds are clamped against the work area of the display they last
  // lived on, so a monitor unplug or resolution change can never resurrect an
  // off-screen (or oversized) window. Any failure downgrades to first-run
  // sizing, never a crash. The dir is the kind's data dir straight from the
  // resolver (NOT app.getPath('userData')), so --cyboflow-dir / CYBOFLOW_DIR /
  // per-kind isolation hold even if the userData relocation above failed.
  const windowStateDir = getCyboflowDirectory();
  const savedWindowState = loadWindowState(windowStateDir);
  let windowBounds: WindowRect;
  if (savedWindowState) {
    windowBounds = clampWindowBounds(
      savedWindowState.bounds,
      screen.getDisplayMatching(savedWindowState.bounds).workArea,
    );
  } else {
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    windowBounds = clampWindowBounds(defaultWindowBounds(workArea), workArea);
  }

  mainWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    icon: path.join(__dirname, `../assets/${appIconBasename()}`),
    // First-paint: start hidden and paint the renderer's root background so the
    // window never flashes an empty white frame while the (heavy) renderer boots;
    // it is revealed on 'ready-to-show' below, once the first frame is painted.
    // '#f5f1e8' is the default Paper theme's --color-bg-primary (var(--paper),
    // frontend/src/styles/tokens/colors.css); the renderer's inline theme script
    // re-applies the user's saved theme before its first paint, so the show gate
    // is what actually removes the flash and this color just blends the frame.
    show: false,
    backgroundColor: '#f5f1e8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The sandboxed preload loader resolves only 'electron' and a few node
      // builtins, so preload.js is esbuild-bundled (scripts/bundle-preload.mjs,
      // wired into build:main) with '@sentry/electron/preload', 'trpc-electron/main'
      // and the shared/* siblings INLINED and 'electron' left external. That script
      // also fails the build if a future import would reintroduce an unresolvable
      // runtime require — which would silently take the whole bridge down here.
      sandbox: true,
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 10 }
    } : {})
  });

  // Increase max listeners to prevent warning when many panels are active
  // Each panel can register multiple event listeners
  mainWindow.webContents.setMaxListeners(100);

  // Persist bounds so the next launch restores them (debounced resize/move,
  // flushed on close; the normal-vs-maximized bookkeeping and the macOS
  // getNormalBounds caveat live with the controller). Bound to THIS window
  // object, not the mutable `mainWindow` global, so a pending timer can never
  // persist a later re-created window through the old controller. Seeded with
  // the bounds the window was created at, so a close before any resize/move
  // still writes a real rect.
  windowStatePersistence = attachWindowStatePersistence(mainWindow, windowStateDir, {
    bounds: windowBounds,
    maximized: savedWindowState?.maximized ?? false,
  });

  // Reveal the window only once the renderer has painted its first frame, and
  // kick off the deferrable startup work at that point. Registered BEFORE
  // loadURL/loadFile so the one-shot 'ready-to-show' is never missed.
  mainWindow.once('ready-to-show', () => {
    // A maximized previous session comes back maximized — the restored x/y/w/h
    // are the window's NORMAL (restore) geometry, so un-maximizing later lands
    // where the user left it. maximize() shows the window itself, so it belongs
    // inside this gate: called earlier it reveals the unpainted frame the gate
    // exists to hide.
    if (savedWindowState?.maximized) {
      mainWindow?.maximize();
    }
    mainWindow?.show();
    runDeferredStartupWork();
  });

  // Verification instances get a distinguishable OS window title so the
  // native-screen window-identity channel is not satisfied by a developer's own
  // window: every unpackaged `electron .` launch shares one bundle, so the
  // title is the only per-instance discriminator peekaboo can see. Two distinct
  // overwrites have to be held off — Electron mirrors the page <title> (pinned
  // off here) and setAppTitle() sets it programmatically (which honors the
  // token itself, and is the single source of the title string).
  if (process.env.CYBOFLOW_VERIFY_TOKEN) {
    mainWindow.on('page-title-updated', (e) => e.preventDefault());
    setAppTitle();
  }

  // Bind the tRPC IPC handler to this window BEFORE the renderer loads, so an
  // early renderer request never races handler registration. On the first window
  // the adapter creates the single global handler; on the macOS 'activate'
  // re-created window it only attaches to it (never a second createIPCHandler).
  attachOrchestratorTrpcToWindow(mainWindow);

  if (isDevelopment) {
    await loadDevUrlWithRetry(mainWindow, `http://localhost:${DEV_RENDERER_PORT}`);
    mainWindow.webContents.openDevTools();
    
    // Enable IPC debugging in development
    
    // Log all IPC calls in main process
    const originalHandle = ipcMain.handle;
    ipcMain.handle = function(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown) {
      const wrappedListener = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const result = await listener(event, ...args);
        return result;
      };
      return originalHandle.call(this, channel, wrappedListener);
    };
  } else {
    // In production, use app.getAppPath() to get the root directory
    // This works correctly whether the app is packaged in ASAR or not
    const indexPath = path.join(app.getAppPath(), 'frontend/dist/index.html');
    console.log('Loading index.html from:', indexPath);

    try {
      await mainWindow.loadFile(indexPath);
    } catch (error) {
      console.error('Failed to load index.html:', error);
      console.error('App path:', app.getAppPath());
      console.error('__dirname:', __dirname);
      
      // Fallback: try relative path (for edge cases)
      const fallbackPath = path.join(__dirname, '../../../../frontend/dist/index.html');
      console.error('Trying fallback path:', fallbackPath);
      try {
        await mainWindow.loadFile(fallbackPath);
      } catch (fallbackError) {
        console.error('Fallback path also failed:', fallbackError);
      }
    }
  }

  // Set the app title based on development mode and worktree
  setAppTitle();

  // Every `target=_blank` / `window.open` in the renderer is denied a popup and
  // offered to the OS instead — so the url reaching `shell.openExternal` is
  // whatever the renderer put in the link. Gate it on scheme: `shell.openExternal`
  // is an OS launcher, not a browser, so `file:`/`javascript:`/custom schemes
  // would otherwise be launchable from a renderer XSS. See artifactFrameGuard.ts.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalOpenTarget(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[Main] Blocked window-open to non-web scheme:', url);
    }
    return { action: 'deny' };
  });

  // Confine static-mockup artifact frames (about:srcdoc, bare sandbox) to their
  // own document: a bare sandbox blocks scripts and the injected CSP blocks
  // subresource fetches, but neither stops a user-initiated link navigation, so a
  // prototype's <a href="https://…"> could still beacon out. Block any navigation
  // of an about:srcdoc frame to a non-about: URL (offering http(s) links to the OS
  // browser instead). The app's main frame and the legacy localhost dev-server
  // prototype iframe are left untouched. See main/src/ipc/artifactFrameGuard.ts.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    const frameUrl = details.frame?.url ?? '';
    // Design Mode v1: a SCRIPT-enabled loopback-origin prototype frame gets its own
    // guard FIRST — all programmatic navigation off its origin is blocked outright
    // with NO external open (offering http(s) to the OS browser would let a scripted
    // frame exfiltrate via window.location). See artifactFrameGuard.ts.
    if (shouldBlockScriptedFrameNavigationFromRegistry(frameUrl, details.url, details.isMainFrame)) {
      details.preventDefault();
      return;
    }
    if (shouldBlockArtifactFrameNavigation(frameUrl, details.url, details.isMainFrame)) {
      details.preventDefault();
      if (isExternallyOpenable(details.url)) {
        void shell.openExternal(details.url);
      }
    }
  });

  mainWindow.on('closed', () => {
    // Reap any live design-prototype servers bound to this window (their canvas is
    // gone). Fail-soft and out-of-band, so it fires server-stopped for any still
    // alive; the renderer is already down, so those notifies are no-ops.
    void designPrototypeServerManager?.stopAll();
    // The Custom Views widget server is process-global, not window-scoped, but
    // no frame can reach it once the window is gone — stop it alongside the
    // prototype servers rather than leave it listening on an orphaned port.
    void customWidgetServerManager?.stop();
    mainWindow = null;
  });

  // Log any console messages from the renderer
  // Electron >=35 passes a single ConsoleMessageEvent object (string `level`),
  // not the legacy positional (event, level, message, line, sourceId) args.
  mainWindow.webContents.on('console-message', (event) => {
    const { message, level, lineNumber, sourceId } = event;
    // Skip messages that are already prefixed to avoid circular logging
    if (message.includes('[Main Process]') || message.includes('[Renderer]')) {
      return;
    }
    // Also skip Electron security warnings and other system messages
    if (message.includes('Electron Security Warning') || sourceId.includes('electron/js2c')) {
      return;
    }

    // In development, log ALL console messages to help with debugging
    if (isDevelopment) {
      // Electron's level is one of 'info' | 'warning' | 'error' | 'debug';
      // map 'warning' to the DevLogLevel 'warn', the rest pass through.
      const levelName: DevLogLevel = level === 'warning' ? 'warn' : level;
      const suffix = ` (${path.basename(sourceId)}:${lineNumber})`;
      appendDevDebugLog('frontend', levelName, 'FRONTEND', `${message}${suffix}`);
    }
  });

  // Override console methods to forward to renderer and logger
  console.log = (...args: unknown[]) => {
    // Format the message
    const message = formatConsoleArgs(args);

    // Write to logger if available
    if (logger) {
      logger.info(message);
    } else {
      originalLog.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'log', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only). In production the renderer never mirrors
    // backend logs, so this IPC send + serialization would be pure overhead on
    // every log line — gate it on isDevelopment (F2).
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'log', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalLog('[Main] Failed to send log to renderer:', e);
      }
    }
  };

  console.error = (...args: unknown[]) => {
    // Prevent infinite recursion by checking if we're already in an error handler
    if ((console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError) {
      return originalError.apply(console, args);
    }
    
    (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = true;
    
    try {
      // If logger is not initialized or we're in the logger itself, use original console
      if (!logger) {
        originalError.apply(console, args);
        return;
      }

      const message = formatConsoleArgs(args);

      // Extract Error object if present
      const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

      // Use logger but with recursion protection
      logger.error(message, errorObj);

      // In development, also write to backend debug log file
      if (isDevelopment) {
        appendDevDebugLog('backend', 'error', 'BACKEND', message, { error: originalError });
      }

      // Forward to renderer (dev-only, F2 — see console.log override above).
      if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('main-log', 'error', message);
        } catch (e) {
          // If sending to renderer fails, use original console to avoid recursion
          originalError('[Main] Failed to send error to renderer:', e);
        }
      }
    } catch (e) {
      // If anything fails in the error handler, fall back to original
      originalError.apply(console, args);
    } finally {
      (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = false;
    }
  };

  console.warn = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    // Extract Error object if present for warnings too
    const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

    if (logger) {
      logger.warn(message, errorObj);
    } else {
      originalWarn.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'warn', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'warn', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalWarn('[Main] Failed to send warning to renderer:', e);
      }
    }
  };

  console.info = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    if (logger) {
      logger.info(message);
    } else {
      originalInfo.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'info', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'info', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalInfo('[Main] Failed to send info to renderer:', e);
      }
    }
  };

  console.debug = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'debug', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'debug', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        console.error('[Main] Failed to send debug to renderer:', e);
      }
    }
  };

  // Log any renderer errors
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process crashed:', details);
  });

  // Handle window focus/blur/minimize for smart git status polling
  mainWindow.on('focus', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/focused
    }
  });

  mainWindow.on('blur', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/blurred
    }
  });

  mainWindow.on('minimize', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/minimized
    }
  });

  mainWindow.on('restore', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/restored
    }
  });
}

/**
 * Schema-version gate: refuse (or knowingly accept) a DB that a NEWER build
 * forward-migrated past what this binary understands.
 *
 * ORDERING IS LOAD-BEARING. This runs immediately after the DB opens and BEFORE
 * any service that touches state shared with other instances — above all the
 * OrchSocketServer's socket file, whose path is fixed and cross-instance. It
 * used to run after initializeServices() had already stood everything up, so a
 * too-old build got far enough to bind (and, on the way out, unlink) the live
 * instance's orch socket before the user ever saw this dialog. On 2026-07-28 a
 * build that only knew migration 60 did exactly that against a v85 database and
 * stranded every MCP subprocess spawned afterwards. A build that is about to be
 * told "you are too old to open this" must not have mutated shared state first.
 * That now includes the database itself: the gate runs BEFORE initialize(), so
 * on Quit the older binary has not re-run baseline DDL or applied
 * ledger-missing migrations against the newer schema. The caller must have run
 * readSchemaVersionStatus() first.
 *
 * Returns false when the user chose Quit — the caller must abort boot without
 * constructing anything further.
 */
function runSchemaVersionGate(): boolean {
  // Each packaged kind now owns its own data dir (stable → ~/.cyboflow, Dev DMG
  // → ~/.cyboflow_dev_dmg), so cross-variant forward-migration no longer happens
  // by default. The gate still guards the remaining ways a newer build can reach
  // an older binary's DB — a shared CYBOFLOW_DIR override, or downgrading the
  // same kind. (Always allow "Open Anyway" per product choice.)
  const schemaStatus = databaseService.getSchemaVersionStatus();
  if (!schemaStatus?.tooNew) return true;

  logger.warn(
    `[Main] Database schema (user_version=${schemaStatus.onDisk}) is newer than this build (max=${schemaStatus.appMax})`
  );
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Check for Updates', 'Open Anyway', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Cyboflow',
    message: 'This database was created by a newer version of Cyboflow',
    detail:
      'Your data (~/.cyboflow) was last opened by a newer build — most likely ' +
      'Cyboflow Dev. This copy of Cyboflow is older and may not understand the ' +
      'updated database.\n\nOpening it anyway can corrupt data if the newer build ' +
      'changed table structures. Updating to the matching version is recommended.',
  });
  if (choice === 2) {
    logger.info('[Main] User chose Quit at schema-version gate — not opening the newer DB');
    databaseService.close();
    app.quit();
    return false;
  }
  if (choice === 0) {
    pendingOpenUpdateSettings = true;
  }
  logger.info(`[Main] Continuing boot past schema-version gate (choice=${choice})`);
  return true;
}

/**
 * Stand up every service. Resolves false when boot was aborted at one of the two
 * database gates — a migration that failed to apply, or the schema-version gate —
 * in which case NOTHING further was constructed and the caller must return
 * immediately.
 */
async function initializeServices(): Promise<boolean> {
  configManager = new ConfigManager();
  await configManager.initialize();

  // Install the authoritative provider-access resolver for the CALL-LEVEL guard
  // (shared/agents/agentProviderGuard). Everything downstream — every Claude SDK
  // query(), every CLI/PTY/app-server spawn, every live-PTY relay — asks this
  // closure, so a provider the user switched off in Settings → Integrations
  // cannot be called even by an ALREADY-OPEN session (whose follow-up turns
  // never re-enter a launch seam). Read fresh on every call, so a toggle takes
  // effect immediately without a restart. Demo mode is exempt: its spawns go to
  // the scripted DemoCliManager and never reach a real vendor.
  setAgentProviderAccessResolver(
    (provider) => configManager.isDemoMode() || configManager.isAgentProviderEnabled(provider),
  );

  // NOTE: telemetry is initialized BEFORE app 'ready' (see the initTelemetry call
  // ahead of app.whenReady() below), because the Aptabase SDK disables itself if
  // initialized post-ready. Here we only register the usage sink so orchestrator
  // code (which can't import services/*) can emit events via emitUsage() — see
  // orchestrator/telemetrySink.ts. The parallel seam-error sink lets that same
  // invariant-bound orchestrator code report HANDLED failures (run/session/step
  // failures, timeouts, skips, systemic parks) to Sentry via emitSeamError().
  setTelemetrySink(trackUsage);
  setSeamErrorSink(captureSeamError);

  // Initialize logger early so it can capture all logs
  logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.cyboflow/logs');

  // Opt-in main-process CPU tracer (CYBOFLOW_PERF_TRACE=1). No-op otherwise; the
  // interval is unref'd, so no explicit stop is needed on quit.
  startPerfTracer(logger);
  
  // Use the boot-resolved database path. The demo bootstrap decides ONCE per
  // process (at module load, before the services/database.ts singleton opens
  // its handle) whether this boot runs on the throwaway demo database — both
  // DatabaseService constructions MUST use the same path or sessions and
  // panels land in different databases (FOREIGN KEY failures on create).
  const dbPath = getBootDatabasePath();
  const demoBootEnv = getDemoBootEnvironment();
  if (demoBootEnv) {
    logger.info(`[Main] DEMO MODE — using demo database at ${demoBootEnv.databasePath}, sandbox repo at ${demoBootEnv.sandboxPath}`);
  } else if (configManager.isDemoMode()) {
    // demoMode was configured but the environment build failed (e.g. git
    // missing) — turn the flag back off and boot normally rather than leaving
    // every launch half-demo.
    logger.error(`[Main] Demo environment setup failed (${getDemoBootError() ?? 'unknown error'}) — disabling demo mode and booting normally`);
    await configManager.updateConfig({ demoMode: false });
  }

  databaseService = new DatabaseService(dbPath);

  // Gate BEFORE initialize(): a binary about to be told "you are too old to
  // open this" must not have re-run baseline DDL or applied ledger-missing
  // migrations against the newer schema first. readSchemaVersionStatus() only
  // reads PRAGMA user_version; the first mutation happens inside initialize()
  // below, after the user has chosen to continue.
  databaseService.readSchemaVersionStatus();
  if (!runSchemaVersionGate()) return false;

  try {
    databaseService.initialize();
  } catch (err) {
    // Fail-closed migration gate. A .sql migration that did not apply leaves the
    // database missing whatever it was supposed to add, and the code below is
    // about to run against it — which surfaces as scattered "no such column"
    // failures that trace back to nothing. Stop here, loudly, while aborting is
    // still free: nothing cross-instance (above all the orch socket) is bound
    // yet, exactly as at the schema-version gate above.
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(`[Main] Database migration failed — refusing to boot: ${error.message}`);
    captureSeamError('boot-migration-failed', error, { platform: process.platform });
    dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['Quit'],
      defaultId: 0,
      noLink: true,
      title: 'Cyboflow',
      message: 'Cyboflow could not update its database',
      detail:
        `A database migration failed, so Cyboflow cannot safely open your data:\n\n${error.message}\n\n` +
        'Nothing was changed — the failed migration was rolled back. Updating to ' +
        'the latest version of Cyboflow usually resolves this; if it persists, ' +
        'please report it with the log at ~/.cyboflow/logs.',
    });
    try {
      databaseService.close();
    } catch {
      // Already failing; a close error must not mask the migration error.
    }
    app.quit();
    return false;
  }

  sessionManager = new SessionManager(databaseService);
  sessionManager.initializeFromDatabase();

  // Per-project trust for repo-supplied permission ALLOW rules (  // migration 127). permissionRules.ts cannot import electron/services
  // (standalone-typecheck invariant), so it exposes an injectable resolver —
  // same boot-injection pattern as setStreamParserPerfBump above. `projectDir`
  // here is the worktree path (or, for an in-place/main-repo session, the
  // project root itself) that loadMergedPermissionRules is called with.
  setProjectPermissionTrustResolver((projectDir: string): boolean => {
    try {
      const session = databaseService.getSessionByWorktreePath(projectDir);
      if (session?.project_id !== undefined) {
        const project = databaseService.getProject(session.project_id);
        return project?.permission_trust === 'trusted';
      }

      const projects = databaseService.getAllProjects();
      const exact = projects.find((p) => p.path === projectDir);
      if (exact) return exact.permission_trust === 'trusted';

      // Fall back to a path-prefix match (a worktree not recorded as any
      // session's worktree_path, e.g. an ad-hoc cwd nested under a known
      // project). path.relative-based containment, not naive startsWith —
      // startsWith('/Users/foo') would also match '/Users/foobar'.
      const containing = projects.find((p) => {
        const relative = path.relative(p.path, projectDir);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      return containing?.permission_trust === 'trusted';
    } catch {
      // Fail-closed: an unexpected DB error must read as untrusted, never trusted.
      return false;
    }
  });

  archiveProgressManager = new ArchiveProgressManager();

  // Create worktree manager
  worktreeManager = new WorktreeManager(configManager, codexBrokerReaper);

  // Initialize the active project's worktree directory if one exists
  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    await worktreeManager.initializeProject(activeProject.path);
  }

  // Initialize CLI manager factory
  cliManagerFactory = CliManagerFactory.getInstance(logger, configManager);

  // Create default CLI manager (Claude). Permission gating runs in-process
  // via the SDK's PreToolUse hook → ApprovalRouter (TASK-590).
  // Skip validation during startup - tools will be validated when actually used
  defaultCliManager = await cliManagerFactory.createManager('claude', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: {
      db: databaseService.getDb(),
    },
    skipValidation: true  // Allow Cyboflow to start even if Claude Code is not installed
  });

  // Create the interactive (PTY) CLI manager (IDEA-013 S4 / TASK-809). Registered
  // as the 'claude-interactive' built-in tool by TASK-806. Constructed with the
  // same db-in-additionalOptions + skipValidation contract as the SDK manager so a
  // missing `claude` binary never blocks startup; availability is probed lazily on
  // first interactive spawn. The SubstrateDispatchFacade routes per-run between this
  // and defaultCliManager based on workflow_runs.substrate.
  const interactiveCliManager = await cliManagerFactory.createManager('claude-interactive', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: {
      db: databaseService.getDb(),
    },
    skipValidation: true,
  });
  // Narrow the AbstractCliManager-typed factory return to the concrete class:
  // AppServices.interactiveCliManager exposes the persistent-REPL seams
  // (relayUserTurn et al.) that only InteractiveClaudeManager has. The factory's
  // 'claude-interactive' branch always constructs one, so this throw is
  // unreachable in practice — it exists purely to narrow the type without a cast.
  if (!(interactiveCliManager instanceof InteractiveClaudeManager)) {
    throw new Error('[Main] cliManagerFactory returned a non-InteractiveClaudeManager for claude-interactive');
  }
  // Share the narrowed manager with the experiments wiring (createArmSession's
  // eager interactive REPL spawn) — same module-level-let pattern as
  // substrateFacade/sessionManager.
  interactiveReplManager = interactiveCliManager;

  const createdCodexSdkManager = await cliManagerFactory.createManager('codex-sdk', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: {
      db: databaseService.getDb(),
      appVersion: app.getVersion(),
    },
    skipValidation: true,
  });
  // Structural, not `instanceof`: the demo factory returns a DemoCliManager
  // carrying the same seams, and requiring the concrete class is what used to
  // force it to fabricate a prototype-grafted stand-in.
  if (!isCodexSdkManagerLike(createdCodexSdkManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the Codex SDK seams for codex-sdk');
  }

  const createdCodexPtyManager = await cliManagerFactory.createManager('codex-pty', {
    sessionManager,
    logger,
    configManager,
    skipValidation: true,
  });
  if (!isCodexPtyManagerLike(createdCodexPtyManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the Codex PTY seams for codex-pty');
  }
  codexPtyManager = createdCodexPtyManager;

  const createdOmpSdkManager = await cliManagerFactory.createManager('omp-sdk', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: {
      db: databaseService.getDb(),
    },
    skipValidation: true,
  });
  // Structural, exactly like the Codex twins above — demo mode returns a
  // DemoCliManager carrying the seams rather than an OmpSdkManager.
  if (!isOmpSdkManagerLike(createdOmpSdkManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the OMP SDK seams for omp-sdk');
  }

  const createdOmpPtyManager = await cliManagerFactory.createManager('omp-pty', {
    sessionManager,
    logger,
    configManager,
    skipValidation: true,
  });
  if (!isOmpPtyManagerLike(createdOmpPtyManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the OMP PTY seams for omp-pty');
  }
  ompPtyManager = createdOmpPtyManager;

  const createdPiPtyManager = await cliManagerFactory.createManager('pi-pty', {
    sessionManager,
    logger,
    configManager,
    skipValidation: true,
  });
  if (!isPiPtyManagerLike(createdPiPtyManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the Pi PTY seams for pi-pty');
  }
  piPtyManager = createdPiPtyManager;

  const createdPiSdkManager = await cliManagerFactory.createManager('pi-sdk', {
    sessionManager,
    logger,
    configManager,
    skipValidation: true,
  });
  if (!isPiSdkManagerLike(createdPiSdkManager)) {
    throw new Error('[Main] cliManagerFactory returned a manager without the Pi SDK seams for pi-sdk');
  }
  piSdkManager = createdPiSdkManager;
  gitDiffManager = new GitDiffManager(logger);
  gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, logger);
  executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  runCommandManager = new RunCommandManager(databaseService);

  taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeCodeManager: defaultCliManager, // Use default CLI manager for backward compatibility
    gitDiffManager,
    executionTracker,
    getMainWindow: () => mainWindow
  });


  // ---------------------------------------------------------------------------
  // Cyboflow orchestrator collaborators — constructed here so they are eager
  // singletons assembled with the rest of AppServices (not lazy on first IPC).
  // ---------------------------------------------------------------------------
  const cyboflowLogger = makeLoggerLike(logger);
  const cyboflowDb = makeDatabaseLike(databaseService);
  // Resolved once here and threaded into every orchestrator SDK-query factory
  // below (makeRevisionQuery, makeVerificationAgentQuery, makeRunbookDraftQuery,
  // makeEvalJudgeQuery, makePairwiseJudgeQuery, makeSdkStructuredQuery,
  // makeSdkTextQuery) as their leading `claudeExecutablePath` argument, and into
  // `SessionSummarizerDeps` below. `resolveClaudeExecutablePath()` is a pure,
  // process-lifetime-constant lookup (packaged-build asar workaround; `undefined`
  // in dev), so resolving it once at boot and passing the value down keeps the
  // orchestrator tree itself free of the `services/*` import — the whole point of
  // this injection (see `orchestrator/verify/verificationAgentQuery.ts`'s module
  // doc for why that layering matters).
  const claudeExecutablePath = resolveClaudeExecutablePath();
  // OMP fleet runtime (omp-phase4-coexistence-adr.md §5): constructed ONLY when
  // the bridge command config resolved at boot. Unresolved ⇒ undefined ⇒ the
  // dispatch seams + picker omit OMP entirely — a half-configured bridge never
  // silently authorizes a session.
  {
    const ompBridgeConfig = resolveOmpBridgeCommandConfig();
    // TWO gates, both required. The bridge config says the fleet is REACHABLE;
    // the supervise capability says this operator authorized Cyboflow to drive
    // it. Spawning and killing remote workers is the same privileged surface
    // the ompCommand router refuses without the capability, so the manager that
    // drives it from the panel seams must refuse on the same terms — otherwise
    // the product's actual path sits outside the authorization model.
    if (ompBridgeConfig !== undefined && !hasSupervise(currentOmpPrincipal())) {
      logger.info(
        'omp:fleet bridge is configured but the supervise capability is absent ' +
          '(turn on Aria mode in Settings → Advanced Options, or set CYBOFLOW_OMP_SUPERVISE ' +
          'on a headless host) — fleet sessions stay unavailable until it is granted',
      );
    }
    // Constructed on the BRIDGE CONFIG alone. The supervise capability is
    // deliberately NOT a construction condition: it comes from Aria mode, which
    // the user flips at runtime, and gating construction on it froze the answer
    // at launch — granting Aria appeared to do nothing until a restart. The
    // capability is enforced per call by OmpSupervisedAdapter instead, which is
    // strictly stronger: revoking Aria now forbids the very next command rather
    // than leaving an already-built manager authorized for the rest of the run.
    ompSessionManager =
      ompBridgeConfig !== undefined
        ? new OmpSessionManager(
            new OmpSupervisedAdapter(
              new OmpBridgeCommandAdapter(
                new OmpBridgeHttpClient(ompBridgeConfig.url, ompBridgeConfig.token, ompBridgeConfig.sessionId),
              ),
              currentOmpPrincipal,
              auditOmp,
            ),
            cyboflowLogger,
          )
        : undefined;
  }

  // Inject the global-config provider so createRun resolves the global default
  // agent permission mode + CLI substrate via the resolvers (ConfigManager
  // satisfies WorkflowConfigProvider structurally).
  workflowRegistry = new WorkflowRegistry(cyboflowDb, cyboflowLogger, configManager);
  const mcpConfigWriter = new McpConfigWriter();

  // Native task-tracking write chokepoint (migration 014). The single serialized
  // writer for `tasks`/`task_events`; injected (structurally) into RunExecutor,
  // RunLauncher, and the run close-out deps below so run lifecycle transitions
  // derive each linked task's stage. The tasks tRPC router reaches it via
  // getInstance(); its taskChangeEvents emitter is consumed directly by the
  // cyboflow.tasks.onTaskChanged subscription (no bridge needed here).
  const taskChangeRouter = TaskChangeRouter.initialize(cyboflowDb);

  // Unified review-inbox write chokepoint (migration 016 / P3). The single
  // serialized writer for `review_items`; the reviewItems tRPC router + the
  // report-finding MCP handler reach it via getInstance(). Initialized HERE,
  // ahead of the tracker sync loop below, because that loop takes it at
  // construction: every Auto-mode conflict override files a non-blocking audit
  // finding on it.
  const reviewItemRouter = ReviewItemRouter.initialize(cyboflowDb);

  // Issue-tracker sync loop (migration 093). Started HERE, immediately after the
  // chokepoint it subscribes to: start() does boot crash-recovery (demoting any
  // `in_flight` outbox row to `ambiguous`) BEFORE arming its listener or poll
  // timer, so it must run before any entity write can reach it. Its 60s timer is
  // unref'd — it never keeps the app alive — and the poll itself is gated on each
  // connection's own 5-minute `last_sync_at`. A project with no tracker connection
  // costs one empty `listConnections` per tick.
  trackerSyncService = new TrackerSyncService({
    db: databaseService.getDb(),
    router: taskChangeRouter,
    reviewRouter: reviewItemRouter,
    // Keyless providers (beads) anchor their workspace to the project's repo.
    // Resolved HERE rather than in the service so the renderer only ever sends
    // a project id — no filesystem path it composes can decide where a CLI is
    // spawned. See TrackerSyncServiceDeps.resolveProjectPath.
    resolveProjectPath: (id) => sessionManager.getProjectById(id)?.path?.trim() || null,
    // The OTHER anchor a keyless connection can have: a folder the user points
    // at when the workspace is not at the project's repo path (a monorepo
    // subdirectory, a workspace kept outside the repo). The dialog runs HERE,
    // in main, so the chosen path never has to be composed by — or returned
    // to — the renderer; it gets a token. See
    // TrackerSyncServiceDeps.pickWorkspaceDirectory.
    pickWorkspaceDirectory: async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        // `dontAddToRecent` keeps a beads workspace out of the OS recent-items
        // list — this is a wiring step, not a document the user opened.
        properties: ['openDirectory', 'dontAddToRecent'],
        title: 'Point at a beads workspace',
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    logger: cyboflowLogger,
  });
  trackerSyncService.start();
  // Hand the running service to the tRPC surface (cyboflow.tracker) — the router
  // cannot import it directly (standalone-typecheck invariant), so the bridge is
  // the seam. See main/src/orchestrator/trackerSyncBridge.ts.
  setTrackerSyncFacade(trackerSyncService);

  // Daily sessions.db backup (7-day retention) — see databaseBackupService.ts
  // for why hourly-tick + file-existence-guard rather than a 24h timer, and
  // why raw_events is archived once into <backups>/raw-events deltas instead
  // of being copied into all seven dailies. Those deltas are NOT covered by
  // the retention window: they are the only copy of that history outside the
  // live database.
  // Skipped in demo mode: demoBootEnv's database is a throwaway reset on every
  // launch, so backing it up is pure waste.
  if (!demoBootEnv) {
    databaseBackupService = new DatabaseBackupService({
      db: databaseService.getDb(),
      backupsDir: path.join(path.dirname(dbPath), 'backups'),
      logger: cyboflowLogger,
    });
    databaseBackupService.start();
  }

  // Sprint-lane write chokepoint (feat/parallel-sprint, migrations 022 + 023).
  // The single serialized writer for `sprint_batches`/`sprint_batch_tasks`;
  // injected (structurally, as narrow slices) into RunLauncher (createForRun at
  // sprint launch), RunExecutor (lane task ids for the `# Sprint tasks` prompt
  // block), and the runs-router lane dep-bag below. The cyboflow_update_sprint_task
  // MCP handler reaches it via getInstance(). Logger is REQUIRED here (CODE-PATTERNS.md
  // optional-logger rule) — omitting it silently no-ops all lane diagnostics.
  // `getSprintMaxTasks` (Item 7) wires createForRun's OWN batch-cap enforcement
  // to the same live per-substrate override every other cap check already
  // reads (runs.start, experiments.start, the MCP backstop) — never omit it,
  // or the store's cap silently floors to the built-in defaults.
  // `onBatchMinted` (migration 137) surfaces the batch's HUMAN prerequisites as
  // standing review items — see humanPrerequisiteSink for the fail-soft contract.
  const sprintLaneStore = SprintLaneStore.initialize(cyboflowDb, cyboflowLogger, {
    getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
    onBatchMinted: humanPrerequisiteSink(cyboflowDb, reviewItemRouter, cyboflowLogger),
  });

  // The human-gate run-pause manager (P4) pairs with the ReviewItemRouter
  // initialized above (the tracker sync loop needs that one at construction, so
  // it is minted earlier): HumanStepManager owns the human=true step gate — it
  // opens a blocking decision review_item (pausing the run) and applies
  // aggregate-unblock auto-resume when the run's last blocking item resolves.
  // In-artifact feedback write chokepoint (migration 077, IDEA-033) — the single
  // serialized writer for feedback_comments / feedback_batches; the
  // cyboflow.feedback tRPC router reaches it via getInstance(). Its feedbackEvents
  // emitter (hosted in trpc/routers/events.ts) is consumed directly by
  // cyboflow.feedback.onFeedbackChanged. The revision LAUNCHER — the host-driven
  // scoped SDK agent that rewrites the idea body on "Send feedback" — is wired here
  // (it binds makeRevisionQuery + TaskChangeRouter, both off-limits to the
  // standalone tRPC router) and read by sendFeedbackHandler via getRevisionLauncher.
  FeedbackRouter.initialize(cyboflowDb);

  // Idea component ledger write chokepoint (migration 101) — the single
  // serialized writer for `idea_components`; the cyboflow.ideaComponents tRPC
  // router reaches it via getInstance() for the card's manual-override path.
  IdeaComponentRouter.initialize(cyboflowDb);

  setRevisionLauncher((info) =>
    runRevisionBatch(
      {
        projectId: info.projectId,
        runId: info.runId,
        batchId: info.batchId,
        atype: info.atype,
        sourceRef: info.sourceRef,
        gateReviewItemIds: info.gateReviewItemIds,
      },
      {
        db: cyboflowDb,
        queryFn: makeRevisionQuery(claudeExecutablePath, cyboflowLogger),
        feedbackRouter: FeedbackRouter.getInstance(),
        applyTaskChange: (projectId, change) =>
          TaskChangeRouter.getInstance().applyChange(projectId, change),
        logger: cyboflowLogger,
      },
    ),
  );
  // Boot recovery: fail any feedback batch left `pending` by a previous app exit
  // (an orphaned pending batch permanently trips the send-batch 'busy' guard).
  // Fire-and-forget — the sweep is not on the critical boot path.
  void FeedbackRouter.getInstance()
    .sweepInterruptedBatches()
    .then((n) => {
      if (n > 0) cyboflowLogger.info(`[feedback] swept ${n} interrupted feedback batch(es) at boot`);
    })
    .catch((err: unknown) => {
      cyboflowLogger.error('[feedback] sweepInterruptedBatches failed at boot', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  // Single write chokepoint for `agent_overrides` (migration 029) — the
  // cyboflow.agents tRPC router reaches it via getInstance(). Serializes
  // per-project; emits AgentChangedEvent post-commit on the per-project channel.
  AgentOverrideRouter.initialize(cyboflowDb);
  HumanStepManager.initialize(cyboflowDb);
  // Per-step result store (Stage 3, migration 033): the programmatic step recorder
  // + crash-safe resume + the monitor.stepResults tRPC query reach it here.
  StepResultStore.initialize(cyboflowDb);

  // Run-artifact write chokepoint (migration 029). The single serialized writer
  // for `artifacts`; the cyboflow.artifacts tRPC router + the report/commit-artifact
  // MCP handlers reach it via getInstance(). Its artifactChangeEvents emitter is
  // consumed directly by cyboflow.artifacts.onArtifactChanged (no bridge needed).
  //
  // The third arg resolves WHERE a committed artifact's durability snapshot
  // (FEATURE #3) is written: the global `artifactCommitDir` setting resolved
  // against the owning project's ROOT (durable across worktree teardown). Kept as
  // a closure over configManager + databaseService so the router stays free of
  // ConfigManager/service imports (standalone-typecheck invariant). Fail-soft:
  // any lookup error returns null → the snapshot is skipped, never the commit.
  // S5 — the Accept-as-baseline committer (4th ArtifactRouter arg). The router stays
  // fs/git-free (standalone-typecheck invariant); this closure does the concrete fs
  // work via the FsBaselineStore (copy run-artifact PNGs into the git-tracked
  // .cyboflow/artifacts/baselines/<key>/<viewport>.png tree at the project ROOT) and
  // stages + commits them with `git`. It is the ONLY layer allowed to import the
  // electron-backed cyboflowDirectory util + child_process. Mirrors the
  // resolveCommitDir closure: a closure over databaseService + the run-artifacts-dir
  // resolver. Returns the baselineKey actually written.
  const fsBaselineStore = new FsBaselineStore();
  ArtifactRouter.initialize(
    cyboflowDb,
    cyboflowLogger,
    (projectId: number) => {
      try {
        const project = databaseService.getProject(projectId);
        if (!project?.path) return null;
        return resolveArtifactCommitDir(project.path, configManager.getArtifactCommitDir());
      } catch {
        return null;
      }
    },
    async ({ projectId, runId, baselineKey, fileNames }) => {
      const project = databaseService.getProject(projectId);
      if (!project?.path) {
        throw new Error(`accept-baseline: project ${projectId} has no path`);
      }
      const projectRoot = project.path;
      const artifactsDir = getCyboflowSubdirectory('artifacts', 'runs', runId);
      const written: string[] = [];
      for (const fileName of fileNames) {
        const stem = path.basename(fileName).replace(/\.png$/i, '');
        const source = path.join(artifactsDir, path.basename(fileName));
        // The viewport stem of the captured PNG IS its baseline viewport stem.
        const dest = await fsBaselineStore.write(projectRoot, baselineKey, stem, source);
        written.push(dest);
      }
      // Stage + commit the baselines tree (only the baselines paths we wrote). Run in
      // the project ROOT (baselines are durable at root, not the run worktree).
      if (written.length > 0) {
        try {
          execFileSync(resolveGitCommand(), ['add', '--', ...written], { cwd: projectRoot, stdio: 'pipe', windowsHide: true });
          execFileSync(
            resolveGitCommand(),
            ['commit', '-m', `chore: accept visual baseline ${baselineKey}`, '--', ...written],
            { cwd: projectRoot, stdio: 'pipe', windowsHide: true },
          );
        } catch (err) {
          // A git failure (no repo / nothing changed) is logged but does not undo the
          // on-disk copy — the bytes are written; the human can commit manually.
          cyboflowLogger?.warn('[acceptBaseline] git commit failed (fail-soft)', {
            projectId,
            baselineKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { baselineKey };
    },
    // 5th arg (IDEA-039) — the run's on-disk artifacts subtree resolver. Source of
    // committed bytes on snapshot AND the tree reapForRun removes on merge /
    // create-PR close-out. A closure over the electron-backed getCyboflowSubdirectory
    // (the router is electron-free, so the path is injected). Mirrors the
    // resolveCommitDir closure above.
    (runId: string) => getCyboflowSubdirectory('artifacts', 'runs', runId),
  );

  // Inject the run-artifacts-dir resolver the screenshots auto-mint scan reads —
  // CYBOFLOW_DIR/artifacts/runs/<runId>, the SAME subtree artifacts:load-images
  // serves bytes from and the agent writes into via $CYBOFLOW_RUN_ARTIFACTS_DIR.
  // Kept as a closure here (the only layer allowed to import the electron-backed
  // cyboflowDirectory util) so autoMintArtifacts stays free of electron imports
  // (standalone-typecheck invariant). Mirrors the ArtifactRouter boot wiring above.
  setRunArtifactsDirResolver((runId: string) => getCyboflowSubdirectory('artifacts', 'runs', runId));

  // Verification-AGENT driver CLI (redesign §5.4): asar-unpacked when packaged,
  // `__dirname`-relative in dev. Resolved HERE and injected, because `__dirname`
  // is THIS file's dist dir (main/dist/main/src) — the composer below must not
  // depend on where it happens to be compiled to.
  const verifyDriverCliPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        'app.asar.unpacked/main/dist/main/src/orchestrator/verify/driver/driverCli.js',
      )
    : path.join(__dirname, 'orchestrator', 'verify', 'driver', 'driverCli.js');
  // VerificationScheduler + everything it is injected with (backends, capped VLM
  // judge, dev/static servers, the verification-agent runner, the runbook store +
  // status resolver, the host probes, the lane runbook bootstrap) — composed in
  // verifyComposition.ts (issue #19 step 4). Order is load-bearing: the routers
  // above must exist (verdict delivery + bootstrap write through them) and
  // VerificationScheduler.initialize() must precede the OrchSocketServer below.
  const verifyComposition = composeVerification({
    configManager,
    cyboflowLogger,
    cyboflowDb,
    databaseService,
    fsBaselineStore,
    claudeExecutablePath,
    driverCliPath: verifyDriverCliPath,
  });
  const { verifyRunbookStore, runbookBootstrapStamps } = verifyComposition;
  // Module-scope holders the per-request tRPC context factory reads lazily.
  verifyHostProbes = verifyComposition.verifyHostProbes;
  verifyRunbookStatus = verifyComposition.verifyRunbookStatus;

  // Passive dynamic-workflow tracker (Workflow tool / ultracode detection).
  // The CLI managers attach it to each run's EventRouter pipeline via
  // tryGetInstance(); it creates completion review items through
  // ReviewItemRouter.getInstance(), so it MUST initialize after the router.
  DynamicWorkflowTracker.initialize(cyboflowDb, { logger: cyboflowLogger });

  // Code-review eval worker + pairwise A/B judge worker + their two trigger
  // subscriptions — composed in evalComposition.ts (issue #19 step 4). Both
  // write through ReviewItemRouter, so this MUST run after the routers above
  // (mirrors DynamicWorkflowTracker).
  composeEvalWorkers({
    cyboflowDb,
    cyboflowLogger,
    configManager,
    claudeExecutablePath,
    gitDiffManager,
    resolveGitRefToSha,
    emptyWorktreeStatus: EMPTY_WORKTREE_STATUS,
    appVersion: app.getVersion(),
    runbookBootstrapStamps,
  });

  // Guarded-model availability (Fable 5.1). Seeds the guarded set as optimistically
  // usable; the spawn seam falls back to Opus and the pickers grey a model out
  // when it's marked unavailable. refresh() is a best-effort Models-API probe that
  // no-ops without an Anthropic credential in the environment (most users
  // authenticate the bundled CLI via Claude Code's own login) — reactive marking
  // from the claude spawn error path then carries the load. Fire-and-forget so a
  // slow/failed probe never blocks boot.
  const modelAvailability = ModelAvailabilityService.initialize({ logger: cyboflowLogger });
  void modelAvailability.refresh().catch((err: unknown) => {
    cyboflowLogger?.warn?.(
      `[ModelAvailability] initial probe failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Concrete publisher: adapts BrowserWindow.webContents.send to the
  // StreamEventPublisher interface.  This is the only place in the codebase
  // that calls win.webContents.send for cyboflow stream events, keeping
  // the electron import out of main/src/orchestrator/.
  const cyboflowPublisher: StreamEventPublisher = {
    publish: (runId, event) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      win.webContents.send(`cyboflow:stream:${runId}`, event);
    },
  };

  // ptyPublisher — the raw-PTY byte path (TASK-814 / IDEA-030). Mirrors
  // cyboflowPublisher but sends VERBATIM interactive-substrate PTY chunks on a
  // DEDICATED cyboflow:pty:<runId> channel for a future live xterm terminal
  // (TASK-815). These ephemeral bytes BYPASS runEventBridge entirely — there is
  // no raw_events persistence and no cyboflow:stream coupling (Q3
  // panel-preservation). The facade subscription that drives this is wired below
  // where substrateFacade + mainWindow are both in scope (near the RunExecutor ctor).
  const ptyPublisher = (runId: string, data: string): void => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    // Send the VERBATIM chunk as a bare string — the renderer contract
    // (`subscribeToPtyBytes` / InteractiveTerminalView, and its tests) treats the
    // preload-bridged `args[0]` as the raw PTY ANSI string and writes it directly
    // to `xterm.write`. Wrapping it in an object made `term.write` receive
    // `{runId,data,timestamp}` and render NOTHING — the blank live terminal seen
    // on the first IDEA-030 live smoke. The channel is already runId-scoped, so no
    // envelope is needed.
    win.webContents.send(`cyboflow:pty:${runId}`, data);
  };

  // Global-agent thread store (migration 071) — constructed HERE, before the
  // OrchSocketServer, because the MCP cyboflow_propose_action handler needs it as
  // the `agentThreadStore` dep (S0.4 left it optional; propose_action fails closed
  // until this lands). The SAME instance is reused by the proposal executor
  // (app.whenReady, below) and injected into the tRPC context — one store, one DB.
  agentThreadStore = new AgentThreadDbStore(cyboflowDb);

  // Custom Views service (migration 132, docs/proposals/CUSTOM-VIEWS.md §9 row
  // S3) — built right here so index.ts wiring stays the ONE call
  // createCustomViewsService documents: the store (this DB), the built-in
  // catalog specs (shared, so the widget action service can resolve a
  // `{type:'catalog'}` ref the same way runWidget does), and the three
  // proposal-preparation closures the widget action service shares with the
  // MCP cyboflow_propose_action handler (prepareProposal.ts). Every closure
  // below reads its module-scope target LAZILY (agentThreadService may not
  // exist yet; the executor deps holder is set later in app.whenReady), so
  // construction order here is safe.
  customViewsStore = new CustomViewsDbStore(cyboflowDb);
  customViewsService = createCustomViewsService({
    db: cyboflowDb,
    store: customViewsStore,
    catalogSpecs: CATALOG_WIDGET_SPECS,
    ensureGlobalThreadId: () => {
      if (!agentThreadService) throw new Error('assistant_unavailable');
      return agentThreadService.ensureGlobalThread().id;
    },
    createProposal: (input) => agentThreadStore.createProposal(input),
    prepare: (raw) => prepareProposal(createPrepareProposalDeps(cyboflowDb), raw),
    execute: (proposalId) => executeProposal(getProposalExecutorDeps(), proposalId),
    getProposal: (id) => agentThreadStore.getProposal(id),
  });

  // OrchSocketServer — the orchestrator-side half of the Cyboflow MCP IPC link.
  // Stands up the Unix-domain socket under ~/.cyboflow/sockets/orch.sock that the
  // spawned cyboflowMcpServer subprocess(es) connect back to so the cyboflow_*
  // tools are routable.  Started here (before the RunLauncher block) so its
  // socket path is available to the providers, the McpServerLifecycle, and the
  // CLI manager below.  `cyboflowDb`/`cyboflowLogger` are already in scope above.
  // `onInteractiveTurnEnd` wires the Stop-hook turn-end seam (IDEA-030):
  // mcpQueryHandler cannot import main/src/services directly (ORCHESTRATOR
  // LAYERING RULE), so the callback is threaded in here where
  // `interactiveCliManager` is already narrowed to InteractiveClaudeManager
  // (the throw-guard above at its construction site).
  const orchSocketServer = new OrchSocketServer(
    orchSocketEndpoint(getCyboflowSubdirectory('sockets', 'orch.sock')),
    cyboflowDb,
    cyboflowLogger,
    {
      onInteractiveTurnEnd: (runId) => interactiveCliManager.notifyTurnEnd(runId),
      onInteractiveQuestionOpen: (runId) => interactiveCliManager.notifyQuestionOpen(runId),
      // Global-agent proposal writer: the cyboflow_propose_action MCP tool (global
      // scope) inserts agent_proposals rows through this store. Without it the
      // handler fails closed (returns an error) — so it must be the SAME instance
      // the executor + tRPC context read.
      agentThreadStore,
      // Custom-widget-authoring global-agent tools (cyboflow_db_schema /
      // _widget_preview / _widget_save, docs/proposals/CUSTOM-VIEWS.md §9 row
      // S6): the SAME `customViewsService` instance constructed above, so a
      // saved widget draft is visible to the exact service the renderer's
      // tRPC router reads. Absent only if this handler runs before boot
      // wiring completes (never the case in production).
      customViews: customViewsService ?? undefined,
      // Global-agent scoped filesystem tools (cyboflow_fs_read / _list / _grep):
      // the always-included roots are the registered project paths; this dep
      // supplies the user-configured EXTRA folders on top. Absent ⇒ [] (project
      // folders only). The orchestrator handler realpath's + scope-checks every
      // access — this only widens the root set, never bypasses enforcement.
      getAssistantFolderAccess: () => configManager.getAssistantFolderAccess(),
      getAssistantExcludedProjectPaths: () => configManager.getAssistantExcludedProjectPaths(),
      // Phase 2 §5.2 seam 1: the cyboflow_register_verify_runbook tool writes the
      // MACHINE-LOCAL runbook record through this store. Deliberately the SAME
      // instance the VerificationScheduler was initialized with above — the setup
      // flow registers a draft here and the ENGINE proves that exact record on a
      // passing setup-proof run, so the two halves of "derive → prove" must be
      // looking at one store over one DB.
      verifyRunbookStore,
      // The GLOBAL visual-verify config, read LIVE per call — the same accessor
      // the WorkflowRegistry injects into createRun. Only the `__quick__` chat
      // sentinel consults it: its run stamp is minted on the session's first turn
      // and has no UPDATE path, so a quick session resolves its verify posture at
      // CALL time through this closure instead. A closure (not the resolved value)
      // so toggling the master switch in Settings takes effect on the next tool
      // call rather than requiring a restart.
      getVisualVerifyConfig: () => configManager.getVisualVerifyConfig(),
      // The sprint task-cap override, read LIVE for the same reason: the
      // cyboflow_create_sprint_batch backstop must honor the CURRENT setting, not
      // one frozen at launch.
      getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
      // Workflow/variant configuration tools (cyboflow_*_workflow / _variant):
      // forward the WorkflowRegistry as the narrow WorkflowConfigLike structural
      // surface so quick sessions can edit flows + variants over MCP without the
      // handler importing the concrete registry. ensureGlobalBuiltIns is a
      // zero-arg closure here (supplying the in-repo built-ins), matching the
      // structural type; every other method forwards 1:1.
      workflowConfig: {
        getById: (id) => workflowRegistry.getById(id),
        listByProject: (projectId) => workflowRegistry.listByProject(projectId),
        ensureGlobalBuiltIns: () => workflowRegistry.ensureGlobalBuiltIns(buildBuiltInWorkflows()),
        getBaselineRotation: (id) => workflowRegistry.getBaselineRotation(id),
        getEffectiveDefinition: (id) => workflowRegistry.getEffectiveDefinition(id),
        updateSpec: (id, def) => workflowRegistry.updateSpec(id, def),
        resetSpec: (id) => workflowRegistry.resetSpec(id),
        createCustom: (params) => workflowRegistry.createCustom(params),
        deleteWorkflow: (id) => workflowRegistry.deleteWorkflow(id),
        listVariants: (id, opts) => workflowRegistry.listVariants(id, opts),
        createVariantFromCurrent: (id, label, opts) =>
          workflowRegistry.createVariantFromCurrent(id, label, opts),
        updateVariant: (variantId, patch) => workflowRegistry.updateVariant(variantId, patch),
        setVariantStatus: (variantId, status) => workflowRegistry.setVariantStatus(variantId, status),
        deleteVariant: (variantId) => workflowRegistry.deleteVariant(variantId),
        setBaselineRotation: (id, patch) => workflowRegistry.setBaselineRotation(id, patch),
      },
      // Ad-hoc code-review eval tool (cyboflow_run_eval): forward to the EvalWorker
      // singleton initialized above, which owns the ONE definition of the snapshot
      // deps (diff closure, app version, config toggles, enqueue) shared with the
      // automatic human-review trigger — so the two mint paths can never drift.
      // Deliberately NOT error-swallowed here (unlike the automatic trigger's
      // snapshot()): an explicit caller must get a reason, and the MCP handler maps
      // a throw to an ok:false reply.
      runAdHocEval: (runId) => EvalWorker.getInstance().runAdHoc(runId),
    },
  );
  // Keep the start promise so the MCP subprocess (below) can be gated on the
  // socket actually listening — it is a pure client and dies with ECONNREFUSED if
  // it connects before the bind completes. The dedicated .catch here keeps a bind
  // failure from surfacing as an unhandled rejection before that gate attaches.
  const orchSocketReady = orchSocketServer.start();
  orchSocketReady.catch((err) => {
    cyboflowLogger.error(
      `[Cyboflow Orch IPC] socket server start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // OrchSocketProvider — delegates to the running OrchSocketServer so RunLauncher
  // injects the live socket path into spawned sessions.
  const orchSocketProvider: OrchSocketProvider = {
    getSocketPath: () => orchSocketServer.getSocketPath(),
  };

  // BridgeScriptResolver — delegates to resolveMcpServerScriptPath(), which
  // returns the asar-unpacked path in packaged builds and the __dirname-relative
  // compiled .js in dev (no extraction step needed).
  const bridgeScriptResolver: BridgeScriptResolver = {
    getScriptPath: () => resolveMcpServerScriptPath(),
  };

  // NodeResolver — returns the process's own node executable path as a
  // best-effort fallback.  A proper findExecutableInPath ladder is epic 7.
  const nodeResolver: NodeResolver = {
    getNodePath: async () => process.execPath,
  };

  // Concrete WorkflowPromptReaderLike adapter — keeps RunExecutor free of direct
  // fs/concrete-module imports while branching on the run's workflow row.
  //
  // The branch logic (built-in / edited built-in `.md` + step-reporting append vs
  // custom-flow rendered-graph prompt) lives in readWorkflowPromptForRow so it is
  // unit-testable without bootstrapping Electron — see workflowPromptReaderAdapter.ts.
  // A live run also passes its runId, so the appended step-reporting / fan-out
  // instructions derive from the run's FROZEN spec and its tuning_level stamp
  // instead of the live `workflows.spec_json` — under a tuning preset those are
  // different graphs, and prompting the orchestrator off the wrong one hands it a
  // lane vocabulary the MCP write path rejects (plan D9).
  const promptReader: WorkflowPromptReaderLike = {
    read: (workflow, runId) =>
      readWorkflowPromptForRow(
        workflow,
        runId === undefined ? null : resolveRunPromptContext(cyboflowDb, runId),
      ),
  };

  // SubstrateDispatchFacade — the substrate-aware ClaudeSpawnerLike that replaces
  // the single-manager spawnerAdapter (IDEA-013 S4 / TASK-809). It resolves
  // workflow_runs.substrate per run (via workflowRegistry.getRunById) and dispatches
  // spawnCliProcess to defaultCliManager ('sdk' / legacy / default) or
  // interactiveCliManager ('interactive'); abort hits the manager that spawned the
  // run's panel. It ALSO extends EventEmitter and fans-in BOTH managers'
  // 'output'/'exit' events, re-emitting them on itself — so the SAME facade serves
  // as RunExecutor's single `source` EventEmitter (which is bound once at
  // construction and cannot be swapped per run). One object satisfies both seams.
  // cyboflowLogger is PASSED (CODE-PATTERNS.md optional-logger rule).
  // Assign the module-level binding (declared near the other shared services) so
  // the run dep-bag wiring in app.whenReady() can reach the SAME facade instance
  // for the live-input relay (IDEA-030 / TASK-817).
  // Panel-id arm of the facade's manager resolution. The facade reads
  // `workflow_runs` to classify a RUN id; chat panels address their own PTY by
  // `panel.id` (a session's panels all share ONE chat_run_id, so the sentinel
  // cannot identify a panel), and a panel id matches no run — it used to floor to
  // 'sdk', making relayInput/relayResize silently no-op for a reopened PTY chat.
  // This lookup answers "which manager owns THIS panel" via the shared lane
  // resolver (services/panelLane.ts), so the facade agrees with every dispatch
  // seam on both axes: the session fixes the provider, the panel's own override
  // fixes the substrate.
  // THE lane→manager table for this process. Shared by the dispatch facade and
  // the panel-owner lookup below so both answer "which manager owns this lane"
  // from one registration list — a new provider is an added entry here and
  // nothing else at this seam.
  const laneManagers: ManagerRegistration[] = [
    { lane: 'claude-sdk', manager: defaultCliManager },
    { lane: 'claude-interactive', manager: interactiveCliManager },
    { lane: 'codex-sdk', manager: createdCodexSdkManager },
    { lane: 'codex-pty', manager: codexPtyManager },
    { lane: 'omp-sdk', manager: createdOmpSdkManager },
    { lane: 'omp-pty', manager: ompPtyManager },
    { lane: 'pi-pty', manager: piPtyManager },
    { lane: 'pi-sdk', manager: piSdkManager },
  ];
  const managerByLane = new Map<PanelLane, AbstractCliManager>(
    laneManagers.map(({ lane, manager }) => [lane, manager]),
  );

  const resolvePanelOwner = (panelId: string): AbstractCliManager | undefined => {
    const panel = panelManager.getPanel(panelId);
    if (!panel || panel.type !== 'claude') return undefined;
    const dbSession = databaseService.getSession(panel.sessionId);
    // A lane with no manager is a wiring bug, not a reason to run the panel on
    // Claude: resolveLaneManager throws in dev/test and logs before flooring in
    // production. The `default:`-to-Claude arm this replaces was silent, so a
    // provider whose manager had not been registered ran as Claude unnoticed.
    return resolveLaneManager(
      resolvePanelLane(dbSession, panel),
      managerByLane,
      defaultCliManager,
      `[Main] resolvePanelOwner(${panelId})`,
    );
  };

  substrateFacade = new SubstrateDispatchFacade({
    managers: laneManagers,
    registry: workflowRegistry,
    logger: cyboflowLogger,
    panelOwnerLookup: resolvePanelOwner,
  });

  // LifecycleTransitions adapter — keeps RunExecutor free of services/* imports by
  // delegating to the transitionTo* helpers at the index.ts boundary.
  const rawDb = databaseService.getDb();
  // Emit a project-wide run-status-changed signal AFTER a successful transition.
  // Placed after the (throwing) transition call so a rejected transition (e.g.
  // restAwaitingReview when the run already left 'running') fires no false event.
  // This is the signal activeRunsStore subscribes to so the rail/action-bar
  // react to the clean-drain REST, which creates no approval row.
  const emitRunStatus = (event: RunStatusChangedEvent): void => {
    runStatusEvents.emit('changed', event);
  };
  // Q1 GUARD (shared sweep): drop a torn-down run's PENDING draft entities (epics +
  // orphan tasks created pre-approval). deleteRunCreatedEntities self-gates on
  // plan_approved_at IS NULL + keys on run_id, so an approved run's revealed tasks
  // (and any non-planner run) are untouched. Resolves the run's project_id here.
  // Defined in the OUTER setup scope so BOTH the lifecycle 'failed' seam below and
  // the app.whenReady() cancel / cancel-and-restart dep-bags can share it.
  const deletePendingDraftsForRun = async (runId: string): Promise<void> => {
    const r = rawDb
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId?: number } | undefined;
    if (!r || typeof r.projectId !== 'number') return;
    await TaskChangeRouter.getInstance().deleteRunCreatedEntities(r.projectId, runId);
  };
  const lifecycleTransitions: LifecycleTransitionsLike = {
    running: (runId) => {
      transitionToRunning(rawDb, { runId });
      emitRunStatus({ runId, status: 'running' });
    },
    restAwaitingReview: (runId) => {
      transitionRunningToAwaitingReview(rawDb, { runId });
      emitRunStatus({ runId, status: 'awaiting_review' });
    },
    failed: (runId, fromStatus, errorMessage) => {
      transitionToFailed(rawDb, { runId, fromStatus, errorMessage });
      emitRunStatus({ runId, status: 'failed' });
      // F5: the run reached a FAILED terminal — sweep its pending drafts so a
      // plan-gated run that errored before approval leaves no orphaned drafts.
      // Fire-and-forget + fail-isolated: transitionToFailed already committed +
      // emitted, so a sweep error must never surface out of this void adapter.
      void deletePendingDraftsForRun(runId).catch((err: unknown) => {
        cyboflowLogger.error('[Main] failed-seam pending-draft sweep rejected', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    canceled: (runId) => {
      transitionToCanceled(rawDb, { runId });
      emitRunStatus({ runId, status: 'canceled' });
    },
  };

  // StepTransitionEmitterLike adapter — delegates to buildStepTransitionEvent() +
  // resolveRunLevelStepId() while keeping RunExecutor free of bridge imports.
  // If resolveRunLevelStepId returns null (fresh run of an unknown workflow),
  // no DB write and no emit occurs.
  const stepTransitionEmitter: StepTransitionEmitterLike = {
    emit: (runId: string, status: 'pending' | 'running' | 'done') => {
      // Resolve the workflow name AND the run's current step pointer. A FRESH run
      // has current_step_id === null and stamps the workflow's initial step; a
      // re-driven run (programmatic→orchestrated handover, resume, nudge, reopen)
      // already has an advanced pointer that resolveRunLevelStepId PRESERVES so the
      // flow-tracking timeline is not reset back to the first stage.
      const runRow = rawDb.prepare(
        `SELECT w.name AS workflowName, r.current_step_id AS currentStepId
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE r.id = ?`,
      ).get(runId) as { workflowName: string; currentStepId: string | null } | undefined;
      if (!runRow) return;
      const stepId = resolveRunLevelStepId(runRow.currentStepId, runRow.workflowName);
      if (!stepId) return;
      buildStepTransitionEvent(runId, stepId, status, cyboflowDb, cyboflowLogger);
    },
  };

  // RunExecutor wired with the SubstrateDispatchFacade as BOTH the spawner (substrate-
  // aware dispatch, in place of the single-manager spawnerAdapter) AND the EventEmitter
  // source (so bridgeEvents() can call .on('output') against the fan-in of both
  // managers, regardless of which substrate ran). Plus WorkflowPromptReader,
  // LifecycleTransitions adapter, streaming publisher + db for event bridging, and the
  // stepTransitionEmitter for lifecycle step-transition events (TASK-765).
  //
  // The executor NEVER auto-completes a run: on SDK iterator drain it rests the
  // run in awaiting_review (running -> awaiting_review via restAwaitingReview).
  // `completed` is set ONLY by an explicit user accept (Merge / Create-PR) in the
  // runs router. This supersedes the old GAP-A pending-work probe (never
  // auto-completing subsumes "don't complete while a gate is pending").
  // Idea-body reader (migration 017): resolves a run's seed_idea_id to its prose
  // body via selectTaskById (UNION over ideas/epics/tasks). Injected as the
  // trailing RunExecutor arg so getPrompt can prepend a `# Selected idea` block
  // to the planner's prompt. Reads through the narrow DatabaseLike adapter
  // (cyboflowDb) — the same handle selectTaskById receives in the tasks router.
  const ideaBodyReader: IdeaBodyReaderLike = {
    read: (id) => {
      const item = selectTaskById(cyboflowDb, id);
      return item
        ? {
            type: item.type,
            title: item.title,
            summary: item.summary,
            body: item.body,
            scope: item.scope,
            ref: item.ref,
            // Attachments are ideas-only (migration 028) and kept off the read
            // model — resolve them directly so getPrompt can list their paths.
            attachments:
              item.type === 'idea'
                ? selectIdeaAttachments(cyboflowDb, id).map((a) => ({ name: a.name, path: a.path }))
                : null,
          }
        : null;
    },
  };

  // Programmatic-run driver (execution-model seam, Stage 2). When a run's
  // immutable `execution_model` stamp is 'programmatic', RunExecutor delegates the
  // whole run to this collaborator: host code (the WorkflowController) walks the
  // run's DAG, running each step as a scoped agent turn via the SAME spawn surface
  // (substrateFacade), driving the live timeline through buildStepTransitionEvent
  // (the same path cyboflow_report_step uses), and resolving human gates by
  // opening a blocking review item via HumanStepManager + awaiting its resolution
  // on reviewItemChangeEvents. Default 'orchestrated' runs never touch this.
  const programmaticRunner = new DefaultProgrammaticRunner({
    spawner: substrateFacade,
    // Enables the controller's agentless visual-verify enqueue capability
    // (enqueueTaskVerification — verification-agent redesign §5.3): absent, the
    // step cleanly skips (fail-open) and visual verification never fires on the
    // programmatic plane.
    db: rawDb,
    reporter: {
      report: (runId, stepId, status) =>
        void buildStepTransitionEvent(runId, stepId, status, cyboflowDb, cyboflowLogger),
    },
    gate: buildReviewQueueHumanGate({
      events: reviewItemChangeEvents,
      channelFor: reviewItemProjectChannel,
      logger: cyboflowLogger,
    }),
    // Per-step idea scope for programmatic prompts. The ownership projection
    // unions workflow_runs.seed_idea_id with ideas created by this run, so Ship's
    // raw-prompt path picks up the idea its context step creates before optional
    // design steps evaluate UI_PROTOTYPE / ARCH_DESIGN.
    runOwnedIdeaIdsProvider: (runId) => listRunOwnedIdeaIds(cyboflowDb, runId),
    // §11 (lane-runbook-bootstrap): the files this run's bootstrap committed,
    // rendered as a do-not-touch list on address-review. That step "fixes in
    // place", and both files are booby-trapped for a well-meant fix — the
    // runbook's proof is content-addressed against the committed bytes, and the
    // rung-1 config edit is what makes the environment stand up at all.
    bootstrapProtectedPathsProvider: (runId) => runbookBootstrapStamps.writtenPathsForRun(runId),
    // Per-step agent-runtime resolver (Codex-per-step mixing): resolves the run's
    // FULL effective agent set (project overrides + workflow agentConfigs + variant
    // deltas — the same layering the agent overlay writes to disk) and looks up the
    // requested agentKey's runtime/model/providerModel/effort. Absent EVERY override
    // (unoverridden agent) -> undefined, so the step spawns under the run-level
    // provider/runtime/model with no per-agent effort. Effort is returned even
    // without a runtime override so a Claude agent can carry a reasoning-effort pin
    // (IDEA-029), and `model` likewise so a Claude agent can carry a MODEL pin: a
    // programmatic step turn IS the agent (a top-level spawn), so the agent
    // overlay's `model:` frontmatter never binds on this plane and this resolver is
    // the pin's only channel. The alias is resolved to its concrete snapshot here
    // (mirroring the overlay writer) so the spawn receives a real model id.
    resolveStepAgent: (runId, agentKey) => {
      const eff = resolveRunEffectiveAgents(rawDb, runId);
      const a = eff.find((e) => e.agentKey === agentKey);
      if (!a || (!a.runtime && !a.effort && !a.model)) return undefined;
      // Provider-access gate for PER-AGENT runtime pins. `agentConfigs` can be
      // written by the MCP workflow-config tools as well as the editor, so a pin
      // naming a provider the user switched off in Settings → Integrations can
      // reach here even though the editor hides it. Drop just the runtime pin
      // (keeping model/effort) so the step falls back to the run-level provider,
      // which createRun already resolved onto an ENABLED provider — same
      // fail-soft shape as the CLAUDE_ONLY_AGENT_KEYS drop.
      const pinnedRuntime =
        a.runtime && !configManager.isAgentProviderEnabled(providerForRuntime(a.runtime))
          ? undefined
          : a.runtime;
      if (a.runtime && pinnedRuntime === undefined) {
        cyboflowLogger.warn(
          `[resolveStepAgent] dropping ${a.runtime} pin for agent '${agentKey}' — provider disabled in Settings → Integrations`,
        );
      }
      // bareModelId resolves the alias to the current concrete snapshot at the
      // agent's DEFAULT window and strips any `[1m]` suffix — so a per-agent
      // `opus` pin spawns `claude-opus-5` (default window), matching the
      // orchestrated overlay's `model:` frontmatter semantics (modelContext.ts),
      // NOT the 1M variant a run-level `opus` picker would select. Intentional:
      // per-agent pins are window-agnostic and consistent across both planes.
      const model = bareModelId(a.model, isModelUsable);
      return {
        ...(pinnedRuntime ? { runtime: pinnedRuntime } : {}),
        ...(model ? { model } : {}),
        // a.providerModel is already normalized (providerModel ?? codexModel) by
        // effectiveAgents; codexModel mirrors it so a not-yet-migrated consumer of
        // this return shape (there is none left in-tree, but the field stays a
        // read-compat alias) still sees the correct value.
        ...(a.providerModel ? { providerModel: a.providerModel, codexModel: a.providerModel } : {}),
        ...(a.effort ? { effort: a.effort } : {}),
      };
    },
    // Blocking-review-items checkpoint: parks a programmatic run at each step
    // boundary while a PENDING BLOCKING review_item exists (e.g. a blocking finding
    // the agent recorded), awaits it clearing on reviewItemChangeEvents, then
    // resumes. Reuses HumanStepManager for the park/resume/count primitives so the
    // same aggregate-unblock invariant governs both gate decisions and findings.
    blockingGate: new ReviewQueueBlockingItemsGate(
      HumanStepManager.getInstance(),
      reviewItemChangeEvents,
      reviewItemProjectChannel,
      cyboflowLogger,
    ),
    // Systemic-pause gate (usage/rate-limit park + auto-resume): see systemicPauseGateWiring.ts.
    systemicGate: buildSystemicPauseGate({
      events: reviewItemChangeEvents,
      channelFor: reviewItemProjectChannel,
      logger: cyboflowLogger,
    }),
    // Visual merge-gate (programmatic actuation): closes the prose-only boundary so
    // a PROGRAMMATIC sprint parks each lane after visual-verify, awaits the async
    // verdict the VerificationScheduler delivers, and re-dispatches implement on a
    // FAIL (or fails the lane at the cap) — instead of integrating prematurely or
    // leaving a FAILed lane parked. Subscribes to the scheduler's verificationEvents
    // + reads the merge-gate's lane write. Inert for verify-disabled / non-sprint runs.
    visualGate: new SchedulerVisualVerifyGate({
      db: cyboflowDb,
      events: verificationEvents,
      channelFor: verificationChannel,
      logger: cyboflowLogger,
    }),
    // ON-DEMAND monitor (the monitor-unify refactor): the single triage + chat
    // human-seam plane, folding the old Stage 3 supervisor + supervisor-chat into
    // one token-frugal `MonitorSession` in the run's existing Chat pane. ALWAYS ON
    // for programmatic runs (supervisor-role redesign, 2026-07-05 — the old
    // `programmaticSupervisor` opt-in is gone): the supervisor is a Q&A partner the
    // human can query at ANY point, and escalations surface in BOTH the chat and
    // the review queue. A `DefaultMonitorSession` over the real on-demand query fns
    // (monitorQuery.ts) + a HistoryReader bound to cyboflowDb; it reads the WHOLE
    // history ONLY when it must act, and costs zero tokens during routine progress.
    // The run's `injectEvent` (2nd factory arg, from the run context — Slice B) is
    // owned by the session so `converse` renders both sides of an exchange into the
    // Chat pane (the tRPC `monitor.send` seam); the runner registers the session in
    // MonitorRegistry so the router reaches it. NOT headlessly verifiable — it
    // makes a real Claude call.
    monitorFactory: ((): ((
      ctx: MonitorContext,
      injectEvent: (event: ClaudeStreamEvent) => void,
    ) => MonitorSession | undefined) => {
      const structuredQuery = makeSdkStructuredQuery(claudeExecutablePath, cyboflowLogger);
      const textQuery = makeSdkTextQuery(claudeExecutablePath, cyboflowLogger);
      // 3rd arg = the RUN-DELIVERABLES reader (CR-6): what this run produced,
      // folded into the gate + review-loop prompts.
      const history = new DefaultHistoryReader(cyboflowDb, cyboflowLogger, (r) => readRunDigest(cyboflowDb, r, cyboflowLogger));
      // Also published to the module-scoped buildMonitorSession holder so the
      // lazy monitor rehydrator (wired in the tRPC dep-wiring block) builds
      // byte-identical sessions when reviving a run's chat after an app restart.
      const buildSession = (
        ctx: MonitorContext,
        injectEvent: ((event: ClaudeStreamEvent) => void) | undefined,
      ): MonitorSession =>
        new DefaultMonitorSession({
          ctx,
          history,
          structuredQuery,
          textQuery,
          injectEvent,
          // Monitor-actuation seam: the retry_step action executes through the
          // SAME retryRunHandler chokepoint as runs.retryStep, bound lazily via
          // the module-scoped holder (the RunExecutor does not exist yet at
          // monitorFactory construction time — see monitorRetryStep's docblock).
          actions: {
            retryStep: (stepId) =>
              monitorRetryStep
                ? monitorRetryStep(ctx.runId, stepId)
                : Promise.resolve({
                    ok: false,
                    message: 'Retry is not wired yet — try again in a moment.',
                  }),
            switchToOrchestrated: (reason) =>
              monitorSwitchToOrchestrated
                ? monitorSwitchToOrchestrated(ctx.runId, reason)
                : Promise.resolve({
                    ok: false,
                    message: 'Handover is not wired yet — try again in a moment.',
                  }),
            // The 9 confirm-gated steering actions, all delegating to the single
            // late-bound monitorSteeringActions holder (wired in the dep-wiring
            // block). Each threads the session's own runId.
            addTask: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.addTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            removeTask: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.removeTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            editTask: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.editTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            skipStep: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.skipStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            unskipStep: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.unskipStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            steerStep: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.steerStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            rewindToStep: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.rewindToStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            rewindLaneToStep: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.rewindLaneToStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            resolveReviewItem: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.resolveReviewItem(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
            fileNote: (input) =>
              monitorSteeringActions
                ? monitorSteeringActions.fileNote(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED),
          },
          logger: cyboflowLogger,
        });
      buildMonitorSession = buildSession;
      return buildSession;
    })(),
    // Host-driven fan-out lane substrate (generalize-parallel-fan-out): builds a
    // per-run FanOutDriver bound to the run's batch_id so the WorkflowController can
    // resolve a fanOut step's item set + drive a sprint lane per item ON THE
    // PROGRAMMATIC PLANE. Reuses the SAME sprintLaneStore already wired below — the
    // lane events fire on sprintLaneChannel(runId), so useSprintLanes lights up live
    // with zero new subscription. Returns undefined when the run carries no batch_id
    // (not a seeded sprint) ⇒ the host gets no driver ⇒ no host-driven fan-out
    // (byte-identical to today; orchestrated sprints still drive lanes via the MCP
    // backstop). driveLane is fail-soft — a lane-store error is swallowed + logged so
    // a broken lane write never aborts the controller walk.
    fanOutDriverFactory: ({ batchId }) => {
      if (!batchId) return undefined;
      return {
        resolveItems: (_runId, over) =>
          over === 'tasks'
            ? sprintLaneStore
                .listLanes(batchId)
                // Crash-safe resume: skip lanes already settled (integrated/
                // failed/blocked) so a re-entered fanOut step does not re-run
                // completed work, flip a failed lane back to integrated, or
                // let a BLOCKED child re-enter without its failed parent
                // (Item 6, Codex C3 — a blocked lane never started and stays
                // excluded until an explicit reset, e.g. resetFailedLanes,
                // re-queues it) — mirrors the monotonic-forward guard in
                // deriveLaneFromTaskDispatch. On a fresh run all lanes are
                // 'queued', so every task is returned.
                .filter(
                  (lane) => lane.status !== 'integrated' && lane.status !== 'failed' && lane.status !== 'blocked',
                )
                .map((lane) => lane.taskId)
            : [],
        // DAG ordering (2026-06-22): expose the batch's BLOCKING edges so the
        // controller dispatches a task only after its prerequisites integrate.
        // Reads task_dependencies for the batch's lane task ids; returns taskId →
        // [prerequisite taskIds]. An empty map ⇒ flat waves (no dependencies).
        dependencies: (_runId, over) => {
          const map = new Map<string, string[]>();
          if (over !== 'tasks') return map;
          const taskIds = sprintLaneStore.listLanes(batchId).map((lane) => lane.taskId);
          if (taskIds.length === 0) return map;
          const placeholders = taskIds.map(() => '?').join(',');
          const rows = rawDb
            .prepare(
              `SELECT task_id, depends_on_task_id FROM task_dependencies
                 WHERE kind = 'blocking' AND task_id IN (${placeholders})`,
            )
            .all(...taskIds) as Array<{ task_id: string; depends_on_task_id: string }>;
          for (const row of rows) {
            const prereqs = map.get(row.task_id) ?? [];
            prereqs.push(row.depends_on_task_id);
            map.set(row.task_id, prereqs);
          }
          return map;
        },
        // Same task-file rows the task editor persists are the concurrency source
        // of truth. This deliberately does not inspect task prompt/body text.
        expectedFiles: (_runId, over) => {
          const map = new Map<string, string[]>();
          if (over !== 'tasks') return map;
          const taskIds = sprintLaneStore.listLanes(batchId).map((lane) => lane.taskId);
          if (taskIds.length === 0) return map;
          const placeholders = taskIds.map(() => '?').join(',');
          const rows = rawDb
            .prepare(`SELECT task_id, file_path FROM task_files WHERE task_id IN (${placeholders})`)
            .all(...taskIds) as Array<{ task_id: string; file_path: string }>;
          for (const row of rows) {
            const files = map.get(row.task_id) ?? [];
            files.push(row.file_path);
            map.set(row.task_id, files);
          }
          return map;
        },
        // Commit-integrity backstop: 'integrated' means "complete AND committed
        // in the session worktree", which inner-step verdicts alone cannot
        // establish — a lane whose `git commit` was denied by a permission gate
        // reported green with its changes left untracked on disk (observed live).
        // Read the run's worktree HEAD at lane start and re-read it at lane end;
        // the controller refuses to integrate a lane that moved HEAD nowhere and
        // left the tree dirty. Every failure path (no worktree row, git error)
        // degrades to "no probe" / a rethrow the controller swallows, so the
        // backstop can only withhold a false integrate, never invent a failure.
        beginCommitProbe: async (rid) => {
          const row = rawDb
            .prepare(`SELECT worktree_path FROM workflow_runs WHERE id = ?`)
            .get(rid) as { worktree_path?: unknown } | undefined;
          const worktreePath =
            row && typeof row.worktree_path === 'string' && row.worktree_path.length > 0
              ? row.worktree_path
              : null;
          if (worktreePath === null) return undefined;
          const readHead = async (): Promise<string> =>
            (await runGitAsync(worktreePath, ['rev-parse', 'HEAD'])).trim();
          const startHead = await readHead();
          return async () => {
            const endHead = await readHead();
            const porcelain = await runGitAsync(worktreePath, ['status', '--porcelain']);
            // §9 (lane-runbook-bootstrap): a RUNBOOK BOOTSTRAP commits into this
            // same shared worktree, mid-lane. HEAD then moves for a reason that
            // is not any lane's work — and since the only case that withholds
            // 'integrated' is "HEAD did not move AND the tree is dirty", an
            // advanced HEAD would let a lane that committed nothing integrate
            // anyway. That is the exact failure this probe exists to catch, so
            // the bootstrap's own commits are subtracted before the comparison.
            //
            // Fail-soft on purpose, in the direction that PRESERVES the probe: a
            // rev-list that throws leaves headAdvanced as the plain sha
            // comparison, which is what shipped.
            let headAdvanced = endHead !== startHead;
            if (headAdvanced) {
              try {
                const bootstrapShas = new Set(runbookBootstrapStamps.commitShasForRun(rid));
                if (bootstrapShas.size > 0) {
                  const between = (
                    await runGitAsync(worktreePath, ['rev-list', `${startHead}..${endHead}`])
                  )
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                  // Compared by PREFIX in both directions: the stamp records
                  // whatever `rev-parse HEAD` returned (full) but a hand-written
                  // or abbreviated sha must still match.
                  headAdvanced = between.some(
                    (sha) =>
                      ![...bootstrapShas].some((b) => sha.startsWith(b) || b.startsWith(sha)),
                  );
                }
              } catch {
                // Keep the plain comparison.
              }
            }
            return { headAdvanced, dirty: porcelain.trim().length > 0 };
          };
        },
        // Targeted failed→running un-settle for the controller's MONITOR LANE
        // RESCUE at the visual merge gate: that gate durably writes the lane
        // 'failed' before the controller's awaitVerdict resolves, so a rescued
        // lane is already settled in the store while its walk is still live.
        // Status-guarded to 'failed' inside the store (a no-op otherwise) and
        // fail-soft there too, so no try/catch is needed here.
        reviveLane: ({ itemId }) => {
          sprintLaneStore.reviveLane(batchId, itemId);
        },
        driveLane: ({ runId: rid, itemId, status, currentStepId, attempt, allowedStepIds }) => {
          try {
            sprintLaneStore.updateLane({
              runId: rid,
              batchId,
              taskId: itemId,
              allowedStepIds,
              ...(status !== undefined ? { status } : {}),
              ...(currentStepId !== undefined ? { currentStepId } : {}),
              ...(attempt !== undefined ? { attempt } : {}),
            });
          } catch (err) {
            cyboflowLogger.debug('[fanOutDriver] driveLane skipped (fail-soft)', {
              runId: rid,
              itemId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },
    // Live batch_id reader (generalize-parallel-fan-out follow-up): backs the
    // fan-out driver provider's mid-walk re-read so `ship`'s materialize-batch
    // step (which UPDATEs workflow_runs.batch_id strictly AFTER this run's
    // ProgrammaticRunContext is built) is honored on the SAME walk instead of a
    // permanently-null one-shot snapshot silently degrading execute-tasks to a
    // single agent step. Reuses the SAME WorkflowRegistry row reader RunExecutor
    // itself uses to snapshot ctx.run at the top of execute() — just re-invoked
    // live rather than once.
    readRunBatchId: (runId) => workflowRegistry.getRunById(runId)?.batch_id ?? null,
    // Sprint task-scope provider (grounding fix, 2026-06-22): resolve the
    // `# Sprint tasks` block body for a sprint run's batch so the programmatic step
    // prompts carry the real task set (reuses the SAME buildSeedTasksBlock helper +
    // readers the orchestrated getPrompt path uses, so both planes emit identical
    // scope). Without it the analyze-dependencies step agent never sees the tasks,
    // concludes "No dependencies", and the dependents fan out concurrently and fail.
    seedTasksProvider: (batchId) =>
      buildSeedTasksBlock(
        batchId,
        { listLaneTaskIds: (b) => sprintLaneStore.listLanes(b).map((lane) => lane.taskId) },
        ideaBodyReader,
        cyboflowLogger,
      ),
    // ── Autonomous LANE TRIAGE (monitor lane rescue) ────────────────────────
    // All three route through the late-bound `laneTriageActions` holder so they
    // reuse the SAME TaskMutationDeps / ReviewItemRouter seams the monitor's chat
    // actions use. Unwired, each degrades to the no-lane-triage posture.
    laneTriageTaskReader: (runId, itemId) => laneTriageActions?.readTask(runId, itemId),
    laneTriageAdjustTask: (runId, input) =>
      laneTriageActions
        ? laneTriageActions.adjustTask(runId, input)
        : Promise.resolve({ ok: false, reason: 'backlog edits are not wired yet' }),
    laneTriageFindingSink: (runId, input) =>
      laneTriageActions ? laneTriageActions.fileFinding(runId, input) : Promise.resolve(),
    // ── SUPERVISED REVIEW LOOP (monitor steering each automatic design lap) ──
    // Same late-bound posture: unwired, BOTH reject — the host then abandons a
    // supervisor resolve, and keeps a set-aside entry in the lap (never dropped).
    monitorFindingSink: (runId, input) =>
      monitorFindingSink ? monitorFindingSink(runId, input) : Promise.reject(new Error('monitor finding sink not wired yet')),
    setAsideFindingSink: (runId, input) =>
      setAsideFindingSink ? setAsideFindingSink(runId, input) : Promise.reject(new Error('set-aside finding sink not wired yet')),
    // ── ESCALATION REVIEW (the supervisor's recommendation at a human gate) ──
    // Same late-bound posture: unwired ⇒ an empty queue and a logged-only
    // recommendation, i.e. today's card exactly.
    escalationSinks: () => gateEscalationSinks,
    // RUN-LEVEL verification posture (CD1) reads the runbook through the SAME
    // closure the scheduler's §3.2 degrade gate and the health panel's badge use
    // — there must never be a third reading of `verify_runbook_local.status`.
    // Read LAZILY through the module holder (it is assigned inside
    // initializeServices, like every other late-bound probe): an unset holder
    // resolves `null`, which the posture reads as UNKNOWN and answers 'available'
    // for, never as "this project has no runbook".
    verifyRunbookStatus: async (projectId, modality, probePath) =>
      verifyRunbookStatus ? verifyRunbookStatus(projectId, modality, probePath) : null,
    // Per-step result sink (migration 033): persist each settled step so results
    // are queryable + crash-safe resume can skip individually-completed steps.
    stepResultRecorder: (runId, report) =>
      StepResultStore.tryGetInstance()?.record({
        runId,
        stepId: report.stepId,
        phaseId: report.phaseId,
        outcome: report.outcome,
        attempts: report.attempts,
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(report.deliberate !== undefined ? { deliberate: report.deliberate } : {}),
      }),
    logger: cyboflowLogger,
  });

  // Selected-finding reader (migration 034) — injected as the trailing
  // RunExecutor arg; reads through the same narrow DatabaseLike adapter the
  // review routers use.
  const findingReader = createSeededFindingReader(cyboflowDb);

  runExecutor = new RunExecutor(
    substrateFacade,
    workflowRegistry,
    cyboflowLogger,
    promptReader,
    lifecycleTransitions,
    cyboflowPublisher,
    rawDb,
    substrateFacade,
    stepTransitionEmitter,
    taskChangeRouter,
    ideaBodyReader,
    // Sprint-lane task-id reader (feat/parallel-sprint): getPrompt resolves the
    // batch's seeded task ids to render the `# Sprint tasks` block. Thin adapter
    // over SprintLaneStore.listLanes — keeps RunExecutor on a narrow interface.
    {
      listLaneTaskIds: (batchId) => sprintLaneStore.listLanes(batchId).map((lane) => lane.taskId),
      markBatchTerminal: (batchId, status) => sprintLaneStore.markBatchTerminal(batchId, status),
    },
    programmaticRunner,
    findingReader,
    // Queued-input deliverer ("always allow messaging a running flow"): at the
    // drained REST seam the executor hands buffered chat input to this collaborator
    // as the NEXT turn via the SAME nudge re-spawn path (flip awaiting_review ->
    // running, setPendingNudge, execute) under the per-run RunQueueRegistry
    // discipline. The closure captures the MODULE-SCOPED runExecutor + runQueues
    // (both assigned by the time any drain fires) and the cyboflowDb DatabaseLike —
    // it is only invoked at drain time, never during construction.
    {
      deliver: (runId, text) => {
        void nudgeRunHandler(runId, text, { db: cyboflowDb, runQueues, runExecutor });
      },
    },
    // Global-default agent-permission-mode thunk (permission-mode redesign
    // §3c#1): the fallback resolveRunAgentPermissionMode uses when a run's owning
    // session has a NULL agent_permission_mode (inherit the global default).
    () => configManager.getDefaultAgentPermissionMode(),
    // Dynamic-workflow liveness probe: the interactive rest seam consults this so
    // a turn-end that merely yields to a background `Workflow` task does not park
    // the run in awaiting_review while its subagents are still working. Read
    // through tryGetInstance so boot ordering (tracker initialized above, but
    // defensively) can never throw here.
    (runId) => DynamicWorkflowTracker.tryGetInstance()?.hasRunningForRun(runId) === true,
  );

  // Raw-PTY byte path (TASK-814 / IDEA-030): subscribe the facade's 'pty-output'
  // fan-in (interactive substrate only) to the ptyPublisher, forwarding VERBATIM
  // chunks to the renderer on cyboflow:pty:<runId>. The payload is opaque
  // `unknown` on the facade EventEmitter, so narrow it through a typed local
  // shape (NO `any`). This deliberately bypasses runEventBridge — the bytes are
  // ephemeral live-view only and are never persisted to raw_events.
  //
  // Broadcast on BOTH `runId` (the gate-vehicle id: workflow-run panels' own id,
  // or a chat session's shared chatSentinelProvider sentinel — the PRIMARY chat
  // panel's InteractiveTerminalView still subscribes by this id) and `panelId`
  // (every panel's own id — an added, non-primary chat panel, TASK-103, has no
  // shared-sentinel subscriber of its own and always subscribes by its panelId).
  // For workflow-run panels these are the same channel (orchestrator invariant),
  // so this is one harmless duplicate send there. Electron drops any
  // webContents.send with no listener, so broadcasting the unused key is inert.
  substrateFacade.on('pty-output', (payload) => {
    const evt = payload as { runId: string; panelId: string; data: string };
    ptyPublisher(evt.runId, evt.data);
    if (evt.panelId !== evt.runId) ptyPublisher(evt.panelId, evt.data);
  });

  // Turn-START status flip for PTY QUICK sessions — the twin of the turn-end
  // rest below, and the reason it can fire at all.
  //
  // Only the COMPOSER path marked a PTY quick session 'running'
  // (ipc/ptyPanelDispatch.ts's markRunning, reached from `sessions:input`). A
  // turn started by RAW TERMINAL KEYSTROKES — which is how an AskUserQuestion in
  // the Claude TUI is answered, arrow keys then Enter — goes
  // xterm -> runs.relayInput -> facade.relayInput -> sendInput and touched no
  // session state. The session then sat at its RESTING status for the whole
  // turn, with three visible consequences: the board derived `idle` so the row
  // never moved to "Working"; the turn-end rest below bailed on its
  // `status !== 'running'` guard; and because `sessions.idle_since` is stamped
  // ONLY at the busy->resting transition (database.ts's
  // IDLE_SINCE_ON_STATUS_CHANGE), the quiet clock stayed frozen at the PREVIOUS
  // rest — a session that had worked for two hours rendered "quiet 19h".
  //
  // Guards mirror the rester exactly (interactive substrate + chat_run_id match,
  // so a flow run's turn never touches the chat session) and it is a no-op when
  // the session is already 'running' — the composer path still flips first for a
  // turn it dispatches, and this must not re-write on every submitted line.
  // Fail-soft: a status-flip failure must never disturb the live REPL.
  substrateFacade.on('turn-start', (payload) => {
    try {
      const evt = payload as { panelId: string; sessionId: string; runId: string };
      const dbSession = sessionManager.getDbSession(evt.sessionId);
      if (!dbSession || dbSession.substrate !== 'interactive') return;
      if (!dbSession.chat_run_id || dbSession.chat_run_id !== evt.runId) return;
      if (dbSession.status === 'running') return;
      // updateSession (not a direct db write) because 'running' needs no
      // completed_unviewed preservation and this is the SAME call the composer
      // path makes — it maps the status, stamps idle_since NULL through the
      // shared CASE, and emits 'session-updated' itself.
      sessionManager.updateSession(evt.sessionId, { status: 'running' });
    } catch (err) {
      console.error('[Main] Failed to flip PTY quick-session status on turn-start:', err);
    }
  });

  // Turn-end status rest for PTY QUICK sessions (IDEA-030 follow-on). The facade
  // re-emits the interactive manager's 'turn-end' ({ panelId, sessionId, runId }),
  // but RunExecutor only listens for runs it executes — the sentinel `__quick__`
  // run has NO executor, so nothing would flip the session out of 'running' when
  // an assistant turn completes. Mirror the SDK quick path's resting value:
  // sessionManager.addSessionOutput marks the DB row 'completed' on the
  // system/result message (rendered as completed_unviewed/stopped by
  // mapDbStatusToSessionStatus). Guarded to sessions whose substrate is
  // 'interactive' AND whose sessions.chat_run_id (the chat sentinel) matches the
  // payload runId — workflow runs (hosted sessions, runId ≠ chat_run_id) are
  // untouched. Fail-soft: a status-flip failure must never disturb the live REPL.
  substrateFacade.on('turn-end', (payload) => {
    try {
      const evt = payload as { panelId: string; sessionId: string; runId: string };
      const dbSession = sessionManager.getDbSession(evt.sessionId);
      if (!dbSession || dbSession.substrate !== 'interactive') return;
      // Role-G: the interactive turn-end carries the gate run = the chat_run_id
      // sentinel (the live chat REPL), DECOUPLED from sessions.run_id (Role-D, the
      // latest flow run). Match on chat_run_id so a flow run's turn-end never rests
      // the chat session (and vice versa).
      if (!dbSession.chat_run_id || dbSession.chat_run_id !== evt.runId) return;
      if (dbSession.status !== 'running') return;
      // A turn-end that lands while a dynamic workflow is still RUNNING for this
      // run is the agent yielding to a background Workflow task, not the session
      // finishing — the CLI re-invokes it when the workflow completes. Flipping
      // to 'completed' here would strand the session in a terminal-looking state
      // (and enable Merge) while its subagents are still writing the worktree.
      // This is reachable today: the Ultracode wizard card launches quick PTY
      // sessions with `--settings '{"ultracode":true}'`, which is exactly the
      // setting that makes the agent fan work out as dynamic workflows.
      // The session rests on the NEXT turn-end after the workflow goes terminal.
      if (DynamicWorkflowTracker.tryGetInstance()?.hasRunningForRun(evt.runId) === true) return;
      // Direct DB write + manual session-updated emit — the same shape as the
      // SDK exit handler in events.ts (updateSession would re-map 'completed'
      // through mapSessionStatusToDbStatus and lose the completed_unviewed edge).
      sessionManager.db.updateSession(evt.sessionId, { status: 'completed' });
      const updatedSession = sessionManager.getSession(evt.sessionId);
      if (updatedSession) {
        sessionManager.emit('session-updated', updatedSession);
      }
    } catch (err) {
      console.error('[Main] Failed to rest PTY quick-session status on turn-end:', err);
    }
  });

  // Per-run PQueue registry. Shared with Orchestrator (for drain-on-shutdown)
  // and ApprovalRouter (for permission-decision dispatch). RunLauncher needs it
  // so `runLauncher.launch()` can enqueue `runExecutor.execute(runId)` — without
  // it, the run stays at `starting` forever.
  runQueues = new RunQueueRegistry();

  // Shared session-mode write chokepoint deps (permission-mode redesign §3d/§3e /
  // Slice 5). The SAME three side effects (persist sessions.agent_permission_mode
  // + 'session-updated' emit + runtime mutate) back three callers: the composer
  // pill IPC handler (builds its own deps from AppServices),
  // runs.setPermissionMode (setSetPermissionModeDeps below), and
  // RunLauncher.launch (the constructor param below). The interactive substrate
  // needs no spawn-side priming: the PTY gating hook rides the inline
  // `--settings` flag and is recomputed from the persisted mode at every spawn.
  sessionPermissionModeDeps = {
    databaseService,
    sessionManager,
  };

  runLauncher = new RunLauncher(
    cyboflowDb,
    workflowRegistry,
    worktreeManager,
    cyboflowLogger,
    mcpConfigWriter,
    orchSocketProvider,
    bridgeScriptResolver,
    nodeResolver,
    cyboflowPublisher,
    runExecutor,
    runQueues,
    taskChangeRouter,
    // Sprint-lane store slice (feat/parallel-sprint, single-run lane model):
    // launch() with seedTaskIds creates the batch + per-task lane rows and
    // stamps workflow_runs.batch_id. Narrow adapter over the singleton.
    {
      createForRun: (projectId, substrate, taskIds) =>
        sprintLaneStore.createForRun(projectId, substrate, taskIds),
    },
    // Launch-picker → host-session mode (permission-mode redesign §3e): when an
    // explicit requestedPermissionMode is supplied, launch() writes it to the host
    // session through the shared chokepoint before createRun.
    sessionPermissionModeDeps,
    // A/B testing (migration 048): the rotation resolver. launch() resolves the
    // variant (explicit pin or weighted random over active variants) pre-createRun
    // so every launch surface inherits rotation from one place.
    new VariantResolver(cyboflowDb),
    // Idea-session nesting lineage (migration 114): launch() stamps
    // sessions.origin_idea_id for a SINGULAR idea-seeded launch, then refreshes
    // the session so the sidebar regroups it under the idea immediately.
    sessionManager,
  );

  // Capture the orch socket path once for the lifecycle + CLI-manager wiring.
  const socketPath = orchSocketServer.getSocketPath();

  // McpServerLifecycle — manages the singleton cyboflowMcpServer subprocess that
  // connects back to the OrchSocketServer above.  The run-id provider returns the
  // documented 'orchestrator' sentinel; per-session run-id is supplied per-tool-call
  // (TASK-800), not here.  cyboflowLogger is a LoggerLike already in scope above.
  const mcpServerLifecycle = new McpServerLifecycle(
    socketPath,
    cyboflowLogger,
    () => 'orchestrator',
  );

  // Wire the orch socket path into BOTH CLI managers so each one's spawn path
  // injects the 'cyboflow' MCP entry / CYBOFLOW_ORCH_SOCKET into every spawned
  // session, on whichever substrate runs.  This is the first production caller of
  // setOrchSocketPath; it does not need to wait on the lifecycle start() below.
  // The managers are typed as AbstractCliManager (setOrchSocketPath lives on each
  // concrete subclass), so narrow via instanceof — the factory creates a
  // ClaudeCodeManager for 'claude' and an InteractiveClaudeManager for
  // 'claude-interactive' at runtime.
  // Chat-gate sentinel provider (permission-mode redesign §6). Constructed here —
  // after the WorkflowRegistry exists — and injected into BOTH managers so a chat
  // turn's approval gate resolves the session's persistent `__quick__` chat_run_id
  // sentinel (minted on read) instead of the overloaded sessions.run_id. Shares the
  // raw better-sqlite3 handle the managers received via additionalOptions.db.
  const chatSentinelProvider = makeChatSentinelProvider({
    db: databaseService.getDb(),
    workflowRegistry,
    logger: cyboflowLogger,
    // On first mint the sentinel is written via a raw UPDATE (bypassing
    // sessionManager), so the frontend's session copy keeps chatRunId=null and the
    // inline approval strip (keyed on it) stays blank until a manual re-fetch
    // (tab-away/back). Push a fresh snapshot so the reactive store resolves the
    // gate runId immediately. getSession re-reads the DB → chatRunId is populated.
    onMint: (sessionId: string) => {
      const updated = sessionManager.getSession(sessionId);
      if (updated) sessionManager.emit('session-updated', updated);
    },
  });
  if (defaultCliManager instanceof ClaudeCodeManager) {
    defaultCliManager.setOrchSocketPath(socketPath);
    defaultCliManager.setChatSentinelProvider(chatSentinelProvider);
    // Global-agent chat thread service (migration 071). Hosts the standing SDK
    // conversation with the S0.2 isolation spawn contract + the
    // AgentThreadEventsSink as the single durable transcript writer. It needs the
    // CONCRETE ClaudeCodeManager (the isolation/tools/mcpScope/eventsSink spawn
    // fields live on ClaudeSpawnOptions, and warm reuse rides its 'output' stream),
    // hence construction under this instanceof narrowing. The Codex app-server
    // manager is wired alongside it: which of the two hosts a turn is resolved
    // per turn from ConfigManager.getAssistantRuntime(). The `publish` closure
    // does BOTH the raw cyboflow:stream:<threadId> IPC send AND an emit on
    // agentThreadEvents so the tRPC onThreadEvent subscription can live-tail too.
    // Model default follows ConfigManager (open question §5); the neutral home base
    // is the per-kind data dir + /agent-home (dev vs prod resolved by
    // getCyboflowSubdirectory).
    agentThreadService = new AgentThreadService({
      store: agentThreadStore,
      // One manager per assistant runtime; the service picks per turn from
      // `runtime()` below. Both are bridged for live-tail from the first turn,
      // so switching providers mid-life needs no restart.
      managers: {
        'claude-sdk': defaultCliManager,
        'codex-sdk': createdCodexSdkManager,
      },
      runtime: () => configManager.getAssistantRuntime(),
      publish: (id, envelope) => {
        // The service builds `{ type, payload, timestamp }` envelopes; the publish
        // dep types them `unknown` to stay decoupled from the concrete discriminated
        // StreamEnvelope union, so bridge with the SAME boundary cast runEventBridge
        // uses (its `type` is a plain string, not the narrow discriminant).
        cyboflowPublisher.publish(id, envelope as StreamEnvelope);
        agentThreadEvents.emit('message', { threadId: id, envelope });
      },
      defaultModel: (runtime) => configManager.getAssistantModelFor(runtime),
      enabled: () => configManager.isAssistantEnabled(),
      contextRetention: () => configManager.getAssistantContextRetention(),
      homeDirBase: getCyboflowSubdirectory('agent-home'),
      logger: cyboflowLogger,
    });
  }
  if (interactiveCliManager instanceof InteractiveClaudeManager) {
    interactiveCliManager.setOrchSocketPath(socketPath);
    interactiveCliManager.setChatSentinelProvider(chatSentinelProvider);
    // Wire the deny-on-teardown shell-approval canceller (IDEA-030 / TASK-819):
    // the interactive teardown seam denies/closes any in-flight PreToolUse shell-
    // approval sockets for the run BEFORE the PTY is killed, delegating to the
    // OrchSocketServer's public twin (which forwards to the handler's shipped
    // cancelInFlightShellApprovals). Without this the manager-side canceller is
    // null and the deny ships as a production no-op.
    interactiveCliManager.setShellApprovalCanceller((runId) =>
      orchSocketServer.cancelInFlightShellApprovals(runId),
    );
  }
  createdCodexSdkManager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: socketPath,
    bridgeScriptPath: bridgeScriptResolver.getScriptPath(),
    nodeExecutablePath: await nodeResolver.getNodePath(),
  });
  createdCodexSdkManager.setApprovalRouterProvider(() => ApprovalRouter.getInstance());
  createdCodexSdkManager.setQuestionRouterProvider(() => QuestionRouter.getInstance());
  // OMP tool approvals are answered in-process after the gating extension vets
  // them; content questions use the same durable QuestionRouter as Claude/Codex.
  createdOmpSdkManager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: socketPath,
    bridgeScriptPath: bridgeScriptResolver.getScriptPath(),
    nodeExecutablePath: await nodeResolver.getNodePath(),
  });
  createdOmpSdkManager.setQuestionRouterProvider(() => QuestionRouter.getInstance());

  // OrchestratorHealth — constructed with the real McpServerLifecycle so both the
  // raw-IPC cyboflow:mcp-health channel and the tRPC cyboflow.health.mcpServer
  // procedure read live status (off the old hard-coded 'starting' fallback).
  // McpServerLifecycle structurally satisfies McpLifecycleReadable, so no adapter
  // is needed.
  // The socket-integrity probe is what keeps this snapshot honest: the lifecycle
  // only knows the subprocess is up, not that the path it dials still exists.
  orchestratorHealth = new OrchestratorHealth(mcpServerLifecycle, {
    isSocketPathIntact: () => orchSocketServer.isSocketPathIntact(),
  });

  // Start the MCP server subprocess only AFTER the orch socket is listening — it
  // is a pure client (net.createConnection) that would otherwise race the bind,
  // hit ECONNREFUSED, and burn its 2-restart budget before the socket comes up.
  // On failure (including a fatal orch-socket bind) record the error on the health
  // surface (callable now that orchestratorHealth exists) and log it.
  void orchSocketReady
    .then(() => mcpServerLifecycle.start())
    .catch((err) => {
      orchestratorHealth.setMcpError(err instanceof Error ? err.message : String(err));
      cyboflowLogger.error(`[Cyboflow MCP] lifecycle start failed: ${String(err)}`);
    });

  // Idle-debounced quick-session summarizer (session-summary-plan.md §5). Built
  // here (services layer, where cross-layer glue lives): the summarizer's
  // environment couplings are resolved as plain values (a bare `'haiku'` string
  // would NOT alias-resolve through the SDK), and the two state probes translate
  // a sessionId onto the same signals the sessions:list-quick board reads. The
  // scheduler module itself imports nothing from services/*.
  const sessionSummarizer = makeSessionSummarizer(
    {
      sdkQueryLoader: loadSdkQuery,
      // Pin the concrete snapshot id; the alias table only applies via the resolver.
      modelId: resolveModelAlias('haiku') ?? 'claude-haiku-4-5',
      claudeExecutablePath,
    },
    cyboflowLogger,
  );
  sessionSummaryScheduler = makeSessionSummaryScheduler({
    db: databaseService,
    isEnabled: () => configManager.isSessionSummaryEnabled(),
    summarize: sessionSummarizer,
    // Turn-in-flight probe: the session's DB status GATED BY process liveness.
    // 'running'/'pending' means a turn is nominally active, but that status can go
    // STALE — a PTY REPL that died without a clean turn-end leaves the session
    // stuck at 'running' forever, which (with a bare status check) would block
    // summarization permanently. So when the status says running/pending we
    // additionally confirm a LIVE process actually backs one of the session's
    // panels before treating it as in-flight: a genuine mid-turn (either
    // substrate) still has its panel in the manager's process map and is
    // correctly blocked; a stale 'running' with nothing alive falls through and
    // is allowed to summarize. isPanelRunning is a public read-only accessor on
    // AbstractCliManager (both substrate managers extend it), so this needs no
    // change under services/panels/claude/.
    isTurnInFlight: (sessionId: string): boolean => {
      const status = databaseService.getSession(sessionId)?.status;
      if (status !== 'running' && status !== 'pending') return false;
      const panels = databaseService.getPanelsForSession(sessionId);
      return panels.some(
        (p) => interactiveCliManager.isPanelRunning(p.id) || defaultCliManager.isPanelRunning(p.id),
      );
    },
    // Open-gate probe: the session's chat run has a pending AskUserQuestion /
    // permission gate — assembled from the SAME blocked-set sources as
    // sessions:list-quick (QuestionRouter / ApprovalRouter / PTY awaiting-input).
    hasOpenGate: (sessionId: string): boolean => {
      const runId = databaseService.getSession(sessionId)?.chat_run_id;
      if (!runId) return false;
      if (QuestionRouter.getInstance().getPending().some((q) => q.runId === runId)) return true;
      if (ApprovalRouter.getInstance().getPending().some((a) => a.runId === runId)) return true;
      return interactiveCliManager.getAwaitingInputRunIds().has(runId);
    },
    // PTY pre-read backfill (§ transcript ingest): an interactive session writes
    // NO conversation_messages of its own — its content lives only as ANSI stdout
    // in session_outputs — so without this the watermark read always sees an empty
    // delta for it. For an interactive session, mirror its Claude-CLI JSONL
    // transcript into conversation_messages before the delta is computed; an SDK
    // session already streams its rows inline, so this resolves immediately.
    ingestTranscript: async (sessionId: string): Promise<void> => {
      if (databaseService.getSession(sessionId)?.substrate !== 'interactive') return;
      await ingestPtyTranscript({ db: databaseService, logger: cyboflowLogger }, sessionId);
    },
    logger: cyboflowLogger,
  });
  // Subscribe to the substrate turn seams: SDK 'exit' arms / 'spawned' clears;
  // the facade's re-emitted PTY 'turn-end' arms. The PTY relay input seam
  // (no 'spawned') is cleared directly from the sessions:input IPC handler.
  // ALL THREE SDK lanes are passed: a Codex/OMP session streams conversation
  // rows exactly like a Claude one, so its turns must arm the idle timer too —
  // subscribing Claude alone left those sessions dependent on a lazy catch-up
  // that only fires if someone happens to read the summary.
  wireSessionSummaryScheduler({
    sdkManagers: [defaultCliManager, createdCodexSdkManager, createdOmpSdkManager],
    facade: substrateFacade,
    scheduler: sessionSummaryScheduler,
  });

  const services: AppServices = {
    app,
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager: defaultCliManager, // Backward compatibility
    interactiveCliManager, // PTY substrate sibling (narrowed to the concrete class above)
    codexSdkManager: createdCodexSdkManager,
    codexPtyManager,
    ompSessionManager,
    ompSdkManager: createdOmpSdkManager,
    ompPtyManager,
    piSdkManager: createdPiSdkManager,
    piPtyManager,
    claudeModelCatalogService: new ClaudeModelCatalogService(cyboflowLogger),
    // Live-session close-out seams for quick sessions (IDEA-030): route the
    // session merge/rebase/dismiss handlers through the SubstrateDispatchFacade
    // so a quick session's persistent process is never orphaned — interactive
    // REPLs are gracefully ended (EOF/`/exit`) or hard-killed; a warm SDK
    // query() is killed. Mirrors the RelayDeps closures wired in
    // app.whenReady(); the facade translates the sentinel runId per substrate.
    endLiveSession: (runId: string) => substrateFacade.endSession(runId),
    killLiveSession: (runId: string) => substrateFacade.killSession(runId),
    // Deterministic at-spawn runId→panelId registration for PTY quick sessions:
    // seeds the facade's translation maps BEFORE the fire-and-forget startPanel
    // so a relay/close-out racing the first PTY byte never falls back to the
    // sentinel runId (the event-fed mapping only exists after the first
    // 'pty-output'/'turn-end').
    registerLivePanel: (runId: string, panelId: string) =>
      substrateFacade.registerInteractivePanel(runId, panelId),
    registerCodexPtyPanel: (runId: string, panelId: string) =>
      substrateFacade.registerPtyPanel(runId, panelId, codexPtyManager),
    registerOmpPtyPanel: (runId: string, panelId: string) =>
      substrateFacade.registerPtyPanel(runId, panelId, ompPtyManager),
    registerPiPtyPanel: (runId: string, panelId: string) =>
      substrateFacade.registerPtyPanel(runId, panelId, piPtyManager),
    // The SAME provider the Claude managers were injected with above, handed to
    // the IPC layer for the CODEX lanes: those spawn from ipc/ with a
    // caller-supplied runId instead of resolving the gate inside the manager, so
    // without this they read `chat_run_id` raw and never reach the revive that
    // heals an app_restart-parked sentinel.
    chatSentinelProvider,
    // Idle-debounced quick-session summarizer — the sessions:input handler calls
    // noteTurnStart on it (the PTY relay input-seam clear, §2.2) and
    // sessions:get-summary kicks lazy catch-up (§2.7).
    sessionSummaryScheduler,
    gitDiffManager,
    gitStatusManager,
    executionTracker,
    runCommandManager,
    taskQueue,
    getMainWindow: () => mainWindow,
    logger,
    archiveProgressManager,
    cyboflow: {
      workflowRegistry,
      runLauncher,
      cancelHostedRuns: (sessionId: string): Promise<void> => {
        if (!cancelHostedRunsImpl) {
          logger?.warn(`[Main] cancelHostedRuns called before orchestrator boot — skipped for session ${sessionId}`);
          return Promise.resolve();
        }
        return cancelHostedRunsImpl(sessionId);
      },
    },
  };

  // The session-worktree git surface is a tRPC router now (slice 3 of the
  // IPC→tRPC migration), not an ipcMain.handle module — but its ops still need
  // the SAME services object registerIpcHandlers gets, close-out seams
  // included. Publish it on the module-scope holder the per-request tRPC
  // context reads.
  sessionGitOps = createGitOps(services);
  // Same seam, same reason, for the session-record surface (batch 1 of the
  // session-side migration): the `cyboflow.sessions` router's reads and small
  // mutations are ops closures over this very services object now, not
  // ipcMain.handle registrations.
  sessionOps = createSessionOps(services);

  // Initialize IPC handlers first so managers (like ClaudePanelManager) are ready
  registerIpcHandlers(services);
  // FU4 — screenshots artifact gallery: serve on-disk PNGs from the run's
  // artifact image root (additive; mirrors the ideaAttachments handler).
  registerArtifactImageHandlers(ipcMain, services);
  // IDEA-039 (Approach C) — static-mockup HTML loader: serve the canonical
  // prototype/index.html for a ui-prototype/generic artifact (run subtree, else
  // the committed snapshot store) with a restrictive CSP <meta> injected.
  registerArtifactHtmlHandlers(ipcMain, services);
  // Design Mode v1 (design-mode.md "Process isolation" + "Server lifecycle") —
  // the token-gated loopback prototype server + its runaway-frame watchdog. The
  // watchdog reads the main window's frame subtree, per-process metrics, and cpu
  // count via Electron-backed seams (the service modules stay Electron-free); the
  // manager loads the canonical interactive-prototype bytes fresh per request. The
  // two reference each other (watchdog reads the manager's live targets; the
  // manager start/stops the watchdog), so the watchdog closes over the
  // module-level manager var, which is assigned on the next line.
  const designFrameWatchdog = new DesignFrameWatchdog({
    // Both loopback servers share this ONE watchdog instance — the Custom
    // Views tier-3 widget server (docs/proposals/CUSTOM-VIEWS.md §5.4) is a
    // second, process-global source of scripted frames, so its live target is
    // concatenated onto the design-prototype server's per-run ones.
    getTargets: () => [...(designPrototypeServerManager?.getTargets() ?? []), ...(customWidgetServerManager?.getTargets() ?? [])],
    getFrames: () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return [];
      try {
        // A killed OOPIF's WebFrameMain throws on property access — the watchdog
        // guards each read; enumerating the subtree itself is guarded here.
        return win.webContents.mainFrame.framesInSubtree as unknown as FrameLike[];
      } catch {
        return [];
      }
    },
    getMetrics: () =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        percentCPUUsage: m.cpu?.percentCPUUsage ?? 0,
        workingSetSizeKB: m.memory?.workingSetSize ?? 0,
      })),
    killPid: (pid: number) => process.kill(pid, 'SIGKILL'),
    sendToRenderer: (event) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      win.webContents.send(DESIGN_PROTO_SERVER_EVENT_CHANNEL, event);
    },
    cpuCount: os.cpus().length,
    logger: cyboflowLogger,
  });
  designPrototypeServerManager = new DesignPrototypeServerManager({
    loadHtml: (runId: string) => loadCanonicalPrototypeHtml(services, runId, 'interactive-prototype'),
    watchdog: designFrameWatchdog,
    onServerStopped: (runId: string) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      win.webContents.send(DESIGN_PROTO_SERVER_EVENT_CHANNEL, { runId, kind: 'server-stopped' });
    },
    logger: cyboflowLogger,
  });
  registerDesignPrototypeServerHandlers(ipcMain, designPrototypeServerManager);
  // Custom Views tier-3 widget document server (docs/proposals/CUSTOM-VIEWS.md
  // §5.4) — the SAME watchdog as the prototype server above (its getTargets
  // already concatenates both managers). loadWidget reads the store built in
  // initializeServices(); customViewsStore is non-null by the time a widget
  // frame can request one (it is constructed before this window-bound wiring
  // ever runs), but the closure guards it defensively anyway.
  customWidgetServerManager = new CustomWidgetServerManager({
    loadWidget: (widgetId: string) => customViewsStore?.getWidget(widgetId) ?? null,
    theme: WIDGET_THEME_TOKENS,
    watchdog: designFrameWatchdog,
    logger: cyboflowLogger,
  });
  // No ipcMain.handle registration here — customWidgetServerManager.ensure/stop
  // are exposed as the cyboflow.customWidgetServer tRPC router (ratchet-blocked
  // otherwise: main/src/ipc/__tests__/noNewIpcHandlers.test.ts). Wired into
  // createContext via `customWidgetServer: customWidgetServerManager ?? undefined`
  // below, alongside `customViews`.
  // Design Mode v0 (design-mode.md) — the Approve intent-first state machine. The
  // cyboflow.design tRPC router (standalone-typecheck-clean) reaches this singleton
  // via getInstance(); boot recovery reads its deps bag. The prototype-byte reader
  // + snapshot base dir are injected here (electron-backed) so the service module
  // stays standalone-typecheck-safe. loadPrototypeHtml returns the RAW canonical
  // bytes (live subtree, else committed store); the render path injects the CSP.
  DesignHandoffService.initialize({
    db: cyboflowDb,
    loadPrototypeHtml: (runId: string, atype: string) => loadCanonicalPrototypeHtml(services, runId, atype),
    snapshotBaseDir: getCyboflowSubdirectory('design-snapshots'),
    logger: cyboflowLogger,
  });
  // Design/brief GATE side effects — the one place a human's "approve" at an
  // approve-ideas / approve-design / approve-brief gate becomes durable state:
  // the run's prototype bound to each approved idea as an `approved_designs` row
  // (which survives the run's artifact cascade delete, unlike the artifact
  // itself), the project's solution thoroughness stamped from the brief, and the
  // adversarial reviewer's remaining entries logged as accepted-risk findings.
  //
  // A singleton for the same reason DesignHandoffService is one: three call sites
  // reach it — the programmatic gate opener below, `resolveReviewItem` for the
  // orchestrated plane, and runExecutor's settle — and two of those build their
  // dependency bags in separate files. Threaded as an optional dep instead, it
  // would compile at both and silently do nothing at one.
  //
  // Wired HERE (after DesignHandoffService) so it shares the SAME snapshot tree
  // and prototype-byte reader: a flow-bound design and a Design Mode approval must
  // be readable through one path. It initializes AFTER ReviewItemRouter /
  // IdeaComponentRouter, whose getInstance() it captures.
  GateSideEffects.initialize({
    db: cyboflowDb,
    snapshotBaseDir: getCyboflowSubdirectory('design-snapshots'),
    loadPrototypeHtml: (runId: string, atype: string) => loadCanonicalPrototypeHtml(services, runId, atype),
    ideaComponentRouter: IdeaComponentRouter.getInstance(),
    reviewItemRouter: ReviewItemRouter.getInstance(),
    // Reuses the EXISTING project-changed channel (the same one projects:update
    // emits on) so the renderer refetches a thoroughness stamp with no new
    // listener — and, critically, no new ipcMain.handle, which the
    // noNewIpcHandlers ratchet would freeze.
    emitProjectUpdated: (projectId: number) => {
      const project = databaseService.getProject(projectId);
      if (project) sessionManager.emit('project:updated', project);
    },
    logger: cyboflowLogger,
  });
  // Design Mode v1 (design-mode.md "Design feedback v1 — acknowledged durable
  // outbox") — the delivery pipeline that drives a queued design-feedback batch
  // through guards → 'dispatching' → the SDK revision turn → 'dispatched', and
  // re-delivers whatever a crash left in flight.
  //
  // Wired HERE, after registerIpcHandlers, because `dispatchTurn` goes through
  // the Claude panel continue path (the same internals behind the
  // 'claude-panels:continue' IPC handler), and claudePanelManager only exists
  // once the IPC handlers are registered. The lazy require mirrors taskQueue's
  // continueQueue — index.ts must not take a static import on ipc/claudePanel.
  //
  // The lifecycle guards are the service's DB-backed defaults; only the SDK turn
  // and the clock are host-supplied.
  designFeedbackOutbox = new DesignFeedbackOutbox({
    db: cyboflowDb,
    feedbackRouter: FeedbackRouter.getInstance(),
    dispatchTurn: async ({ sessionId, prompt }): Promise<void> => {
      const session = sessionManager.getSession(sessionId);
      if (!session) throw new Error(`design session ${sessionId} no longer exists`);
      const claudePanel = panelManager
        .getPanelsForSession(sessionId)
        .find((panel) => panel.type === 'claude');
      if (!claudePanel) throw new Error(`design session ${sessionId} has no Claude panel to deliver the turn to`);
      const { claudePanelManager } = require('./ipc/claudePanel') as typeof import('./ipc/claudePanel');
      if (!claudePanelManager) throw new Error('the Claude panel manager is not available yet');
      const conversationHistory = sessionManager.getPanelConversationMessages(claudePanel.id);
      // Resolves once the SDK has ACCEPTED the turn — that acceptance is exactly
      // what the outbox records as 'dispatched'.
      await claudePanelManager.continuePanel(
        claudePanel.id,
        session.worktreePath,
        prompt,
        conversationHistory,
      );
      // Echo the dispatched turn into the panel transcript, exactly as the
      // 'claude-panels:continue' IPC path does via handlePanelContinue — without
      // this the host-sent revision turn is invisible in the design session's
      // chat (the "sends missing from transcript" bug class).
      sessionManager.addPanelConversationMessage(claudePanel.id, 'user', prompt);
    },
    logger: cyboflowLogger,
  });
  // The sendDesignBatch mutation's fire-and-track poke (the design analogue of
  // setRevisionLauncher). notifyQueued never rejects, so voiding it is safe.
  setDesignBatchNotifier((batchId: string) => {
    void designFeedbackOutbox?.notifyQueued(batchId);
  });
  // Then set up event listeners that may rely on initialized managers
  setupEventListeners(services, () => mainWindow);
  
  // Register console logging IPC handler for development
  if (isDevelopment) {
    ipcMain.handle('console:log', (event, logData) => {
      const { level, args, source } = logData; // helper rebuilds its own ISO timestamp; original `timestamp` ignored for format uniformity
      const message = args.join(' ');
      appendDevDebugLog('frontend', level as DevLogLevel, source, message);
      console.log(`[Frontend ${level}] ${message}`); // unchanged
    });
  }
  
  // NOTE: git status polling is no longer started here — it is deferred to the
  // main window's first 'ready-to-show' (see runDeferredStartupWork) so it never
  // competes with the critical path to first paint.

  return true;
}

// Initialize telemetry (error reporting + usage metrics) BEFORE the app 'ready'
// event. The Aptabase usage-metrics SDK MUST be initialized pre-ready — it
// early-returns and permanently disables tracking (buffering events that are
// never drained) if `initialize()` runs after the app is ready, and it awaits
// `whenReady` internally itself. Sentry has no such ordering constraint but is
// initialized here too for a single seam. Config is read synchronously because
// the async ConfigManager.initialize() (inside initializeServices, which runs
// in the whenReady callback below) is far too late. Silent no-op when the env
// credentials (SENTRY_DSN / APTABASE_APP_KEY) or config flags are absent.
initTelemetry(readTelemetryConfigSync());

app.whenReady().then(async () => {
  // Lost the single-instance-per-kind race (guard set at module load, above):
  // another instance of this kind owns the data dir. The dedicated whenReady
  // handler there shows the dialog and exits — do no boot work here.
  if (!gotSingleInstanceLock) return;

  // Replace Electron's stock default menu before any window exists — the menu
  // is process-global, and the stock menu's View > Reload binds plain Cmd+R
  // (Ctrl+R elsewhere), which would otherwise swallow that keydown before it
  // ever reaches the renderer's keyboard-shortcut handler. On Windows and
  // Linux its File submenu also carries Quit, which is what this branch's own
  // menu was added for. See menu.ts.
  installApplicationMenu();

  console.log('[Main] App is ready, initializing services...');
  // The schema-version gate now runs INSIDE initializeServices, immediately
  // after the DB opens and before anything binds the shared orch socket. A
  // false result means the user chose Quit and nothing was constructed.
  if (!(await initializeServices())) return;

  // NOTE: the prototype-server and codex-broker boot sweeps are no longer run
  // here — they are deferred to the main window's first 'ready-to-show' (see
  // runDeferredStartupWork) so they never compete with the critical path to
  // first paint. They were already fire-and-forget, so nothing downstream waits
  // on them.

  // Architecture gate: an x64 bundle running under Rosetta/WOW on ARM hardware
  // boots fine but emulates the bundled Claude sidecar, which then blows past
  // the SDK first-event watchdog. Warn (never block — the app IS usable) so the
  // resulting "claude subprocess may have failed to start" failures are
  // attributable to the installed build instead of looking like an app bug.
  const archMismatch = detectArchMismatch({
    runningUnderARM64Translation: app.runningUnderARM64Translation,
    processArch: process.arch,
    platform: process.platform,
  });
  if (archMismatch) {
    logger.warn(formatArchMismatchLog(archMismatch));
    captureSeamError(
      'boot-arch-mismatch',
      new Error(`running ${archMismatch.bundleArch} build under ARM64 translation on ${archMismatch.nativeArch}`),
      { bundleArch: archMismatch.bundleArch, nativeArch: archMismatch.nativeArch },
    );
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Continue'],
      defaultId: 0,
      noLink: true,
      title: 'Cyboflow',
      ...formatArchMismatchDialog(archMismatch, process.platform),
    });
  }

  // One-shot pull (race-free vs a push): the renderer asks on mount whether the
  // boot gate wants Settings → Updates opened, and we clear the flag.
  ipcMain.handle('app:consume-open-update-settings', () => {
    const open = pendingOpenUpdateSettings;
    pendingOpenUpdateSettings = false;
    return open;
  });

  console.log('[Main] Services initialized, wiring orchestrator...');

  // Wire the orchestrator + every tRPC router dependency BEFORE creating the
  // window. The renderer can fire mutations (runs.start, closeout, …) as soon
  // as it loads; creating the window only after this block guarantees no
  // request ever reaches a router whose deps setter has not run yet.
  {
    // Reuse the module-level RunQueueRegistry instantiated in initializeServices()
    // so RunLauncher, Orchestrator, and ApprovalRouter all share the same instance.
    // Inline adapter: expose the narrow DatabaseLike surface by delegating to
    // the underlying better-sqlite3 handle.  Using getDb() avoids the
    // type-erasure cast (as unknown as DatabaseLike) that previously bypassed
    // the structural check and would have thrown at runtime if any orchestrator
    // code called db.prepare() or db.transaction().
    const db = makeDatabaseLike(databaseService);
    const loggerLike = makeLoggerLike(logger);
    orchestrator = new Orchestrator({
      db,
      logger: loggerLike,
      runQueues,
      omp: fleetRegistryReader,
      // The stuck-run push channel the epic always specified but never wired.
      // events.onStuckDetected subscribes to this emitter; without it the
      // renderer's runStatusMap stays empty and the whole stuck UI is dead.
      stuckEvents,
      // Rung 1 (orphan_pty) liveness. RunExecutor is the right supplier here
      // and defaultCliManager is NOT: the CLI managers are per-provider, so
      // asking the Claude SDK manager whether a run is alive answers "no" for
      // every healthy OMP, Codex and interactive-PTY run and would stamp all
      // of them orphaned. hasActiveExecution is provider-agnostic — it is true
      // while ANY executor-driven walk holds the run between start and
      // teardownRun, which is precisely the window in which somebody could
      // still collect an approval.
      //
      // The ID domains line up by an enforced invariant, not by luck:
      // RunExecutor.execute sets panelId = sessionId = runId (see the comment
      // at its assignment), so no run->panel translation is needed.
      //
      // Honest about the proxy: this answers "an executor still holds this
      // run", not "the agent process is alive". Those diverge if a walk hangs
      // on a dead process, which this will still report as alive — strictly
      // better than the `() => true` no-op it replaces, and it never reports a
      // live run as dead, which is the direction that would cause damage.
      claudeManager: {
        hasActiveRunForId: (runId: string): boolean => runExecutor.hasActiveExecution(runId),
      },
      // Review-item write chokepoint. Used at start to drain any LEGACY
      // idle-session review items (the mint was retired for the live
      // QuickSessionsTable — see Orchestrator.start / drainLegacyIdleReviewItems).
      applyReviewItem: (projectId, change) =>
        ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
    });
    await orchestrator.start();
    // NOTE: the tRPC IPC handler is attached inside createWindow() — BEFORE the
    // renderer loads — and createWindow() itself only runs after this whole
    // wiring block, so every router dependency setter (setStartRunDeps,
    // setRunCloseoutDeps, Approval/Question routers, …) has run before the
    // renderer can issue a single request.
    console.log('[Main] Orchestrator started (tRPC IPC handler attaches pre-load in createWindow)');

    // Wire ApprovalRouter after the RunQueueRegistry is live.
    // Permission decisions are produced in-process by the SDK PreToolUse hook
    // (claudeCodeManager.makePreToolUseHook), so no per-request socket-reply
    // factory is needed here.
    ApprovalRouter.initialize(db);
    ApprovalRouter.getInstance().on('approvalCreated', (request: ApprovalRequest) => {
      const event = buildApprovalCreatedEvent(request, db);
      approvalEvents.emit('created', event);
      console.log('[Main] Bridged approvalCreated → approvalEvents.emit(created) for approvalId=', request.id);
    });
    ApprovalRouter.getInstance().on('approvalDecided', (event: ApprovalDecidedEvent) => {
      approvalEvents.emit('decided', event);
      console.log('[Main] Bridged approvalDecided → approvalEvents.emit(decided) for approvalId=', event.approvalId, 'decision=', event.decision);
    });
    console.log('[Main] ApprovalRouter → approvalEvents bridge wired');
    console.log('[Main] ApprovalRouter initialized');

    // Wire QuestionRouter after the RunQueueRegistry and ApprovalRouter are live.
    // Question answers arrive via the SDK PreToolUse hook in ClaudeCodeManager.
    QuestionRouter.initialize(db);
    QuestionRouter.getInstance().on('questionCreated', (request: QuestionRequest) => {
      const event = buildQuestionCreatedEvent(request, db);
      questionEvents.emit('created', event);
      console.log('[Main] Bridged questionCreated → questionEvents.emit(created) for questionId=', request.id);
    });
    QuestionRouter.getInstance().on('questionAnswered', (event: QuestionAnsweredEvent) => {
      questionEvents.emit('answered', event);
      console.log('[Main] Bridged questionAnswered → questionEvents.emit(answered) for questionId=', event.questionId);
    });
    console.log('[Main] QuestionRouter → questionEvents bridge wired');
    console.log('[Main] QuestionRouter initialized');

    // Boot recovery: any awaiting_input rows from a previous session have a dead SDK session.
    // Split counts: `resumable` are rested in awaiting_review (nudge-resumable, NOT a
    // force-fail); `failed` are force-failed with app_restart. Only `failed` feeds the
    // boot-recovery force-fail aggregate below.
    const staleQuestionsRecovered = QuestionRouter.getInstance().recoverStaleAwaitingInput();
    if (staleQuestionsRecovered.resumable + staleQuestionsRecovered.failed > 0) {
      console.log(
        `[Main] Recovered ${staleQuestionsRecovered.resumable + staleQuestionsRecovered.failed} stale awaiting_input run(s) on boot ` +
          `(${staleQuestionsRecovered.resumable} resumable, ${staleQuestionsRecovered.failed} failed)`,
      );
    }

    // Boot recovery: any awaiting_review rows from a previous session have a dead socket.
    const recoveredCount = ApprovalRouter.getInstance().recoverStaleAwaitingReview();
    if (recoveredCount > 0) {
      console.log(`[Main] Recovered ${recoveredCount} stale awaiting_review run(s) on boot`);
    }

    // Boot recovery: runs orphaned by an archived (dismissed) session. Left
    // non-terminal (e.g. 'stuck' from before the dismiss-cascade existed) they
    // keep showing in the active-runs rail. Cancel them so the rail's
    // terminal-status filter hides them — self-healing for any dismiss that
    // failed to cancel a hosted run. Runs BEFORE recoverActiveStateOrphans so an
    // archived-session orphan is already 'canceled' (off the candidate SELECT) and
    // can never be picked for orchestrated resume — which would otherwise race this
    // sweep and spawn an SDK subprocess into a deleted worktree.
    const archivedOrphanRecovery = recoverArchivedSessionRunOrphans(db);
    if (archivedOrphanRecovery.runsCanceled > 0) {
      console.log(`[Main] Canceled ${archivedOrphanRecovery.runsCanceled} run(s) orphaned by archived sessions (approvals canceled: ${archivedOrphanRecovery.approvalsCanceled})`);
    }

    // Boot recovery: any running/starting rows from a previous process have no live
    // executor — the SDK iterator and PTY are gone. Resume the resumable ones
    // (programmatic re-walk, or a fresh SDK `--resume` turn for orchestrated runs
    // with a live worktree + fresh Claude resume target); force-fail the rest as
    // interrupted (app_restart).
    const orphanRecovery = recoverActiveStateOrphans(db, runQueues);
    if (
      orphanRecovery.runningRecovered > 0 ||
      orphanRecovery.startingRecovered > 0 ||
      orphanRecovery.approvalsCanceled > 0
    ) {
      console.log(`[Main] Recovered active-state orphans (running: ${orphanRecovery.runningRecovered}, starting: ${orphanRecovery.startingRecovered}, approvals canceled: ${orphanRecovery.approvalsCanceled})`);
    }

    // Report boot-recovery force-fails to Sentry as ONE aggregate event (these
    // runs were reclassified interrupted with the synthetic 'app_restart' reason —
    // the prior process crashed, so no per-run error object exists). Count is
    // bucketed to keep tag cardinality low; a spike here signals frequent unclean
    // shutdowns. Includes ALL three app_restart force-fail paths: stale
    // awaiting_review (recoveredCount), the UNRESUMABLE active-state orphans
    // (runningRecovered/startingRecovered exclude the resumed programmatic AND
    // orchestrated runs, which were reset — not failed), AND the FAILED
    // (unresumable) subset of stale awaiting_input — but NOT the resumable
    // awaiting_input runs, which are rested in awaiting_review rather than failed.
    const bootForceFailed =
      recoveredCount +
      orphanRecovery.runningRecovered +
      orphanRecovery.startingRecovered +
      staleQuestionsRecovered.failed;
    if (bootForceFailed > 0) {
      const countBucket =
        bootForceFailed === 1 ? '1' : bootForceFailed <= 5 ? '2-5' : bootForceFailed <= 20 ? '6-20' : '20+';
      captureSeamError(
        'boot-recovery-force-failed',
        new Error(`${bootForceFailed} run(s) reclassified interrupted on boot recovery (app_restart, unresumable)`),
        { errorClass: 'app-restart', recoveryReason: 'app_restart', countBucket },
      );
    }

    // Boot recovery: verification_requests left 'leased'/'running' by a prior
    // process have no live scheduler worker (the in-memory AbortController + lease +
    // detached promise died with that process), so they cannot resume — re-drain
    // them to 'timeout'. Mirrors recoverActiveStateOrphans for the visual-verify
    // queue; runs once on the freshly-initialized singleton before any nudge.
    const verifyOrphans = await VerificationScheduler.getInstance().runRecovery();
    if (verifyOrphans > 0) {
      console.log(`[Main] Re-drained ${verifyOrphans} orphaned verification request(s) to timeout on boot`);
    }

    // Crash-safe resume (Stage 3): re-drive PROGRAMMATIC runs the previous process
    // left mid-walk. recoverActiveStateOrphans reset them to 'starting' (NOT
    // force-failed); re-enqueue each on its per-run queue, threading the persisted
    // current_step_id so the WorkflowController fast-forwards past completed steps
    // and a gate re-attaches to its still-pending review item. Fire-and-forget +
    // per-run try/catch, mirroring runLauncher.
    if (orphanRecovery.programmaticToResume.length > 0) {
      console.log(`[Main] Resuming ${orphanRecovery.programmaticToResume.length} programmatic run(s) after restart`);
      for (const { id, currentStepId, completedStepIds } of orphanRecovery.programmaticToResume) {
        if (currentStepId) runExecutor.setPendingResumeStep(id, currentStepId);
        if (completedStepIds.length > 0) runExecutor.setPendingCompletedSteps(id, completedStepIds);
        const queue = runQueues.getOrCreate(id);
        void queue.add(async () => {
          try {
            await runExecutor.execute(id);
          } catch (err) {
            loggerLike.error('[Main] programmatic resume re-drive failed', {
              runId: id,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
          }
        });
      }
    }

    // Crash-safe resume, ORCHESTRATED arm: re-drive single-conversation SDK runs
    // the previous process left running/starting. recoverActiveStateOrphans reset
    // them to 'starting' (NOT force-failed) after verifying a fresh Claude resume
    // target + surviving worktree. setPendingResume makes execute() thread the
    // captured external session id as `--resume` (mirrors resumeRunHandler's
    // orchestrated arm); fire-and-forget — each is one cold SDK spawn whose turn
    // drains to awaiting_review on its own.
    if (orphanRecovery.orchestratedToResume.length > 0) {
      console.log(`[Main] Resuming ${orphanRecovery.orchestratedToResume.length} orchestrated run(s) after restart`);
      for (const { id } of orphanRecovery.orchestratedToResume) {
        runExecutor.setPendingResume(id);
        const queue = runQueues.getOrCreate(id);
        void queue.add(async () => {
          try {
            await runExecutor.execute(id);
          } catch (err) {
            loggerLike.error('[Main] orchestrated resume re-drive failed', {
              runId: id,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
          }
        });
      }
    }

    // Boot recovery: reclassify historical app_restart force-fails as
    // outcome='interrupted' BEFORE the generic terminal-outcome backfill, so the
    // failed-stamp below only sees the remaining real (non-app_restart) failures.
    // Widened guard (outcome IS NULL OR 'failed') reclaims rows an earlier boot's
    // backfillTerminalOutcomes already stamped 'failed' — safe because the
    // app_restart sentinel is written only by the three boot-recovery seams.
    const interruptedBackfilled = backfillInterruptedOutcomes(db);
    if (interruptedBackfilled > 0) {
      console.log(`[Main] Reclassified ${interruptedBackfilled} historical app_restart run(s) as outcome='interrupted'`);
    }

    // Boot backfill: older archived sessions may still own pending review items.
    // Dismiss them through the ReviewItemRouter chokepoint (never raw SQL),
    // fail-soft per row so one bad item cannot block startup.
    const archivedReviewItemBackfill = await backfillArchivedSessionReviewItems(db, loggerLike);
    if (archivedReviewItemBackfill.itemsDismissed > 0 || archivedReviewItemBackfill.itemsFailed > 0) {
      console.log(
        `[Main] Backfilled archived-session review items (dismissed: ${archivedReviewItemBackfill.itemsDismissed}, failed: ${archivedReviewItemBackfill.itemsFailed})`,
      );
    }

    // Boot recovery: stamp outcome on failed/canceled runs that never got one
    // (kills mid-phase, pre-instrumentation rows) so the Insights success-rate
    // stats are trustworthy. Deliberately runs AFTER the two orphan sweeps
    // above — they transition orphans to failed/canceled, and this pass then
    // backfills those fresh rows' outcomes in the same boot. completed+NULL
    // rows are intentionally untouched (awaiting a close-out decision).
    const outcomeBackfill = backfillTerminalOutcomes(db);
    if (outcomeBackfill.failedBackfilled > 0 || outcomeBackfill.canceledBackfilled > 0) {
      console.log(`[Main] Backfilled terminal outcomes (failed: ${outcomeBackfill.failedBackfilled}, canceled: ${outcomeBackfill.canceledBackfilled})`);
    }

    // Insights Phase-2 (migration 026) self-heal. rollupRunUsage is wired only to
    // runExecutor's terminal lifecycle hook, but ~8 other writers can put a run
    // into a terminal status (cancel handlers, questionRouter, the trpc close-outs,
    // the merge path, and the orphan sweeps just above) — each leaves the run's
    // usage living ONLY in raw_events. Insights hides this behind its raw_events
    // fallback, so the gap is invisible until that log is pruned. Sweeping the
    // invariant here covers every writer at once, including future ones. Must run
    // AFTER the orphan sweeps + outcome backfill so runs force-terminated on this
    // boot are materialized in the same pass. Fail-soft internally.
    const usageBackfill = backfillRunUsageRollups(db);
    if (usageBackfill.materialized > 0) {
      console.log(`[Main] Materialized ${usageBackfill.materialized} missing run_usage rollup(s) of ${usageBackfill.candidates} candidate(s)`);
    }

    // Boot self-heal (migration 066): the derived 'In development' stage projects
    // a task's live run associations, and the recovery sweeps above force-fail
    // runs with raw UPDATEs (no per-task recompute). Recompute every task parked
    // at a derived stage AFTER those sweeps so a task whose runs died with the
    // app reverts to its entry stage instead of reading as in-development forever.
    // Fail-soft: a sweep error must never block boot.
    try {
      await TaskChangeRouter.getInstance().sweepStaleDerivedStageTasks();
    } catch (sweepErr) {
      console.warn('[Main] stale derived-stage sweep failed (continuing boot):', sweepErr instanceof Error ? sweepErr.message : String(sweepErr));
    }

    // Boot recovery (Design Mode v0): drive any design_handoffs left mid-Approve by
    // a previous process (state intent/snapshotted/folded) forward through the SAME
    // step functions the first-run approve uses — a crash after the body fold cannot
    // strand the operation (design-mode.md "Approve" Recovery). Non-fatal: the sweep
    // is itself per-row fail-soft, and any top-level error is logged, never blocks boot.
    try {
      const designRecovery = await recoverDesignHandoffs(DesignHandoffService.getInstance().depsBag);
      if (designRecovery.completed > 0 || designRecovery.unresolved > 0 || designRecovery.errored > 0) {
        console.log(
          `[Main] Recovered design handoffs (completed: ${designRecovery.completed}, unresolved: ${designRecovery.unresolved}, errored: ${designRecovery.errored})`,
        );
      }
    } catch (designErr) {
      console.warn('[Main] design-handoff recovery failed (continuing boot):', designErr instanceof Error ? designErr.message : String(designErr));
    }

    // Known limitation: ApprovalRouter.clearPendingForRun is still a documented no-op
    // until TASK-304 lands. The Cancel-and-restart button therefore stops the Claude
    // SDK run and updates DB rows, but does not yet send deny-replies on the
    // permission socket. See approvalRouter.ts:328–337.
    // Q1 GUARD sweep (this scope): the initializeServices-scope twin backs the
    // lifecycle 'failed' seam; the two cannot share a closure (sibling scopes), so
    // the cancel / cancel-and-restart dep-bags close over this local copy. Drops a
    // torn-down run's PENDING draft entities — deleteRunCreatedEntities self-gates
    // on plan_approved_at IS NULL + keys on run_id.
    const deletePendingDraftsForRun = async (runId: string): Promise<void> => {
      const r = db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
        .get(runId) as { projectId?: number } | undefined;
      if (!r || typeof r.projectId !== 'number') return;
      await TaskChangeRouter.getInstance().deleteRunCreatedEntities(r.projectId, runId);
    };

    setCancelAndRestartDeps({
      db,
      approvalRouter: ApprovalRouter.getInstance(),
      questionRouter: QuestionRouter.getInstance(),
      runQueues,
      // Provider-neutral stop (runtime-mix plan D6): route through the SAME
      // SubstrateDispatchFacade.abort seam runs.cancel uses below, which resolves
      // the manager that actually spawned the run's panel. The previous
      // defaultCliManager.stopPanel binding was Claude-only, so a codex-primary
      // (or interactive) run's process survived the cancel half of
      // cancel-and-restart while the row was replaced underneath it.
      managerStop: (runId: string) => substrateFacade.abort(runId),
      // F5: sweep the OLD run's pending drafts after it flips 'canceled'.
      deletePendingDraftsForRun,
      // Migration 066: the OLD run flips 'canceled' but the replacement run carries
      // no task/batch link, so revert the old run's batch lanes + direct task off
      // 'In development' to their entry stage (fail-soft inside the handler).
      recomputeTasksForBatch: (batchId: string) =>
        TaskChangeRouter.getInstance().recomputeTasksForBatch(batchId),
      recomputeTask: (taskId: string) =>
        TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
      logger: loggerLike,
    });
    console.log('[Main] cancelAndRestart deps wired');

    // Phase 4a — git-neutral run Cancel. Stops the live agent on BOTH substrates
    // by routing through the SubstrateDispatchFacade kill seam
    // (substrateFacade.abort), NOT defaultCliManager.stopPanel (SDK-only — would
    // orphan an interactive run's PTY). abort() resolves the manager that spawned
    // the run's panel and calls killProcess on it — the SDK manager overrides
    // killProcess to abort its query() iterator, the interactive manager inherits
    // it to kill the PTY tree — so a single call stops whichever substrate ran.
    // (killSession targets a run's persistent live process at close-out; abort()
    // is still the canonical universal-cancel seam.) Reuses the SAME `db`, `runQueues`,
    // ApprovalRouter / QuestionRouter accessors, and `loggerLike` as the
    // cancelAndRestart wiring above. emitRunStatusChanged emits on the SAME
    // module-level `runStatusEvents` 'changed' channel the lifecycleTransitions
    // adapter uses, so the rail / action-bar (activeRunsStore) reacts to a cancel.
    // The bag has NO worktree collaborator — cancel never touches git.
    const cancelRunDepsBag = {
      db,
      runQueues,
      // stopLiveRun also aborts a PROGRAMMATIC run's host-driven WorkflowController
      // (requestProgrammaticCancel) — substrateFacade.abort alone only kills the
      // current step, leaving the controller to spawn the next one / a gate to hang.
      // requestProgrammaticCancel is synchronous + a no-op for orchestrated runs.
      stopLiveRun: async (runId: string) => {
        runExecutor.requestProgrammaticCancel(runId);
        await substrateFacade.abort(runId);
      },
      clearPendingApprovalsForRun: (runId: string) =>
        ApprovalRouter.getInstance().clearPendingForRun(runId),
      clearPendingQuestionsForRun: (runId: string) =>
        QuestionRouter.getInstance().clearPendingForRun(runId),
      clearPendingHumanGatesForRun: (runId: string) =>
        HumanStepManager.getInstance().clearPendingForRun(runId),
      emitRunStatusChanged: (runId: string, status: 'canceled') =>
        runStatusEvents.emit('changed', { runId, status }),
      // Batch close-out (single-run parallel sprint): cancelling a sprint batch
      // run flips its sprint_batches row terminal too, so the lane substrate
      // never strands non-terminal.
      markBatchTerminal: (batchId: string, status: 'canceled') =>
        SprintLaneStore.getInstance().markBatchTerminal(batchId, status),
      // Migration 066: after the cancel + batch close-out, revert the batch's
      // non-integrated lanes off 'In development' to their entry stage.
      recomputeTasksForBatch: (batchId: string) =>
        TaskChangeRouter.getInstance().recomputeTasksForBatch(batchId),
      // Migration 066: a DIRECTLY task-linked run (workflow_runs.task_id, no batch)
      // reverts its task off 'In development' too. Load-bearing for session dismiss
      // (cancelHostedRuns → cancelRunHandler), which never recomputes otherwise.
      recomputeTask: (taskId: string) =>
        TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
      // Q1 GUARD: after a successful cancel, drop the run's PENDING draft entities
      // (epics + orphan tasks it created pre-approval) so a torn-down plan leaves
      // no orphans. Shares the single deletePendingDraftsForRun sweep defined at the
      // cancelAndRestart wiring above (self-gated on plan_approved_at IS NULL).
      deletePendingDraftsForRun,
      // Visual-verify cleanup: abort in-flight captures/judges + mark the run's
      // non-terminal verification_requests rows 'timeout'. tryGetInstance keeps it
      // a no-op if the scheduler was never initialized; fail-soft inside the handler.
      cancelVerificationsForRun: (runId: string) =>
        VerificationScheduler.tryGetInstance()?.cancelForRun(runId),
      // TASK-057: a cancelled run must reap its detached ui-prototype http.server
      // too. Fail-soft is handled inside cancelRunHandler.
      reapPrototypeServers: (runId: string) =>
        prototypeServerReaper.reapForRun(getCyboflowSubdirectory('artifacts', 'runs', runId)),
      logger: loggerLike,
    };
    setCancelRunDeps(cancelRunDepsBag);
    console.log('[Main] runs.cancel deps wired');

    // Session Dismiss → cancel hosted runs (consumed by sessions:delete via the
    // services bag). Every NON-terminal run on the session goes through the SAME
    // git-neutral cancelRunHandler as the runs.cancel mutation — settling pending
    // approvals/questions (no orphaned review-queue items), stopping the live
    // agent, and closing a sprint run's lane batch. Per-run fail-soft: one bad
    // run must not block dismissing the session.
    cancelHostedRunsImpl = async (sessionId: string): Promise<void> => {
      const rows = db
        .prepare(
          `SELECT id FROM workflow_runs
            WHERE session_id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
        )
        .all(sessionId) as Array<{ id: string }>;
      for (const row of rows) {
        try {
          await cancelRunHandler(row.id, cancelRunDepsBag);
        } catch (err: unknown) {
          loggerLike.error('[Main] session dismiss: cancel of hosted run failed', {
            sessionId,
            runId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    console.log('[Main] session-dismiss hosted-run cancel wired');

    // Phase 4b — SDK-only Pause/Resume. Pause is the NON-terminal twin of Cancel:
    // it stops the active SDK turn (via the SAME substrateFacade.abort kill seam)
    // and parks the run in `paused`, PRESERVING claude_session_id +
    // current_step_id. It reuses the SAME `db`, `runQueues`, ApprovalRouter /
    // QuestionRouter accessors, and `loggerLike` as the Cancel wiring above, and
    // emits on the SAME `runStatusEvents` 'changed' channel so the rail /
    // action-bar (activeRunsStore) reacts. Like Cancel the bag has NO worktree
    // collaborator — Pause never touches git. SDK-only is enforced inside the
    // handler (it refuses a non-sdk run before any kill / DB write).
    setPauseRunDeps({
      db,
      runQueues,
      stopLiveRun: (runId: string) => substrateFacade.abort(runId),
      // PROGRAMMATIC pause: signal the WorkflowController walk (the handler
      // enforces walk-first ordering, BEFORE stopLiveRun) so the interrupted
      // step reports 'aborted' — not a clean 'ok' — and the walk stops spawning
      // subsequent steps while the row parks in 'paused'. Synchronous; a no-op
      // for orchestrated runs (no entry in the executor's aborts map).
      abortProgrammaticWalk: (runId: string) => runExecutor.requestProgrammaticCancel(runId),
      clearPendingApprovalsForRun: (runId: string) =>
        ApprovalRouter.getInstance().clearPendingForRun(runId),
      clearPendingQuestionsForRun: (runId: string) =>
        QuestionRouter.getInstance().clearPendingForRun(runId),
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      logger: loggerLike,
    });
    console.log('[Main] runs.pause deps wired');

    // Resume re-drives the SAME SDK conversation via the executor's --resume path.
    // It uses the SAME module-scoped RunExecutor instance nudge uses (so the
    // executor's pendingResume / pendingNudge maps are shared), flips the run
    // paused -> running, and re-drives execute(runId) with the executor marked for
    // resume (continue prompt + claude_session_id threaded as the SDK resume id).
    // emitRunStatusChanged rides the SAME runStatusEvents 'changed' channel.
    setResumeRunDeps({
      db,
      runQueues,
      runExecutor,
      // PROGRAMMATIC resume: persisted done/skipped step ids (migration 033) so
      // the re-driven WorkflowController skips completed steps and resumes at
      // the interrupted one. Unused by the orchestrated --resume arm.
      completedStepIds: (runId: string) =>
        StepResultStore.tryGetInstance()?.completedStepIds(runId) ?? [],
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      logger: loggerLike,
    });
    console.log('[Main] runs.resume deps wired');

    // Reopen revives a FAILED run (session reopen-on-timeout follow-up): flips
    // failed -> running, clears the failure stamp, and re-drives the SAME SDK
    // conversation via --resume with the user's text (using the SAME RunExecutor
    // instance + pendingNudge map as nudge). Same deps shape as Resume; rides the
    // SAME runStatusEvents 'changed' channel.
    setReopenRunDeps({
      db,
      runQueues,
      runExecutor,
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      logger: loggerLike,
    });
    console.log('[Main] runs.reopen deps wired');

    // Retry-from-step revives a FAILED (or resting awaiting_review) PROGRAMMATIC
    // run at a chosen/derived step via the crash-safe resume machinery — the
    // fourth sanctioned terminal revive (stateMachine.ts rationale). Shares the
    // SAME RunExecutor + runStatusEvents channel as resume/reopen; step_results
    // reads ride StepResultStore; the fan-out lane reset rides SprintLaneStore so
    // a retried fan-out step re-dispatches its failed lanes instead of skipping
    // them as settled.
    const retryRunDepsBag: RetryRunDeps = {
      db,
      runQueues,
      runExecutor,
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
      resetFailedLanes: (batchId) => SprintLaneStore.getInstance().resetFailedLanes(batchId),
      reopenBatch: (batchId) => SprintLaneStore.getInstance().reopenBatch(batchId),
      logger: loggerLike,
    };
    setRetryRunDeps(retryRunDepsBag);
    console.log('[Main] runs.retryStep deps wired');

    // Drained-rest race guard (reviewItems.resolve/dismiss trailing auto-resume):
    // the trailing maybeResumeRun must never revive a run whose walk has ENDED —
    // when the resolved gate was the run's LAST step, the walk finishes and rests
    // the run in awaiting_review before the trailing call runs, and a resume then
    // strands it 'running' with no live walk. The probe is the SAME
    // hasActiveExecution the retry pre-flight consumes.
    setReviewItemsRunProbe({
      hasActiveExecution: (runId) => runExecutor.hasActiveExecution(runId),
    });
    console.log('[Main] reviewItems run-execution probe wired');

    // Monitor-actuation binding (retry_step): route the monitor's validated
    // retry action through the SAME retryRunHandler + deps bag as the tRPC
    // mutation, mapping the discriminated result onto a chat-friendly
    // ok/message pair the monitor injects as a follow-up turn.
    //
    // not_retryable fallback: a run PARKED on a live systemic pause (usage-limit
    // item) is awaiting_review WITH an active walk, so retryRunHandler refuses
    // it — but "retry the step" is exactly what resolving the pause item does
    // (ReviewQueueSystemicPauseGate settles 'retry' and the walk re-runs the
    // interrupted step without burning budget). Probe for that item and resolve
    // it through the ReviewItemRouter chokepoint; only when no pause item exists
    // is the refusal surfaced to the user.
    monitorRetryStep = async (runId, stepId) => {
      const result = await retryRunHandler(runId, stepId, retryRunDepsBag);
      if ('delivered' in result) {
        return { ok: true, message: `Retrying the run from step '${result.stepId}'.` };
      }
      if (result.reason === 'not_retryable') {
        try {
          const pauseItem = await HumanStepManager.getInstance().findPendingSystemicPauseItem(runId);
          if (pauseItem) {
            await ReviewItemRouter.getInstance().applyReviewItem(pauseItem.projectId, {
              op: 'resolve',
              actor: 'orchestrator',
              reviewItemId: pauseItem.reviewItemId,
              resolution: 'retry now (via monitor)',
            });
            return {
              ok: true,
              message: 'Resolved the usage-limit pause — the run is resuming from the interrupted step.',
            };
          }
        } catch (err) {
          loggerLike.warn('[Main] monitor retry_step pause-resolution fallback failed', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const messages: Record<string, string> = {
        not_found: 'Run not found.',
        not_programmatic: 'Only programmatic runs support step retry.',
        not_retryable: "The run isn't in a retryable state — it must be failed or resting.",
        no_target_step: 'No failed step to retry — name the step id to re-run.',
        unknown_step: `Step '${stepId ?? ''}' is not part of this workflow.`,
        race: 'The run changed state mid-retry — try again.',
      };
      return { ok: false, message: messages[result.reason] ?? `Retry refused (${result.reason}).` };
    };
    console.log('[Main] monitor retry_step action wired');

    // Monitor-actuation binding (switch_to_orchestrated): the one-way
    // programmatic -> orchestrated handover, routed through handoverRunHandler
    // (walk abort -> the sanctioned execution_model flip -> gate sweep ->
    // handover-brief nudge -> orchestrated re-drive). Reuses the SAME db /
    // runQueues / runExecutor / runStatusEvents as the retry bag; the prompt
    // body rides WorkflowRegistry.getById + readWorkflowPromptForRow (keyed by
    // workflow ID — names are not unique across projects), fail-soft to null so
    // a missing prompt degrades to a brief that says so.
    const handoverRunDepsBag: HandoverRunDeps = {
      db,
      runQueues,
      runExecutor,
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      clearPendingGateItems: (runId) => HumanStepManager.getInstance().clearPendingForRun(runId),
      stopLiveRun: (runId: string) => substrateFacade.abort(runId),
      // Handover tears down the run's monitor (same as terminal close-out's
      // disposeMonitorResources): the orchestrated agent now owns the chat, so the
      // composer must stop routing turns to the read-only monitor. Enforces the
      // "orchestrated runs have no monitor" invariant the rehydrator already asserts.
      disposeMonitor: (runId: string) => {
        runExecutor.disposeMonitorResources(runId);
        MonitorRegistry.getInstance().unregister(runId);
      },
      readWorkflowPrompt: (workflowId) => {
        try {
          const row = workflowRegistry.getById(workflowId);
          return row ? readWorkflowPromptForRow(row).prompt : null;
        } catch {
          return null;
        }
      },
      listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
      logger: loggerLike,
    };
    monitorSwitchToOrchestrated = async (runId, reason) => {
      const result = await handoverRunHandler(runId, reason, handoverRunDepsBag);
      if ('delivered' in result) {
        return {
          ok: true,
          message:
            'Handing the run over to an interactive agent — it will address your request and continue the remaining workflow steps in this chat.',
        };
      }
      const messages: Record<string, string> = {
        not_found: 'Run not found.',
        not_programmatic: 'This run is already running as an interactive agent.',
        not_switchable:
          "The run isn't in a state that can be handed over — it must be running, resting, or failed.",
        race: 'The run changed state mid-handover — try again.',
      };
      return { ok: false, message: messages[result.reason] ?? `Handover refused (${result.reason}).` };
    };
    console.log('[Main] monitor switch_to_orchestrated action wired');

    // Final-gate auto-handover: chatting with a programmatic run parked at its
    // FINAL human gate (or resting for merge) converts it to a full orchestrated
    // agent carrying the message as the agent's first request — no manual
    // switch_to_orchestrated ceremony. Reuses the SAME handoverRunDepsBag (via
    // handoverRunHandler with the finalGate context), the injected step-results
    // source, and RunExecutor.ensureMonitorInjectBridge for the transcript inject.
    // Consulted by cyboflow.monitor.send BEFORE the monitor path (fail-soft).
    setFinalGateHandover(
      createFinalGateHandover({
        db,
        isEnabled: () => configManager.getAutoHandoverAtFinalGateEnabled(),
        listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
        getInjectEvent: (runId) => runExecutor.ensureMonitorInjectBridge(runId),
        handover: (runId, reason, finalGate) =>
          handoverRunHandler(runId, reason, handoverRunDepsBag, { finalGate }),
        logger: loggerLike,
      }),
    );
    console.log('[Main] monitor final-gate auto-handover wired');

    // Monitor steering actions (the 8 non-stopping backlog/step/review edits).
    // All route through chokepoints (TaskChangeRouter / SprintLaneStore /
    // ReviewItemRouter) that own their OWN serialization, so none touches the
    // run's held PQueue — they work while the walk is mid-DAG. skip/unskip/steer
    // write the live RunDirectives the controller reads at the loop head / the
    // SpawnStepRunner reads via its per-step guidance thunk.
    const taskMutationDeps: TaskMutationDeps = {
      db,
      applyTaskChange: (projectId, change) =>
        TaskChangeRouter.getInstance().applyChange(projectId, change),
      applyTaskDelete: (projectId, opts) => TaskChangeRouter.getInstance().applyDelete(projectId, opts),
      laneStore: {
        addLane: (laneArgs) => SprintLaneStore.getInstance().addLane(laneArgs),
        removeLane: (laneArgs) => SprintLaneStore.getInstance().removeLane(laneArgs),
      },
      // Migration 066: recompute the mutated task's execution stage after a
      // mid-sprint add (→ In development) or remove (→ entry stage).
      recomputeTask: (taskId) => TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
      logger: loggerLike,
    };

    // Map the task-mutation handler's discriminated refusal to a chat-friendly pair.
    const mapTaskResult = (r: TaskMutationResult): MonitorActionResult => {
      if (r.ok) return { ok: true, message: r.message };
      const messages: Record<TaskMutationNoOpReason, string> = {
        not_found: 'Run not found.',
        not_programmatic: 'Only programmatic sprint runs support backlog edits.',
        no_batch: r.detail ?? 'This run has no active sprint batch to edit.',
        task_not_found: `No task matching '${r.detail ?? ''}' in this run's project.`,
        not_eligible: "The task couldn't be made sprint-eligible.",
        already_started: 'That task has already started — too late to change it.',
        not_in_sprint: `Task ${r.detail ?? ''} isn't in this sprint — I can only edit tasks still queued in this run's batch.`,
        duplicate: 'That task is already in the sprint.',
        nothing_to_change: 'Nothing to change — give a new title, body, or priority.',
        lane_error: r.detail ? `Sprint update failed: ${r.detail}` : 'Sprint update failed unexpectedly.',
      };
      return { ok: false, message: messages[r.reason] };
    };

    // A run's project id (review-item + note actions are project-scoped).
    const runProjectId = (runId: string): number | undefined => {
      const row = db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
        .get(runId) as { projectId?: number } | undefined;
      return typeof row?.projectId === 'number' ? row.projectId : undefined;
    };

    // Validate a stepId belongs to a programmatic run's effective workflow
    // definition — so skip/unskip/steer give "unknown step" feedback instead of
    // silently stashing a directive the controller will never honor. Fan-out
    // INNER step ids (e.g. a sprint lane's 'implement' / 'code-review') count:
    // the controller consults the skip set per inner step (driveItem's loop) and
    // the guidance thunk keys on the synthesized inner step id, so directives on
    // them ARE honored — only the OUTER phase steps used to pass this gate,
    // which wrongly refused the monitor exactly the lane steps live steering
    // targets most. (Rewind validates separately against OUTER steps only — the
    // walk's resume machinery is outer-step-indexed.)
    const validateRunStep = (
      runId: string,
      stepId: string,
    ): { ok: true } | { ok: false; message: string } => {
      const row = db
        .prepare('SELECT execution_model AS executionModel FROM workflow_runs WHERE id = ?')
        .get(runId) as { executionModel: string | null } | undefined;
      if (!row) return { ok: false, message: 'Run not found.' };
      if (row.executionModel !== 'programmatic')
        return { ok: false, message: 'Only programmatic runs support step control.' };
      // FROZEN spec, never the live workflows.spec_json — a live read validates
      // step ids against the wrong graph for a variant run / mid-run edit
      // (docs/CODE-PATTERNS.md "Per-run workflow definitions resolve the FROZEN spec").
      const frozen = resolveRunFrozenSpec(db, runId);
      const def = frozen ? resolveWorkflowDefinition(frozen.workflowName, frozen.specJson) : null;
      if (!def) return { ok: false, message: "This run's workflow definition could not be resolved." };
      const exists = def.phases.some((p) =>
        p.steps.some(
          (s) => s.id === stepId || (s.fanOut?.inner.some((inner) => inner.id === stepId) ?? false),
        ),
      );
      if (!exists) return { ok: false, message: `Step '${stepId}' isn't part of this workflow.` };
      return { ok: true };
    };

    // Is `stepId` an OUTER fan-out step of the run's (FROZEN) definition? Such a
    // step never spawns its own agent while lanes exist (the controller walks the
    // synthesized INNER chain instead), and its durable RunDirectives guidance is
    // never re-read — so steer_step treats it as a LIVE-ONLY broadcast to the
    // running sprint lanes (see the steerStep binding below).
    const isOuterFanOutStep = (runId: string, stepId: string): boolean => {
      const frozen = resolveRunFrozenSpec(db, runId);
      const def = frozen ? resolveWorkflowDefinition(frozen.workflowName, frozen.specJson) : null;
      return def
        ? def.phases.some((p) => p.steps.some((s) => s.id === stepId && s.fanOut !== undefined))
        : false;
    };

    // LIVE delivery for steer_step: when the steered step is executing RIGHT NOW,
    // interject the guidance into the running agent turn(s) via the SDK steering
    // queue (SubstrateDispatchFacade.injectSteering — a priority-'now' push into
    // the turn's live prompt input; the agent folds it in at its next loop
    // boundary). Which spawns count as "running this step":
    //   - the run-level agent (spawnKey === runId) when workflow_runs.
    //     current_step_id matches the steered step;
    //   - each RUNNING sprint lane whose lane pointer (sprint_batch_tasks.
    //     current_step_id) matches — fan-out lanes run INNER steps under spawnKey
    //     `${runId}:${taskId}`, and `taskRef` narrows delivery to ONE lane;
    //   - with `broadcastToLanes` (the steered id is an OUTER fan-out step, whose
    //     lane pointers hold INNER ids that can never equal it), EVERY running
    //     lane of the batch matches regardless of which inner step it is on.
    // Fail-soft: any error → 0 delivered (the stored next-spawn guidance is the
    // durable path); returns how many live agents actually accepted the push.
    const deliverLiveGuidance = (
      runId: string,
      stepId: string,
      guidance: string,
      taskRef?: string,
      broadcastToLanes?: boolean,
    ): number => {
      try {
        const live = new Set(substrateFacade.listLiveSpawnKeys(runId));
        if (live.size === 0) return 0;
        const row = db
          .prepare(
            `SELECT current_step_id AS currentStepId, batch_id AS batchId, project_id AS projectId
               FROM workflow_runs WHERE id = ?`,
          )
          .get(runId) as
          | { currentStepId: string | null; batchId: string | null; projectId: number | null }
          | undefined;
        if (!row) return 0;
        const targets: string[] = [];
        if (row.batchId) {
          let laneRows = broadcastToLanes
            ? (db
                .prepare(
                  `SELECT task_id AS taskId FROM sprint_batch_tasks
                     WHERE batch_id = ? AND status = 'running'`,
                )
                .all(row.batchId) as Array<{ taskId: string }>)
            : (db
                .prepare(
                  `SELECT task_id AS taskId FROM sprint_batch_tasks
                     WHERE batch_id = ? AND status = 'running' AND current_step_id = ?`,
                )
                .all(row.batchId, stepId) as Array<{ taskId: string }>);
          if (taskRef !== undefined) {
            // Ref-or-id resolution (mirrors taskMutationHandler.resolveTaskId):
            // an opaque id matches directly; a display ref resolves project-scoped.
            const resolved = db
              .prepare('SELECT id FROM tasks WHERE id = ? OR (project_id = ? AND ref = ?)')
              .get(taskRef, row.projectId, taskRef) as { id: string } | undefined;
            laneRows = resolved ? laneRows.filter((lane) => lane.taskId === resolved.id) : [];
          }
          targets.push(...laneRows.map((lane) => `${runId}:${lane.taskId}`));
        }
        // The run-level (non-lane) agent — only when the operator did NOT narrow
        // to a lane (taskRef targets lanes exclusively).
        if (taskRef === undefined && row.currentStepId === stepId) {
          targets.push(runId);
        }
        const text = `## Operator guidance (live)\n\nThe operator sent this guidance for the step you are executing RIGHT NOW — fold it into your current work:\n\n${guidance}`;
        let delivered = 0;
        for (const spawnKey of targets) {
          if (live.has(spawnKey) && substrateFacade.injectSteering(spawnKey, runId, text)) {
            delivered += 1;
          }
        }
        return delivered;
      } catch (err) {
        loggerLike.warn('[Main] steer_step live delivery failed (fail-soft)', {
          runId,
          stepId,
          error: err instanceof Error ? err.message : String(err),
        });
        return 0;
      }
    };

    // Rewind deps bag (monitor rewind_to_step): the SAME db / runQueues /
    // runExecutor / runStatusEvents as the retry bag, plus the abort seam
    // (substrateFacade.abort — pause/handover's stopLiveRun), the step_results
    // purge primitive, the fan-out lane counters, and the pending-gate sweep.
    // countRedispatchableLanes counts non-'integrated' lanes — exactly what a
    // re-entered fanOut step would dispatch after resetFailedLanes re-queues the
    // failed ones (the production driver's resolveItems filters integrated+failed;
    // failed lanes count here because the handler resets them before re-driving).
    const rewindRunDepsBag: RewindRunDeps = {
      db,
      runQueues,
      runExecutor,
      stopLiveRun: (runId) => substrateFacade.abort(runId),
      emitRunStatusChanged: (runId, status) => runStatusEvents.emit('changed', { runId, status }),
      listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
      deleteStepResults: (runId, stepIds) =>
        StepResultStore.tryGetInstance()?.deleteForSteps(runId, stepIds) ?? 0,
      recordStepResult: (r) => StepResultStore.tryGetInstance()?.record(r),
      resetFailedLanes: (batchId) => SprintLaneStore.getInstance().resetFailedLanes(batchId),
      countRedispatchableLanes: (batchId) =>
        SprintLaneStore.getInstance()
          .listLanes(batchId)
          .filter((lane) => lane.status !== 'integrated').length,
      reopenBatch: (batchId) => SprintLaneStore.getInstance().reopenBatch(batchId),
      clearPendingGateItems: (runId) => HumanStepManager.getInstance().clearPendingForRun(runId),
      clearPendingApprovalsForRun: (runId) => {
        ApprovalRouter.getInstance().clearPendingForRun(runId);
      },
      clearPendingQuestionsForRun: (runId) => {
        QuestionRouter.getInstance().clearPendingForRun(runId);
      },
      logger: loggerLike,
    };
    // The review queue's "Address review findings" CTA (TASK-277) is a SECOND
    // entry point onto this SAME dep bag — rewindRunHandler(runId,
    // 'address-review', ...), wired here rather than duplicating the bag.
    setRewindRunDeps(rewindRunDepsBag);
    console.log('[Main] runs.addressReviewFindings deps wired');

    // Lane-rewind deps bag (monitor rewind_lane_to_step). Deliberately tiny next to
    // the rewind bag above: a lane rewind mutates nothing durable — it records an
    // in-memory directive and interrupts ONE lane — so it needs no queue, no
    // step_results purge, and no batch/lane writers. `abortLaneSpawn` is the SAME
    // facade abort the whole-run rewind uses as `stopLiveRun`, keyed here on the
    // PER-LANE spawn key (`${runId}:${taskId}`) the fan-out driver spawns under
    // rather than the run id, so exactly one lane's process dies.
    const laneRewindDepsBag: LaneRewindDeps = {
      db,
      requestLaneRewind: (runId, itemId, stepId) => runExecutor.requestLaneRewind(runId, itemId, stepId),
      listLiveSpawnKeys: (runId) => substrateFacade.listLiveSpawnKeys(runId),
      abortLaneSpawn: (spawnKey) => substrateFacade.abort(spawnKey),
      logger: loggerLike,
    };

    monitorSteeringActions = {
      addTask: (runId, input) => addTaskToRun(runId, input, taskMutationDeps).then(mapTaskResult),
      removeTask: (runId, input) => removeTaskFromRun(runId, input, taskMutationDeps).then(mapTaskResult),
      editTask: (runId, input) => editRunTask(runId, input, taskMutationDeps).then(mapTaskResult),
      skipStep: async (runId, input) => {
        const v = validateRunStep(runId, input.stepId);
        if (!v.ok) return { ok: false, message: v.message };
        runExecutor.addUserSkip(runId, input.stepId);
        return {
          ok: true,
          message: `Step '${input.stepId}' will be skipped when the run reaches it (no effect if it has already run).`,
        };
      },
      unskipStep: async (runId, input) => {
        const v = validateRunStep(runId, input.stepId);
        if (!v.ok) return { ok: false, message: v.message };
        runExecutor.removeUserSkip(runId, input.stepId);
        return { ok: true, message: `Cleared the pending skip on step '${input.stepId}'.` };
      },
      steerStep: async (runId, input) => {
        const v = validateRunStep(runId, input.stepId);
        if (!v.ok) return { ok: false, message: v.message };
        // An OUTER fan-out step never spawns its own agent while lanes exist and
        // its durable guidance is never re-read (the controller walks the
        // synthesized INNER chain; SpawnStepRunner resolves guidance by the inner
        // ids) — storing under it would be a silent no-op reported as success.
        // Treat it as a LIVE-ONLY broadcast to the running sprint agents instead,
        // and point the operator at the inner step ids for durable guidance.
        if (isOuterFanOutStep(runId, input.stepId)) {
          const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance, input.taskRef, true);
          if (delivered > 0) {
            return {
              ok: true,
              message: `Delivered your guidance live to ${delivered} running sprint agent${delivered === 1 ? '' : 's'}. (Live-only: '${input.stepId}' is a fan-out phase, so nothing is stored — steer one of its inner steps, e.g. 'implement', to store guidance for future spawns.)`,
            };
          }
          return {
            ok: false,
            message: `No sprint agent is running right now, so there was nothing to steer live — and '${input.stepId}' is a fan-out phase whose stored guidance would never be read. Steer one of its inner steps (e.g. 'implement') to store guidance for future spawns.`,
          };
        }
        // taskRef narrows to ONE sprint lane's RUNNING agent — a live-only
        // delivery (RunDirectives.stepGuidance is keyed by stepId alone, so a
        // stored per-lane steer would leak to every lane's next spawn of that
        // step; refusing the store keeps the narrowing honest).
        if (input.taskRef !== undefined) {
          const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance, input.taskRef);
          if (delivered > 0) {
            return {
              ok: true,
              message: `Delivered your guidance live to ${input.taskRef}'s agent on step '${input.stepId}'. (Live-only: it is not stored for future spawns — steer without taskRef for that.)`,
            };
          }
          return {
            ok: false,
            message: `${input.taskRef}'s agent isn't currently mid-flight on step '${input.stepId}', so there was nothing to steer live. Steer without taskRef to store guidance for every future spawn of the step.`,
          };
        }
        // Durable path FIRST: the guidance rides RunDirectives and is composed
        // into every FUTURE spawn of this step (including retries after a live
        // delivery — deliberate reinforcement, not duplication).
        runExecutor.setStepGuidance(runId, input.stepId, input.guidance);
        // Live path: when the step is executing right now, ALSO interject the
        // guidance mid-turn via the SDK steering queue.
        const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance);
        const stored = `Added your guidance to step '${input.stepId}' — it'll be included whenever that step (re)spawns.`;
        return {
          ok: true,
          message:
            delivered > 0
              ? `${stored} Also delivered it live to ${delivered} agent${delivered === 1 ? '' : 's'} running that step right now.`
              : `${stored} No agent is mid-flight on that step right now, so it first lands at the next spawn.`,
        };
      },
      rewindToStep: async (runId, input) => {
        const result = await rewindRunHandler(runId, input.stepId, rewindRunDepsBag);
        if ('delivered' in result) {
          const abortNote = result.abortedLiveWalk ? ' Stopped the in-flight work first.' : '';
          const keptNote = result.fanOutKeptSettled
            ? ' Already-integrated sprint work stays settled — only the surrounding steps re-run.'
            : '';
          return {
            ok: true,
            message: `Rewound the run to step '${result.stepId}' — re-running from there now.${abortNote}${keptNote}`,
          };
        }
        const messages: Record<string, string> = {
          not_found: 'Run not found.',
          not_programmatic: 'Only programmatic runs can be rewound.',
          not_rewindable:
            "The run isn't in a rewindable state — it must be running, resting, failed, or paused.",
          unknown_step: `Step '${input.stepId}' is not one of this workflow's timeline steps — rewind targets the run's own steps, not a sprint task's inner steps.`,
          target_not_prior:
            "That step is ahead of the run's current position — rewind only goes backward. To jump forward, skip the steps in between instead.",
          fanout_settled:
            'Every sprint task in this run is already integrated — nothing would re-run at that fan-out step. Rewind to an earlier step instead, or add a task first.',
          race: 'The run changed state mid-rewind — try again.',
        };
        return { ok: false, message: messages[result.reason] ?? `Rewind refused (${result.reason}).` };
      },
      rewindLaneToStep: async (runId, input) => {
        const result = await laneRewindHandler(runId, input, laneRewindDepsBag);
        if ('delivered' in result) {
          // Distinguish the two interrupt paths in the message: a killed agent turn
          // is visible to the user (the lane's transcript stops mid-thought), while a
          // directive that lands at the lane's next step boundary is not.
          const stopNote = result.abortedSpawn
            ? " Stopped that lane's current agent first."
            : ' It takes effect as soon as the lane finishes what it is doing.';
          const fromNote = result.fromStepId !== null ? ` (was on '${result.fromStepId}')` : '';
          return {
            ok: true,
            message: `Rewound ${result.ref}'s lane to step '${result.stepId}'${fromNote} — only that lane re-runs; the rest of the sprint keeps going.${stopNote}`,
          };
        }
        const laneStatusHint =
          result.laneStatus === 'queued'
            ? "that lane hasn't started yet, so it will run from the top of its chain anyway"
            : result.laneStatus === 'integrated'
              ? 'that lane already finished and integrated — re-running it needs a whole-run rewind to the fan-out step'
              : `that lane has already settled (${result.laneStatus ?? 'unknown'}) — re-driving a settled lane needs a whole-run rewind or a retry`;
        const messages: Record<string, string> = {
          not_found: 'Run not found.',
          not_programmatic: 'Only programmatic runs have sprint lanes to rewind.',
          run_not_running:
            "The run isn't executing right now, so there is no live lane to rewind. Use retry or the whole-run rewind to revive it first.",
          no_fan_out: "This run has no sprint task fan-out, so there are no lanes to rewind.",
          unknown_task: `No task matching '${input.taskRef}' in this project.`,
          lane_not_found: `${input.taskRef} isn't one of this run's sprint lanes.`,
          lane_not_live: `Can't rewind ${input.taskRef}'s lane — ${laneStatusHint}.`,
          unknown_step: `'${input.stepId}' isn't one of this run's lane steps — a lane rewind targets a task's INNER steps (e.g. 'implement', 'code-review'), not the run's phase steps. Use the whole-run rewind for those.`,
          target_not_prior: `'${input.stepId}' is ahead of where that lane is now — a lane rewind only goes backward.`,
        };
        return { ok: false, message: messages[result.reason] ?? `Lane rewind refused (${result.reason}).` };
      },
      // The two review-queue actions (resolve_review_item / file_note) live in
      // ./monitorReviewQueueComposition.ts (issue #19 size ratchet) and reuse
      // this block's db / run→project lookup / logger.
      ...composeMonitorReviewQueueActions({ db, runProjectId, loggerLike }),
    };
    console.log('[Main] monitor steering actions wired');

    // Autonomous MONITOR-ACTION sinks (lane rescue, review-loop steering, gate
    // escalation). Built HERE, alongside the steering actions, so all of them
    // reuse the SAME `taskMutationDeps`, review-queue chokepoint and run→project
    // resolution those actions route through. Logic: monitorActionSinks.ts.
    const monitorActionSinkDeps: MonitorActionSinkDeps = {
      db,
      runProjectId,
      applyReviewItem: (projectId, change) =>
        ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
      awaitProjectWritesSettled: (projectId) => ReviewItemRouter.getInstance().awaitProjectWritesSettled(projectId),
      taskMutations: taskMutationDeps,
      describeTaskFailure: (result) => mapTaskResult(result).message,
      logger: loggerLike,
    };
    laneTriageActions = buildLaneTriageActions(monitorActionSinkDeps);
    monitorFindingSink = buildMonitorFindingSink(monitorActionSinkDeps);
    setAsideFindingSink = buildSetAsideFindingSink(monitorActionSinkDeps);
    gateEscalationSinks = buildGateEscalationSinks(monitorActionSinkDeps);
    console.log('[Main] monitor action sinks wired');

    // Lazy monitor rehydration: after an app restart the in-process
    // MonitorRegistry is empty, and boot recovery only re-drives
    // starting/running/awaiting_review runs (re-registering their monitors as a
    // side effect) — a run already failed/paused/canceled/completed at boot
    // would keep a silently dead monitor chat. On a registry miss the monitor
    // router consults this rehydrator: it revives the session from the
    // workflow_runs row via the SAME construction closure the run used at start
    // (buildMonitorSession) and recreates the persisting inject bridge through
    // RunExecutor.ensureMonitorInjectBridge so converse turns still render into
    // the Chat pane and persist to raw_events. Refusal matrix (non-sdk,
    // non-programmatic, missing row/worktree) lives in monitorRehydration.ts.
    setMonitorRehydrator(
      createMonitorRehydrator({
        db,
        ensureInjectBridge: (runId) => runExecutor.ensureMonitorInjectBridge(runId),
        buildSession: (ctx, injectEvent) => {
          if (!buildMonitorSession) {
            // Unreachable in practice: initializeServices() assigns the holder
            // before this wiring block runs; the router treats a throw as a miss.
            throw new Error('buildMonitorSession not initialized before rehydrator wiring');
          }
          return buildMonitorSession(ctx, injectEvent);
        },
        logger: loggerLike,
      }),
    );
    console.log('[Main] monitor lazy rehydrator wired');

    setStartRunDeps({
      runLauncher,
      sessionManager,
    });
    console.log('[Main] runs.start deps wired');

    // A/B experiments (slice B, migration 049). Inject the concrete collaborators
    // the experiments router orchestrates: the SHA-pinned arm-session core
    // (createQuickSessionCore — the SAME path sessions:create-quick uses), the run
    // launcher, the entity chokepoint, the git-neutral run cancel, and the FULL
    // session-dismiss path (cancels hosted runs THEN removes the worktree — never a
    // bare worktree-remove, per the plan).
    const experimentsDb = makeDatabaseLike(databaseService);
    const dismissSessionFully = async (sessionId: string): Promise<void> => {
      const dbSession = databaseService.getSession(sessionId);
      // 1. Cancel hosted runs first (git-neutral; settles pending approvals).
      try {
        if (cancelHostedRunsImpl) await cancelHostedRunsImpl(sessionId);
      } catch (err) {
        loggerLike.warn('[Main] experiment dismiss: cancel hosted runs failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // 2. Archive the session + stamp outcome='dismissed' on its runs.
      try {
        await sessionManager.archiveSession(sessionId);
      } catch (err) {
        loggerLike.warn('[Main] experiment dismiss: archiveSession failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        stampSessionRunsOutcome(experimentsDb, sessionId, 'dismissed');
      } catch {
        /* fail-soft */
      }
      // 3. Remove the worktree — worktree-backed, non-main-repo sessions only.
      // An IN-PLACE session (migration 047) has NO worktree of its own: its
      // worktree_path IS the project checkout. Attempting removeWorktree for one
      // is at best a no-op on a nonexistent path and at worst aimed at the user's
      // real checkout, so it is skipped outright. This became load-bearing when
      // the idea-session door (openIdeaSessionCore) started using this same
      // primitive to compensate a half-created IN-PLACE home session.
      if (
        dbSession?.worktree_name &&
        dbSession.project_id &&
        !dbSession.is_main_repo &&
        !dbSession.in_place
      ) {
        const project = databaseService.getProject(dbSession.project_id);
        if (project) {
          try {
            await worktreeManager.removeWorktree(
              project.path,
              dbSession.worktree_name,
              project.worktree_folder || undefined,
            );
          } catch (err) {
            loggerLike.warn('[Main] experiment dismiss: removeWorktree failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    };
    setExperimentsDeps({
      db: experimentsDb,
      runLauncher,
      // Sprint seed-task cap: the same live Settings override runs.start and the
      // batch picker read, so an experiment arm accepts exactly what a normal
      // sprint launch would.
      getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
      // settleQuickArm write barrier: refuse to rest a quick arm whose session
      // has an agent turn mid-write (grading would snapshot a partial diff).
      // Routed through the facade so every substrate manager is consulted.
      hasActiveAgentTurn: (sessionId) => substrateFacade.hasTurnInFlightForSession(sessionId),
      worktreeManager: {
        getProjectMainBranch: (p) => worktreeManager.getProjectMainBranch(p),
        getHeadCommit: (p) => worktreeManager.getHeadCommit(p),
      },
      createArmSession: async ({ projectId, baseCommittish, nameHint, quickConfig }) => {
        const { session, runId, resolvedSubstrate } = await createQuickSessionCore(
          {
            taskQueue: taskQueue!,
            sessionManager,
            workflowRegistry,
            getDb: () => databaseService.getDb(),
            // A quick arm's config can pass an invalid substrate/runtime combo (the
            // wire schema permits cross-field combos createRun rejects), which throws
            // AFTER the worktree + session row are provisioned — sweep that orphan.
            dismissHalfCreatedSession: dismissSessionFully,
          },
          quickConfig
            ? {
                projectId,
                baseCommittish,
                nameHint,
                requestedSubstrate: quickConfig.substrate,
                agentProvider: quickConfig.agentProvider,
                agentRuntime: quickConfig.agentRuntime,
                agentModel: quickConfig.model,
                requestedAgentMode: quickConfig.permissionMode,
              }
            : // Pin 'sdk' explicitly: an A/B arm session is an INFRASTRUCTURE host
              // (its worktree hosts the arm's workflow runs), not a user quick
              // session, so its sentinel must never inherit the quick-session PTY
              // default (quickSessionDefaultSubstrate). This keeps the arm sentinel
              // 'sdk' exactly as before that default existed.
              { projectId, baseCommittish, nameHint, requestedSubstrate: 'sdk' },
        );
        // Stamp parity with the quick IPC handler, via the SHARED chokepoint
        // (stampQuickSessionRuntimeConfig): the arm's permission-mode pick and
        // the RESOLVED substrate/agent_runtime must land on the SESSION row too
        // — chat spawns read sessions.agent_permission_mode
        // (resolveSessionAgentPermissionMode), and the sessions:input relay
        // branch + frontend substrate gates read sessions.substrate/
        // agent_runtime. Without this the sub-form's substrate and permission
        // picks silently never applied: the arm ran as an SDK session on the
        // global permission default while its run row claimed otherwise. Infra
        // arms (no quickConfig) keep their pre-existing NULL stamps.
        //
        // The runtime is derived GENERICALLY, through the same helper the quick
        // handler's ladder ends in (resolveNonClaudeSessionRuntime): a
        // provider-literal test here used to recognize only codex-sdk, so an
        // omp-sdk arm stamped nothing and the shared chokepoint fell back to
        // deriving claude-sdk from the SDK substrate — the sentinel run row said
        // omp-sdk while sessions.agent_runtime said claude-sdk, and every chat
        // turn in that arm dispatched to Claude. The arm wire schema carries only
        // STORABLE runtimes, so no PTY runtime can appear here.
        if (quickConfig) {
          try {
            const armSessionRuntime = resolveNonClaudeSessionRuntime(quickConfig);
            stampQuickSessionRuntimeConfig(databaseService.getDb(), session.id, {
              resolvedSubstrate,
              ...(armSessionRuntime !== undefined
                ? { sessionAgentRuntime: armSessionRuntime }
                : {}),
              requestedAgentMode: quickConfig.permissionMode,
            });
          } catch (err) {
            // This stamp runs AFTER createQuickSessionCore's compensation window
            // closed, so a throw here would orphan the provisioned session +
            // worktree (the caller never learns the session id and can't sweep
            // it). Compensate exactly like the core: best-effort full dismiss,
            // then rethrow so startExperiment still sees the failure.
            try {
              await dismissSessionFully(session.id);
            } catch (sweepErr) {
              loggerLike.warn('[Main] experiment arm: orphan sweep after stamp failure failed', {
                sessionId: session.id,
                error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
              });
            }
            throw err;
          }
        }
        // Seed the quick arm's chat config onto its Claude panel. A quick arm is
        // an interactive session the user drives, but its per-turn model /
        // reasoning-effort are read from PANEL settings at sessions:input spawn
        // time (never from the session row) — and the arm's Claude panel is created
        // bare (lazily, by bootstrapArmSessionPanels). Without seeding it here, the
        // quickConfig model/effort would fall back to the SDK/CLI defaults.
        // Mirrors the quick handler's updatePanelSettings seeding;
        // bootstrapArmSessionPanels is idempotent so it reuses this panel.
        // (fastMode is deliberately NOT part of the arm wire schema — the user
        // can still toggle it per-turn in the session UI after launch.)
        if (quickConfig && resolvedSubstrate === 'interactive') {
          // EAGER PTY SPAWN — parity with sessions:create-quick's interactive
          // branch: without it an interactive arm boots to a DEAD terminal (no
          // REPL until a first ^G-composed sessions:input re-spawns one on
          // demand; direct terminal keystrokes go nowhere). Same contracts as
          // the quick handler: the panel is NOT registered with
          // ClaudePanelManager (the PTY surface never uses the structured
          // claudePanels:* IPC), the runId→panelId translation is seeded
          // BEFORE the spawn so a relay racing the first PTY byte resolves,
          // and startPanel is NEVER awaited (its promise resolves only when
          // the REPL exits — awaiting would deadlock arm creation).
          try {
            const chatPanel = await panelManager.createPanel({
              sessionId: session.id,
              type: 'claude',
              title: 'Chat',
            });
            if (quickConfig.model !== undefined || quickConfig.reasoningEffort !== undefined) {
              databaseService.updatePanelSettings(chatPanel.id, {
                ...(quickConfig.model !== undefined ? { model: quickConfig.model } : {}),
                ...(quickConfig.reasoningEffort !== undefined
                  ? { reasoningEffort: quickConfig.reasoningEffort }
                  : {}),
              });
            }
            substrateFacade.registerInteractivePanel(runId, chatPanel.id);
            void interactiveReplManager
              .startPanel(
                chatPanel.id,
                session.id,
                session.worktreePath,
                '', // prompt — the briefing rides --append-system-prompt, so the REPL opens idle
                session.permissionMode,
                quickConfig.model,
                undefined, // effort ('ultracode') — not part of the arm wire schema
                undefined, // fastMode — not part of the arm wire schema
                undefined, // resumeSessionId — fresh eager spawn
                quickConfig.reasoningEffort,
                undefined, // userAcknowledgedProviderDisabled — not a resume prompt
                QUICK_PTY_BRIEFING, // session context, NOT a user turn
              )
              .catch((err: unknown) => {
                // Fail-soft (mirrors create-quick): the arm stays usable — the
                // first ^G-composed sessions:input bootstraps the REPL on demand.
                loggerLike.warn('[Main] experiment arm: eager interactive REPL spawn failed', {
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            // The REPL is live but IDLE — the briefing rides the system prompt, so
            // this spawn starts no turn. See restInteractiveSessionIdle for why it
            // rests at the turn-end value rather than 'running' or 'stopped'.
            restInteractiveSessionIdle(sessionManager, session.id);
          } catch (err) {
            loggerLike.warn('[Main] experiment arm: interactive chat-panel seed failed', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (
          quickConfig &&
          (quickConfig.model !== undefined || quickConfig.reasoningEffort !== undefined)
        ) {
          try {
            const chatPanel = await panelManager.createPanel({
              sessionId: session.id,
              type: 'claude',
              title: 'Chat',
            });
            // Server-side createPanel skips the frontend panels:create
            // auto-registration (ipc/panels.ts) — but an SDK-substrate arm's
            // chat is driven through the panel-scoped claudePanels/panels IPC,
            // whose manager throws "Panel not registered" for an unregistered
            // panel, and bootstrapArmSessionPanels sees this panel and skips
            // the registering create. Register here (lazy require, mirroring
            // ipc/panels.ts — the handler assigns the export at boot, long
            // before any arm launch) so the arm's FIRST chat turn dispatches.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { claudePanelManager } = require('./ipc/claudePanel') as {
              claudePanelManager?: {
                registerPanel(panelId: string, sessionId: string): void;
              };
            };
            claudePanelManager?.registerPanel(chatPanel.id, session.id);
            databaseService.updatePanelSettings(chatPanel.id, {
              ...(quickConfig.model !== undefined ? { model: quickConfig.model } : {}),
              ...(quickConfig.reasoningEffort !== undefined
                ? { reasoningEffort: quickConfig.reasoningEffort }
                : {}),
            });
          } catch (err) {
            // Fail-soft: a seeding failure leaves the arm usable (it falls back to
            // SDK/CLI defaults, exactly as before this seed existed) — never abort
            // arm creation over a per-turn config pin.
            loggerLike.warn('[Main] experiment arm: chat-panel config seed failed', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { sessionId: session.id, worktreePath: session.worktreePath, runId };
      },
      taskChangeRouter: TaskChangeRouter.getInstance(),
      dismissSession: dismissSessionFully,
      cancelRun: async (runId) => {
        await cancelRunHandler(runId, cancelRunDepsBag);
      },
      getVariant: (variantId) => workflowRegistry.getVariantById(variantId),
      getWorkflow: (workflowId) => {
        const w = workflowRegistry.getById(workflowId);
        return w ? { id: w.id, name: w.name } : null;
      },
      getProjectPath: (projectId) => {
        const p = sessionManager.getProjectById(projectId);
        return p?.path ?? null;
      },
      setVariantStatus: (variantId, status) => workflowRegistry.setVariantStatus(variantId, status),
      setVariantWeight: (variantId, weight) => workflowRegistry.updateVariant(variantId, { weight }),
      setBaselineRotation: (workflowId, patch) => workflowRegistry.setBaselineRotation(workflowId, patch),
      adoptWorkflowSpec: (workflowId, definition) => workflowRegistry.updateSpec(workflowId, definition),
      // Slice C: experiments.decide resolves the blocking pairwise decision review
      // item via experiment_comparisons.decision_review_item_id. Look up the item's
      // project (review items are project-scoped) then route the resolve through the
      // single ReviewItemRouter chokepoint. Fire-and-forget + fail-soft — a decide
      // must never fail because the notification could not be resolved.
      resolveReviewItem: (reviewItemId) => {
        try {
          const row = db
            .prepare('SELECT project_id AS projectId FROM review_items WHERE id = ?')
            .get(reviewItemId) as { projectId?: number } | undefined;
          if (!row || typeof row.projectId !== 'number') return;
          void ReviewItemRouter.getInstance()
            .applyReviewItem(row.projectId, {
              op: 'resolve',
              actor: 'orchestrator',
              reviewItemId,
              resolution: 'experiment-decided',
            })
            .catch(() => {});
        } catch {
          /* fail-soft: pre-050 DB or missing item — nothing to resolve */
        }
      },
      // Slice C: rerunComparison re-drives the pairwise snapshot+enqueue after
      // deleting the stale comparison row.
      pairwiseMaybeSnapshot: async (experimentId) => {
        const worker = PairwiseJudgeWorker.tryGetInstance();
        if (worker) await worker.maybeSnapshotAndEnqueue(experimentId);
      },
    });
    console.log('[Main] experiments deps wired');

    // Open-idea-session door (idea sessions plan, Stage 1). The IPC handler in
    // ipc/session.ts is thin by contract; every collaborator is assembled HERE
    // because two of them only exist at this composition root: the FULL safe
    // session-dismiss (dismissSessionFully — now in-place-aware, see its step 3)
    // and the lazily-bound Claude panel registrar. Deliberately placed AFTER
    // dismissSessionFully so the compensation primitive is in scope.
    setOpenIdeaSessionDeps({
      getDb: () => databaseService.getDb(),
      quickSession: {
        taskQueue: taskQueue!,
        sessionManager,
        workflowRegistry,
        getDb: () => databaseService.getDb(),
        // The idea door pins substrate/runtime itself, so createRun should never
        // reject the combo — but the core's compensation window is the only
        // layer holding the session id when it does.
        dismissHalfCreatedSession: dismissSessionFully,
      },
      runPreflights: () => runClaudeSdkSessionPreflights(configManager),
      panelManager,
      getClaudePanelRegistrar: () => {
        // Lazy require, mirroring ipc/panels.ts: the handler assigns the export
        // at boot, long before any Open, but it is not readable at wiring time.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { claudePanelManager } = require('./ipc/claudePanel') as typeof import('./ipc/claudePanel');
        return claudePanelManager;
      },
      refreshSession: (sessionId) => {
        sessionManager.refreshSessionFromDatabase(sessionId);
      },
      dismissSession: dismissSessionFully,
    });
    console.log('[Main] open-idea-session deps wired');

    // Boot recovery: reconcile non-terminal A/B experiments (migration 049).
    // running→grading when both arms are settled; a half-created experiment (crash
    // mid-startSideBySide, one arm never launched) → abandoned, THEN its two arm
    // sessions are dismissed via the SAME full session-delete path startSideBySide's
    // rollback uses (dismissSessionFully — cancels hosted runs + removes worktrees)
    // and both arms' entities are swept. Deliberately placed AFTER dismissSessionFully
    // + setExperimentsDeps are wired: the sweep callback reuses dismissSessionFully,
    // which closes over cancelHostedRunsImpl (assigned above) + experimentsDb.
    try {
      await recoverExperiments(db, async (exp) => {
        await dismissAndSweepHalfCreatedExperiment(db, exp, {
          dismissSession: dismissSessionFully,
          deleteExperimentArmEntities: (projectId, opts) =>
            TaskChangeRouter.getInstance().deleteExperimentArmEntities(projectId, opts),
          logger: loggerLike,
        });
      });
    } catch (err) {
      loggerLike.error('[Main] experiment boot recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Global-agent proposal executor (migration 071). A user-confirmed proposal
    // executes server-side through the SAME chokepoints, stamped actor:'user' — the
    // executor owns the CAS state machine, the launch compensation saga, and boot
    // reconciliation of rows stranded 'executing' by a crash. Deps mirror
    // setExperimentsDeps: the quick-session core, the run launcher, the FULL safe
    // session-dismiss (dismissSessionFully — cancels hosted runs + removes the
    // worktree) + git-neutral run cancel (the same compensation primitives the A/B
    // rollback ladder uses), the TaskChangeRouter chokepoint, and the workflow registry.
    // Reuse the SINGLE agentThreadStore built in initializeServices (same DB) — the
    // MCP propose handler, this executor, and the tRPC context all share one store.
    const proposalExecutorDeps: ProposalExecutorDeps = {
      store: agentThreadStore,
      newIdempotencyKey: () => randomUUID(),
      // launch-run host sessions + start-quick-session mint/brief delivery: proposalExecutorQuickSessionDeps.ts.
      ...buildProposalExecutorQuickSessionDeps({
        createQuickSessionCore, stampQuickSessionRuntimeConfig, reportEagerSpawnFailure,
        quickSessionCore: { taskQueue: taskQueue!, sessionManager, workflowRegistry, getDb: () => databaseService.getDb(), dismissHalfCreatedSession: dismissSessionFully },
        newSessionName: generateQuickWorktreeBranchName,
        sessionManager, panelManager, substrateFacade, interactiveReplManager,
        getClaudePanelManager: () => (require('./ipc/claudePanel') as typeof import('./ipc/claudePanel')).claudePanelManager,
        ptyBriefing: QUICK_PTY_BRIEFING, logger: loggerLike,
      }),
      // launch-run: workflow resolution (by id or name, custom flows included)
      // + shape-derived seed mapping live in proposalExecutorLaunchDeps.ts.
      ...buildProposalExecutorLaunchDeps({
        workflowRegistry,
        getProjectById: (projectId) => sessionManager.getProjectById(projectId),
        runLauncher,
      }),
      cancelRun: async (runId) => {
        await cancelRunHandler(runId, cancelRunDepsBag);
      },
      dismissSession: dismissSessionFully,
      runExists: (runId) =>
        experimentsDb.prepare('SELECT 1 FROM workflow_runs WHERE id = ?').get(runId) !== undefined,
      applyTaskChange: async (projectId, change) => {
        await TaskChangeRouter.getInstance().applyChange(projectId, change);
      },
      createBacklogItem: async (projectId, item) => {
        // The SAME chokepoint every other entity create goes through, stamped
        // actor:'user' (the human's Confirm click is the authorship). Field mapping
        // is one-to-one with CreateBacklogItem; parentEpicId/originatingIdeaId were
        // already resolved to opaque ids + existence-checked at propose time
        // (mcpQueryHandler's create-backlog-items branch).
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(projectId, {
          actor: 'user',
          entityType: item.taskType,
          title: item.title,
          summary: item.summary,
          body: item.body,
          priority: item.priority,
          category: item.category,
          scope: item.scope,
          parentEpicId: item.parentEpicId ?? null,
          originatingIdeaId: item.originatingIdeaId ?? null,
        });
        const row = experimentsDb
          .prepare(
            `SELECT ref FROM (
               SELECT id, ref FROM ideas
               UNION ALL SELECT id, ref FROM epics
               UNION ALL SELECT id, ref FROM tasks
             ) WHERE id = ?`,
          )
          .get(taskId) as { ref?: unknown } | undefined;
        return { taskId, ...(typeof row?.ref === 'string' ? { ref: row.ref } : {}) };
      },
      readTaskFields: (projectId, taskId) => {
        // The item may be an idea/epic/task (all share priority + stage_id) — resolve
        // it across the three tables the same way TaskChangeRouter's locateEntity does.
        const row = experimentsDb
          .prepare(
            `SELECT priority, stage_id AS stageId FROM (
               SELECT id, project_id, priority, stage_id FROM ideas
               UNION ALL SELECT id, project_id, priority, stage_id FROM epics
               UNION ALL SELECT id, project_id, priority, stage_id FROM tasks
             ) WHERE id = ? AND project_id = ?`,
          )
          .get(taskId, projectId) as TaskFieldsSnapshot | undefined;
        return row ?? null;
      },
      runInTransaction: <T>(fn: () => T): T => experimentsDb.transaction(fn)() as T,
      // edit-workflow + create-workflow: WorkflowRegistry / AgentOverrideRouter closures.
      ...buildProposalExecutorWorkflowDeps({ workflowRegistry, agentOverrideRouter: AgentOverrideRouter.getInstance(), db: experimentsDb }),
      // triage-findings: the ReviewItemRouter chokepoint + a live-state read.
      ...buildProposalExecutorReviewDeps({ reviewItemRouter: ReviewItemRouter.getInstance(), db: experimentsDb }),
      logger: loggerLike,
    };
    setProposalExecutorDeps(proposalExecutorDeps);
    console.log('[Main] proposal executor deps wired');

    // Boot reconciliation: finalize any proposal stranded 'executing' by a crash
    // (verifies observable side effects; NEVER re-runs them). Fire-and-forget +
    // fail-soft — a reconcile failure must never wedge boot.
    void reconcileOrphanedExecutingProposals(proposalExecutorDeps).catch((err) => {
      loggerLike.error('[Main] proposal executor boot reconcile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Design-mode-fork launch saga (QuestionRouter.launchDesignModeOnFork /
    // designSessionLaunch.ts). A HUMAN answering the planner's approve-idea gate
    // with "Approve → design mode" launches a Design Mode session — the SAME
    // three-layer belt sessions:create-quick's design branch drives
    // (ipc/session.ts ~787-1091: validateDesignIdeaLink, createQuickSessionCore
    // with requireSdkSubstrate, the design_idea_id stamp + ui-prototype stub),
    // replayed here since this launch has no renderer client. Compensation
    // (dismissSessionFully) and the review-item failure report reuse the SAME
    // primitives proposalExecutorDeps wires just above.
    QuestionRouter.getInstance().setDesignSessionLaunchDeps({
      validateIdeaLink: (ideaId, projectId) => {
        const result = validateDesignIdeaLink(databaseService.getDb(), ideaId, projectId);
        if (!result.ok) return { ok: false, error: result.error };
        // Max-one-running-per-idea (idea sessions plan, Stage 1): the design
        // fork is one of the doors the hard rule guards. Same rejection channel
        // as a dead idea link — the saga reports either as "could not launch".
        const busy = findIdeaBusyReason(databaseService.getDb(), ideaId);
        return busy === null ? { ok: true } : { ok: false, error: busy.message };
      },
      createDesignSession: async ({ projectId, ideaId, nameHint }) => {
        // Fail-closed Claude/SDK availability pre-flight — the SHARED ladder
        // (services/claudeSdkSessionPreflight.ts) the design branch of
        // sessions:create-quick and the open-idea-session door also run: a
        // design session is hard-pinned to the Claude SDK substrate, so an
        // unavailable Claude login/binary must reject BEFORE any worktree is
        // cut, rather than let substrate resolution silently fall through. Only
        // the wording is local — this fork's messages are terser than the IPC
        // handler's (no "Enable Claude to start a design session." tail) and
        // stay byte-identical to what it threw before the extraction.
        const designPreflight = await runClaudeSdkSessionPreflights(configManager);
        if (!designPreflight.ok) {
          throw new Error(DESIGN_FORK_PREFLIGHT_MESSAGES[designPreflight.reason]);
        }

        const { session, runId, resolvedSubstrate } = await createQuickSessionCore(
          {
            taskQueue: taskQueue!,
            sessionManager,
            workflowRegistry,
            getDb: () => databaseService.getDb(),
          },
          {
            projectId,
            nameHint,
            agentProvider: 'claude',
            agentRuntime: 'claude-sdk',
            requestedSubstrate: 'sdk',
            requireSdkSubstrate: true,
          },
        );
        // From here down, createQuickSessionCore has ALREADY minted a real
        // session + sentinel run + git worktree — anything that throws past
        // this point must compensate via a full dismiss before propagating,
        // because launchDesignSessionForFork (designSessionLaunch.ts) only
        // records `created.sessionId` once THIS callback resolves; a throw
        // from inside it leaves the saga's own catch block with no id to
        // dismiss, orphaning the session/run/worktree. finishDesignSessionCreate
        // (designSessionLaunch.ts) owns that internal compensation — see its
        // JSDoc for why this is NOT redundant with the saga's own dismiss (the
        // two only ever apply in mutually exclusive windows): do NOT also add
        // a dismiss to the saga's catch for this failure mode.
        await finishDesignSessionCreate({
          sessionId: session.id,
          resolvedSubstrate,
          stampDesignIdeaId: () => {
            const dbHandle = databaseService.getDb();
            dbHandle.prepare(`UPDATE sessions SET design_idea_id = ? WHERE id = ?`).run(ideaId, session.id);
            // `origin_idea_id` (migration 114): a design session IS a session
            // launched from the idea, and the sidebar nests children by that
            // column. Lineage, not a claim — no unique index. Kept a SEPARATE
            // statement, mirroring the sessions:create-quick design branch.
            dbHandle.prepare(`UPDATE sessions SET origin_idea_id = ? WHERE id = ?`).run(ideaId, session.id);
          },
          refreshSession: (sessionId) => {
            sessionManager.refreshSessionFromDatabase(sessionId);
          },
          dismissSession: dismissSessionFully,
          onCompensationFailure: (dismissErr) => {
            loggerLike.warn('[Main] design-mode fork: compensating dismiss failed after mid-create error', {
              sessionId: session.id,
              error: dismissErr instanceof Error ? dismissErr.message : String(dismissErr),
            });
          },
        });

        // v0.5 re-entry stub (mirrors ipc/session.ts ~1064-1090) — fail-soft: a
        // stub failure must never fail session creation. Deliberately called
        // AFTER finishDesignSessionCreate rather than folded into it — this
        // failure mode is intentionally NOT compensating.
        try {
          await ArtifactRouter.getInstance().apply(projectId, {
            op: 'create',
            runId,
            atype: 'ui-prototype',
            label: 'Prototype',
            payloadJson: null,
            sourceRef: ideaId,
            sessionId: session.id,
            isNew: true,
            actor: 'orchestrator',
          });
        } catch (stubErr) {
          loggerLike.warn('[Main] design-mode fork: prototype stub creation failed (non-fatal)', {
            sessionId: session.id,
            error: stubErr instanceof Error ? stubErr.message : String(stubErr),
          });
        }

        return { sessionId: session.id, runId, worktreePath: session.worktreePath };
      },
      kickoffDesignPanel: async ({ sessionId, worktreePath }) => {
        // Mirrors useQuickSession.ts's post-create sequence: create the Chat
        // panel, register it with the Claude runtime, then fire the canonical
        // design kickoff prompt as its first turn via startPanel — a FRESH
        // panel has no running process and no claude_session_id yet, so this is
        // the 'panels:continue' first-message branch (ipc/session.ts ~2783-2797),
        // never continuePanel/resume.
        const panel = await panelManager.createPanel({ sessionId, type: 'claude', title: 'Chat' });
        const { claudePanelManager } = require('./ipc/claudePanel') as typeof import('./ipc/claudePanel');
        if (!claudePanelManager) throw new Error('the Claude panel manager is not available yet');
        // We just created this panel with type 'claude', so its customState IS a
        // ClaudePanelState — but ToolPanel's `state.customState` is a union across
        // every panel kind with no discriminant tying it to `panel.type`, so TS
        // cannot see that. The parallel call in ipc/panels.ts:36 passes it
        // unnarrowed only because its `require` is untyped; narrow here rather
        // than giving up the typed import.
        claudePanelManager.registerPanel(
          panel.id,
          panel.sessionId,
          panel.type === 'claude'
            ? (panel.state.customState as ClaudePanelState | undefined)
            : undefined,
        );

        const kickoffPrompt = DESIGN_MODE_KICKOFF_PROMPT;
        sessionManager.addPanelConversationMessage(panel.id, 'user', kickoffPrompt);
        const dbSession = sessionManager.getDbSession(sessionId);
        await claudePanelManager.startPanel(panel.id, worktreePath, kickoffPrompt, dbSession?.permission_mode);
      },
      dismissSession: dismissSessionFully,
      reportLaunchFailure: ({ projectId, ideaId, runId, error }) => {
        void ReviewItemRouter.getInstance()
          .applyReviewItem(projectId, {
            op: 'create',
            actor: 'orchestrator',
            kind: 'finding',
            title: 'Design mode launch failed',
            body:
              `The approve-idea gate's design-mode fork could not launch a design session ` +
              `for idea ${ideaId} (run ${runId}): ${error}\n\nOpen the idea's prototype from the ` +
              `backlog and start a design session manually, or re-run the planner and pick ` +
              `"Approve → design mode" again.`,
            blocking: false,
            severity: 'error',
            entityType: 'idea',
            entityId: ideaId,
            runId,
            payload: { kind: 'finding', category: 'design-mode-launch' },
          })
          .catch((err) => {
            loggerLike.error('[Main] design-mode fork: failed to report launch failure', {
              ideaId,
              runId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
    } satisfies DesignSessionLaunchDeps);
    console.log('[Main] design-mode-fork launch deps wired');

    // Boot recovery: reconcile EVERY workflow's rotation experiment against its live
    // weighted pool (migration 058). Config could have drifted while a pre-058 build
    // ran (no reconcile hooks), or a crash interrupted a mid-reconcile — this heals
    // the drift (opens/supersedes/closes as the pool dictates). Per-workflow
    // try/catch inside; never throws.
    try {
      reconcileAllRotationExperiments(db, loggerLike);
    } catch (err) {
      loggerLike.error('[Main] rotation experiment boot reconcile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // runs.setPermissionMode → shared session-mode write chokepoint (permission-
    // mode redesign §3d / Slice 5). Re-routes the chat / flow-run permission pill
    // through the SAME updateSessionAgentPermissionMode chokepoint the composer
    // pill + launch picker use, so the mode write lands on
    // sessions.agent_permission_mode (the execution SoT) with the full four side
    // effects — never on the demoted workflow_runs.permission_mode_snapshot.
    setSetPermissionModeDeps(sessionPermissionModeDeps);
    console.log('[Main] runs.setPermissionMode deps wired');

    // Sprint-lane read dep (feat/parallel-sprint, single-run lane model). Backs
    // cyboflow.runs.sprintLanes; the singleton was initialized in
    // initializeServices() right after TaskChangeRouter.
    setSprintLaneDeps({
      listLanes: (batchId) => SprintLaneStore.getInstance().listLanes(batchId),
    });
    console.log('[Main] runs.sprintLanes deps wired');

    // Piece C — idle-chat nudge. Uses the SAME `db` DatabaseLike adapter +
    // `runQueues` + `loggerLike` as the cancelAndRestart wiring above, plus the
    // module-scoped RunExecutor built in initializeServices(). The handler
    // re-drives runExecutor.execute(runId) with a stashed nudge so the run
    // resumes its SDK conversation.
    //
    // awaitTurnStart: one-shot waiter over the facade's per-logical-turn
    // 'spawned' fan-in (panelId === runId for flow runs). Only consumed by
    // callers opting into `deliveredAt: 'turn-start'` (the gate-resolution
    // paths: approve-ideas verdicts, recovery-gate answers) — the plain
    // runs.nudge mutation keeps its await-the-drain behavior.
    const nudgeDeps = {
      db,
      runQueues,
      runExecutor,
      logger: loggerLike,
      awaitTurnStart: (runId: string) => {
        let onSpawned: ((payload: unknown) => void) | null = null;
        const started = new Promise<void>((resolveStarted) => {
          onSpawned = (payload: unknown) => {
            const evt = payload as { panelId?: unknown };
            if (evt !== null && typeof evt === 'object' && evt.panelId === runId) {
              if (onSpawned) substrateFacade.off('spawned', onSpawned);
              resolveStarted();
            }
          };
          substrateFacade.on('spawned', onSpawned);
        });
        return {
          started,
          cancel: () => {
            if (onSpawned) substrateFacade.off('spawned', onSpawned);
          },
        };
      },
    };
    setNudgeRunDeps(nudgeDeps);
    // Live merge/PR gate (runs.sessionSettleState): the chatTurnInFlight half
    // answers from the SAME facade barrier the experiment settle guard uses.
    setSessionSettleDeps({
      hasActiveAgentTurn: (sessionId) => substrateFacade.hasTurnInFlightForSession(sessionId),
    });
    console.log('[Main] runs.nudge deps wired');

    // Approve-ideas verdict delivery (IDEA-009 / TASK-035B): the default
    // ORCHESTRATED planner parks its SDK conversation at a drained REST after
    // minting the approve-ideas gate via cyboflow_report_finding, so a submitted
    // per-idea verdict map must be DELIVERED as the run's next turn (it cannot read
    // review items via MCP). Wrap nudgeRunHandler with the SAME deps bag the nudge
    // mutation uses so the resume re-drives the same warm executor; reviewItems.
    // resolve nudges FIRST and resolves once the resumed turn STARTS (the caller
    // passes `deliveredAt: 'turn-start'`, backed by awaitTurnStart above).
    setResolveVerdictNudgeDeps({
      nudge: (runId, text, opts) => nudgeRunHandler(runId, text, nudgeDeps, opts),
    });
    console.log('[Main] reviewItems approve-ideas verdict-delivery deps wired');

    // "Always allow messaging a running flow": the composer can send while an SDK
    // run is EXECUTING; the text is buffered on the SAME module-scoped RunExecutor
    // and delivered as the next turn at the drained REST seam (the deliverer is
    // wired into the RunExecutor ctor in initializeServices()). Reuse that instance
    // so the buffer the mutation writes is the one the drain seam reads.
    setQueueInputDeps({
      runExecutor,
    });
    console.log('[Main] runs.queueInput deps wired');

    // IDEA-030 / TASK-817: wire the live-input relay (the ONLY post-spawn input
    // path into a running interactive REPL). Both methods route through the
    // SubstrateDispatchFacade, which dispatches to the interactive manager's live
    // PTY and NO-OPs for the SDK substrate (Q3 byte-identical). runId === panelId
    // per the orchestrator invariant, so the facade maps directly.
    // IDEA-030 / TASK-818: endSession is the explicit-termination seam for a
    // persistent live process — the close-out mutations (merge / createPr /
    // dismiss) call it BEFORE worktree removal so the interactive PTY's spawn
    // promise resolves (and a warm SDK query() is killed). It rides the SAME
    // RelayDeps bag (the single bag for live-session collaborators) and routes
    // through the facade, which dispatches per substrate.
    setRelayDeps({
      relayInput: (runId, text) => substrateFacade.relayInput(runId, text),
      relayResize: (runId, cols, rows) => substrateFacade.relayResize(runId, cols, rows),
      endSession: (runId) => substrateFacade.endSession(runId),
      killSession: (runId) => substrateFacade.killSession(runId),
      getPtyBacklog: (runId) => substrateFacade.getPtyBacklog(runId),
    });
    console.log('[Main] runs.relayInput/relayResize/endSession/killSession/getPtyBacklog deps wired');

    // Wire the run user-shell (worktree-terminal feature): plain $SHELL PTYs in
    // the run's worktree, keyed by terminalId, backing the run "Terminal" tabs (a
    // run can host MULTIPLE via ＋terminal; the primary's terminalId === runId). The
    // cwd is resolved from workflow_runs.worktree_path (flow runs have no sessions
    // row, so they can't use the panel/session terminal stack). Raw bytes stream to
    // the renderer on `cyboflow:shell:<terminalId>` (mirrors the agent PTY's
    // cyboflow:pty:<runId>); input/resize/backlog/close ride tRPC (setRunShellDeps).
    // Independent of the RunExecutor, so a shell — and any dev server it launched —
    // SURVIVES run completion; close() reaps every terminal for a run at close-out
    // and destroyAll() at app quit.
    runShellManager = new RunShellManager(
      (runId) => {
        const row = db
          .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
          .get(runId) as { worktree_path: string | null } | undefined;
        return row?.worktree_path ?? null;
      },
      (terminalId, chunk) => {
        mainWindow?.webContents.send(`cyboflow:shell:${terminalId}`, chunk);
      },
      (file, args, options) => pty.spawn(file, args, options),
    );
    setRunShellDeps({
      open: (runId, terminalId) => runShellManager!.open(runId, terminalId),
      write: (terminalId, data) => runShellManager!.write(terminalId, data),
      resize: (terminalId, cols, rows) => runShellManager!.resize(terminalId, cols, rows),
      getBacklog: (terminalId) => runShellManager!.getBacklog(terminalId),
      closeOne: (terminalId) => runShellManager!.closeOne(terminalId),
      close: (runId) => runShellManager!.close(runId),
    });
    console.log('[Main] runs.shellOpen/shellInput/shellResize/shellBacklog/shellClose deps wired');

    // GAP-B: wire the run close-out (merge / dismiss + worktree cleanup) deps.
    // worktreeManager.removeWorktreeByPath takes the run's absolute nested
    // worktree path; getProjectById resolves the project path from project_id.
    setRunCloseoutDeps({
      worktreeManager: {
        getProjectMainBranch: (projectPath) => worktreeManager.getProjectMainBranch(projectPath),
        squashAndMergeWorktreeToMain: (projectPath, worktreePath, mainBranch, commitMessage) =>
          worktreeManager.squashAndMergeWorktreeToMain(projectPath, worktreePath, mainBranch, commitMessage),
        mergeWorktreeToMain: (projectPath, worktreePath, mainBranch) =>
          worktreeManager.mergeWorktreeToMain(projectPath, worktreePath, mainBranch),
        removeWorktreeByPath: (projectPath, worktreePath) =>
          worktreeManager.removeWorktreeByPath(projectPath, worktreePath),
        deleteBranch: (projectPath, branchName, opts) =>
          worktreeManager.deleteBranch(projectPath, branchName, opts),
        gitPush: (worktreePath) => worktreeManager.gitPush(worktreePath),
        getRemoteUrlAndBranch: (worktreePath) => worktreeManager.getRemoteUrlAndBranch(worktreePath),
      },
      sessionManager: {
        getProjectById: (projectId) => {
          const p = sessionManager.getProjectById(projectId);
          return p ? { path: p.path } : undefined;
        },
      },
      // Close-out clears the run's pending approvals (settles in-memory entries
      // + sweeps DB-only `pending` rows) so dismiss/merge/PR don't leave orphaned
      // items in the review queue.
      clearPendingApprovalsForRun: (runId) =>
        ApprovalRouter.getInstance().clearPendingForRun(runId),
      // Monitor-unify: at terminal close-out, tear down the run's on-demand monitor —
      // its per-run inject plumbing (RunExecutor) AND its registry entry. The monitor
      // outlives the walk (chat-at-rest), so this is the ONLY place it goes away.
      disposeMonitorResources: (runId) => {
        runExecutor.disposeMonitorResources(runId);
        MonitorRegistry.getInstance().unregister(runId);
      },
      // TASK-057: kill the run's detached ui-prototype http.server at close-out
      // (merge / createPr / dismiss). Fail-soft is handled inside the router.
      reapPrototypeServers: (runId) =>
        prototypeServerReaper.reapForRun(getCyboflowSubdirectory('artifacts', 'runs', runId)),
      // Visual-verify cleanup on the MERGE / CREATE-PR close-out path. Deliberately
      // the SAME closure the cancel/dismiss bag above wires, so both ways a run can
      // end reach one implementation: without it, merging left a draining
      // verification to deliver a finding onto a closed-out run. Fail-soft inside
      // the router; tryGetInstance keeps it a no-op when verification is disabled.
      cancelVerificationsForRun: (runId) =>
        VerificationScheduler.tryGetInstance()?.cancelForRun(runId),
      // Native task-tracking (migration 014): merge/createPr/dismiss stamp the
      // run's outcome and recompute the linked task's derived execution stage.
      // getInstance() resolves the singleton initialized during service construction.
      taskStageDeriver: TaskChangeRouter.getInstance(),
    });
    console.log('[Main] runs.merge/dismiss deps wired');

    setHealthProvider(orchestratorHealth);
    console.log('[Main] health.mcpServer deps wired');

    // Subscription-usage meters. The store hydrates its last-known readings from
    // user_preferences so the review queue shows something before the first poll
    // returns; the poller then asks both providers directly, which is the only
    // way to get a percentage out of Claude below its warning threshold.
    const providerUsageStore = initProviderUsageStore(databaseService, console);
    const providerUsagePoller = new ProviderUsagePoller(
      providerUsageStore,
      {
        pollClaude: pollClaudeUsage,
        pollCodex: () => pollCodexRateLimits(app.getVersion()),
        isProviderEnabled: (provider) => configManager.isAgentProviderEnabled(provider),
      },
      console,
    );
    setProviderUsageSource({
      getState: () => providerUsageStore.getState(),
      events: providerUsageStore.events,
      refresh: () => providerUsagePoller.refresh(),
    });
    console.log('[Main] providerUsage deps wired');
  }

  // Create the window only now — after ALL router deps above are wired — so a
  // fast user action right after first paint can never hit an un-wired mutation.
  console.log('[Main] Orchestrator wired, creating window...');
  await createWindow();
  console.log('[Main] Window created successfully');

  // Record app open in the local database (used for app-update detection)
  try {
    const currentVersion = app.getVersion();
    databaseService.recordAppOpen(false, currentVersion);
  } catch (error) {
    console.error('[Main] Failed to record app open:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      console.log('[Main] Activating app, creating new window...');
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clear the dock badge on `will-quit` (fires only after all `before-quit`
// preventDefault opportunities have passed, so the badge does not zero
// while the app is still running due to a cancelled quit).
app.on('will-quit', () => {
  dockBadgeService.setBadgeCount(0);
});

/**
 * Everything that must happen before this process may exit: settle in-flight
 * runs, kill child and remote processes, release ports, flush writes.
 *
 * Extracted from the `before-quit` listener so it can be AWAITED. It previously
 * ran inside an `async` listener, which Electron does not wait on — see
 * services/quitDrain.ts for what that race cost us (a fatal abort during Node
 * environment teardown, and runs stranded in `running` across restarts).
 *
 * Ordering is load-bearing and unchanged: stop the things that SCHEDULE work
 * before the things that DO it, settle runs before tearing down the processes
 * running them, and close the logger last.
 */
async function drainOnQuit(): Promise<void> {
  // Clear any pending idle session-summary timers (session-summary-plan.md §5).
  if (sessionSummaryScheduler) {
    sessionSummaryScheduler.dispose();
  }

  // Stop the issue-tracker poll loop: clears its timer + pending write-back
  // debounces and unsubscribes it from taskChangeEvents. Synchronous — an
  // in-flight pass is deliberately NOT awaited, since abandoning one mid-drain is
  // exactly the crash its boot ambiguous-recovery already handles.
  if (trackerSyncService) {
    trackerSyncService.stop();
  }

  // Kill every live OMP fleet worker. Unlike the other managers' children these
  // are REMOTE processes: nothing about this app exiting stops them, so without
  // an explicit fleet_kill they outlive the quit, keep burning producer budget
  // and keep mutating worktrees no one is watching. Best-effort and awaited —
  // stopAll never rejects (a failed kill is logged and the panel terminated
  // locally), so this cannot wedge the quit.
  if (ompSessionManager) {
    try {
      await ompSessionManager.stopAll();
    } catch (err) {
      console.warn('[Main] OMP fleet teardown on quit failed (workers may survive):', err);
    }
  }

  // Stop the vitest-orphan sweep timer. Its handle is unref'd so it could never
  // hold the process open, but leaving a sweep to fire into a torn-down app is
  // pointless work.
  vitestOrphanReaper.stop();

  // Stop the MCP-orphan tripwire's hourly scan. Its interval is already
  // unref'd (never holds the event loop open on its own), so this is cleanup
  // for tidiness rather than a shutdown-correctness requirement.
  mcpOrphanTripwire?.stop();

  // Stop the daily database-backup tick. Its interval is already unref'd, so
  // this is cleanup for tidiness rather than a shutdown-correctness requirement.
  databaseBackupService?.stop();

  // Latch the run executor into shutdown mode BEFORE anything below kills an
  // agent. cliManagerFactory.shutdown() (further down) aborts every live agent
  // process, and a live execute() sees that abort as its spawn settling: the
  // Claude SDK manager reports an intentional abort as a CLEAN exit (the spawn
  // RESOLVES), while the interactive PTY manager surfaces the kill as a
  // rejection. Without this latch the first would rest a cut-off run in
  // awaiting_review and the second would mark it `failed` — both statuses boot
  // recovery refuses to revive. Latched, both arms skip the transition and the
  // row stays running/starting, which is precisely what runRecovery.ts looks
  // for on the next launch (resume, or an honest app_restart/interrupted
  // force-fail). See RunExecutor.beginShutdown.
  runExecutor?.beginShutdown();

  // Stop orchestrator (drains run queues). A run with a live execution holds
  // the head of its concurrency-1 queue with a task that settles only when its
  // session ends, so at quit it never will — waiting on one flushes nothing and
  // only spends the quit budget, which is what once left the database close and
  // the MCP stop unrun. `shouldWait` skips exactly those queues so the state
  // mutations queued behind ordinary runs still flush. The skipped run is not
  // transitioned (beginShutdown above is what keeps that true once its agent is
  // killed below); its non-terminal row is boot recovery's job.
  if (orchestrator) {
    console.log('[Main] Stopping orchestrator...');
    await orchestrator.stop((runId) => !runExecutor?.hasActiveExecution(runId));
    console.log('[Main] Orchestrator stopped');
  }

  // Pause the eval worker queue. Any pending/running run_evals row simply stays
  // as-is (no crash-safe resume in v1) and is neither re-picked-up nor auto-failed
  // on next boot. tryGetInstance() is boot-order-safe (no throw if never inited).
  const evalWorker = EvalWorker.tryGetInstance();
  if (evalWorker) {
    console.log('[Main] Stopping eval worker...');
    await evalWorker.stop();
    console.log('[Main] Eval worker stopped');
  }

  // Pause the pairwise judge worker queue (A/B testing slice C). Any pending/running
  // experiment_comparisons row stays as-is and is re-enqueued by recoverInterrupted
  // on next boot (both frozen diffs live on the row). tryGetInstance is boot-safe.
  const pairwiseWorker = PairwiseJudgeWorker.tryGetInstance();
  if (pairwiseWorker) {
    console.log('[Main] Stopping pairwise judge worker...');
    await pairwiseWorker.stop();
    console.log('[Main] Pairwise judge worker stopped');
  }

  // Cleanup all sessions and terminate child processes. Deliberately AFTER the
  // queue drain above: cleanup() settles no run-executor task (it stops the
  // project run script and the terminal-panel PTYs), so running it first buys
  // the drain nothing and its per-pty exit grace polls eat the 10s quit ceiling
  // in services/quitDrain.ts ahead of the database flush.
  if (sessionManager) {
    console.log('[Main] Cleaning up sessions and terminating child processes...');
    await sessionManager.cleanup();
    console.log('[Main] Session cleanup complete');
  }

  // Stop all run commands
  if (runCommandManager) {
    console.log('[Main] Stopping all run commands...');
    await runCommandManager.stopAllRunCommands();
    console.log('[Main] Run commands stopped');
  }
  
  // Stop git status polling
  if (gitStatusManager) {
    console.log('[Main] Stopping git status polling...');
    gitStatusManager.stopPolling();
    console.log('[Main] Git status polling stopped');
  }

  // Shutdown CLI manager factory and all CLI processes
  if (cliManagerFactory) {
    console.log('[Main] Shutting down CLI manager factory and all CLI processes...');
    await cliManagerFactory.shutdown();
    console.log('[Main] CLI manager factory shutdown complete');
  }

  // Tear down all run user-shells (and any dev servers they launched) so none
  // orphan on quit. RunShellManager is independent of the CLI factory above.
  if (runShellManager) {
    console.log('[Main] Destroying all run user-shells...');
    runShellManager.destroyAll();
    console.log('[Main] Run user-shells destroyed');
  }

  // Kill the PTY behind every open terminal tool panel. This is a THIRD
  // independent pty owner (alongside the CLI factory and RunShellManager), and
  // until now nothing called its teardown at all: destroyTerminal ran on panel
  // delete, destroyAllTerminals had no caller, so any terminal panel still open
  // at quit kept a live pty — and a live node-pty onData callback — straight
  // through Node's environment disposal. That is the shape of the fatal abort in
  // CYBOFLOW-APP-12 (a napi ThreadSafeFunction callback firing under
  // node::FreeEnvironment). Synchronous and internally fail-soft.
  console.log('[Main] Destroying all terminal panels...');
  terminalPanelManager.destroyAllTerminals();
  console.log('[Main] Terminal panels destroyed');

  // TASK-057: SIGTERM any detached ui-prototype http.server still serving under
  // this instance's artifacts/runs root, so quitting leaves zero prototype
  // servers. Awaited (the sweep only sends signals — it does not wait for exit)
  // and internally fail-soft, so a `ps` failure never blocks quit.
  console.log('[Main] Sweeping leaked ui-prototype servers...');
  await prototypeServerReaper.sweepOrphans(getCyboflowSubdirectory('artifacts', 'runs'));
  console.log('[Main] Prototype-server sweep complete');

  // Design Mode v1: tear down every in-process interactive prototype server (and
  // stop its watchdog). In-process node servers, so this fully releases their
  // ports on quit. Internally fail-soft; awaited so ports free before exit.
  if (designPrototypeServerManager) {
    console.log('[Main] Stopping design prototype servers...');
    await designPrototypeServerManager.stopAll();
    console.log('[Main] Design prototype servers stopped');
  }
  if (customWidgetServerManager) {
    console.log('[Main] Stopping custom widget server...');
    await customWidgetServerManager.stop();
    console.log('[Main] Custom widget server stopped');
  }

  // Close task queue
  if (taskQueue) {
    await taskQueue.close();
  }

  // Flush any buffered dev-mode debug log lines so pending writes land before
  // exit (dev-only; a no-op that resolves immediately in production, where the
  // dev-log writer is never fed). See utils/devDebugLog.ts (F16).
  await flushDevDebugLogs();

  // Close logger to ensure all logs are flushed
  if (logger) {
    logger.close();
  }
}

/**
 * Quit passes. `draining` holds the quit open while drainOnQuit runs; `drained`
 * lets the re-issued quit straight through, so the normal `will-quit` → `quit`
 * sequence still fires (that is where the dock badge is cleared) rather than
 * being skipped by a hard `app.exit`.
 */
let quitDrainState: 'idle' | 'draining' | 'drained' = 'idle';

app.on('before-quit', (event) => {
  // Second pass: the teardown has already run to completion (or to its
  // deadline) and re-issued the quit. Nothing is left to hold it for.
  if (quitDrainState === 'drained') return;

  // A quit arriving while the teardown is mid-flight (an impatient second
  // Cmd-Q): keep holding it, but do not start a second drain over the same
  // services — and do not re-run the flush or re-raise the archive dialog
  // below, both of which the first pass already settled.
  if (quitDrainState === 'draining') {
    event.preventDefault();
    return;
  }

  // Drain the debounced provider-usage write before anything can preventDefault
  // or tear the DB down — a trailing 2s debounce is otherwise lost on quit.
  try {
    tryGetProviderUsageStore()?.flush();
  } catch (error) {
    console.warn('[Main] providerUsage flush on quit failed:', error);
  }

  // A `claude auth login` parked on its code prompt would outlive the app.
  try {
    claudeAuthOps?.dispose();
  } catch (error) {
    console.warn('[Main] claude sign-in dispose on quit failed:', error);
  }

  // Check if there are active archive tasks
  if (archiveProgressManager && archiveProgressManager.hasActiveTasks()) {
    event.preventDefault();
    
    console.log('[Main] Archive tasks in progress, showing warning dialog...');
    const activeCount = archiveProgressManager.getActiveTaskCount();
    const choice = mainWindow 
      ? dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Cyboflow is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        })
      : dialog.showMessageBoxSync({
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Cyboflow is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        });
    
    if (choice === 1) {
      // User chose to quit anyway. app.exit() skips the window 'close' event,
      // so flush the geometry explicitly or the last ≤500ms of resize is lost.
      archiveProgressManager.clearAll();
      windowStatePersistence?.flush();
      app.exit(0);
    }
    // Otherwise, the quit is cancelled and app continues
    return;
  }

  // This listener body must stay SYNCHRONOUS up to here. preventDefault is the
  // only thing that keeps the app alive past this tick, and Electron ignores a
  // promise returned from a before-quit listener entirely.
  event.preventDefault();
  quitDrainState = 'draining';
  void runQuitDrain({
    drain: drainOnQuit,
    finish: () => {
      quitDrainState = 'drained';
      app.quit();
    },
    // console, not `logger` — the teardown closes the logger as its last step.
    logger: {
      info: (message) => console.log(message),
      warn: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
    },
  });
});

// Export getter function for mainWindow
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
