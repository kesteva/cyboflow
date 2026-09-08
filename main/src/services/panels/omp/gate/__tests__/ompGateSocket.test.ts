/**
 * Socket-gate + sentinel tests for the OMP gating extension.
 *
 * These drive a REAL Unix-socket server speaking the orchestrator's actual wire
 * shape — the `shell-approval-request` arm declared at
 * `main/src/orchestrator/mcpServer/mcpQueryHandler.ts:854-860` and the verdict
 * frame `writeShellVerdict` emits at `mcpQueryHandler.ts:5477-5492` — rather
 * than a stubbed socket, so the framing (NDJSON, requestId correlation, split
 * and batched frames) is exercised end to end.
 *
 * The invariant under test: every non-verdict outcome REJECTS. OMP converts a
 * rejected `tool_call` handler into `{ block: true, reason }`
 * (`extensibility/extensions/runner.ts:1235-1270`), so a rejection here is a
 * blocked tool call with the reason surfaced to the model — never a silent pass.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ENV_ORCH_SOCKET,
  HUMAN_DECISION_BUDGET_MS,
  MOST_RESTRICTIVE_GATE_CONFIG,
  canonicalToolNameForOrchestrator,
  createToolCallHandler,
  requestSocketDecision,
  writeGateSentinel,
  type OmpGateLogger,
  type OmpGateRuntime,
} from '../ompGateExtension';
// The production platform seam that maps the POSIX socket path onto a Windows
// named pipe — the test stubs bind the endpoint exactly the way index.ts does.
import { orchSocketEndpoint } from '../../../../../orchestrator/mcpServer/orchSocketEndpoint';
import type { OmpGateSentinel, OmpToolCallEvent } from '../ompGateTypes';

const silentLogger: OmpGateLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Temp dirs + a real orchestrator-shaped socket server
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const servers: net.Server[] = [];
/**
 * Every server-side connection, destroyed before `server.close()` in teardown.
 * `close()` waits for open connections, and a half-closed one would hang the
 * afterEach hook rather than the assertion.
 */
const serverConnections: net.Socket[] = [];

function makeTempDir(): string {
  // Short prefix on purpose: a Unix socket path is capped near 104 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompgate-'));
  tempDirs.push(dir);
  return dir;
}

interface StubOrchestrator {
  socketPath: string;
  /** Every request frame the server received, parsed. */
  received: Record<string, unknown>[];
  /** Drop every accepted connection — the "orchestrator went away" lever. */
  dropConnections: () => void;
  /** True once the client hung up — how the server learns the gate gave up. */
  connectionClosed: boolean;
}

/**
 * Start a server that answers each `shell-approval-request` using `respond`.
 * Returning `null` means "answer nothing" (the human-is-slow case).
 */
async function startOrchestrator(
  respond: (req: Record<string, unknown>) => string | null,
): Promise<StubOrchestrator> {
  // On Windows a plain fs path cannot host the AF_UNIX-style bind (EACCES
  // without elevation) — route the name through the production orchSocketEndpoint
  // seam, exactly what index.ts does at boot, so the stub binds a named pipe.
  const socketPath = orchSocketEndpoint(path.join(makeTempDir(), 's'));
  const received: Record<string, unknown>[] = [];
  const connections: net.Socket[] = [];

  const server = net.createServer((conn) => {
    connections.push(conn);
    serverConnections.push(conn);
    conn.on('close', () => {
      result.connectionClosed = true;
    });
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (raw.trim().length === 0) continue;
        const req = JSON.parse(raw) as Record<string, unknown>;
        received.push(req);
        const reply = respond(req);
        if (reply !== null) conn.write(reply);
      }
    });
    conn.on('error', () => undefined);
  });
  servers.push(server);

  const result: StubOrchestrator = {
    socketPath,
    received,
    dropConnections: () => {
      for (const conn of connections.splice(0)) conn.destroy();
    },
    connectionClosed: false,
  };

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return result;
}

