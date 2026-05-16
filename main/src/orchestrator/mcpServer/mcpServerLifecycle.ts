/**
 * McpServerLifecycle — manages the singleton cyboflowMcpServer subprocess.
 *
 * Spawns one subprocess per orchestrator process (not per run — cross-run
 * discrimination happens via per-tool arguments and socket session-id routing).
 *
 * Responsibilities:
 *  - Resolve the script path (handles packaged .asar extraction via scriptPath.ts).
 *  - Spawn the subprocess with stdio: ['pipe','pipe','pipe'], passing
 *    CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET via env.
 *  - Route subprocess stderr line-by-line to the injected logger with
 *    [Cyboflow MCP] prefix; stdout is left alone (it is the MCP protocol stream).
 *  - Auto-restart up to MAX_RESTARTS times with exponential backoff on non-zero exit.
 *    After all retry attempts are exhausted status transitions to 'failed'.
 *  - stop() sends SIGTERM, waits up to 2 s, then SIGKILLs if still alive.
 *
 * See TASK-454 for rationale on restart policy choice (2 attempts, 1s/5s backoff).
 */
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { findNodeExecutable } from '../../utils/nodeFinder';
import { resolveMcpServerScriptPath } from './scriptPath';
import type { LoggerLike } from '../types';

// Re-export for callers that want the status type without importing the class.
export type McpServerStatus = 'starting' | 'running' | 'failed' | 'stopped';

export class McpServerLifecycle {
  private subprocess: ChildProcess | null = null;
  private _status: McpServerStatus = 'stopped';
  private restartAttempts = 0;

  private readonly MAX_RESTARTS = 2;
  /** Backoff delays in ms indexed by attempt number (0-based). */
  private readonly BACKOFF_MS: readonly [number, number] = [1000, 5000];

  /**
   * @param socketPath              Unix socket path that the subprocess connects
   *                                to for IPC.  Passed as CYBOFLOW_ORCH_SOCKET.
   * @param logger                  Injected logger; must expose .info/.warn/.error.
   * @param orchestratorRunIdProvider  Returns the value for CYBOFLOW_RUN_ID env var.
   *                                   For the singleton orchestrator server this is
   *                                   the sentinel string 'orchestrator'.  Per-session
   *                                   identification happens inside tool calls via the
   *                                   run_id argument passed by Claude Code.
   */
  constructor(
    private readonly socketPath: string,
    private readonly logger: LoggerLike,
    private readonly orchestratorRunIdProvider: () => string,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): McpServerStatus {
    return this._status;
  }

  /**
   * Resolve the cyboflowMcpServer.js script path.
   * Public so tests and claudeCodeManager can call it independently.
   */
  resolveScriptPath(): string {
    return resolveMcpServerScriptPath();
  }

  /**
   * Start the MCP server subprocess.
   *
   * Idempotent: if status is already 'running', returns immediately.
   * Resets the restart counter so a manual start-after-failure is clean.
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      return;
    }

    this._status = 'starting';

    const nodePath = await findNodeExecutable();
    const scriptPath = this.resolveScriptPath();

    // Validate that the script file exists before trying to spawn it.
    if (!fs.existsSync(scriptPath)) {
      this._status = 'failed';
      this.logger.error(
        `[Cyboflow MCP] Script not found at ${scriptPath}; spawn aborted. ` +
          `Run pnpm run build:main to produce the dist artifact.`,
      );
      return;
    }

    const env: Record<string, string> = {
      ...this.buildSafeEnv(),
      CYBOFLOW_RUN_ID: this.orchestratorRunIdProvider(),
      CYBOFLOW_ORCH_SOCKET: this.socketPath,
    };

    const child = spawn(nodePath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.subprocess = child;

    // Route stderr line-by-line to the logger; stdout is the MCP protocol
    // stream owned by the SDK transport — do NOT attach a handler here.
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) {
          this.logger.info(`[Cyboflow MCP] ${line}`);
        }
      }
    });

    child.on('error', (err: Error) => {
      this.logger.error(`[Cyboflow MCP] spawn error: ${err.message}`);
      this._status = 'failed';
    });

    child.on('exit', (code: number | null) => {
      this.handleExit(code);
    });

    // Give the subprocess 200 ms to bootstrap before declaring it running.
    // If it dies in that window the exit handler will fire before this resolves.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Only upgrade to 'running' if the process is still alive (pid still set).
    if (this.subprocess?.pid !== undefined && this._status === 'starting') {
      this._status = 'running';
    }
  }

  /**
   * Stop the MCP server subprocess.
   *
   * Sends SIGTERM; if the subprocess does not exit within 2 seconds, SIGKILLs.
   * Status transitions to 'stopped' immediately so the exit handler treats the
   * exit as intentional and does not attempt auto-restart.
   */
  async stop(): Promise<void> {
    // Set stopped BEFORE sending SIGTERM so the exit handler does not restart.
    this._status = 'stopped';

    const child = this.subprocess;
    if (!child || child.exitCode !== null || child.killed) {
      this.subprocess = null;
      return;
    }

    child.kill('SIGTERM');

    // Wait up to 2 s for clean exit, then escalate to SIGKILL.
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    // Check if still alive after the wait.
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }

    this.subprocess = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle subprocess exit events.
   *
   * - Zero exit or intentional stop ('stopped' status): no-op.
   * - Non-zero exit while restarts remain: schedule a backoff restart.
   * - Non-zero exit after all retries exhausted: transition to 'failed'.
   */
  private handleExit(code: number | null): void {
    // Intentional stop — the caller already set status='stopped'.
    if (this._status === 'stopped') {
      return;
    }

    // Clean exit (code 0) while not deliberately stopped is unusual but
    // treat it the same as non-zero to guard against silent drop-out.
    if (this.restartAttempts < this.MAX_RESTARTS) {
      const delay = this.BACKOFF_MS[this.restartAttempts];
      this.logger.warn(
        `[Cyboflow MCP] subprocess exited with code ${code}, ` +
          `restart attempt ${this.restartAttempts + 1}/${this.MAX_RESTARTS} ` +
          `in ${delay}ms`,
      );
      this.restartAttempts++;
      // Detach subprocess reference before restarting.
      this.subprocess = null;
      // Reset status to allow start() to proceed.
      this._status = 'stopped';
      setTimeout(() => {
        void this.start();
      }, delay);
    } else {
      this._status = 'failed';
      this.logger.error(
        '[Cyboflow MCP] subprocess unrecoverable after 2 restarts; ' +
          'outbound MCP tools unavailable until app restart.',
      );
    }
  }

  /**
   * Build a safe env record from process.env that only includes string values.
   * process.env may contain undefined entries on some platforms.
   */
  private buildSafeEnv(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  }
}
