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
import { z } from 'zod';
import type { AppServices } from './types';
import { resolveSoloFlowPluginRoot, buildDefaultSoloFlowWorkflows } from '../orchestrator/workflowRegistry';
import type { OrchestratorHealth } from '../orchestrator/health';
import { HEALTH_STARTING } from '../../../shared/types/mcpHealth';
import { setHealthProvider, getHealthProvider } from '../orchestrator/trpc/routers/health';
import { validateInput } from './validateInput';

/**
 * Inject the OrchestratorHealth singleton.
 *
 * @deprecated Use `setHealthProvider` from `./orchestrator/trpc/routers/health`
 * directly (called from main/src/index.ts at boot).  This shim exists only to
 * preserve the test-file import until TASK-716 cleans it up.  It no longer
 * maintains a parallel module-level singleton — it delegates entirely to
 * setHealthProvider so the IPC handler and tRPC procedure share one source of
 * truth.
 */
export function setCyboflowHealth(health: OrchestratorHealth): void {
  setHealthProvider(health);
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
    async (_event, args: unknown) => {
      try {
        const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listWorkflows');
        if (!v.ok) return { success: false, error: v.error };
        const { projectId } = v.value;

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
    async (_event, args: unknown) => {
      try {
        const v = validateInput(
          z.object({ workflowId: z.string().min(1), projectId: z.number().finite() }),
          args,
          'cyboflow:startRun',
        );
        if (!v.ok) return { success: false, error: v.error };
        const { workflowId, projectId } = v.value;

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
   * cyboflow:listRuns
   *
   * Args: { projectId: number }
   * Returns: { success: true, data: WorkflowRunRow[] } | { success: false, error: string }
   *
   * Returns workflow_runs for the given project, ordered by created_at DESC
   * (newest run first).  Excludes the heavy policy_json column.
   */
  ipcMain.handle(
    'cyboflow:listRuns',
    (_event, args: unknown) => {
      try {
        const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listRuns');
        if (!v.ok) return { success: false, error: v.error };
        const { projectId } = v.value;
        const rows = services.databaseService.getDb()
          .prepare(
            `SELECT id, workflow_id, project_id, status, worktree_path, branch_name,
                    created_at, updated_at, started_at, ended_at, stuck_reason
             FROM workflow_runs
             WHERE project_id = ?
             ORDER BY created_at DESC`,
          )
          .all(projectId);
        return { success: true, data: rows };
      } catch (error) {
        console.error('[cyboflow:listRuns] error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'listRuns failed',
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
   * Interim IPC channel bridging the frontend sidebar dot until TASK-715
   * migrates the renderer to the tRPC transport (TASK-716 then deletes this).
   *
   * Reads from the SAME OrchestratorHealth singleton as the tRPC
   * cyboflow.health.mcpServer procedure via getHealthProvider(), so both
   * surfaces are always in sync.  Falls back to HEALTH_STARTING before
   * setHealthProvider() is called at boot.
   */
  ipcMain.handle('cyboflow:mcp-health', () => {
    const health = getHealthProvider();
    if (health === null) {
      return HEALTH_STARTING;
    }
    return health.getMcpServerStatus();
  });
}

