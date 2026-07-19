import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Fake fs.WriteStream registry
//
// devDebugLog lazily opens ONE stream per log file and caches it, so the mock
// hands back a fresh recording fake per path and keeps them addressable so the
// tests can inspect written lines in order.
// ---------------------------------------------------------------------------

interface FakeWriteStream {
  writes: string[];
  errorHandler: ((err: Error) => void) | null;
  write: (chunk: string, cb?: (err?: Error | null) => void) => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => FakeWriteStream;
  end: (cb?: () => void) => void;
}

const fakeStreams = new Map<string, FakeWriteStream>();
let createWriteStreamThrows = false;

function makeFakeStream(): FakeWriteStream {
  const stream: FakeWriteStream = {
    writes: [],
    errorHandler: null,
    // Record the chunk and fire the callback ASYNCHRONOUSLY, like a real stream,
    // so the buffered-queue + flush-waiter path is actually exercised.
    write(chunk, cb) {
      this.writes.push(chunk);
      if (cb) queueMicrotask(() => cb());
      return true;
    },
    on(event, handler) {
      if (event === 'error') this.errorHandler = handler as (err: Error) => void;
      return this;
    },
    end() {},
  };
  return stream;
}

vi.mock('fs', () => ({
  createWriteStream: vi.fn((filePath: string) => {
    if (createWriteStreamThrows) throw new Error('open failed');
    const s = makeFakeStream();
    fakeStreams.set(filePath, s);
    return s;
  }),
}));

import * as fs from 'fs';
import {
  getDevDebugLogPath,
  appendDevDebugLog,
  formatConsoleArgs,
  flushDevDebugLogs,
  __resetDevDebugWritersForTests,
} from './devDebugLog';

// Derive expected filenames from the helper itself so there is no second copy
// of the filename literal in this file (keeping the single-source-for-filenames
// property).
const frontendPath = getDevDebugLogPath('frontend');
const backendPath = getDevDebugLogPath('backend');

describe('getDevDebugLogPath', () => {
  it('returns the frontend debug log path under process.cwd()', () => {
    expect(frontendPath).toBe(path.join(process.cwd(), path.basename(frontendPath)));
    expect(path.basename(frontendPath)).toMatch(/^cyboflow-.*-debug\.log$/);
    expect(path.dirname(frontendPath)).toBe(process.cwd());
  });
  it('returns the backend debug log path under process.cwd()', () => {
    expect(backendPath).toBe(path.join(process.cwd(), path.basename(backendPath)));
    expect(path.basename(backendPath)).toMatch(/^cyboflow-.*-debug\.log$/);
    expect(path.dirname(backendPath)).toBe(process.cwd());
  });
  it('frontend and backend paths are distinct', () => {
    expect(frontendPath).not.toBe(backendPath);
  });
});

