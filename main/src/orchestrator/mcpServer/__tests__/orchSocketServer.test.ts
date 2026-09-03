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
import { orchSocketEndpoint } from '../orchSocketEndpoint';
import { OrchTokenRegistry, ORCH_AUTH_KILL_SWITCH_ENV_VAR } from '../../orchAuthToken';
import type { LoggerLike } from '../../types';
import type { OrchSocketProvider } from '../../runLauncher';
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

/**
 * A unique tmp socket path per call (short enough to stay under the OS limit).
 * On Windows a plain fs path cannot host an AF_UNIX bind (EACCES without
 * elevation), so the fixture routes the name through the production
 * orchSocketEndpoint seam — exactly what index.ts does at boot — and binds a
 * named pipe instead. The server code under test is unchanged.
 */
function makeTmpSocketPath(): string {
  return orchSocketEndpoint(
    path.join(os.tmpdir(), `orch-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`),
  );
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
  /**
   * A suite-local token registry, injected into every server built here.
   * Binding a runId now requires that run's bearer token, and using a real
   * registry (rather than an accept-all stub) keeps these transport tests
   * honest about the authenticated path without touching the process-wide
   * singleton the production spawn seams mint into.
   */
  let tokens: OrchTokenRegistry;
  const openClients: net.Socket[] = [];

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
    logger = makeSpyLogger();
    socketPath = makeTmpSocketPath();
    tokens = new OrchTokenRegistry();
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

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-1', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
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
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    const { client, waitForLines, lines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    const full =
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-split', runId: 'run-z', token: tokens.mint('run-z') }) + '\n';
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
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    // First a malformed line, then a valid one on the SAME connection.
    client.write('this is not json\n');
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-after-bad', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
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
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    expect(server.getSocketPath()).toBe(socketPath);
    expect(server.hasClientForRun('run-bound')).toBe(false);

    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);

    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-bind', runId: 'run-bound', token: tokens.mint('run-bound') }) + '\n',
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

  // POSIX-only: staging a stale socket FILE (and asserting on the fs node the
  // bind creates) presumes a unix socket is a real filesystem node. Windows
  // named pipes have no stable fs node — statSync/existsSync race with EBUSY —
  // and no stale node can occupy a pipe name; stop()-closes coverage is shared
  // with the transport tests above.
  it.skipIf(process.platform === 'win32')(
    'start() creates the sockets dir and unlinks a stale socket file; stop() closes the server',
    async () => {
    // Point at a nested, not-yet-existing sockets directory + a stale file.
    const dir = path.join(os.tmpdir(), `orch-dir-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    socketPath = path.join(dir, 'orch.sock');
    expect(fs.existsSync(dir)).toBe(false);

    // Seed a stale file at the socket path inside a pre-created dir to prove
    // unlink runs (a leftover regular file would otherwise block listen()).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(socketPath, 'stale');
    expect(fs.existsSync(socketPath)).toBe(true);

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    expect(fs.existsSync(dir)).toBe(true);

    // The server is live: a real client round-trips a message.
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-live', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
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
    },
  );

  // -------------------------------------------------------------------------
  // 6. start() recovers from EADDRINUSE (path in use at bind time)
  // -------------------------------------------------------------------------

  // POSIX-only: a stale bind failure requires a unix-socket FILE left occupying
  // the path. Windows named pipes vanish with their server, so no stale node can
  // occupy a pipe name and the reclaim path is unreachable there.
  it.skipIf(process.platform === 'win32')(
    'recovers from EADDRINUSE by unlinking the in-use socket and retrying once',
    async () => {
    // A leftover file occupies the socket path AND the pre-bind unlink is
    // suppressed for the first check, so listen() actually throws EADDRINUSE
    // (binding a unix socket fails when any file already occupies the path) —
    // reproducing the real bug's check→bind race deterministically. The server's
    // recovery unlinks it and retries.
    fs.writeFileSync(socketPath, 'stale');
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);

    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
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
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-eaddr', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // 7. start() refuses to clobber a LIVE peer's socket (two-instance guard)
  // -------------------------------------------------------------------------

  it('start() refuses to clobber a socket a LIVE server is already listening on', async () => {
    // Server A owns the path and is actively listening.
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();
    // The bind's fs node is only inspectable on POSIX — Windows named pipes have
    // no stable fs node (existsSync/statSync race with EBUSY). Live-ness is
    // asserted below via the connect-probe and the real client round-trip.
    if (process.platform !== 'win32') expect(fs.existsSync(socketPath)).toBe(true);

    // Server B targets the SAME path. Its start() must detect the live listener
    // via the connect-probe and reject, rather than unlink A's socket out from
    // under it (the two-instance orch.sock clobber that stranded MCP subprocesses).
    const serverB = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await expect(serverB.start()).rejects.toThrow(/already listening/i);

    // A is untouched: still listening, still round-trips a real client.
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-live', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. EADDRINUSE recovery re-probes and refuses to clobber a LIVE socket
  // -------------------------------------------------------------------------

  it('EADDRINUSE against a LIVE socket rejects instead of unlinking it', async () => {
    // Server A is live on the path.
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    // Server B skips its pre-bind probe (existsSync→false once) so it reaches
    // listen() and hits EADDRINUSE against A's live socket — reproducing the
    // probe→bind race. The EADDRINUSE handler must re-probe, see A alive, and
    // reject rather than unlink A's live socket out from under it.
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const serverB = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await expect(serverB.start()).rejects.toThrow(/already listening/i);

    // A is untouched: still listening, still round-trips a real client.
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-live-eaddr', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9. stop() refuses to unlink a socket file another instance now owns
  // -------------------------------------------------------------------------

  // POSIX-only: the scenario hinges on unlinking a bound socket file by path and
  // on inode-ownership checks — both unix-socket fs-node semantics. Windows named
  // pipes have no stable fs node (rm/stat on a live pipe fail EBUSY) and the name
  // cannot be force-replaced while a server holds it.
  it.skipIf(process.platform === 'win32')(
    'stop() does NOT unlink the socket file when another instance has rebound the path',
    async () => {
    // Server A binds the path and records its inode.
    const serverA = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await serverA.start();

    // An older build (no pre-bind probe) clobbers the path and binds its own
    // socket there — exactly the two-instance collision that stranded every
    // later MCP subprocess. Reproduce it by force-replacing the file.
    fs.rmSync(socketPath, { force: true });
    const serverB = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await serverB.start();
    const inodeB = fs.statSync(socketPath).ino;

    // A now shuts down. It must leave B's file alone — which means NOT calling
    // close() either: libuv unlinks a unix socket by PATH inside close(), so a
    // plain close() here would delete B's socket before any guard could run.
    await serverA.stop();

    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.statSync(socketPath).ino).toBe(inodeB);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rebound by another instance'),
      expect.objectContaining({ socketPath }),
    );

    // B is genuinely still reachable — a NEW connection succeeds, which is the
    // property that actually broke in production (old fds survived; connect did not).
    const { client, waitForLines } = connectClient(socketPath);
    openClients.push(client);
    await waitForConnect(client);
    client.write(
      JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'req-owned', runId: 'run-a', token: tokens.mint('run-a') }) + '\n',
    );
    const lines = await waitForLines(1);
    expect(parse(lines[0]).ok).toBe(true);

    await serverB.stop();
    // afterEach's stop() targets `server`, which this test never assigned.
    },
  );

  // -------------------------------------------------------------------------
  // Structural interface conformance (compile-time assertions)
  // -------------------------------------------------------------------------

  it('satisfies the OrchSocketProvider interface', async () => {
    server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
    await server.start();

    // This assignment fails to compile if the structural shape drifts.
    const asProvider: OrchSocketProvider = server;
    expect(typeof asProvider.getSocketPath()).toBe('string');
    // hasClientForRun survives as a diagnostic (its PermissionServerLike
    // contract retired with the stale_socket rung), so pin it directly rather
    // than through an interface no longer worth declaring.
    expect(server.hasClientForRun('nope')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Peer authentication (per-run bearer tokens)
  //
  // The runId on the wire is SELF-DECLARED, and binding it is what grants a
  // connection run-scoped powers (shell-approval routing, entity writes, the
  // global agent's `agent:<threadId>` fs/SQL family). These pin that a bind
  // requires the run's token.
  // -------------------------------------------------------------------------

  describe('bind authentication', () => {
    /** Send one list-approvals frame and give the server time to act on it. */
    async function sendFrame(client: net.Socket, frame: Record<string, unknown>): Promise<void> {
      client.write(JSON.stringify(frame) + '\n');
      await new Promise((r) => setTimeout(r, 120));
    }

    function waitForClose(client: net.Socket, timeoutMs = 2000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (client.destroyed) {
          resolve();
          return;
        }
        const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
        client.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    it('refuses to bind a runId presented with NO token and closes the connection', async () => {
      seedRun(db, { id: 'run-a' });
      tokens.mint('run-a');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, lines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      await sendFrame(client, {
        type: 'mcp-list-pending-approvals',
        requestId: 'req-notoken',
        runId: 'run-a',
      });

      await waitForClose(client);
      // The message must never have reached the handler.
      expect(lines).toHaveLength(0);
      expect(server.hasClientForRun('run-a')).toBe(false);
      expect(
        logger.warn.mock.calls.some(([msg]) => String(msg).includes('refused a run binding')),
      ).toBe(true);
    });

    it('refuses to bind a runId presented with the WRONG token and closes the connection', async () => {
      seedRun(db, { id: 'run-a' });
      seedRun(db, { id: 'run-b' });
      tokens.mint('run-a');
      // Another run's perfectly valid token must not open this run.
      const otherRunsToken = tokens.mint('run-b');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, lines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      await sendFrame(client, {
        type: 'mcp-list-pending-approvals',
        requestId: 'req-wrongtoken',
        runId: 'run-a',
        token: otherRunsToken,
      });

      await waitForClose(client);
      expect(lines).toHaveLength(0);
      expect(server.hasClientForRun('run-a')).toBe(false);
    });

    it('binds and routes normally when the correct token is presented, and never logs the secret', async () => {
      seedRun(db, { id: 'run-a' });
      const token = tokens.mint('run-a');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, waitForLines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      client.write(
        JSON.stringify({
          type: 'mcp-list-pending-approvals',
          requestId: 'req-ok',
          runId: 'run-a',
          token,
        }) + '\n',
      );

      const lines = await waitForLines(1);
      expect(parse(lines[0]).ok).toBe(true);
      expect(server.hasClientForRun('run-a')).toBe(true);

      // A token in a log line is a token in a support bundle.
      const everythingLogged = JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.debug.mock.calls,
      ]);
      expect(everythingLogged).not.toContain(token);
    });

    it('does not let a connection bound to one run bind a SECOND run with the first run\'s token', async () => {
      seedRun(db, { id: 'run-a' });
      seedRun(db, { id: 'run-b' });
      const tokenA = tokens.mint('run-a');
      tokens.mint('run-b');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, waitForLines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      client.write(
        JSON.stringify({
          type: 'mcp-list-pending-approvals',
          requestId: 'req-a',
          runId: 'run-a',
          token: tokenA,
        }) + '\n',
      );
      await waitForLines(1);
      expect(server.hasClientForRun('run-a')).toBe(true);

      // Same connection, now claiming run-b while still holding only run-a's token.
      await sendFrame(client, {
        type: 'mcp-list-pending-approvals',
        requestId: 'req-b',
        runId: 'run-b',
        token: tokenA,
      });

      await waitForClose(client);
      expect(server.hasClientForRun('run-b')).toBe(false);
    });

    it('drops lines already buffered behind a refused bind instead of routing them', async () => {
      seedRun(db, { id: 'run-a' });
      tokens.mint('run-a');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, lines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      // Two complete frames in ONE write: the first is refused, so the second
      // must never be routed even though it is already in the receive buffer.
      client.write(
        JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'r1', runId: 'run-a' }) +
          '\n' +
          JSON.stringify({ type: 'mcp-list-pending-approvals', requestId: 'r2', runId: 'run-a' }) +
          '\n',
      );
      await waitForClose(client);
      await new Promise((r) => setTimeout(r, 100));
      expect(lines).toHaveLength(0);
    });

    it('accepts an unauthenticated bind when the kill switch is set, and says so loudly', async () => {
      const prior = process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR];
      process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR] = '1';
      try {
        seedRun(db, { id: 'run-a' });
        server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
        await server.start();

        const { client, waitForLines } = connectClient(socketPath);
        openClients.push(client);
        await waitForConnect(client);

        // No token minted at all, and none presented.
        client.write(
          JSON.stringify({
            type: 'mcp-list-pending-approvals',
            requestId: 'req-legacy',
            runId: 'run-a',
          }) + '\n',
        );

        const lines = await waitForLines(1);
        expect(parse(lines[0]).ok).toBe(true);
        expect(server.hasClientForRun('run-a')).toBe(true);
        expect(
          logger.warn.mock.calls.some(([msg]) =>
            String(msg).includes('peer authentication is DISABLED'),
          ),
        ).toBe(true);
      } finally {
        if (prior === undefined) delete process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR];
        else process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR] = prior;
      }
    });

    it('leaves a connection that never declares a runId open, and answers it with an error', async () => {
      // Nothing in the production wire contract omits runId (all 55 message
      // arms require it), so this pins that the unbound surface stays as it
      // was: parse, no bind, no run-scoped state, and an error back.
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const { client, waitForLines } = connectClient(socketPath);
      openClients.push(client);
      await waitForConnect(client);

      client.write(JSON.stringify({ type: 'no-such-type', requestId: 'req-unbound' }) + '\n');

      const lines = await waitForLines(1);
      const resp = parse(lines[0]);
      expect(resp.requestId).toBe('req-unbound');
      expect(resp.ok).toBe(false);
      expect(client.destroyed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Filesystem hardening
  // -------------------------------------------------------------------------

  describe('socket permissions', () => {
    // chmod on a socket node is meaningful on POSIX; Windows has no mode bits.
    const posix = process.platform !== 'win32';

    it.skipIf(!posix)('creates the sockets directory 0700 and the socket file 0600', async () => {
      // A nested dir this test owns, so the mode assertion is about what
      // start() did rather than about whatever tmpdir happens to be.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-perm-${process.pid}-`));
      socketPath = path.join(dir, 'nested', 'orch.sock');
      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      const dirMode = fs.statSync(path.dirname(socketPath)).mode & 0o777;
      const fileMode = fs.statSync(socketPath).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);

      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!posix)('tightens a sockets directory an older build left world-readable', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-perm-${process.pid}-`));
      const sockets = path.join(dir, 'sockets');
      fs.mkdirSync(sockets, { mode: 0o755 });
      fs.chmodSync(sockets, 0o755);
      socketPath = path.join(sockets, 'orch.sock');

      server = new OrchSocketServer(socketPath, dbAdapter(db), logger, {}, tokens);
      await server.start();

      expect(fs.statSync(sockets).mode & 0o777).toBe(0o700);

      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
