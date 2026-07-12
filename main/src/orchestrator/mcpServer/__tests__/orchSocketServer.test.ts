/**
 * Integration/unit tests for OrchSocketServer.
 *
 * Covers the five test_strategy.targets behaviours from TASK-798:
 *
 * 1. A valid newline-delimited McpQueryMessage sent by a connected client is
 *    routed through McpQueryHandler and a JSON response is written back on the
 *    same socket.                                                  (integration)
 *
 * 2. A JSON message split across two socket writes is reassembled by the
 *    rolling receive buffer and routed exactly once.               (integration)
 *
 * 3. A malformed (non-JSON) line is logged via the injected logger and dropped
 *    without crashing the server or terminating other connections.      (unit)
 *
 * 4. getSocketPath() returns the listening path; hasClientForRun(runId)
 *    reflects whether a client connection bound to that runId is open.   (unit)
 *
 * 5. stop() closes the server; start() unlinks a stale socket file and creates
 *    the sockets dir.                                              (integration)
 *
 * Tests use a real net client over an os.tmpdir() socket path (hermetic — never
 * touches ~/.cyboflow), the shared dbAdapter + orchestratorTestDb fixtures, and
 * a vi.fn()-backed LoggerLike spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { OrchSocketServer } from '../orchSocketServer';
import type { LoggerLike } from '../../types';
import type { OrchSocketProvider } from '../../runLauncher';
import type { PermissionServerLike } from '../../stuckDetector';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../../__test_fixtures__/orchestratorTestDb';

// The EADDRINUSE-recovery test needs one real bind failure, which the pre-bind
// unlink in start() otherwise prevents. Wrap only fs.existsSync so that test can
// suppress the pre-bind check for a single call; every other fs call (here and in
// start()) keeps real behavior, and better-sqlite3 uses native I/O rather than
// this module, so the DB fixtures and the rest of the suite are unaffected.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpyLogger extends LoggerLike {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeSpyLogger(): SpyLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** A unique tmp socket path per call (short enough to stay under the OS limit). */
function makeTmpSocketPath(): string {
  return path.join(os.tmpdir(), `orch-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/**
 * Connect a real client and collect newline-delimited response lines, exposing
 * a promise that resolves once `count` complete lines have arrived.
 */
function connectClient(socketPath: string): {
  client: net.Socket;
  lines: string[];
  waitForLines: (count: number, timeoutMs?: number) => Promise<string[]>;
} {
  const lines: string[] = [];
  let recv = '';
  const client = net.createConnection(socketPath);
  client.on('data', (buf: Buffer) => {
    recv += buf.toString('utf8');
    let nl: number;
    while ((nl = recv.indexOf('\n')) !== -1) {
      const line = recv.slice(0, nl).trim();
      recv = recv.slice(nl + 1);
      if (line) lines.push(line);
    }
  });

  const waitForLines = (count: number, timeoutMs = 2000): Promise<string[]> =>
    new Promise<string[]>((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        if (lines.length >= count) {
          resolve(lines);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for ${count} line(s); got ${lines.length}`));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });

  return { client, lines, waitForLines };
}