describe('appendDevDebugLog + flushDevDebugLogs', () => {
  beforeEach(() => {
    __resetDevDebugWritersForTests();
    fakeStreams.clear();
    createWriteStreamThrows = false;
    vi.mocked(fs.createWriteStream).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the stream in append mode lazily on first write', () => {
    appendDevDebugLog('backend', 'log', 'BACKEND', 'hello');
    expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
    const [calledPath, opts] = vi.mocked(fs.createWriteStream).mock.calls[0];
    expect(calledPath).toBe(backendPath);
    expect(opts).toMatchObject({ flags: 'a' });
  });

  it('writes a formatted line to the frontend file', async () => {
    appendDevDebugLog('frontend', 'log', 'FRONTEND', 'hello');
    await flushDevDebugLogs();
    const stream = fakeStreams.get(frontendPath);
    expect(stream).toBeDefined();
    expect(stream!.writes).toHaveLength(1);
    expect(stream!.writes[0]).toMatch(/^\[.*\] \[FRONTEND LOG\] hello\n$/);
  });

  it('writes a formatted line to the backend file with the level uppercased', async () => {
    appendDevDebugLog('backend', 'error', 'BACKEND', 'oops');
    await flushDevDebugLogs();
    const stream = fakeStreams.get(backendPath);
    expect(stream!.writes[0]).toMatch(/^\[.*\] \[BACKEND ERROR\] oops\n$/);
  });

  it('reuses a single stream per file across many writes', async () => {
    appendDevDebugLog('backend', 'log', 'BACKEND', 'a');
    appendDevDebugLog('backend', 'log', 'BACKEND', 'b');
    await flushDevDebugLogs();
    // createWriteStream opened the backend file exactly once.
    const backendOpens = vi
      .mocked(fs.createWriteStream)
      .mock.calls.filter(([p]) => p === backendPath);
    expect(backendOpens).toHaveLength(1);
  });

  it('preserves strict line order for a single stream', async () => {
    const messages = ['line-1', 'line-2', 'line-3', 'line-4', 'line-5'];
    for (const m of messages) {
      appendDevDebugLog('backend', 'log', 'BACKEND', m);
    }
    await flushDevDebugLogs();
    const stream = fakeStreams.get(backendPath)!;
    expect(stream.writes).toHaveLength(messages.length);
    // The message text appears in the same order it was appended.
    expect(stream.writes.map((w) => w.match(/\] (line-\d)\n$/)?.[1])).toEqual(messages);
  });

  it('flushDevDebugLogs resolves only after buffered writes complete', async () => {
    appendDevDebugLog('backend', 'log', 'BACKEND', 'x');
    appendDevDebugLog('backend', 'log', 'BACKEND', 'y');
    // The flush promise must not have resolved synchronously — writes drain on
    // microtasks. Await it, then assert everything landed.
    let resolved = false;
    const p = flushDevDebugLogs().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
    expect(fakeStreams.get(backendPath)!.writes).toHaveLength(2);
  });

  it('flushDevDebugLogs resolves immediately when nothing is buffered (prod no-op)', async () => {
    // No appendDevDebugLog calls — mirrors production, where these helpers are
    // never fed. Flush must resolve without opening any stream.
    await expect(flushDevDebugLogs()).resolves.toBeUndefined();
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  it('swallows a createWriteStream failure and reports via originalConsole', async () => {
    createWriteStreamThrows = true;
    const errSpy = vi.fn();
    expect(() =>
      appendDevDebugLog('frontend', 'log', 'X', 'm', { error: errSpy })
    ).not.toThrow();
    // The failed-open drops the backlog; flush must still resolve (never hang).
    await expect(flushDevDebugLogs()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('reports an async stream error via originalConsole and reopens on next write', async () => {
    const errSpy = vi.fn();
    appendDevDebugLog('backend', 'log', 'BACKEND', 'first', { error: errSpy });
    await flushDevDebugLogs();
    const firstStream = fakeStreams.get(backendPath)!;

    // Simulate an async stream error (e.g. EPIPE) — the writer drops the stream.
    firstStream.errorHandler?.(new Error('EPIPE'));
    expect(errSpy).toHaveBeenCalled();

    // The next write lazily reopens a fresh stream (createWriteStream runs again).
    appendDevDebugLog('backend', 'log', 'BACKEND', 'second');
    await flushDevDebugLogs();
    const backendOpens = vi
      .mocked(fs.createWriteStream)
      .mock.calls.filter(([p]) => p === backendPath);
    expect(backendOpens.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatConsoleArgs', () => {
  it('joins multiple string arguments with single spaces', () => {
    expect(formatConsoleArgs(['hello', 'world', 'foo'])).toBe('hello world foo');
  });

  it('JSON-stringifies plain objects with 2-space indent', () => {
    const obj = { a: 1, b: 'two' };
    const result = formatConsoleArgs([obj]);
    expect(result).toBe(JSON.stringify(obj, null, 2));
  });

  it('renders Error instances as `Error: {message}\\nStack: {stack}`', () => {
    const err = new Error('something went wrong');
    const result = formatConsoleArgs([err]);
    expect(result).toBe(`Error: ${err.message}\nStack: ${err.stack}`);
  });

  it('handles circular-structure objects without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatConsoleArgs([circular])).not.toThrow();
    expect(formatConsoleArgs([circular])).toContain('[Object with circular structure:');
  });

  it('handles null and undefined via String()', () => {
    expect(formatConsoleArgs([null, undefined])).toBe('null undefined');
  });

  it('mixes strings, numbers, and objects correctly', () => {
    const result = formatConsoleArgs(['count:', 42, { ok: true }]);
    expect(result).toBe(`count: 42 ${JSON.stringify({ ok: true }, null, 2)}`);
  });
});
