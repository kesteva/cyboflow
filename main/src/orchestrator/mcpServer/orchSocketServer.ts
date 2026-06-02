/**
 * OrchSocketServer — the orchestrator-side half of the Cyboflow MCP IPC link.
 *
 * Stands up a Unix-domain `net.Server` that listens on a socket path under
 * `~/.cyboflow/sockets/`, accepts connections from spawned `cyboflowMcpServer`
 * subprocesses, parses the newline-delimited JSON wire protocol those
 * subprocesses emit, and routes each message through a real `McpQueryHandler`
 * (constructed with the injected cyboflow DB). This is what makes the three
 * `cyboflow_*` tools routable for the first time.
 *
 * Standalone-typecheck invariant (mirrors orchestrator/types.ts and
 * orchestrator/runLauncher.ts): this module must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The socket
 * path is resolved by the caller (TASK-799 passes
 * getCyboflowSubdirectory('sockets', 'orch.sock')) and injected as a
 * constructor argument, so this file never imports the electron-backed
 * cyboflow-directory helper.
 *
 * Transport boundary: this class owns *only* the transport layer — framing,
 * connection lifecycle, and malformed-line handling. `McpQueryHandler` owns the
 * application layer (it never throws and writes its own error responses), so a
 * malformed (non-JSON) line is logged and dropped here and never reaches the
 * handler. The framing mirrors the rolling-buffer logic the subprocess uses on
 * its side (cyboflowMcpServer.ts:66-90), so a JSON message split across multiple
 * 'data' events — or batched without a trailing newline in the first chunk —
 * reassembles correctly.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { McpQueryHandler, type McpQueryMessage } from './mcpQueryHandler';
import type { DatabaseLike, LoggerLike } from '../types';
import type { PermissionServerLike } from '../stuckDetector';

// ---------------------------------------------------------------------------
// Wire-envelope narrowing
// ---------------------------------------------------------------------------

/**
 * The minimal envelope every message on this socket shares. A line must be a
 * JSON object carrying a string `type` and a string `requestId`; `runId` is
 * present on every message the subprocess emits (cyboflowMcpServer.ts:126) and,
 * when present, binds the originating socket to that run so `hasClientForRun`
 * can report it.
 */
interface McpQueryEnvelope {
  type: string;
  requestId: string;
  runId?: string;
}

function isMcpQueryEnvelope(v: unknown): v is McpQueryEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.type !== 'string') return false;
  if (typeof obj.requestId !== 'string') return false;
  if (obj.runId !== undefined && typeof obj.runId !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// OrchSocketServer
// ---------------------------------------------------------------------------

/**
 * Implements `PermissionServerLike` (stuckDetector.ts) via `hasClientForRun`,
 * and structurally satisfies `OrchSocketProvider` (runLauncher.ts) via
 * `getSocketPath`. The `OrchSocketProvider` interface is not imported here
 * because runLauncher.ts drags concrete service types (WorktreeManager,
 * RunExecutor, …) that would violate the standalone-typecheck invariant; the
 * structural match is asserted in the unit test instead.
 */
export class OrchSocketServer implements PermissionServerLike {
  private readonly handler: McpQueryHandler;
  private server: net.Server | null = null;
  private readonly clientsByRun = new Map<string, Set<net.Socket>>();
  /**
   * Every live connection, regardless of whether it has bound a runId. Held so
   * stop() can actively destroy in-flight sockets — net.Server.close() does NOT
   * resolve while connections remain open, so without this stop() would hang
   * whenever a subprocess is still connected.
   */
  private readonly connections = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    db: DatabaseLike,
    private readonly logger: LoggerLike,
  ) {
    this.handler = new McpQueryHandler(db);
  }

  /**
   * Create the sockets directory if missing, unlink any stale socket file at
   * the path (a leftover file makes `listen` fail with EADDRINUSE), then create
   * the server and resolve once it is listening.
   */
  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    // A unix socket fails to bind onto a leftover file from a prior run.
    if (fs.existsSync(this.socketPath)) {
      fs.rmSync(this.socketPath, { force: true });
    }

    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;

    server.on('error', (err: Error) => {
      this.logger.error('[Cyboflow Orch IPC] server error', { error: err.message });
    });

    await new Promise<void>((resolve) => {
      server.listen(this.socketPath, () => {
        this.logger.info('[Cyboflow Orch IPC] listening', { socketPath: this.socketPath });
        resolve();
      });
    });
  }

  /**
   * Close the server and resolve once closed. Best-effort unlink of the socket
   * file so a subsequent start() does not have to.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    // Destroy any in-flight connections first; net.Server.close() resolves only
    // once every open connection has ended.
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch (err) {
      this.logger.debug('[Cyboflow Orch IPC] socket file unlink skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The socket path this server listens on (satisfies OrchSocketProvider). */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Whether a client connection bound to `runId` is currently open. */
  hasClientForRun(runId: string): boolean {
    return (this.clientsByRun.get(runId)?.size ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  /**
   * Per-connection handler. Owns a rolling receive buffer mirroring
   * cyboflowMcpServer.ts:66-90 so messages that span multiple 'data' events,
   * or arrive without a trailing newline, parse correctly. The set of runIds
   * this socket has bound (so it can be unregistered on close/error) is tracked
   * locally.
   */
  private onConnection(socket: net.Socket): void {
    let recvBuffer = '';
    const boundRuns = new Set<string>();
    this.connections.add(socket);

    socket.on('data', (buf: Buffer) => {
      recvBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = recvBuffer.indexOf('\n')) !== -1) {
        const line = recvBuffer.slice(0, nl).trim();
        recvBuffer = recvBuffer.slice(nl + 1);
        if (!line) continue;
        this.routeLine(line, socket, boundRuns);
      }
    });

    socket.on('error', (err: Error) => {
      this.logger.warn('[Cyboflow Orch IPC] client socket error', { error: err.message });
      this.connections.delete(socket);
      this.unbindSocket(socket, boundRuns);
    });

    socket.on('close', () => {
      this.logger.debug('[Cyboflow Orch IPC] client disconnected');
      this.connections.delete(socket);
      this.unbindSocket(socket, boundRuns);
    });
  }

  /**
   * Parse and route a single complete line. A non-JSON line is logged and
   * dropped — it must never throw out of the 'data' handler.
   */
  private routeLine(line: string, socket: net.Socket, boundRuns: Set<string>): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.logger.warn('[Cyboflow Orch IPC] failed to parse line', {
        line,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!isMcpQueryEnvelope(parsed)) {
      this.logger.warn('[Cyboflow Orch IPC] dropped malformed envelope', { line });
      return;
    }

    if (parsed.runId !== undefined && !boundRuns.has(parsed.runId)) {
      this.bindSocket(parsed.runId, socket);
      boundRuns.add(parsed.runId);
    }

    // The envelope is validated; the handler's exhaustive-default fallback
    // covers any type not in the current union, so the cast is safe.
    const msg = parsed as McpQueryMessage;
    void this.handler.handleMessage(msg, socket);
  }

  private bindSocket(runId: string, socket: net.Socket): void {
    let set = this.clientsByRun.get(runId);
    if (!set) {
      set = new Set<net.Socket>();
      this.clientsByRun.set(runId, set);
    }
    set.add(socket);
  }

  private unbindSocket(socket: net.Socket, boundRuns: Set<string>): void {
    for (const runId of boundRuns) {
      const set = this.clientsByRun.get(runId);
      if (!set) continue;
      set.delete(socket);
      if (set.size === 0) this.clientsByRun.delete(runId);
    }
    boundRuns.clear();
  }
}
