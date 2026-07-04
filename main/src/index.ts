import { app, BrowserWindow, ipcMain, shell, dialog, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { TaskQueue } from './services/taskQueue';
import { SessionManager } from './services/sessionManager';
import { ConfigManager, readTelemetryConfigSync } from './services/configManager';
import { WorktreeManager } from './services/worktreeManager';
import { GitDiffManager } from './services/gitDiffManager';
import { GitStatusManager } from './services/gitStatusManager';
import { ExecutionTracker } from './services/executionTracker';
import { ModelAvailabilityService } from './services/modelAvailabilityService';
import { DatabaseService } from './database/database';
import { RunCommandManager } from './services/runCommandManager';
import { Logger } from './utils/logger';
import { ArchiveProgressManager } from './services/archiveProgressManager';
import { initializeCommitManager } from './services/commitManager';
import { setCyboflowDirectory, getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import { initTelemetry, trackUsage } from './services/telemetry';
import { setTelemetrySink } from './orchestrator/telemetrySink';
import { getCurrentWorktreeName } from './utils/worktreeUtils';
import { registerIpcHandlers } from './ipc';
import { registerArtifactImageHandlers } from './ipc/artifactImages';
import { setupEventListeners } from './events';
import { AppServices } from './ipc/types';
import { CliManagerFactory } from './services/cliManagerFactory';
import { AbstractCliManager } from './services/panels/cli/AbstractCliManager';
import { ClaudeCodeManager } from './services/panels/claude/claudeCodeManager';
import { InteractiveClaudeManager } from './services/panels/claude/interactiveClaudeManager';
import { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import { setupConsoleWrapper } from './utils/consoleWrapper';
import { Orchestrator } from './orchestrator/Orchestrator';
import { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import { ApprovalRouter } from './orchestrator/approvalRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { ReviewItemRouter, reviewItemChangeEvents, reviewItemProjectChannel } from './orchestrator/reviewItemRouter';
import { AgentOverrideRouter } from './orchestrator/agentOverrideRouter';
import { ArtifactRouter } from './orchestrator/artifactRouter';
import { setRunArtifactsDirResolver } from './orchestrator/autoMintArtifacts';
import { resolveArtifactCommitDir } from './orchestrator/artifactSnapshot';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { DefaultProgrammaticRunner } from './orchestrator/programmatic/defaultProgrammaticRunner';
import { ReviewQueueHumanGate } from './orchestrator/programmatic/humanGate';
import { ReviewQueueBlockingItemsGate } from './orchestrator/programmatic/blockingItemsGate';
import { ReviewQueueSystemicPauseGate } from './orchestrator/programmatic/systemicPauseGate';
import {
  DefaultMonitorSession,
  DefaultHistoryReader,
  MonitorRegistry,
  type MonitorActionResult,
  type MonitorContext,
  type MonitorSession,
} from './orchestrator/programmatic/monitor';
import { retryRunHandler, type RetryRunDeps } from './orchestrator/retryRunHandler';
import { makeSdkStructuredQuery, makeSdkTextQuery } from './orchestrator/programmatic/monitorQuery';
import { StepResultStore } from './orchestrator/stepResultStore';
import { DynamicWorkflowTracker } from './orchestrator/dynamicWorkflows';
import { dockBadgeService } from './services/dockBadgeService';
import { appRouter } from './orchestrator/trpc/router';
import { createContext } from './orchestrator/trpc/context';
import { attachOrchestratorTrpc } from './orchestrator/trpc/ipcAdapter';
import { setCancelAndRestartDeps, setCancelRunDeps, setPauseRunDeps, setResumeRunDeps, setReopenRunDeps, setRetryRunDeps, setStartRunDeps, setRunCloseoutDeps, setNudgeRunDeps, setQueueInputDeps, setRelayDeps, setRunShellDeps, setSprintLaneDeps, setSetPermissionModeDeps } from './orchestrator/trpc/routers/runs';
import type { SessionAgentPermissionModeDeps } from './orchestrator/sessionPermissionMode';
import { nudgeRunHandler } from './orchestrator/nudgeRunHandler';
import { RunShellManager } from './services/runShellManager';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { SprintLaneStore } from './orchestrator/sprintLaneStore';
import { setHealthProvider } from './orchestrator/trpc/routers/health';
import {
  setReviewItemsRunProbe,
  resumeWouldStrandEndedWalk,
} from './orchestrator/trpc/routers/reviewItems';
import { setMonitorRehydrator } from './orchestrator/trpc/routers/monitor';
import { createMonitorRehydrator } from './orchestrator/programmatic/monitorRehydration';
import { resolveReviewItem as resolveReviewItemCore } from './orchestrator/resolveReviewItemHandler';
import {
  addTaskToRun,
  removeTaskFromRun,
  editRunTask,
  type TaskMutationDeps,
  type TaskMutationResult,
  type TaskMutationNoOpReason,
} from './orchestrator/taskMutationHandler';
import { resolveWorkflowDefinition } from '../../shared/types/workflows';
import { handoverRunHandler, type HandoverRunDeps } from './orchestrator/handoverRunHandler';
import { OrchestratorHealth } from './orchestrator/health';
import { McpServerLifecycle } from './orchestrator/mcpServer/mcpServerLifecycle';
import { resolveMcpServerScriptPath } from './orchestrator/mcpServer/scriptPath';
import { OrchSocketServer } from './orchestrator/mcpServer/orchSocketServer';
import { approvalEvents, questionEvents, runStatusEvents, stepTransitionEvents } from './orchestrator/trpc/routers/events';
import { EvalWorker } from './orchestrator/eval/evalWorker';
import { ClaudeJudge } from './orchestrator/eval/evalJury';
import { makeEvalJudgeQuery } from './orchestrator/eval/evalJudgeQuery';
import type { WorkflowStepTransitionEvent } from '../../shared/types/workflows';
import type { RunGitDiff } from '../../shared/types/runFiles';
import type { RunStatusChangedEvent } from '../../shared/types/cyboflow';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../shared/types/cyboflow';
import { cancelRunHandler } from './orchestrator/cancelRunHandler';
import type { ApprovalRequest } from './orchestrator/approvalRouter';
import type { QuestionRequest } from './orchestrator/questionRouter';
import type { ApprovalDecidedEvent } from '../../shared/types/approvals';
import type { QuestionAnsweredEvent } from '../../shared/types/questions';
import type { ClaudeStreamEvent } from '../../shared/types/claudeStream';
import type { DatabaseLike } from './orchestrator/types';
import { buildApprovalCreatedEvent } from './orchestrator/approvalCreatedBridge';
import { buildQuestionCreatedEvent } from './orchestrator/questionCreatedBridge';
import { WorkflowRegistry } from './orchestrator/workflowRegistry';
import { makeChatSentinelProvider } from './orchestrator/chatSentinelProvider';
import { RunLauncher } from './orchestrator/runLauncher';
import type { StreamEventPublisher, OrchSocketProvider, BridgeScriptResolver, NodeResolver } from './orchestrator/runLauncher';
import { VariantResolver } from './orchestrator/variantResolver';
import { McpConfigWriter } from './orchestrator/mcpConfigWriter';
import { RunExecutor } from './orchestrator/runExecutor';
import type { LifecycleTransitionsLike, StepTransitionEmitterLike, IdeaBodyReaderLike, FindingReaderLike, WorkflowPromptReaderLike } from './orchestrator/runExecutor';
import { buildSeedTasksBlock } from './orchestrator/seedTasksBlock';
import { selectTaskById, selectIdeaAttachments } from './orchestrator/taskListing';
import { selectFindingForSeed } from './orchestrator/reviewItemListing';
import { buildStepTransitionEvent, resolveInitialStepId } from './orchestrator/stepTransitionBridge';
import {
  transitionToRunning,
  transitionRunningToAwaitingReview,
  transitionToFailed,
  transitionToCanceled,
} from './services/cyboflow/transitions';
import { readWorkflowPromptForRow } from './orchestrator/workflowPromptReaderAdapter';
import { makeLoggerLike, makeDatabaseLike } from './orchestrator/loggerAdapter';
import { recoverActiveStateOrphans, recoverArchivedSessionRunOrphans, backfillTerminalOutcomes } from './orchestrator/runRecovery';
import * as fs from 'fs';
import { getDevDebugLogPath, appendDevDebugLog, formatConsoleArgs } from './utils/devDebugLog';
import type { DevLogLevel } from './utils/devDebugLog';
import { getBootDatabasePath, getDemoBootEnvironment, getDemoBootError } from './services/demo/demoBootstrap';

export let mainWindow: BrowserWindow | null = null;

// Set by the boot-time schema-version gate when the user picked "Check for
// Updates" on a database that a newer build advanced. Consumed once by the
// renderer (Sidebar) on mount to auto-open Settings → Updates.
let pendingOpenUpdateSettings = false;

/**
 * Set the application title based on development mode and worktree
 */
function setAppTitle() {
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
let runQueues: RunQueueRegistry;
let workflowRegistry: WorkflowRegistry;
let runLauncher: RunLauncher;
// Module-scoped so the tRPC boot wiring block (setNudgeRunDeps) can reach the
// same RunExecutor instance built in initializeServices().
let runExecutor: RunExecutor;
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
// Monitor-actuation seam (the 8 NON-STOPPING steering actions: add/remove/edit
// task, skip/unskip/steer step, resolve review item, file note). Same
// late-binding pattern as the two above — bound in the tRPC dep-wiring block
// where db / runExecutor / the routers are all live. Grouped into one holder
// object (rather than 8 separate module vars) since they share a wiring site.
// Null until wired → each action reports "not available yet" instead of acting.
interface MonitorSteeringActions {
  addTask(runId: string, input: { title: string; body?: string; priority?: string }): Promise<MonitorActionResult>;
  removeTask(runId: string, input: { taskRef: string }): Promise<MonitorActionResult>;
  editTask(
    runId: string,
    input: { taskRef: string; title?: string; body?: string; priority?: string },
  ): Promise<MonitorActionResult>;
  skipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  unskipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  steerStep(runId: string, input: { stepId: string; guidance: string }): Promise<MonitorActionResult>;
  resolveReviewItem(
    runId: string,
    input: { reviewItemId: string; outcome?: 'approve' | 'reject'; resolution?: string },
  ): Promise<MonitorActionResult>;
  fileNote(runId: string, input: { title: string; body?: string }): Promise<MonitorActionResult>;
}
let monitorSteeringActions: MonitorSteeringActions | null = null;
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
// Session Dismiss → cancel hosted runs. Declared at module scope because the
// services bag (initializeServices) defers to it while the REAL implementation
// is assigned in app.whenReady()'s orchestrator wiring block (it needs
// substrateFacade + the routers). A pre-boot call is a logged no-op.
let cancelHostedRunsImpl: ((sessionId: string) => Promise<void>) | null = null;

// Service instances
let configManager: ConfigManager;
let logger: Logger;
let sessionManager: SessionManager;
let worktreeManager: WorktreeManager;
let cliManagerFactory: CliManagerFactory;
let defaultCliManager: AbstractCliManager;
let gitDiffManager: GitDiffManager;
let gitStatusManager: GitStatusManager;
let executionTracker: ExecutionTracker;
let databaseService: DatabaseService;
let runCommandManager: RunCommandManager;
let archiveProgressManager: ArchiveProgressManager;
// Run user-shells (worktree-terminal feature). Module-level so the before-quit
// handler (outside the orchestrator-setup block) can destroyAll() on app quit.
let runShellManager: RunShellManager | null = null;

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required: preload uses require('trpc-electron/main') which the sandboxed
      // preload loader rejects (only 'electron' and relative paths resolve there).
      sandbox: false,
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 10 }
    } : {})
  });

  // Increase max listeners to prevent warning when many panels are active
  // Each panel can register multiple event listeners
  mainWindow.webContents.setMaxListeners(100);

  if (isDevelopment) {
    await mainWindow.loadURL('http://localhost:4521');
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
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

    // Forward to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
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

      if (mainWindow && !mainWindow.isDestroyed()) {
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

    if (mainWindow && !mainWindow.isDestroyed()) {
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

    if (mainWindow && !mainWindow.isDestroyed()) {
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

    if (mainWindow && !mainWindow.isDestroyed()) {
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

async function initializeServices() {
  configManager = new ConfigManager();
  await configManager.initialize();

  // NOTE: telemetry is initialized BEFORE app 'ready' (see the initTelemetry call
  // ahead of app.whenReady() below), because the Aptabase SDK disables itself if
  // initialized post-ready. Here we only register the usage sink so orchestrator
  // code (which can't import services/*) can emit events via emitUsage() — see
  // orchestrator/telemetrySink.ts.
  setTelemetrySink(trackUsage);

  // Initialize logger early so it can capture all logs
  logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.cyboflow/logs');
  
  // Initialize commitManager with configManager
  initializeCommitManager(configManager, logger);

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
  databaseService.initialize();

  sessionManager = new SessionManager(databaseService);
  sessionManager.initializeFromDatabase();

  archiveProgressManager = new ArchiveProgressManager();

  // Create worktree manager
  worktreeManager = new WorktreeManager(configManager);

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

  // Sprint-lane write chokepoint (feat/parallel-sprint, migrations 022 + 023).
  // The single serialized writer for `sprint_batches`/`sprint_batch_tasks`;
  // injected (structurally, as narrow slices) into RunLauncher (createForRun at
  // sprint launch), RunExecutor (lane task ids for the `# Sprint tasks` prompt
  // block), and the runs-router lane dep-bag below. The cyboflow_update_sprint_task
  // MCP handler reaches it via getInstance(). Logger is REQUIRED here (CLAUDE.md
  // optional-logger rule) — omitting it silently no-ops all lane diagnostics.
  const sprintLaneStore = SprintLaneStore.initialize(cyboflowDb, cyboflowLogger);

  // Unified review-inbox write chokepoint (migration 016 / P3) + the human-gate
  // run-pause manager (P4). ReviewItemRouter is the single serialized writer for
  // `review_items`; the reviewItems tRPC router + the report-finding MCP handler
  // reach it via getInstance(). HumanStepManager owns the human=true step gate:
  // it opens a blocking decision review_item (pausing the run) and applies
  // aggregate-unblock auto-resume when the run's last blocking item resolves.
  ReviewItemRouter.initialize(cyboflowDb);
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
  ArtifactRouter.initialize(cyboflowDb, cyboflowLogger, (projectId: number) => {
    try {
      const project = databaseService.getProject(projectId);
      if (!project?.path) return null;
      return resolveArtifactCommitDir(project.path, configManager.getArtifactCommitDir());
    } catch {
      return null;
    }
  });

  // Inject the run-artifacts-dir resolver the screenshots auto-mint scan reads —
  // CYBOFLOW_DIR/artifacts/runs/<runId>, the SAME subtree artifacts:load-images
  // serves bytes from and the agent writes into via $CYBOFLOW_RUN_ARTIFACTS_DIR.
  // Kept as a closure here (the only layer allowed to import the electron-backed
  // cyboflowDirectory util) so autoMintArtifacts stays free of electron imports
  // (standalone-typecheck invariant). Mirrors the ArtifactRouter boot wiring above.
  setRunArtifactsDirResolver((runId: string) => getCyboflowSubdirectory('artifacts', 'runs', runId));

  // Passive dynamic-workflow tracker (Workflow tool / ultracode detection).
  // The CLI managers attach it to each run's EventRouter pipeline via
  // tryGetInstance(); it creates completion review items through
  // ReviewItemRouter.getInstance(), so it MUST initialize after the router.
  DynamicWorkflowTracker.initialize(cyboflowDb, { logger: cyboflowLogger });

  // Code-review eval worker (migration 043). Grades a built-in run's frozen
  // pre-human diff against the 7-dimension rubric with a K-sample Claude jury and
  // writes net-new findings through ReviewItemRouter — so it MUST initialize after
  // the router (mirrors DynamicWorkflowTracker above). Electron-touching deps are
  // injected as closures (GitDiffManager, the SDK judge-query, the findings
  // chokepoint) so the worker itself imports no concrete service.
  //
  // gitDiff closure narrows GitDiffResult to the RunGitDiff wire shape and swallows
  // capture errors to null (the snapshot fails-soft on a null diff) — same closure
  // shape as the runs-router tRPC context (index.ts createContext), kept separate so
  // it can fail-soft rather than throw.
  const evalGitDiff = async (
    worktreePath: string,
    baseRef?: string,
  ): Promise<RunGitDiff | null> => {
    try {
      const result = baseRef
        ? await gitDiffManager.captureDiffAgainstRef(worktreePath, baseRef)
        : await gitDiffManager.captureWorkingDirectoryDiff(worktreePath);
      return { diff: result.diff, stats: result.stats, changedFiles: result.changedFiles };
    } catch (err) {
      cyboflowLogger?.warn?.(
        `[eval] gitDiff closure failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  EvalWorker.initialize(cyboflowDb, cyboflowLogger, {
    gitDiff: evalGitDiff,
    judge: new ClaudeJudge({
      structuredQuery: makeEvalJudgeQuery(cyboflowLogger),
      logger: cyboflowLogger,
    }),
    reviewItemWriter: (projectId, change) =>
      ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
    appVersion: app.getVersion(),
    // GLOBAL code-review-eval toggle (default ON) — read fresh per trigger so a
    // Settings change takes effect without relaunch. A per-run override
    // (workflow_runs.eval_enabled) outranks this; the snapshot consults it only
    // when the per-run value is NULL. Closure keeps the eval module free of any
    // concrete-service import (standalone-typecheck invariant).
    isEvalEnabled: () => configManager.getCodeReviewEvalEnabled(),
  });
  // Crash-safe resume: re-enqueue any eval an app quit left 'pending'/'running'
  // (the frozen diff lives in the row, so a re-grade is self-contained) — otherwise
  // the summary panel polls a perpetual 'running'.
  EvalWorker.getInstance().recoverInterrupted();

  // Trigger seam (zero-touch): subscribe to the SHARED step-transition emitter and
  // snapshot on the sprint-review => human-review boundary. The flow prompts report
  // each step as it BEGINS (status='running'), so "human-review begins" is
  // observable EXACTLY ONCE as stepId==='human-review' && status==='running'. Only
  // sprint + ship carry that step; the snapshot re-checks isCyboflowWorkflowName so
  // custom flows with a same-named step default OFF. Fire-and-forget +
  // error-swallowed inside snapshot() — this can never affect the run.
  stepTransitionEvents.on('transition', (event: WorkflowStepTransitionEvent) => {
    if (event.stepId === 'human-review' && event.status === 'running') {
      void EvalWorker.getInstance().snapshot(event.runId);
    }
  });

  // Guarded-model availability (Fable 5). Seeds the guarded set as optimistically
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

  // OrchSocketServer — the orchestrator-side half of the Cyboflow MCP IPC link.
  // Stands up the Unix-domain socket under ~/.cyboflow/sockets/orch.sock that the
  // spawned cyboflowMcpServer subprocess(es) connect back to so the cyboflow_*
  // tools are routable.  Started here (before the RunLauncher block) so its
  // socket path is available to the providers, the McpServerLifecycle, and the
  // CLI manager below.  `cyboflowDb`/`cyboflowLogger` are already in scope above.
  const orchSocketServer = new OrchSocketServer(
    getCyboflowSubdirectory('sockets', 'orch.sock'),
    cyboflowDb,
    cyboflowLogger,
  );
  void orchSocketServer.start().catch((err) => {
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
  const promptReader: WorkflowPromptReaderLike = {
    read: readWorkflowPromptForRow,
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
  // cyboflowLogger is PASSED (CLAUDE.md optional-logger rule).
  // Assign the module-level binding (declared near the other shared services) so
  // the run dep-bag wiring in app.whenReady() can reach the SAME facade instance
  // for the live-input relay (IDEA-030 / TASK-817).
  substrateFacade = new SubstrateDispatchFacade(
    defaultCliManager,
    interactiveCliManager,
    workflowRegistry,
    cyboflowLogger,
  );

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
  // resolveInitialStepId() while keeping RunExecutor free of bridge imports.
  // If resolveInitialStepId returns null (unknown workflow name), no DB write
  // and no emit occurs.
  const stepTransitionEmitter: StepTransitionEmitterLike = {
    emit: (runId: string, status: 'pending' | 'running' | 'done') => {
      // Resolve the workflow name to get the step id.
      const runRow = rawDb.prepare(
        `SELECT w.name AS workflowName
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE r.id = ?`,
      ).get(runId) as { workflowName: string } | undefined;
      if (!runRow) return;
      const stepId = resolveInitialStepId(runRow.workflowName);
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
    reporter: {
      report: (runId, stepId, status) =>
        void buildStepTransitionEvent(runId, stepId, status, cyboflowDb, cyboflowLogger),
    },
    gate: new ReviewQueueHumanGate(
      HumanStepManager.getInstance(),
      reviewItemChangeEvents,
      reviewItemProjectChannel,
      cyboflowLogger,
    ),
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
    // Systemic-pause gate (the 2026-07-06 planner incident): a step failing with
    // a usage/session/rate-limit-class error PARKS the run behind a blocking
    // 'decision' item ("resolve to retry now, dismiss to give up") and
    // auto-resumes at the parsed limit-reset time, instead of burning the step's
    // retry / optional-skip / triage budgets on a condition no retry can fix.
    // Item writes ride the ReviewItemRouter chokepoint (orchestrator actor);
    // park/resume rides the SAME HumanStepManager primitives as the blocking
    // gate, so a systemic pause participates in aggregate-unblock.
    systemicGate: new ReviewQueueSystemicPauseGate({
      items: {
        findPending: (runId, source) =>
          HumanStepManager.getInstance().findPendingItemBySource(runId, source),
        create: async ({ runId, projectId, title, body, source }) => {
          const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(
            projectId,
            {
              op: 'create',
              actor: 'orchestrator',
              kind: 'decision',
              title,
              body,
              blocking: true,
              source,
              runId,
            },
          );
          return reviewItemId;
        },
        resolve: async ({ projectId, reviewItemId, resolution }) => {
          await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
            op: 'resolve',
            actor: 'orchestrator',
            reviewItemId,
            resolution,
          });
        },
        dismiss: async ({ projectId, reviewItemId, resolution }) => {
          await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
            op: 'dismiss',
            actor: 'orchestrator',
            reviewItemId,
            resolution,
          });
        },
      },
      parker: HumanStepManager.getInstance(),
      events: reviewItemChangeEvents,
      channelFor: reviewItemProjectChannel,
      logger: cyboflowLogger,
    }),
    // ON-DEMAND monitor (the monitor-unify refactor): the single triage + chat
    // human-seam plane that folds the old Stage 3 supervisor + supervisor-chat
    // planes into one token-frugal `MonitorSession` rendering in the run's existing
    // Chat pane. ALWAYS ON for programmatic runs (the supervisor-role redesign,
    // 2026-07-05 — the old `programmaticSupervisor` opt-in config is gone): the
    // supervisor is a Q&A partner the human can query at ANY point in the run, and
    // escalations surface in BOTH the chat and the human review queue rather than
    // routing to one or the other. A `DefaultMonitorSession` over the real
    // on-demand query fns (monitorQuery.ts) + a HistoryReader bound to cyboflowDb.
    // The session reads the WHOLE run history ONLY when it must act (triage a
    // failure / answer a human chat turn); it consumes zero tokens during routine
    // progress. The run's `injectEvent` (threaded as the 2nd factory arg from the
    // run context, Slice B) is owned by the session so its `converse` renders the
    // human turn + the monitor's reply into the run's Chat pane (the tRPC
    // `monitor.send` seam). The runner registers the session in MonitorRegistry so
    // the router reaches it. NOT headlessly verifiable — it makes a real Claude
    // call (monitorQuery.ts).
    monitorFactory: ((): ((
      ctx: MonitorContext,
      injectEvent: (event: ClaudeStreamEvent) => void,
    ) => MonitorSession | undefined) => {
      const structuredQuery = makeSdkStructuredQuery(cyboflowLogger);
      const textQuery = makeSdkTextQuery(cyboflowLogger);
      const history = new DefaultHistoryReader(cyboflowDb, cyboflowLogger);
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
            // The 8 non-stopping steering actions, all delegating to the single
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
                // Crash-safe resume: skip lanes already settled (integrated/failed)
                // so a re-entered fanOut step does not re-run completed work or flip
                // a failed lane back to integrated — mirrors the monotonic-forward
                // guard in deriveLaneFromTaskDispatch. On a fresh run all lanes are
                // 'queued', so every task is returned.
                .filter((lane) => lane.status !== 'integrated' && lane.status !== 'failed')
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
        driveLane: ({ runId: rid, itemId, status, currentStepId, allowedStepIds }) => {
          try {
            sprintLaneStore.updateLane({
              runId: rid,
              batchId,
              taskId: itemId,
              allowedStepIds,
              ...(status !== undefined ? { status } : {}),
              ...(currentStepId !== undefined ? { currentStepId } : {}),
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
      }),
    logger: cyboflowLogger,
  });

  // Selected-finding reader (migration 034): resolves a compound run's
  // seed_finding_ids to each finding's content via selectFindingForSeed (which
  // already SELECTs only kind='finding' rows and lifts proposedTarget /
  // suggestedFix / locations from payload_json). Injected as the trailing
  // RunExecutor arg so getPrompt can prepend a `# Selected findings` block, and
  // so the terminal-seam close-out can read seeded-finding status. Reads through
  // the narrow DatabaseLike adapter (cyboflowDb) — the same handle the review
  // routers use. Returns null when the row is missing or not a finding.
  const findingReader: FindingReaderLike = {
    read: (id) => {
      const finding = selectFindingForSeed(cyboflowDb, id);
      return finding
        ? {
            id: finding.id,
            title: finding.title,
            body: finding.body,
            severity: finding.severity,
            priority: finding.priority,
            proposedTarget: finding.proposedTarget,
            source: finding.source,
            suggestedFix: finding.suggestedFix,
            locations: finding.locations,
          }
        : null;
    },
  };

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
  );

  // Raw-PTY byte path (TASK-814 / IDEA-030): subscribe the facade's 'pty-output'
  // fan-in (interactive substrate only) to the ptyPublisher, forwarding VERBATIM
  // chunks to the renderer on cyboflow:pty:<runId>. The payload is opaque
  // `unknown` on the facade EventEmitter, so narrow it through a typed local
  // shape (NO `any`). This deliberately bypasses runEventBridge — the bytes are
  // ephemeral live-view only and are never persisted to raw_events.
  substrateFacade.on('pty-output', (payload) => {
    const evt = payload as { runId: string; data: string };
    ptyPublisher(evt.runId, evt.data);
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
    // A/B testing (migration 046): the rotation resolver. launch() resolves the
    // variant (explicit pin or weighted random over active variants) pre-createRun
    // so every launch surface inherits rotation from one place.
    new VariantResolver(cyboflowDb),
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

  // OrchestratorHealth — constructed with the real McpServerLifecycle so both the
  // raw-IPC cyboflow:mcp-health channel and the tRPC cyboflow.health.mcpServer
  // procedure read live status (off the old hard-coded 'starting' fallback).
  // McpServerLifecycle structurally satisfies McpLifecycleReadable, so no adapter
  // is needed.
  orchestratorHealth = new OrchestratorHealth(mcpServerLifecycle);

  // Start the MCP server subprocess fire-and-forget; on failure record the error
  // on the health surface (callable now that orchestratorHealth exists) and log it.
  void mcpServerLifecycle.start().catch((err) => {
    orchestratorHealth.setMcpError(err instanceof Error ? err.message : String(err));
    cyboflowLogger.error(`[Cyboflow MCP] lifecycle start failed: ${String(err)}`);
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
    // Live-REPL close-out seams for PTY quick sessions (IDEA-030): route the
    // session merge/rebase/dismiss handlers through the SubstrateDispatchFacade
    // so a quick session's persistent interactive REPL is gracefully ended
    // (EOF/`/exit`) or hard-killed instead of orphaned. Mirrors the RelayDeps
    // closures wired in app.whenReady(); the facade translates the sentinel
    // runId to the live panelId and strictly NO-OPs for the SDK substrate.
    endLiveSession: (runId: string) => substrateFacade.endSession(runId),
    killLiveSession: (runId: string) => substrateFacade.killSession(runId),
    // Deterministic at-spawn runId→panelId registration for PTY quick sessions:
    // seeds the facade's translation maps BEFORE the fire-and-forget startPanel
    // so a relay/close-out racing the first PTY byte never falls back to the
    // sentinel runId (the event-fed mapping only exists after the first
    // 'pty-output'/'turn-end').
    registerLivePanel: (runId: string, panelId: string) =>
      substrateFacade.registerInteractivePanel(runId, panelId),
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

  // Initialize IPC handlers first so managers (like ClaudePanelManager) are ready
  registerIpcHandlers(services);
  // FU4 — screenshots artifact gallery: serve on-disk PNGs from the run's
  // artifact image root (additive; mirrors the ideaAttachments handler).
  registerArtifactImageHandlers(ipcMain, services);
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
  
  // Start git status polling
  gitStatusManager.startPolling();
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
  console.log('[Main] App is ready, initializing services...');
  await initializeServices();

  // Schema-version gate: both packaged variants share ~/.cyboflow, so a newer
  // build (e.g. Cyboflow Dev) may have forward-migrated the DB past what this
  // binary understands. Warn before we build the UI on top of a schema this
  // binary may not fully grasp. (Always allow "Open Anyway" per product choice.)
  const schemaStatus = databaseService.getSchemaVersionStatus();
  if (schemaStatus?.tooNew) {
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
      return;
    }
    if (choice === 0) {
      pendingOpenUpdateSettings = true;
    }
    logger.info(`[Main] Continuing boot past schema-version gate (choice=${choice})`);
  }

  // One-shot pull (race-free vs a push): the renderer asks on mount whether the
  // boot gate wants Settings → Updates opened, and we clear the flag.
  ipcMain.handle('app:consume-open-update-settings', () => {
    const open = pendingOpenUpdateSettings;
    pendingOpenUpdateSettings = false;
    return open;
  });

  console.log('[Main] Services initialized, creating window...');
  await createWindow();
  console.log('[Main] Window created successfully');

  // Wire tRPC orchestrator after BrowserWindow is available
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
    orchestrator = new Orchestrator({ db, logger: loggerLike, runQueues });
    await orchestrator.start();
    if (!mainWindow) {
      throw new Error(
        'mainWindow is null after createWindow — cannot attach orchestrator tRPC bridge'
      );
    }
    attachOrchestratorTrpc({
      window: mainWindow,
      router: appRouter,
      createContext: () => createContext({
        db,
        setDockBadge: (count) => dockBadgeService.setBadgeCount(count),
        workflowRegistry,
        agentOverrideRouter: AgentOverrideRouter.getInstance(),
        getForcedSubstrate: () => configManager.getForcedSubstrate(),
        // Run-scoped Diff tab: closure over GitDiffManager keeps the standalone
        // runs router free of a services/* import. Narrow the GitDiffResult down
        // to the RunGitDiff wire shape (diff + stats + changedFiles).
        gitDiff: async (worktreePath: string, baseRef?: string) => {
          // With the run's base_sha, diff the working tree against it so commits
          // made since launch (e.g. sprint/ship merging task lanes) show too;
          // without it, fall back to the working-directory diff (vs HEAD).
          const result = baseRef
            ? await gitDiffManager.captureDiffAgainstRef(worktreePath, baseRef)
            : await gitDiffManager.captureWorkingDirectoryDiff(worktreePath);
          return { diff: result.diff, stats: result.stats, changedFiles: result.changedFiles };
        },
      }),
    });
    console.log('[Main] Orchestrator started and tRPC IPC handler attached');

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
    const staleQuestionsRecovered = QuestionRouter.getInstance().recoverStaleAwaitingInput();
    if (staleQuestionsRecovered > 0) {
      console.log(`[Main] Recovered ${staleQuestionsRecovered} stale awaiting_input run(s) on boot`);
    }

    // Boot recovery: any awaiting_review rows from a previous session have a dead socket.
    const recoveredCount = ApprovalRouter.getInstance().recoverStaleAwaitingReview();
    if (recoveredCount > 0) {
      console.log(`[Main] Recovered ${recoveredCount} stale awaiting_review run(s) on boot`);
    }

    // Boot recovery: any running/starting rows from a previous process have no live
    // executor — the SDK iterator and PTY are gone. Transition them to failed.
    const orphanRecovery = recoverActiveStateOrphans(db, runQueues);
    if (
      orphanRecovery.runningRecovered > 0 ||
      orphanRecovery.startingRecovered > 0 ||
      orphanRecovery.approvalsCanceled > 0
    ) {
      console.log(`[Main] Recovered active-state orphans (running: ${orphanRecovery.runningRecovered}, starting: ${orphanRecovery.startingRecovered}, approvals canceled: ${orphanRecovery.approvalsCanceled})`);
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

    // Boot recovery: runs orphaned by an archived (dismissed) session. Left
    // non-terminal (e.g. 'stuck' from before the dismiss-cascade existed) they
    // keep showing in the active-runs rail. Cancel them so the rail's
    // terminal-status filter hides them — self-healing for any dismiss that
    // failed to cancel a hosted run.
    const archivedOrphanRecovery = recoverArchivedSessionRunOrphans(db);
    if (archivedOrphanRecovery.runsCanceled > 0) {
      console.log(`[Main] Canceled ${archivedOrphanRecovery.runsCanceled} run(s) orphaned by archived sessions (approvals canceled: ${archivedOrphanRecovery.approvalsCanceled})`);
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
      claudeManagerStop: (sessionId: string) => defaultCliManager.stopPanel(sessionId),
      // F5: sweep the OLD run's pending drafts after it flips 'canceled'.
      deletePendingDraftsForRun,
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
    // (killSession is interactive-ONLY — a strict no-op for SDK — so it is the
    // wrong seam for a universal cancel.) Reuses the SAME `db`, `runQueues`,
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
      // Q1 GUARD: after a successful cancel, drop the run's PENDING draft entities
      // (epics + orphan tasks it created pre-approval) so a torn-down plan leaves
      // no orphans. Shares the single deletePendingDraftsForRun sweep defined at the
      // cancelAndRestart wiring above (self-gated on plan_approved_at IS NULL).
      deletePendingDraftsForRun,
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
    // silently stashing a directive the controller will never honor.
    const validateRunStep = (
      runId: string,
      stepId: string,
    ): { ok: true } | { ok: false; message: string } => {
      const row = db
        .prepare(
          `SELECT wr.execution_model AS executionModel, w.name AS workflowName, w.spec_json AS specJson
             FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id WHERE wr.id = ?`,
        )
        .get(runId) as
        | { executionModel: string | null; workflowName: string; specJson: string | null }
        | undefined;
      if (!row) return { ok: false, message: 'Run not found.' };
      if (row.executionModel !== 'programmatic')
        return { ok: false, message: 'Only programmatic runs support step control.' };
      const def = resolveWorkflowDefinition(row.workflowName, row.specJson);
      if (!def) return { ok: false, message: "This run's workflow definition could not be resolved." };
      const exists = def.phases.some((p) => p.steps.some((s) => s.id === stepId));
      if (!exists) return { ok: false, message: `Step '${stepId}' isn't part of this workflow.` };
      return { ok: true };
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
        runExecutor.setStepGuidance(runId, input.stepId, input.guidance);
        return {
          ok: true,
          message: `Added your guidance to step '${input.stepId}' — it'll be included when that step runs (no effect if it has already run).`,
        };
      },
      resolveReviewItem: async (runId, input) => {
        const projectId = runProjectId(runId);
        if (projectId === undefined) return { ok: false, message: 'Run not found.' };
        const result = await resolveReviewItemCore(
          {
            projectId,
            reviewItemId: input.reviewItemId,
            ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
            ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
          },
          {
            db,
            applyReviewItemResolve: (pid, resolveArgs) =>
              ReviewItemRouter.getInstance().applyReviewItem(pid, {
                op: 'resolve',
                actor: resolveArgs.actor,
                reviewItemId: resolveArgs.reviewItemId,
                ...(resolveArgs.resolution != null ? { resolution: resolveArgs.resolution } : {}),
              }),
            promotePendingDraftsForRun: (rid) =>
              QuestionRouter.getInstance().promotePendingDraftsForRun(rid),
            deleteRunCreatedEntities: (pid, rid) =>
              TaskChangeRouter.getInstance().deleteRunCreatedEntities(pid, rid),
            maybeResumeRun: (rid) => HumanStepManager.getInstance().maybeResumeRun(rid),
            wouldStrandEndedWalk: resumeWouldStrandEndedWalk,
            logger: loggerLike,
          },
        );
        if (result.ok) {
          const verb =
            result.outcome === 'reject'
              ? 'Rejected'
              : result.outcome === 'approve'
                ? 'Approved'
                : 'Resolved';
          return {
            ok: true,
            message: `${verb} the review item${result.resumed ? ' — the run is resuming.' : '.'}`,
          };
        }
        return { ok: false, message: result.message };
      },
      fileNote: async (runId, input) => {
        const projectId = runProjectId(runId);
        if (projectId === undefined) return { ok: false, message: 'Run not found.' };
        try {
          await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
            op: 'create',
            actor: 'orchestrator',
            kind: 'human_task',
            title: input.title,
            ...(input.body !== undefined ? { body: input.body } : {}),
            blocking: false,
            source: 'monitor',
            runId,
          });
          return { ok: true, message: `Filed a note in the review queue: '${input.title}'.` };
        } catch (err) {
          loggerLike.warn('[Main] monitor fileNote failed', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false, message: 'Could not file the note.' };
        }
      },
    };
    console.log('[Main] monitor steering actions wired');

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
    setNudgeRunDeps({
      db,
      runQueues,
      runExecutor,
      logger: loggerLike,
    });
    console.log('[Main] runs.nudge deps wired');

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
    // persistent interactive REPL — the close-out mutations (merge / createPr /
    // dismiss) call it BEFORE worktree removal so the live PTY's spawn promise
    // resolves. It rides the SAME RelayDeps bag (the single bag for live-session
    // collaborators) and routes through the facade, which NO-OPs for SDK.
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
      // Native task-tracking (migration 014): merge/createPr/dismiss stamp the
      // run's outcome and recompute the linked task's derived execution stage.
      // getInstance() resolves the singleton initialized during service construction.
      taskStageDeriver: TaskChangeRouter.getInstance(),
    });
    console.log('[Main] runs.merge/dismiss deps wired');

    setHealthProvider(orchestratorHealth);
    console.log('[Main] health.mcpServer deps wired');
  }

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

app.on('before-quit', async (event) => {
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
      // User chose to quit anyway
      archiveProgressManager.clearAll();
      app.exit(0);
    }
    // Otherwise, the quit is cancelled and app continues
    return;
  }
  
  // Stop orchestrator (drains run queues)
  if (orchestrator) {
    console.log('[Main] Stopping orchestrator...');
    await orchestrator.stop();
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

  // Cleanup all sessions and terminate child processes
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

  // Close task queue
  if (taskQueue) {
    await taskQueue.close();
  }

  // Close logger to ensure all logs are flushed
  if (logger) {
    logger.close();
  }
});

// Export getter function for mainWindow
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
