/**
 * Tests for questionShellHook.ts — the interactive-substrate "parked on an
 * AskUserQuestion gate" side channel. Mirrors stopShellHook.test.ts: a stubbed
 * net.Socket whose lifecycle the test drives, asserting the wire frame and that
 * every path resolves (this script must exit 0 unconditionally — see its header).
 */
import { describe, it, expect, vi } from 'vitest';
import * as net from 'net';
import { EventEmitter } from 'events';
import {
  runQuestionHook,
  resolveQuestionHookEnv,
  drainStdin,
  type QuestionHookLogger,
} from '../questionShellHook';

const silentLogger: QuestionHookLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeStubSocket(): {
  socket: net.Socket;
  requests: string[];
  pushAck: (requestId: string) => void;
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

  queueMicrotask(() => emit('connect'));

  return {
    socket,
    requests,
    pushAck: (requestId) => {
      const line = JSON.stringify({ type: 'mcp-query-response', requestId, ok: true }) + '\n';
      emit('data', Buffer.from(line, 'utf8'));
    },
    emitClose: () => emit('close'),
    emitError: (err: Error) => emit('error', err),
  };
}

function requestIdOf(requests: string[]): string {
  const msg = JSON.parse(requests[0].trim()) as { requestId: string };
  return msg.requestId;
}

describe('resolveQuestionHookEnv', () => {
  it('returns null when either env var is missing', () => {
    expect(resolveQuestionHookEnv({})).toBeNull();
    expect(resolveQuestionHookEnv({ CYBOFLOW_ORCH_SOCKET: '/tmp/x.sock' })).toBeNull();
    expect(resolveQuestionHookEnv({ CYBOFLOW_RUN_ID: 'run-1' })).toBeNull();
  });

  it('returns { socketPath, runId } when both are present', () => {
    expect(
      resolveQuestionHookEnv({ CYBOFLOW_ORCH_SOCKET: '/tmp/x.sock', CYBOFLOW_RUN_ID: 'run-1' }),
    ).toEqual({ socketPath: '/tmp/x.sock', runId: 'run-1' });
  });
});

describe('drainStdin', () => {
  it('resolves on "end" and on "error" (never rejects)', async () => {
    const s1 = new EventEmitter();
    const p1 = drainStdin(s1 as unknown as NodeJS.ReadableStream);
    s1.emit('data', Buffer.from('{"payload":1}'));
    s1.emit('end');
    await expect(p1).resolves.toBeUndefined();

    const s2 = new EventEmitter();
    const p2 = drainStdin(s2 as unknown as NodeJS.ReadableStream);
    s2.emit('error', new Error('boom'));
    await expect(p2).resolves.toBeUndefined();
  });
});

describe('runQuestionHook', () => {
  it('sends an interactive-question-open frame carrying the runId, then resolves on ack', async () => {
    const stub = makeStubSocket();
    const promise = runQuestionHook({
      socketPath: '/unused.sock',
      runId: 'run-1',
      logger: silentLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    const sent = JSON.parse(stub.requests[0].trim()) as { type: string; runId: string; requestId: string };
    expect(sent.type).toBe('interactive-question-open');
    expect(sent.runId).toBe('run-1');
    expect(typeof sent.requestId).toBe('string');

    stub.pushAck(requestIdOf(stub.requests));
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on socket close/error before an ack (never blocks the question)', async () => {
    const close = makeStubSocket();
    const p1 = runQuestionHook({ socketPath: '/x', runId: 'r', logger: silentLogger, connect: () => close.socket });
    await vi.waitFor(() => expect(close.requests.length).toBeGreaterThanOrEqual(1));
    close.emitClose();
    await expect(p1).resolves.toBeUndefined();

    const err = makeStubSocket();
    const p2 = runQuestionHook({ socketPath: '/x', runId: 'r', logger: silentLogger, connect: () => err.socket });
    await vi.waitFor(() => expect(err.requests.length).toBeGreaterThanOrEqual(1));
    err.emitError(new Error('ECONNRESET'));
    await expect(p2).resolves.toBeUndefined();
  });

  it('resolves within the hard ACK timeout when the orchestrator never responds', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStubSocket();
      const promise = runQuestionHook({
        socketPath: '/unused.sock',
        runId: 'run-4',
        logger: silentLogger,
        connect: () => stub.socket,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);

      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
