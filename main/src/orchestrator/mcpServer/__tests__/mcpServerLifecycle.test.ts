/**
 * Unit tests for McpServerLifecycle.
 *
 * All tests are hermetic — no real subprocess is spawned.  child_process.spawn
 * is mocked via vi.mock and a FakeChildProcess event emitter is used in its
 * place.
 *
 * Four behaviours under test per the TASK-454 test strategy:
 *
 * 1. After 2 consecutive non-zero exits, getStatus() returns 'failed' and no
 *    further spawn fires (restart-state-machine AC).
 *
 * 2. stderr data from the subprocess is forwarded to the injected logger with
 *    the [Cyboflow MCP] prefix; multi-line chunks are split correctly.
 *
 * 3. stdout data from the subprocess is NOT forwarded to the logger (MCP
 *    protocol-stream isolation).
 *
 * 4. stop() on a running lifecycle SIGTERMs first; if the process does not
 *    exit within 2 s it SIGKILLs; status transitions to 'stopped'.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as mockFs from 'fs';

// ---------------------------------------------------------------------------
// FakeChildProcess
// ---------------------------------------------------------------------------

/**
 * Minimal ChildProcess test double.
 *
 * Exposes .stdin, .stdout, .stderr as EventEmitters so tests can push data,
 * and tracks kill() invocations for assertion.
 */
class FakeChildProcess extends EventEmitter {
  readonly stdin: EventEmitter = new EventEmitter();
  readonly stdout: EventEmitter = new EventEmitter();
  readonly stderr: EventEmitter = new EventEmitter();

  pid: number | undefined = 12345;
  exitCode: number | null = null;
  killed = false;

  readonly killCalls: string[] = [];

  kill(signal?: string): boolean {
    const sig = signal ?? 'SIGTERM';
    this.killCalls.push(sig);
    if (sig === 'SIGKILL') {
      this.killed = true;
    }
    return true;
  }

  /** Simulate the process exiting with a given code. */
  simulateExit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let spawnCallCount = 0;
let currentFake: FakeChildProcess | null = null;

// Mock child_process so no real process is spawned.
vi.mock('child_process', () => ({
  spawn: vi.fn((): ChildProcess => {
    spawnCallCount++;
    const fake = new FakeChildProcess();
    currentFake = fake;
    return fake as unknown as ChildProcess;
  }),
}));

// Mock scriptPath to avoid touching the real filesystem / electron.
vi.mock('../scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/path/cyboflowMcpServer.js'),
}));

// Mock nodeFinder to return a deterministic path without async discovery.
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/node')),
}));

// Mock fs.existsSync so the "script not found" guard always passes.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// ---------------------------------------------------------------------------
// Import the class.  vi.mock calls are hoisted by Vitest so the mocks are in
// place before the module under test resolves its own imports.
// ---------------------------------------------------------------------------

import { McpServerLifecycle } from '../mcpServerLifecycle';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
// These resolve to the hoisted mocks above; used to drive/inspect the spawn.
import { spawn } from 'child_process';
import { findNodeExecutable } from '../../../utils/nodeFinder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOCKET_PATH = '/tmp/test-orch.sock';

function makeLifecycle(loggerOverride?: ReturnType<typeof makeSpyLogger>) {
  const logger = loggerOverride ?? makeSpyLogger();
  const lifecycle = new McpServerLifecycle(
    SOCKET_PATH,
    logger,
    () => 'orchestrator',
  );
  return { lifecycle, logger };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  spawnCallCount = 0;
  currentFake = null;
  vi.clearAllMocks();
  // Re-apply the fs.existsSync mock so the "script not found" guard passes.
  vi.mocked(mockFs.existsSync).mockReturnValue(true);
});

