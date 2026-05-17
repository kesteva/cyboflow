/**
 * @deprecated DEAD CODE — scheduled for deletion in TASK-579
 * (epic: crystal-cuts-and-rebrand). Zero production importers as of the
 * claude-agent-sdk-migration EPIC; the production approval path runs through
 * `main/src/orchestrator/approvalRouter.ts` and the canonical wire types live
 * in `shared/types/approval.ts`.
 *
 * The `PermissionRequest` / `PermissionResponse` interfaces below are Cyboflow-
 * era types and diverge from the canonical substrate-portable contract in
 * `shared/types/approval.ts` — notably `PermissionRequest.sessionId` is the
 * Cyboflow-era equivalent of `ApprovalRequest.runId`. They are intentionally
 * NOT aligned here; this file's death (TASK-579) is the alignment.
 */
import { EventEmitter } from 'events';
import { ipcMain } from 'electron';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export class PermissionManager extends EventEmitter {
  private pendingRequests: Map<string, PermissionRequest> = new Map();
  private static instance: PermissionManager;

  private constructor() {
    super();
    this.setupIpcHandlers();
  }

  static getInstance(): PermissionManager {
    if (!PermissionManager.instance) {
      PermissionManager.instance = new PermissionManager();
    }
    return PermissionManager.instance;
  }

  private setupIpcHandlers() {
    ipcMain.handle('permission:respond', async (_, requestId: string, response: PermissionResponse) => {
      const request = this.pendingRequests.get(requestId);
      if (!request) {
        throw new Error(`No pending permission request with id ${requestId}`);
      }

      this.pendingRequests.delete(requestId);
      this.emit(`response:${requestId}`, response);
      return { success: true };
    });

    ipcMain.handle('permission:getPending', async () => {
      return Array.from(this.pendingRequests.values());
    });
  }

  async requestPermission(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionResponse> {
    const request: PermissionRequest = {
      id: `${sessionId}-${Date.now()}-${Math.random()}`,
      sessionId,
      toolName,
      input,
      timestamp: Date.now()
    };

    this.pendingRequests.set(request.id, request);

    // Notify frontend about new permission request
    const { getMainWindow } = await import('../index');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      console.log('[PermissionManager] Sending permission request to frontend:', request.id, request.toolName);
      mainWindow.webContents.send('permission:request', request);
    } else {
      console.error('[PermissionManager] No main window available to send permission request!');
    }

    // Wait for response indefinitely (no timeout)
    return new Promise((resolve, reject) => {
      this.once(`response:${request.id}`, (response: PermissionResponse) => {
        resolve(response);
      });
    });
  }

  clearPendingRequests(sessionId?: string) {
    if (sessionId) {
      for (const [id, request] of this.pendingRequests.entries()) {
        if (request.sessionId === sessionId) {
          this.pendingRequests.delete(id);
          this.emit(`response:${id}`, { behavior: 'deny', message: 'Session terminated' });
        }
      }
    } else {
      for (const id of this.pendingRequests.keys()) {
        this.emit(`response:${id}`, { behavior: 'deny', message: 'All requests cleared' });
      }
      this.pendingRequests.clear();
    }
  }
}