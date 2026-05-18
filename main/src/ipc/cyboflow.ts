/**
 * IPC handlers for the cyboflow orchestrator subsystem.
 *
 * Channels registered here:
 *   cyboflow:listWorkflows  — list (and auto-seed) workflows for a project
 *   cyboflow:startRun       — launch a new workflow run
 *   cyboflow:approveRun     — approve / deny an approval request (stub; epic 7)
 *   cyboflow:mcp-health     — returns current MCP server health snapshot
 *
 * Collaborators (WorkflowRegistry, RunLauncher) are constructed lazily on
 * first call using the injected AppServices.  When epic 6 (orchestrator-and-
 * trpc-router) lands, replace the lazy-init blocks with proper singletons
 * instantiated during app startup.
 */
import { IpcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import type { AppServices } from './types';
import { WorkflowRegistry, DEFAULT_SOLOFLOW_WORKFLOWS } from '../orchestrator/workflowRegistry';
import { RunLauncher } from '../orchestrator/runLauncher';
import type { StreamEventPublisher, OrchSocketProvider, BridgeScriptResolver, NodeResolver } from '../orchestrator/runLauncher';
import { McpConfigWriter } from '../orchestrator/mcpConfigWriter';
import type { LoggerLike } from '../orchestrator/types';
import type { OrchestratorHealth } from '../orchestrator/health';
import type { McpServerHealth } from '../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// Module-level lazy singletons (reset on each hot-reload in dev; fine for prod)
// ---------------------------------------------------------------------------

let _workflowRegistry: WorkflowRegistry | null = null;
let _runLauncher: RunLauncher | null = null;

/**
 * TEST-ONLY: inject a pre-built RunLauncher to bypass the sentinel stubs.
 * Call this after `vi.resetModules()` + dynamic import, before invoking any
 * handler, so `getRunLauncher` returns the injected instance instead of
 * constructing one with the throwing epic-7 sentinels.
 *
 * Never call this in production code.
 */
export function _setRunLauncherForTest(launcher: RunLauncher): void {
  _runLauncher = launcher;
}

/**
 * Module-level OrchestratorHealth singleton.
 *
 * Null until the McpServerLifecycle is wired (epic 6). While null, the
 * cyboflow:mcp-health handler returns the safe 'starting' default so the
 * frontend dot stays yellow instead of crashing.
 *
 * Set this via setCyboflowHealth() after constructing OrchestratorHealth
 * in the app bootstrap path (main/src/index.ts) once the McpServerLifecycle
 * singleton is available.
 */
let _orchestratorHealth: OrchestratorHealth | null = null;

/** The safe fallback returned before the health singleton is injected. */
const HEALTH_STARTING: McpServerHealth = { status: 'starting', restartAttempts: 0 };

/**
 * Inject the OrchestratorHealth singleton.
 * Call once from main/src/index.ts during app bootstrap, after
 * McpServerLifecycle.start() is called.
 */
export function setCyboflowHealth(health: OrchestratorHealth): void {
  _orchestratorHealth = health;
}

/**
 * Build a LoggerLike from AppServices.logger (which may be undefined or a
 * Logger instance whose method signatures don't fully match LoggerLike).
 * Falls back to a console-based shim.
 */
function makeLoggerLike(services: AppServices): LoggerLike {
  if (!services.logger) {
    return {
      info:  (msg, ctx) => console.info(msg, ctx ?? ''),
      warn:  (msg, ctx) => console.warn(msg, ctx ?? ''),
      error: (msg, ctx) => console.error(msg, ctx ?? ''),
      debug: (msg, ctx) => console.debug(msg, ctx ?? ''),
    };
  }
  // The Logger class exposes info/warn/error but not debug, and its signatures
  // only accept (message: string, error?: Error).  Wrap to satisfy LoggerLike.
  // Stringify the optional context and append it to the message so callers
  // that pass { path, error, ... } bags don't silently lose those fields.
  const logger = services.logger;
  return {
    info:  (msg: string, ctx?: Record<string, unknown>) => logger.info(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    warn:  (msg: string, ctx?: Record<string, unknown>) => logger.warn(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    error: (msg: string, ctx?: Record<string, unknown>) => logger.error(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    debug: (msg: string, ctx?: Record<string, unknown>) => console.debug(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  };
}

function getWorkflowRegistry(services: AppServices): WorkflowRegistry {
  if (!_workflowRegistry) {
    // WorkflowRegistry expects a DatabaseLike (narrow interface with .prepare / .transaction).
    // DatabaseService wraps better-sqlite3 internally; getDb() exposes the raw handle that
    // satisfies DatabaseLike.
    _workflowRegistry = new WorkflowRegistry(
      services.databaseService.getDb(),
      makeLoggerLike(services),
    );
  }
  return _workflowRegistry;
}

function getRunLauncher(services: AppServices): RunLauncher {
  if (!_runLauncher) {
    // Concrete publisher: adapts BrowserWindow.webContents.send to the
    // StreamEventPublisher interface.  This is the only place in the codebase
    // that calls win.webContents.send for cyboflow stream events, keeping
    // the electron import out of main/src/orchestrator/.
    const publisher: StreamEventPublisher = {
      publish: (runId, event) => {
        const win = services.getMainWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send(`cyboflow:stream:${runId}`, event);
      },
    };

    // OrchSocketProvider — TODO(epic 7): permissionIpcServer is not yet on
    // AppServices.  The sentinel throws at call time so any code path that
    // reaches getSocketPath() surfaces a loud, traceable error instead of
    // silently producing a broken socket path.
    const orchSocketProvider: OrchSocketProvider = {
      getSocketPath: () => {
        throw new Error('cyboflow: orchSocketProvider not yet wired (epic 7 owns permissionIpcServer)');
      },
    };

    // BridgeScriptResolver — TODO(epic 7): ASAR extraction of the bridge
    // script is not yet implemented.  The sentinel throws at call time so
    // missing wiring fails loudly rather than resolving to a phantom path.
    const bridgeScriptResolver: BridgeScriptResolver = {
      getScriptPath: () => {
        throw new Error('cyboflow: bridgeScriptResolver not yet wired (epic 7 owns ASAR extraction)');
      },
    };

    // NodeResolver — returns the process's own node executable path as a
    // best-effort fallback.  A proper findExecutableInPath ladder is epic 7.
    const nodeResolver: NodeResolver = {
      getNodePath: async () => process.execPath,
    };

    _runLauncher = new RunLauncher(
      services.databaseService.getDb(),
      getWorkflowRegistry(services),
      services.worktreeManager,
      makeLoggerLike(services),
      new McpConfigWriter(),
      orchSocketProvider,
      bridgeScriptResolver,
      nodeResolver,
      publisher,
    );
  }
  return _runLauncher;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCyboflowHandlers(ipcMain: IpcMain, services: AppServices): void {
  /**
   * cyboflow:listWorkflows
   *
   * Args: { projectId: number }
   * Returns: { success: true, data: WorkflowRow[] } | { success: false, error: string }
   *
   * Auto-seeds the 5 SoloFlow workflow rows when the project has no registered
   * workflows.  Uses INSERT OR IGNORE semantics so re-seeding is idempotent.
   */
  ipcMain.handle(
    'cyboflow:listWorkflows',
    async (_event, args: { projectId: number }) => {
      try {
        const { projectId } = args;
        const registry = getWorkflowRegistry(services);

        let workflows = registry.listByProject(projectId);

        if (workflows.length === 0) {
          // Auto-seed the 5 SoloFlow defaults, resolving paths from $HOME.
          const homeDir = os.homedir();
          const descriptors = DEFAULT_SOLOFLOW_WORKFLOWS.map((wf) => ({
            name: wf.name,
            path: path.join(homeDir, wf.pathFromHome),
          }));
          registry.seed(projectId, descriptors);
          workflows = registry.listByProject(projectId);
        }

        return { success: true, data: workflows };
      } catch (error) {
        console.error('[cyboflow:listWorkflows] error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'listWorkflows failed',
        };
      }
    },
  );

  /**
   * cyboflow:startRun
   *
   * Args: { workflowId: string, projectId: number }
   * Returns: { success: true, data: { runId, worktreePath, branchName } }
   *        | { success: false, error: string }
   */
  ipcMain.handle(
    'cyboflow:startRun',
    async (_event, args: { workflowId: string; projectId: number }) => {
      try {
        const { workflowId, projectId } = args;

        // Resolve project path via sessionManager (the canonical project store).
        const project = services.sessionManager.getProjectById(projectId);
        if (!project) {
          return { success: false, error: `Project ${projectId} not found` };
        }

        const launcher = getRunLauncher(services);
        const { runId, worktreePath, branchName } = await launcher.launch(
          workflowId,
          project.path,
        );

        return { success: true, data: { runId, worktreePath, branchName } };
      } catch (error) {
        console.error('[cyboflow:startRun] error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'startRun failed',
        };
      }
    },
  );

  /**
   * cyboflow:approveRun  (NOT_IMPLEMENTED stub)
   *
   * Epic 7 wires the real approval flow.  The day-3 gate test (TASK-355)
   * bypasses this IPC channel and drives the orchestrator directly.
   */
  ipcMain.handle('cyboflow:approveRun', async () => {
    return { success: false, error: 'NOT_IMPLEMENTED: cyboflow:approveRun is pending epic 7' };
  });

  /**
   * cyboflow:mcp-health
   *
   * Returns a point-in-time snapshot of the MCP server's health status.
   * Interim IPC channel bridging the frontend sidebar dot until the
   * tRPC ipcLink (orchestrator-and-trpc-router epic) is fully wired.
   *
   * Returns { status: 'starting', restartAttempts: 0 } when the
   * OrchestratorHealth singleton has not yet been injected via
   * setCyboflowHealth(), ensuring the sidebar dot shows yellow rather
   * than erroring out on first paint.
   */
  ipcMain.handle('cyboflow:mcp-health', () => {
    if (_orchestratorHealth === null) {
      return HEALTH_STARTING;
    }
    return _orchestratorHealth.getMcpServerStatus();
  });
}
