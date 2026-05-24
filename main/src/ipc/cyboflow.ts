/**
 * IPC handlers for the cyboflow orchestrator subsystem.
 *
 * Channels registered here:
 *   cyboflow:approveRun     — approve / deny an approval request (stub; epic 7)
 *
 * The four channels that were previously handled here have been migrated to
 * the tRPC transport and their raw-IPC handlers deleted (TASK-714 + TASK-715):
 *   cyboflow:listWorkflows  → trpc.cyboflow.workflows.list
 *   cyboflow:listRuns       → trpc.cyboflow.runs.list
 *   cyboflow:startRun       → trpc.cyboflow.runs.start
 *   cyboflow:mcp-health     → trpc.cyboflow.health.mcpServer
 *
 * The registerCyboflowHandlers function is kept registered from
 * main/src/ipc/index.ts as the hook for any future raw-IPC channels added to
 * this surface.
 */
import { IpcMain } from 'electron';
import type { AppServices } from './types';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCyboflowHandlers(ipcMain: IpcMain, _services: AppServices): void {
  /**
   * cyboflow:approveRun  (NOT_IMPLEMENTED stub)
   *
   * Epic 7 wires the real approval flow.  The day-3 gate test (TASK-355)
   * bypasses this IPC channel and drives the orchestrator directly.
   */
  ipcMain.handle('cyboflow:approveRun', async () => {
    return { success: false, error: 'NOT_IMPLEMENTED: cyboflow:approveRun is pending epic 7' };
  });
}