afterEach(async () => {
  // Drain any pending timers so tests don't bleed into each other.
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test suite 1: restart state machine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test suite 0: fork-bomb guard (ELECTRON_RUN_AS_NODE)
//
// In a packaged app with no standalone `node` on PATH, findNodeExecutable()
// returns process.execPath — the app binary. Spawning it MUST run in Node mode
// (ELECTRON_RUN_AS_NODE=1), else each spawn boots a new app instance that boots
// its own MCP lifecycle → an exponential, unkillable loop of app windows.
// ---------------------------------------------------------------------------

describe('McpServerLifecycle — fork-bomb guard', () => {
  function envOfSpawn(callIndex: number): Record<string, string> {
    const opts = vi.mocked(spawn).mock.calls[callIndex][2] as { env: Record<string, string> };
    return opts.env;
  }

  it('sets ELECTRON_RUN_AS_NODE=1 when the resolved node IS the app binary (process.execPath)', async () => {
    vi.useFakeTimers();
    vi.mocked(findNodeExecutable).mockResolvedValueOnce(process.execPath);

    const { lifecycle } = makeLifecycle();
    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(spawnCallCount).toBe(1);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(process.execPath);
    expect(envOfSpawn(0).ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('does NOT set ELECTRON_RUN_AS_NODE when a real standalone node binary is resolved', async () => {
    vi.useFakeTimers();
    vi.mocked(findNodeExecutable).mockResolvedValueOnce('/opt/homebrew/bin/node');

    const { lifecycle } = makeLifecycle();
    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(spawnCallCount).toBe(1);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe('/opt/homebrew/bin/node');
    expect(envOfSpawn(0).ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe('McpServerLifecycle — restart state machine', () => {
  it('transitions to "failed" after 2 restart attempts (3 total spawn calls)', async () => {
    vi.useFakeTimers();

    const { lifecycle, logger } = makeLifecycle();

    // Start — first spawn.
    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(spawnCallCount).toBe(1);
    // Simulate first crash.
    currentFake!.simulateExit(1);

    // Advance 1 s for first backoff.
    await vi.advanceTimersByTimeAsync(1000);
    // Allow the restarted _spawn() to settle (200 ms bootstrap wait).
    await vi.advanceTimersByTimeAsync(300);

    expect(spawnCallCount).toBe(2);
    // Simulate second crash.
    currentFake!.simulateExit(1);

    // Advance 5 s for second backoff.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(300);

    expect(spawnCallCount).toBe(3);
    // Simulate third crash — now beyond MAX_RESTARTS.
    currentFake!.simulateExit(1);

    // Drain any residual timers.
    await vi.runAllTimersAsync();

    expect(lifecycle.getStatus()).toBe('failed');
    expect(spawnCallCount).toBe(3); // No fourth spawn.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unrecoverable after 2 restarts'),
    );
  });

  it('resets the restart budget after stop() + start() following "failed" state', async () => {
    vi.useFakeTimers();

    const { lifecycle } = makeLifecycle();

    // ---- First run: exhaust all restarts → 'failed'. ----
    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    // Crash 1 (spawn 1 → triggers attempt 1 restart → spawn 2).
    currentFake!.simulateExit(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(300);

    // Crash 2 (spawn 2 → triggers attempt 2 restart → spawn 3).
    currentFake!.simulateExit(1);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(300);

    // Crash 3 (spawn 3 → no more retries → 'failed').
    currentFake!.simulateExit(1);
    await vi.runAllTimersAsync();

    expect(lifecycle.getStatus()).toBe('failed');
    expect(spawnCallCount).toBe(3);

    // ---- Recovery: stop() then start() from 'failed'. ----
    await lifecycle.stop();

    const recoverPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await recoverPromise;

    expect(lifecycle.getStatus()).toBe('running');
    expect(spawnCallCount).toBe(4); // Fresh spawn after recovery.

    // ---- Verify a fresh 3-attempt budget is available. ----
    // Crash 1 of new cycle.
    currentFake!.simulateExit(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCallCount).toBe(5);

    // Crash 2 of new cycle.
    currentFake!.simulateExit(1);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCallCount).toBe(6);

    // Crash 3 of new cycle → 'failed' again (not stuck after 1 retry).
    currentFake!.simulateExit(1);
    await vi.runAllTimersAsync();

    expect(lifecycle.getStatus()).toBe('failed');
    expect(spawnCallCount).toBe(6); // No 7th spawn.
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: stderr → logger routing
// ---------------------------------------------------------------------------

describe('McpServerLifecycle — stderr routing', () => {
  it('forwards each stderr line to logger.info with [Cyboflow MCP] prefix', async () => {
    vi.useFakeTimers();

    const { lifecycle, logger } = makeLifecycle();

    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    // Emit a multi-line chunk on stderr.
    const chunk = Buffer.from('line1\nline2\n');
    currentFake!.stderr.emit('data', chunk);

    expect(logger.info).toHaveBeenCalledWith('[Cyboflow MCP] line1');
    expect(logger.info).toHaveBeenCalledWith('[Cyboflow MCP] line2');
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('ignores empty lines in stderr chunks (whitespace-only trimmed away)', async () => {
    vi.useFakeTimers();

    const { lifecycle, logger } = makeLifecycle();

    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    const chunk = Buffer.from('\n\n  \n');
    currentFake!.stderr.emit('data', chunk);

    // No logger calls for blank lines.
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: stdout NOT routed to logger
// ---------------------------------------------------------------------------

describe('McpServerLifecycle — stdout isolation', () => {
  it('does NOT forward stdout data to the logger (MCP protocol stream)', async () => {
    vi.useFakeTimers();

    const { lifecycle, logger } = makeLifecycle();

    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    // Emit arbitrary bytes on stdout.
    currentFake!.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","result":{"tools":[]}}\n'));

    // Logger must have received NO calls from stdout.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: stop() SIGTERM → SIGKILL → 'stopped'
// ---------------------------------------------------------------------------

describe('McpServerLifecycle — stop()', () => {
  it('sends SIGTERM and transitions to "stopped" when process exits cleanly', async () => {
    vi.useFakeTimers();

    const { lifecycle } = makeLifecycle();

    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    const fake = currentFake!;

    // stop() sends SIGTERM; simulate immediate clean exit.
    const stopPromise = lifecycle.stop();
    fake.simulateExit(0);
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(fake.killCalls).toContain('SIGTERM');
    expect(lifecycle.getStatus()).toBe('stopped');
  });

  it('sends SIGKILL after 2 s if process ignores SIGTERM', async () => {
    vi.useFakeTimers();

    const { lifecycle } = makeLifecycle();

    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    const fake = currentFake!;
    // Do NOT simulate exit after SIGTERM — the process is stubborn.

    const stopPromise = lifecycle.stop();
    // Advance past the 2-second SIGKILL deadline.
    await vi.advanceTimersByTimeAsync(2500);
    await stopPromise;

    expect(fake.killCalls).toContain('SIGTERM');
    expect(fake.killCalls).toContain('SIGKILL');
    expect(lifecycle.getStatus()).toBe('stopped');
  });

  it('cancels the pending backoff restart when stop() is called within the backoff window', async () => {
    vi.useFakeTimers();

    const { lifecycle } = makeLifecycle();

    // Start — first spawn.
    const startPromise = lifecycle.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(spawnCallCount).toBe(1);

    // Crash once → backoff timer (1 s) is scheduled but NOT yet fired.
    currentFake!.simulateExit(1);
    // Advance only partway through the 1 s backoff.
    await vi.advanceTimersByTimeAsync(500);

    // stop() must cancel the pending timer.
    await lifecycle.stop();

    // Advance well past the original backoff deadline.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    // The ghost spawn must NOT have happened.
    expect(spawnCallCount).toBe(1);
    expect(lifecycle.getStatus()).toBe('stopped');
  });
});