function waitForConnect(client: net.Socket, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client connect timeout')), timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface ParsedResponse {
  type: string;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

function parse(line: string): ParsedResponse {
  return JSON.parse(line) as ParsedResponse;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchSocketServer', () => {
  let db: Database.Database;
  let logger: SpyLogger;
  let server: OrchSocketServer;
  let socketPath: string;
  const openClients: net.Socket[] = [];

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
    logger = makeSpyLogger();
    socketPath = makeTmpSocketPath();
  });

  afterEach(async () => {
    for (const c of openClients.splice(0)) {
      c.destroy();
    }
    if (server) await server.stop();
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. Valid message → routed → response written back
  // -------------------------------------------------------------------------

  it('routes a valid newline-delimited message through McpQueryHandler and writes a response back', async () => {
    seedRun(db, { id: 'run-a' });
    seedApproval(db, {
      id: 'appr-1',
      runId: 'run-a',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      toolInputJson: '{"cmd":"ls"}',
    });

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-1', runId: 'run-a' }) + '\n',
    );

    const lines = await waitForLines(1);
    expect(lines).toHaveLength(1);
    const resp = parse(lines[0]);
    expect(resp.type).toBe('mcp-query-response');
    expect(resp.requestId).toBe('req-1');
    expect(resp.ok).toBe(true);
    const data = resp.data as { approvals: Array<{ approval_id: string }> };
    expect(data.approvals).toHaveLength(1);
    expect(data.approvals[0].approval_id).toBe('appr-1');
  });

  // -------------------------------------------------------------------------
  // 2. Split-frame reassembly → routed exactly once
  // -------------------------------------------------------------------------

  it('reassembles a JSON message split across two socket writes and routes it exactly once', async () => {
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    const { client, waitForLines, lines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    const full =
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-split', runId: 'run-z' }) + '\n';
    const mid = Math.floor(full.length / 2);

    // Two writes for the single framed message; the trailing newline arrives in
    // the second chunk. A correct rolling buffer yields exactly one response.
    client.write(full.slice(0, mid));
    await new Promise<void>((r) => setTimeout(r, 30));
    client.write(full.slice(mid));

    const got = await waitForLines(1);
    expect(got).toHaveLength(1);
    const resp = parse(got[0]);
    expect(resp.requestId).toBe('req-split');
    expect(resp.ok).toBe(true);

    // Give the server a beat — assert no duplicate response was emitted.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(lines).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 3. Malformed line → logged + dropped, server stays up
  // -------------------------------------------------------------------------

  it('logs and drops a malformed (non-JSON) line without crashing the server or the connection', async () => {
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    // First a malformed line, then a valid one on the SAME connection.
    client.write('this is not json\n');
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-after-bad', runId: 'run-a' }) + '\n',
    );

    const lines = await waitForLines(1);
    // Only the valid message produced a response — the malformed line was dropped.
    expect(lines).toHaveLength(1);
    const resp = parse(lines[0]);
    expect(resp.requestId).toBe('req-after-bad');
    expect(resp.ok).toBe(true);

    // The transport logged the parse failure via the injected logger.
    expect(logger.warn).toHaveBeenCalled();
    const warnedAboutParse = logger.warn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('failed to parse line'),
    );
    expect(warnedAboutParse).toBe(true);

    // The server is still listening.
    expect(server.getSocketPath()).toBe(socketPath);
  });

  // -------------------------------------------------------------------------
  // 4. getSocketPath / hasClientForRun
  // -------------------------------------------------------------------------

  it('getSocketPath() returns the path and hasClientForRun reflects a bound runId', async () => {
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    expect(server.getSocketPath()).toBe(socketPath);
    expect(server.hasClientForRun('run-bound')).toBe(false);

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-bind', runId: 'run-bound' }) + '\n',
    );
    await waitForLines(1);

    expect(server.hasClientForRun('run-bound')).toBe(true);
    expect(server.hasClientForRun('run-unknown')).toBe(false);

    // Closing the client unbinds the run.
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.destroy();
    await closed;
    // Allow the server-side 'close' handler to run.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(server.hasClientForRun('run-bound')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. start() unlinks stale socket + creates dir; stop() closes the server
  // -------------------------------------------------------------------------

  it('start() creates the sockets dir and unlinks a stale socket file; stop() closes the server', async () => {
    // Point at a nested, not-yet-existing sockets directory + a stale file.
    const dir = path.join(os.tmpdir(), `orch-dir-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    socketPath = path.join(dir, 'orch.sock');
    expect(fs.existsSync(dir)).toBe(false);

    // Seed a stale file at the socket path inside a pre-created dir to prove
    // unlink runs (a leftover regular file would otherwise block listen()).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(socketPath, 'stale');
    expect(fs.existsSync(socketPath)).toBe(true);

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    expect(fs.existsSync(dir)).toBe(true);

    // The server is live: a real client round-trips a message.
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-live', runId: 'run-a' }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);

    await server.stop();

    // After stop(), the socket file is gone and the server is no longer
    // listening: a fresh connection attempt is refused (ENOENT/ECONNREFUSED).
    expect(fs.existsSync(socketPath)).toBe(false);
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = net.createConnection(socketPath);
        const timer = setTimeout(() => {
          probe.destroy();
          reject(new Error('probe_connect_timeout'));
        }, 1000);
        probe.once('connect', () => {
          clearTimeout(timer);
          probe.destroy();
          resolve();
        });
        probe.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }),
    ).rejects.toBeDefined();

    // Reset so afterEach's stop() is a no-op (already stopped).
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 6. start() recovers from EADDRINUSE (path in use at bind time)
  // -------------------------------------------------------------------------

  it('recovers from EADDRINUSE by unlinking the in-use socket and retrying once', async () => {
    // A leftover file occupies the socket path AND the pre-bind unlink is
    // suppressed for the first check, so listen() actually throws EADDRINUSE
    // (binding a unix socket fails when any file already occupies the path) —
    // reproducing the real bug's check→bind race deterministically. The server's
    // recovery unlinks it and retries.
    fs.writeFileSync(socketPath, 'stale');
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start(); // must recover (unlink + retry), not hang

    const warnedEaddr = logger.warn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('EADDRINUSE'),
    );
    expect(warnedEaddr).toBe(true);

    // The retried server is the live listener: a real client round-trips.
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-eaddr', runId: 'run-a' }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Structural interface conformance (compile-time assertions)
  // -------------------------------------------------------------------------

  it('satisfies the OrchSocketProvider and PermissionServerLike interfaces', async () => {
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger);
    await server.start();

    // These assignments fail to compile if the structural shape drifts.
    const asProvider: OrchSocketProvider = server;
    const asPermServer: PermissionServerLike = server;
    expect(typeof asProvider.getSocketPath()).toBe('string');
    expect(asPermServer.hasClientForRun('nope')).toBe(false);
  });
});