/** The exact frame `writeShellVerdict` emits. */
function verdictFrame(
  requestId: string,
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason?: string,
): string {
  return (
    JSON.stringify({
      type: 'mcp-query-response',
      requestId,
      ok: true,
      data: {
        permissionDecision,
        ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
      },
    }) + '\n'
  );
}

afterEach(async () => {
  for (const conn of serverConnections.splice(0)) conn.destroy();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// requestSocketDecision
// ---------------------------------------------------------------------------

describe('requestSocketDecision', () => {
  it('sends the orchestrator wire shape verbatim, with a Claude-cased tool name', async () => {
    const orch = await startOrchestrator((req) =>
      verdictFrame(String(req['requestId']), 'allow'),
    );

    await requestSocketDecision({
      socketPath: orch.socketPath,
      runId: 'run-42',
      toolName: 'bash',
      toolInput: { command: 'ls -la' },
      logger: silentLogger,
    });

    expect(orch.received).toHaveLength(1);
    const req = orch.received[0]!;
    expect(req['type']).toBe('shell-approval-request');
    expect(req['runId']).toBe('run-42');
    // NOT 'bash': the server's acceptEdits fast-path (isAcceptEditsAutoApprovable)
    // and its permission-rule matching are both Claude-cased, so OMP's own
    // spelling could never match either.
    expect(req['toolName']).toBe('Bash');
    // The input is NOT rewritten — `command` is the key both classifiers read.
    expect(req['toolInput']).toEqual({ command: 'ls -la' });
    expect(typeof req['requestId']).toBe('string');
  });

  /**
   * The other half of the same defect: the frame is what the orchestrator sees,
   * so a unit assertion on `canonicalToolNameForOrchestrator` alone would not
   * prove the mapping is actually applied at the write. These read it back off a
   * real socket.
   */
  it('canonicalizes every mapped OMP tool name on the wire', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ['bash', 'Bash'],
      ['read', 'Read'],
      ['write', 'Write'],
      ['edit', 'Edit'],
      ['glob', 'Glob'],
      ['grep', 'Grep'],
      ['fetch', 'WebFetch'],
      ['web_search', 'WebSearch'],
      ['todo', 'TodoWrite'],
    ];

    for (const [ompName] of expected) {
      await requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: ompName,
        toolInput: {},
        logger: silentLogger,
      });
    }

    expect(orch.received.map((r) => r['toolName'])).toEqual(expected.map(([, claude]) => claude));
  });

  it('passes MCP and unmapped names through unchanged', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));

    // `mcp__foo_bar` is already the shared cross-provider spelling — rewriting it
    // would break the server's own matching. An OMP-only tool has no Claude
    // counterpart, so inventing one would be policy nobody can cite.
    for (const name of ['mcp__foo_bar', 'mcp__cyboflow_report_finding', 'task', 'browser']) {
      await requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: name,
        toolInput: {},
        logger: silentLogger,
      });
    }

    expect(orch.received.map((r) => r['toolName'])).toEqual([
      'mcp__foo_bar',
      'mcp__cyboflow_report_finding',
      'task',
      'browser',
    ]);
  });

  it('canonicalToolNameForOrchestrator is a total, case-exact function', () => {
    expect(canonicalToolNameForOrchestrator('bash')).toBe('Bash');
    expect(canonicalToolNameForOrchestrator('web_search')).toBe('WebSearch');
    // Only OMP's canonical lowercase names map; anything else is passed through
    // rather than guessed at, so an unrecognized name degrades to "ask a human".
    expect(canonicalToolNameForOrchestrator('Bash')).toBe('Bash');
    expect(canonicalToolNameForOrchestrator('BASH')).toBe('BASH');
    expect(canonicalToolNameForOrchestrator('')).toBe('');
    expect(canonicalToolNameForOrchestrator('mcp__bash')).toBe('mcp__bash');
  });

  it('resolves allow on an allow verdict', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'write',
        toolInput: {},
        logger: silentLogger,
      }),
    ).resolves.toEqual({ decision: 'allow' });
  });

  it('resolves deny and carries the human-supplied reason through', async () => {
    const orch = await startOrchestrator((req) =>
      verdictFrame(String(req['requestId']), 'deny', 'not on this branch'),
    );

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'write',
        toolInput: {},
        logger: silentLogger,
      }),
    ).resolves.toEqual({ decision: 'deny', reason: 'not on this branch' });
  });

  it('ignores frames for other requestIds and stray unparseable lines', async () => {
    const orch = await startOrchestrator(
      (req) =>
        'not json at all\n' +
        verdictFrame('some-other-request', 'deny') +
        verdictFrame(String(req['requestId']), 'allow'),
    );

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'read',
        toolInput: {},
        logger: silentLogger,
      }),
    ).resolves.toEqual({ decision: 'allow' });
  });

  it('rejects when the socket does not exist (orchestrator unreachable)', async () => {
    // Named-pipe endpoint on Windows (see startOrchestrator); the absent name
    // surfaces the same ENOENT-style connect failure the client maps to
    // "orchestrator unreachable".
    const socketPath = orchSocketEndpoint(path.join(makeTempDir(), 'absent'));

    await expect(
      requestSocketDecision({
        socketPath,
        runId: 'r',
        toolName: 'bash',
        toolInput: {},
        logger: silentLogger,
      }),
    ).rejects.toThrow(/unreachable|failing closed/i);
  });

  it('rejects when the orchestrator closes before answering', async () => {
    // On Windows a plain fs path cannot host the AF_UNIX-style bind (EACCES
  // without elevation) — route the name through the production orchSocketEndpoint
  // seam, exactly what index.ts does at boot, so the stub binds a named pipe.
  const socketPath = orchSocketEndpoint(path.join(makeTempDir(), 's'));
    const server = net.createServer((conn) => {
      serverConnections.push(conn);
      conn.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(
      requestSocketDecision({
        socketPath,
        runId: 'r',
        toolName: 'bash',
        toolInput: {},
        logger: silentLogger,
      }),
    ).rejects.toThrow(/before a decision|failing closed/i);
  });

  it('rejects on a correlated frame carrying no decision', async () => {
    const orch = await startOrchestrator(
      (req) =>
        JSON.stringify({ type: 'mcp-query-response', requestId: req['requestId'], ok: true, data: {} }) +
        '\n',
    );

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'bash',
        toolInput: {},
        logger: silentLogger,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it('rejects on an ok:false frame rather than reading its data', async () => {
    const orch = await startOrchestrator(
      (req) =>
        JSON.stringify({
          type: 'mcp-query-response',
          requestId: req['requestId'],
          ok: false,
          data: { permissionDecision: 'allow' },
        }) + '\n',
    );

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'bash',
        toolInput: {},
        logger: silentLogger,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it('keeps waiting while the human thinks, well inside the budget', async () => {
    const orch = await startOrchestrator(() => null);

    let settled = false;
    const pending = requestSocketDecision({
      socketPath: orch.socketPath,
      runId: 'r',
      toolName: 'bash',
      toolInput: {},
      logger: silentLogger,
    });
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    // Socket liveness still ends the wait early, and still THROWS — that is
    // what keeps "orchestrator down" separable from "nobody answered".
    orch.dropConnections();
    await observed;
    await expect(pending).rejects.toThrow(/failing closed/i);
  });

  it('settles as a timeout — NOT a throw — when the budget expires', async () => {
    const orch = await startOrchestrator(() => null);

    await expect(
      requestSocketDecision({
        socketPath: orch.socketPath,
        runId: 'r',
        toolName: 'bash',
        toolInput: {},
        logger: silentLogger,
        budgetMs: 60,
      }),
    ).resolves.toEqual({ decision: 'timeout' });
  });

  it('destroys the connection on budget expiry so the orchestrator sees a disconnect', async () => {
    const orch = await startOrchestrator(() => null);
    const closed = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (orch.connectionClosed) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });

    await requestSocketDecision({
      socketPath: orch.socketPath,
      runId: 'r',
      toolName: 'bash',
      toolInput: {},
      logger: silentLogger,
      budgetMs: 60,
    });

    await closed;
    expect(orch.connectionClosed).toBe(true);
  });

  it('drops the socket from the in-flight set on budget expiry', async () => {
    const orch = await startOrchestrator(() => null);
    const inFlight = new Set<net.Socket>();

    await requestSocketDecision({
      socketPath: orch.socketPath,
      runId: 'r',
      toolName: 'bash',
      toolInput: {},
      logger: silentLogger,
      budgetMs: 60,
      inFlight,
    });

    expect(inFlight.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The budget, on fake timers, at the real 25s boundary
// ---------------------------------------------------------------------------

/**
 * A stub socket so the budget can be tested at its true value without a 25s
 * wall-clock wait. Real I/O and fake timers do not mix; the injectable
 * `connect` seam exists for exactly this.
 */
function makeStubSocket(): {
  socket: net.Socket;
  emit: (event: string, arg?: unknown) => void;
  destroyed: () => boolean;
  /** The requestId of the frame the gate wrote, for correlating a reply. */
  requestId: () => string;
} {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const written: string[] = [];
  let wasDestroyed = false;
  const on = (event: string, cb: (arg?: unknown) => void): net.Socket => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return socket;
  };
  const socket = {
    on,
    once: on,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => undefined,
    destroy: () => {
      wasDestroyed = true;
    },
  } as unknown as net.Socket;

  return {
    socket,
    emit: (event, arg) => (handlers.get(event) ?? []).slice().forEach((h) => h(arg)),
    destroyed: () => wasDestroyed,
    requestId: () => {
      const frame = JSON.parse(written[0] ?? '{}') as { requestId?: string };
      return frame.requestId ?? '';
    },
  };
}

describe('the human-decision budget at its real value', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`expires at exactly ${HUMAN_DECISION_BUDGET_MS}ms, 5s inside OMP's 30s cap`, async () => {
    vi.useFakeTimers();
    const stub = makeStubSocket();

    const pending = requestSocketDecision({
      socketPath: '/unused',
      runId: 'r',
      toolName: 'bash',
      toolInput: {},
      logger: silentLogger,
      connect: () => stub.socket,
    });
    stub.emit('connect');

    await vi.advanceTimersByTimeAsync(HUMAN_DECISION_BUDGET_MS - 1);
    expect(stub.destroyed()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ decision: 'timeout' });
    expect(stub.destroyed()).toBe(true);
    // 5s of margin for the block to travel back before OMP aborts the handler.
    expect(HUMAN_DECISION_BUDGET_MS).toBe(25_000);
  });

  it('lets a verdict arriving at 24.9s win the race', async () => {
    vi.useFakeTimers();
    const stub = makeStubSocket();

    const pending = requestSocketDecision({
      socketPath: '/unused',
      runId: 'r',
      toolName: 'bash',
      toolInput: {},
      logger: silentLogger,
      connect: () => stub.socket,
    });
    stub.emit('connect');

    await vi.advanceTimersByTimeAsync(24_900);
    // The real server correlates by requestId; read it off the written frame.
    stub.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'mcp-query-response',
          requestId: stub.requestId(),
          ok: true,
          data: { permissionDecision: 'allow' },
        }) + '\n',
      ),
    );

    await expect(pending).resolves.toEqual({ decision: 'allow' });

    // Advancing past the budget must not disturb the settled promise.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.destroyed()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The handler end to end
// ---------------------------------------------------------------------------

function runtimeFor(socketPath: string | undefined, overrides: Partial<OmpGateRuntime> = {}): OmpGateRuntime {
  return {
    config: { ...MOST_RESTRICTIVE_GATE_CONFIG },
    runId: 'run-1',
    socketPath,
    logger: silentLogger,
    inFlight: new Set<net.Socket>(),
    ...overrides,
  };
}

function toolCall(toolName: string, input: Record<string, unknown> = {}): OmpToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId: 'call-1', input };
}

describe('createToolCallHandler', () => {
  it('returns undefined (no opinion) when the human approves', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));
    const handler = createToolCallHandler(runtimeFor(orch.socketPath));

    await expect(handler(toolCall('bash', { command: 'ls' }))).resolves.toBeUndefined();
  });

  it('returns a block carrying the human deny reason', async () => {
    const orch = await startOrchestrator((req) =>
      verdictFrame(String(req['requestId']), 'deny', 'too risky'),
    );
    const handler = createToolCallHandler(runtimeFor(orch.socketPath));

    const result = await handler(toolCall('bash', { command: 'rm -rf /' }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('too risky');
  });

  it('THROWS when the orchestrator is unreachable — OMP turns that into a block', async () => {
    const handler = createToolCallHandler(runtimeFor(path.join(makeTempDir(), 'absent')));

    await expect(handler(toolCall('bash'))).rejects.toThrow(/failing closed/i);
  });

  it(`THROWS when ${ENV_ORCH_SOCKET} is unset — there is nobody to ask`, async () => {
    const handler = createToolCallHandler(runtimeFor(undefined));

    await expect(handler(toolCall('bash'))).rejects.toThrow(new RegExp(ENV_ORCH_SOCKET));
  });

  it('never touches the socket for a locally decided call', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'deny'));
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: { ...MOST_RESTRICTIVE_GATE_CONFIG, autoAllowTools: ['read'] },
      }),
    );

    await expect(handler(toolCall('read', { path: '/x' }))).resolves.toBeUndefined();
    expect(orch.received).toHaveLength(0);
  });

  /**
   * The remote-target narrowing, observed at the seam that actually matters.
   * `decideToolCall` returning `'ask'` is only half the claim — what makes an
   * `ssh://` read safe is that a REQUEST REACHES THE ORCHESTRATOR and a human
   * verdict comes back. OMP's `read`/`grep` escalate themselves to exec tier on
   * an `ssh://` path (read.ts:401, grep.ts:906), so this is the difference
   * between "cyboflow read a remote host over the user's SSH credentials with
   * nobody watching" and "cyboflow asked".
   */
  it('routes an ssh:// read to the human even though `read` is auto-allowed', async () => {
    const orch = await startOrchestrator((req) =>
      verdictFrame(String(req['requestId']), 'deny', 'no remote reads on this run'),
    );
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: { ...MOST_RESTRICTIVE_GATE_CONFIG, autoAllowTools: ['read'] },
      }),
    );

    const result = await handler(toolCall('read', { path: 'ssh://user@host/etc/shadow' }));

    expect(orch.received).toHaveLength(1);
    expect(orch.received[0]?.['toolName']).toBe('Read');
    expect(orch.received[0]?.['toolInput']).toEqual({ path: 'ssh://user@host/etc/shadow' });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('no remote reads on this run');
  });

  /**
   * The rung observed where the defect actually bit. `decideToolCall` returning
   * `allow` is only half the claim — what broke the live sprint was that the
   * call REACHED the socket, waited out the 25s budget nobody was there to
   * answer, and came back blocked. So the assertion that matters is zero socket
   * traffic, with the orchestrator stubbed to DENY so a leaked request could not
   * pass silently.
   */
  it('runs a lane commit locally in acceptEdits — no socket round-trip at all', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'deny'));
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: { ...MOST_RESTRICTIVE_GATE_CONFIG, permissionMode: 'acceptEdits' },
      }),
    );

    await expect(handler(toolCall('bash', { command: 'git status' }))).resolves.toBeUndefined();
    await expect(
      handler(toolCall('bash', { command: 'git add -A && git commit -m "task"' })),
    ).resolves.toBeUndefined();
    expect(orch.received).toHaveLength(0);

    // …and a push still goes to the human, Claude-cased on the wire.
    const pushed = await handler(toolCall('bash', { command: 'git push' }));
    expect(orch.received).toHaveLength(1);
    expect(orch.received[0]?.['toolName']).toBe('Bash');
    expect(orch.received[0]?.['toolInput']).toEqual({ command: 'git push' });
    expect(pushed?.block).toBe(true);
  });

  it('routes an ssh:// write to the human in acceptEdits mode', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: {
          ...MOST_RESTRICTIVE_GATE_CONFIG,
          permissionMode: 'acceptEdits',
          editTools: ['write'],
        },
      }),
    );

    // Local write: the edit-tool allowance stands, no socket traffic.
    await expect(handler(toolCall('write', { path: '/repo/x.ts' }))).resolves.toBeUndefined();
    expect(orch.received).toHaveLength(0);

    // Remote write: the same tool, the same mode, but a human decides.
    await expect(handler(toolCall('write', { path: 'ssh://host/x.ts' }))).resolves.toBeUndefined();
    expect(orch.received).toHaveLength(1);
  });

  it('leaves dontAsk log-only — a remote target there still never asks', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'deny'));
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: {
          ...MOST_RESTRICTIVE_GATE_CONFIG,
          permissionMode: 'dontAsk',
          autoAllowTools: ['read'],
        },
      }),
    );

    await expect(handler(toolCall('read', { path: 'ssh://host/x' }))).resolves.toBeUndefined();
    expect(orch.received).toHaveLength(0);
  });

  it('blocks a disallowed tool without asking the human', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));
    const handler = createToolCallHandler(
      runtimeFor(orch.socketPath, {
        config: { ...MOST_RESTRICTIVE_GATE_CONFIG, disallowedTools: ['bash'] },
      }),
    );

    const result = await handler(toolCall('bash'));
    expect(result?.block).toBe(true);
    expect(orch.received).toHaveLength(0);
  });

  it('returns a BLOCK (not a throw) when the human decision budget expires', async () => {
    const orch = await startOrchestrator(() => null);
    const handler = createToolCallHandler(runtimeFor(orch.socketPath, { budgetMs: 60 }));

    const result = await handler(toolCall('bash', { command: 'ls' }));

    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/no decision arrived within 25s/i);
    // The sentence has to tell the model what to do next, not just that it failed.
    expect(result?.reason).toMatch(/retry|permission mode/i);
  });

  it('distinguishes budget expiry from orchestrator-down: one blocks, the other throws', async () => {
    const slow = await startOrchestrator(() => null);
    const blocked = await createToolCallHandler(
      runtimeFor(slow.socketPath, { budgetMs: 60 }),
    )(toolCall('bash'));
    expect(blocked?.block).toBe(true);

    const down = createToolCallHandler(
      runtimeFor(path.join(makeTempDir(), 'absent'), { budgetMs: 60 }),
    );
    await expect(down(toolCall('bash'))).rejects.toThrow(/unreachable|failing closed/i);
  });

  it('deregisters the socket from the in-flight set once a verdict lands', async () => {
    const orch = await startOrchestrator((req) => verdictFrame(String(req['requestId']), 'allow'));
    const runtime = runtimeFor(orch.socketPath);
    const handler = createToolCallHandler(runtime);

    await handler(toolCall('bash'));
    expect(runtime.inFlight.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The load sentinel
// ---------------------------------------------------------------------------

describe('writeGateSentinel', () => {
  it('writes {loadedAt, runId, pid} to the configured path', () => {
    const sentinelPath = path.join(makeTempDir(), 'sentinel.json');

    expect(writeGateSentinel(sentinelPath, 'run-9', silentLogger)).toBe(true);

    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as OmpGateSentinel;
    expect(sentinel.runId).toBe('run-9');
    expect(sentinel.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(sentinel.loadedAt))).toBe(false);
  });

  it('reports failure without creating a file when the path is unwritable', () => {
    const sentinelPath = path.join(makeTempDir(), 'no-such-dir', 'sentinel.json');

    expect(writeGateSentinel(sentinelPath, 'run-9', silentLogger)).toBe(false);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('reports failure when the sentinel path is unset', () => {
    expect(writeGateSentinel(undefined, 'run-9', silentLogger)).toBe(false);
    expect(writeGateSentinel('  ', 'run-9', silentLogger)).toBe(false);
  });
});
