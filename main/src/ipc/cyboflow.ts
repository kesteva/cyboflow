/**
 * IPC handlers for the cyboflow orchestrator subsystem.
 *
 * Channels registered here:
 *   cyboflow:listWorkflows  — list (and auto-seed) workflows for a project
 *   cyboflow:startRun       — launch a new workflow run
 *   cyboflow:approveRun     — approve / deny an approval request (stub; epic 7)
 *   cyboflow:mcp-health     — returns current MCP server health snapshot
 *
 * This file is the LIVE transport for the cyboflow.* procedure surface.
 * The renderer (frontend/src/utils/cyboflowApi.ts) calls these channels via
 * electron.invoke — NOT via the tRPC client.
 *
 * tRPC routers under main/src/orchestrator/trpc/routers/ are placeholders;
 * this raw-IPC surface is the live transport for cyboflow.* procedures.
 * See docs/ARCHITECTURE.md "cyboflow.* transport status" for the full decision.
 *
 * WorkflowRegistry and RunLauncher are constructed eagerly in main/src/index.ts
 * as part of AppServices assembly (services.cyboflow.*). Handlers read these
 * pre-built instances from services rather than constructing singletons here.
 */
import { IpcMain } from 'electron';
import * as os from 'os';
import type { AppServices } from './types';
import { resolveSoloFlowPluginRoot, buildDefaultSoloFlowWorkflows } from '../orchestrator/workflowRegistry';
import type { OrchestratorHealth } from '../orchestrator/health';
import type { McpServerHealth } from '../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// OrchestratorHealth singleton (injected after McpServerLifecycle is wired)
// ---------------------------------------------------------------------------

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

        let workflows = services.cyboflow.workflowRegistry.listByProject(projectId);

        if (workflows.length === 0) {
          // Auto-seed the 5 SoloFlow defaults, resolving paths from the plugin root.
          const homeDir = os.homedir();
          const { root: pluginRoot } = resolveSoloFlowPluginRoot(homeDir);
          const descriptors = buildDefaultSoloFlowWorkflows(pluginRoot);
          services.cyboflow.workflowRegistry.seed(projectId, descriptors);
          workflows = services.cyboflow.workflowRegistry.listByProject(projectId);
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

        const { runId, worktreePath, branchName } = await services.cyboflow.runLauncher.launch(
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

