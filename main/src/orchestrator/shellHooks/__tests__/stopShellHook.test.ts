/**
 * Tests for stopShellHook.ts (IDEA-030 turn-end-detection fix) — the
 * deterministic Stop-hook side channel that notifies the orchestrator a run's
 * turn ended, since newer `claude` CLIs (2.1.207+) stopped reliably emitting
 * the transcript markers the transcript-tail path relies on.
 *
 * Mirrors the preToolUseShellHook test style in shellApprovalRouting.test.ts:
 * a stubbed net.Socket whose lifecycle the test drives (connect/data/close/
 * error), asserting on the request the hook writes and the terminal outcome.
 *
 * The one hard invariant under test throughout: every path resolves (this
 * script must exit 0 unconditionally — see the header of stopShellHook.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import * as net from 'net';
import { EventEmitter } from 'events';
import {
  runStopHook,
  resolveStopHookEnv,
  drainStdin,
  type StopHookLogger,
} from '../stopShellHook';

const silentLogger: StopHookLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Stub socket — mirrors shellApprovalRouting.test.ts's makeStubSocket
// ---------------------------------------------------------------------------

function makeStubSocket(): {
  socket: net.Socket;
  requests: string[];
  pushAck: (requestId: string) => void;
  emitRawData: (raw: string) => void;
  emitClose: () => void;
  emitError: (err: Error) => void;
} {
  const requests: string[] = [];
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const on = (event: string, cb: (arg?: unknown) => void): net.Socket => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return socket;
  };
  const emit = (event: string, arg?: unknown): void => {
    (handlers.get(event) ?? []).slice().forEach((h) => h(arg));
  };
  const socket = {
    on,
    once: on,
    write: (chunk: string | Buffer) => {
      requests.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end: () => undefined,
    destroy: () => undefined,
  } as unknown as net.Socket;

  // Fire 'connect' on the next tick so the hook writes its request.
  queueMicrotask(() => emit('connect'));

  return {
    socket,
    requests,
    pushAck: (requestId) => {
      const line = JSON.stringify({ type: 'mcp-query-response', requestId, ok: true }) + '\n';
      emit('data', Buffer.from(line, 'utf8'));
    },
    emitRawData: (raw: string) => emit('data', Buffer.from(raw, 'utf8')),
    emitClose: () => emit('close'),
    emitError: (err: Error) => emit('error', err),
  };
}

/** Extract the requestId the hook generated from its written request line. */
function requestIdOf(requests: string[]): string {
  const msg = JSON.parse(requests[0].trim()) as { requestId: string; type: string; runId: string };
  return msg.requestId;
}

// ---------------------------------------------------------------------------
// resolveStopHookEnv
// ---------------------------------------------------------------------------

describe('resolveStopHookEnv', () => {
  it('returns null when both env vars are missing', () => {
    expect(resolveStopHookEnv({})).toBeNull();
  });

  it('returns null when only CYBOFLOW_ORCH_SOCKET is present', () => {
    expect(resolveStopHookEnv({ CYBOFLOW_ORCH_SOCKET: '/tmp/x.sock' })).toBeNull();
  });

  it('returns null when only CYBOFLOW_RUN_ID is present', () => {
    expect(resolveStopHookEnv({ CYBOFLOW_RUN_ID: 'run-1' })).toBeNull();
  });

  it('returns { socketPath, runId } when both are present', () => {
    expect(
      resolveStopHookEnv({ CYBOFLOW_ORCH_SOCKET: '/tmp/x.sock', CYBOFLOW_RUN_ID: 'run-1' }),
    ).toEqual({ socketPath: '/tmp/x.sock', runId: 'run-1' });
  });
});

// ---------------------------------------------------------------------------
// drainStdin
// ---------------------------------------------------------------------------

describe('drainStdin', () => {
  it('resolves on stdin "end", discarding any data', async () => {
    const stream = new EventEmitter();
    const promise = drainStdin(stream as unknown as NodeJS.ReadableStream);
    stream.emit('data', Buffer.from('{"some":"stop payload"}'));
    stream.emit('end');
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves (does not reject) on stdin "error"', async () => {
    const stream = new EventEmitter();
    const promise = drainStdin(stream as unknown as NodeJS.ReadableStream);
    stream.emit('error', new Error('boom'));
    await expect(promise).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runStopHook — the stdin→socket flow
// ---------------------------------------------------------------------------

describe('runStopHook', () => {
  it('sends an interactive-turn-end frame carrying the runId, then resolves on ack', async () => {
    const stub = makeStubSocket();
    const promise = runStopHook({
      socketPath: '/unused.sock',
      runId: 'run-1',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    const sent = JSON.parse(stub.requests[0].trim()) as { type: string; runId: string; requestId: string };
    expect(sent.type).toBe('interactive-turn-end');
    expect(sent.runId).toBe('run-1');
    expect(typeof sent.requestId).toBe('string');

    stub.pushAck(requestIdOf(stub.requests));
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on socket close before an ack (orchestrator down — never blocks the stop)', async () => {
    const stub = makeStubSocket();
    const promise = runStopHook({
      socketPath: '/unused.sock',
      runId: 'run-2',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.emitClose();

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on socket error before an ack', async () => {
    const stub = makeStubSocket();
    const promise = runStopHook({
      socketPath: '/unused.sock',
      runId: 'run-3',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.emitError(new Error('ECONNRESET'));

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves within the hard ACK timeout when the orchestrator never responds', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStubSocket();
      const promise = runStopHook({
        socketPath: '/unused.sock',
        runId: 'run-4',
        logger: silentLogger,
        connect: () => stub.socket,
      });

      // Let the queued 'connect' microtask fire and the request be written.
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);

      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // Just under the bound: still pending.
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);

      // Crossing the bound resolves it — no ack ever arrived.
      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a data frame carrying a mismatched requestId and still resolves on the real ack', async () => {
    const stub = makeStubSocket();
    const promise = runStopHook({
      socketPath: '/unused.sock',
      runId: 'run-5',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.pushAck('some-other-requestId');
    stub.pushAck(requestIdOf(stub.requests));

    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores malformed JSON on the socket without throwing, and still resolves on close', async () => {
    const stub = makeStubSocket();
    const promise = runStopHook({
      socketPath: '/unused.sock',
      runId: 'run-6',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.emitRawData('not json\n');
    stub.emitClose();

    await expect(promise).resolves.toBeUndefined();
  });
});
