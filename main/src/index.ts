import { app, BrowserWindow, ipcMain, shell, dialog, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { TaskQueue } from './services/taskQueue';
import { SessionManager } from './services/sessionManager';
import { ConfigManager } from './services/configManager';
import { WorktreeManager } from './services/worktreeManager';
import { GitDiffManager } from './services/gitDiffManager';
import { GitStatusManager } from './services/gitStatusManager';
import { ExecutionTracker } from './services/executionTracker';
import { DatabaseService } from './database/database';
import { RunCommandManager } from './services/runCommandManager';
import { Logger } from './utils/logger';
import { ArchiveProgressManager } from './services/archiveProgressManager';
import { initializeCommitManager } from './services/commitManager';
import { setCyboflowDirectory, getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import { getCurrentWorktreeName } from './utils/worktreeUtils';
import { registerIpcHandlers } from './ipc';
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
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { DynamicWorkflowTracker } from './orchestrator/dynamicWorkflows';
import { dockBadgeService } from './services/dockBadgeService';
import { appRouter } from './orchestrator/trpc/router';
import { createContext } from './orchestrator/trpc/context';
import { attachOrchestratorTrpc } from './orchestrator/trpc/ipcAdapter';
import { setCancelAndRestartDeps, setCancelRunDeps, setPauseRunDeps, setResumeRunDeps, setStartRunDeps, setRunCloseoutDeps, setNudgeRunDeps, setRelayDeps, setSprintLaneDeps } from './orchestrator/trpc/routers/runs';
import { SprintLaneStore } from './orchestrator/sprintLaneStore';
import { setHealthProvider } from './orchestrator/trpc/routers/health';
import { OrchestratorHealth } from './orchestrator/health';
import { McpServerLifecycle } from './orchestrator/mcpServer/mcpServerLifecycle';
import { resolveMcpServerScriptPath } from './orchestrator/mcpServer/scriptPath';
import { OrchSocketServer } from './orchestrator/mcpServer/orchSocketServer';
import { approvalEvents, questionEvents, runStatusEvents } from './orchestrator/trpc/routers/events';
import type { RunStatusChangedEvent } from '../../shared/types/cyboflow';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../shared/types/cyboflow';
import { cancelRunHandler } from './orchestrator/cancelRunHandler';
import type { ApprovalRequest } from './orchestrator/approvalRouter';
import type { QuestionRequest } from './orchestrator/questionRouter';
import type { ApprovalDecidedEvent } from '../../shared/types/approvals';
import type { QuestionAnsweredEvent } from '../../shared/types/questions';
import type { DatabaseLike } from './orchestrator/types';
import { buildApprovalCreatedEvent } from './orchestrator/approvalCreatedBridge';
import { buildQuestionCreatedEvent } from './orchestrator/questionCreatedBridge';
import { WorkflowRegistry } from './orchestrator/workflowRegistry';
import { RunLauncher } from './orchestrator/runLauncher';
import type { StreamEventPublisher, OrchSocketProvider, BridgeScriptResolver, NodeResolver } from './orchestrator/runLauncher';
import { McpConfigWriter } from './orchestrator/mcpConfigWriter';
import { RunExecutor } from './orchestrator/runExecutor';
import type { LifecycleTransitionsLike, StepTransitionEmitterLike, IdeaBodyReaderLike } from './orchestrator/runExecutor';
import { selectTaskById } from './orchestrator/taskListing';
import { buildStepTransitionEvent, resolveInitialStepId } from './orchestrator/stepTransitionBridge';
import {
  transitionToRunning,
  transitionRunningToAwaitingReview,
  transitionToFailed,
  transitionToCanceled,
} from './services/cyboflow/transitions';
import { readWorkflowPrompt } from './orchestrator/workflowPromptReader';
import { buildStepReportingAppend } from './orchestrator/prompts/step-reporting-instructions';
import { resolveWorkflowDefinition } from '../../shared/types/workflows';
import { makeLoggerLike, makeDatabaseLike } from './orchestrator/loggerAdapter';
import { recoverActiveStateOrphans, recoverArchivedSessionRunOrphans, backfillTerminalOutcomes } from './orchestrator/runRecovery';
import * as fs from 'fs';
import { getDevDebugLogPath, appendDevDebugLog, formatConsoleArgs } from './utils/devDebugLog';
import type { DevLogLevel } from './utils/devDebugLog';

export let mainWindow: BrowserWindow | null = null;

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
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
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
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const levelName = levelNames[level] || 'unknown';
      const suffix = ` (${path.basename(sourceId)}:${line})`;
      appendDevDebugLog('frontend', levelName as DevLogLevel, 'FRONTEND', `${message}${suffix}`, { error: originalError });
    } else {
      // In production, only log errors and warnings from renderer
      if (level >= 2) { // 2 = warning, 3 = error
      }
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

  // Initialize logger early so it can capture all logs
  logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.cyboflow/logs');
  
  // Initialize commitManager with configManager
  initializeCommitManager(configManager, logger);

  // Use the same database path as the original backend
  const dbPath = configManager.getDatabasePath();
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
  HumanStepManager.initialize(cyboflowDb);

  // Passive dynamic-workflow tracker (Workflow tool / ultracode detection).
  // The CLI managers attach it to each run's EventRouter pipeline via
  // tryGetInstance(); it creates completion review items through
  // ReviewItemRouter.getInstance(), so it MUST initialize after the router.
  DynamicWorkflowTracker.initialize(cyboflowDb, { logger: cyboflowLogger });

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

  // Concrete WorkflowPromptReaderLike adapter — delegates to readWorkflowPrompt()
  // while keeping RunExecutor free of direct fs/concrete-module imports.
  //
  // TASK-803: on top of the `.md` body + its `system_prompt_append` frontmatter,
  // concatenate the per-run cyboflow step-reporting instructions. The adapter
  // resolves the workflow row by `workflow_path` (the only key RunExecutor.getPrompt
  // passes through the read-only WorkflowPromptReaderLike seam), then resolves the
  // EFFECTIVE definition via resolveWorkflowDefinition(name, spec_json) — honoring
  // user edits in spec_json, never WORKFLOW_DEFINITIONS[name] directly — and passes
  // the resolved def to buildStepReportingAppend. Fail-soft: an unresolved row or a
  // non-SoloFlow/broken-spec workflow yields '' so nothing extra is injected.
  const promptReader = {
    read: (workflowPath: string) => {
      const base = readWorkflowPrompt(workflowPath);
      const row = databaseService
        .getDb()
        .prepare('SELECT name, spec_json FROM workflows WHERE workflow_path = ? LIMIT 1')
        .get(workflowPath) as { name: string; spec_json: string } | undefined;
      if (!row) return base;
      const resolvedDef = resolveWorkflowDefinition(row.name, row.spec_json);
      const stepReportingAppend = buildStepReportingAppend(resolvedDef);
      if (stepReportingAppend === '') return base;
      const systemPromptAppend =
        base.systemPromptAppend.length > 0
          ? `${base.systemPromptAppend}\n\n${stepReportingAppend}`
          : stepReportingAppend;
      return { prompt: base.prompt, systemPromptAppend };
    },
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

  // Per-run PQueue registry. Shared with Orchestrator (for drain-on-shutdown)
  // and ApprovalRouter (for permission-decision dispatch). RunLauncher needs it
  // so `runLauncher.launch()` can enqueue `runExecutor.execute(runId)` — without
  // it, the run stays at `starting` forever.
  runQueues = new RunQueueRegistry();

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
  if (defaultCliManager instanceof ClaudeCodeManager) {
    defaultCliManager.setOrchSocketPath(socketPath);
  }
  if (interactiveCliManager instanceof InteractiveClaudeManager) {
    interactiveCliManager.setOrchSocketPath(socketPath);
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

app.whenReady().then(async () => {
  console.log('[Main] App is ready, initializing services...');
  await initializeServices();
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
      createContext: () => createContext({ db, setDockBadge: (count) => dockBadgeService.setBadgeCount(count), workflowRegistry }),
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
    setCancelAndRestartDeps({
      db,
      approvalRouter: ApprovalRouter.getInstance(),
      questionRouter: QuestionRouter.getInstance(),
      runQueues,
      claudeManagerStop: (sessionId: string) => defaultCliManager.stopPanel(sessionId),
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
      stopLiveRun: (runId: string) => substrateFacade.abort(runId),
      clearPendingApprovalsForRun: (runId: string) =>
        ApprovalRouter.getInstance().clearPendingForRun(runId),
      clearPendingQuestionsForRun: (runId: string) =>
        QuestionRouter.getInstance().clearPendingForRun(runId),
      emitRunStatusChanged: (runId: string, status: 'canceled') =>
        runStatusEvents.emit('changed', { runId, status }),
      // Batch close-out (single-run parallel sprint): cancelling a sprint batch
      // run flips its sprint_batches row terminal too, so the lane substrate
      // never strands non-terminal.
      markBatchTerminal: (batchId: string, status: 'canceled') =>
        SprintLaneStore.getInstance().markBatchTerminal(batchId, status),
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
      emitRunStatusChanged: (runId, status) =>
        runStatusEvents.emit('changed', { runId, status }),
      logger: loggerLike,
    });
    console.log('[Main] runs.resume deps wired');

    setStartRunDeps({
      runLauncher,
      sessionManager,
    });
    console.log('[Main] runs.start deps wired');

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
