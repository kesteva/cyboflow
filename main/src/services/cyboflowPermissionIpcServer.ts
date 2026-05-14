import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { ApprovalRouter, type ApprovalDecision } from '../orchestrator/approvalRouter';
import { getCyboflowSubdirectory } from '../utils/crystalDirectory';

export class CyboflowPermissionIpcServer {
  private server: net.Server | null = null;
  private clients: Map<string, net.Socket> = new Map();
  private socketPath: string;

  constructor() {
    // Use a directory without spaces for better compatibility
    // DMG apps can write to user's home directory
    let socketDir: string;
    try {
      socketDir = getCyboflowSubdirectory('sockets');
      
      // Ensure the directory exists
      if (!fs.existsSync(socketDir)) {
        fs.mkdirSync(socketDir, { recursive: true });
      }
      
      // Test write access
      const testFile = path.join(socketDir, '.test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (error) {
      console.error('[Permission IPC] Failed to create socket directory, falling back to system temp:', error);
      socketDir = os.tmpdir();
    }
    
    this.socketPath = path.join(socketDir, `cyboflow-permissions-${process.pid}.sock`);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up any existing socket file
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }

      this.server = net.createServer((client) => {
        const clientId = randomUUID();
        this.clients.set(clientId, client);
        

        client.on('data', async (data) => {
          try {
            const message = JSON.parse(data.toString());

            if (message.type === 'permission-request') {
              // TODO: at integration time, map sessionId → runId via the workflow-runs
              // registry owned by the workflow-runs-and-day3-gate epic.  For now the
              // caller passes whatever ID the bridge subprocess was spawned with; that
              // value is used directly as the runId.
              const { requestId, sessionId, toolName, input } = message;

              // Build the socketReply closure here where client + requestId are in scope.
              // This closure is passed directly to requestApproval, which stores it alongside
              // the pending entry and invokes it exactly once in respond().
              const socketReply = (decision: ApprovalDecision) => {
                client.write(JSON.stringify({
                  type: 'permission-response',
                  requestId,
                  response: decision,
                }));
              };

              try {
                await ApprovalRouter.getInstance().requestApproval(
                  sessionId,
                  toolName,
                  input,
                  socketReply,
                );
              } catch (error) {
                // Send error response back to the bridge on any failure (including
                // RunNotRunningError when the run is no longer in 'running' state).
                client.write(JSON.stringify({
                  type: 'permission-response',
                  requestId,
                  response: {
                    behavior: 'deny',
                    message: error instanceof Error ? error.message : 'Permission denied',
                  },
                }));
              }
            }
          } catch (error) {
            console.error('[Permission IPC] Error handling message:', error);
          }
        });

        client.on('error', (error) => {
          console.error('[Permission IPC] Client error:', error);
        });

        client.on('close', () => {
          this.clients.delete(clientId);
        });
      });

      this.server.on('error', (error) => {
        console.error('[Permission IPC] Server error:', error);
        reject(error);
      });

      this.server.listen(this.socketPath, () => {
        
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const client of this.clients.values()) {
        client.end();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          // Clean up socket file
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getSocketPath(): string {
    return this.socketPath;
  }
}