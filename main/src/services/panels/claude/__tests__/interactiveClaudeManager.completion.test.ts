/**
 * Completion-wiring tests for InteractiveClaudeManager (IDEA-013 S3 / TASK-808).
 *
 * Folds the REPL-never-exits blocker. With a faked PTY + fake TranscriptSource:
 *  (a) onTurnEnd -> EOF/`/exit` written to PTY stdin; then PTY onExit code 0 ->
 *      the spawn promise resolves ONLY AFTER the settle window (awaiting_review
 *      path).
 *  (b) onExit non-zero -> the spawn promise REJECTS (RunExecutor 'failed' path).
 *  (c) a run with NO onTurnEnd and no exit -> the spawn promise is still pending
 *      after the test window (no spurious resolve).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConfigManager } from '../../../configManager';
import type {
  TranscriptSource,
  OnLineCallback,
  OnTurnEndCallback,
  TurnEndMarker,
} from '../transcript/transcriptSource';

// ---------------------------------------------------------------------------
// Stub IPty
// ---------------------------------------------------------------------------

interface ExitListener {
  (e: { exitCode: number; signal?: number }): void;
}

class FakePty {
  readonly pid = 0; // falsy -> killProcess uses the simple kill() fallback.
  readonly process = 'claude';
  readonly cols = 80;
  readonly rows = 30;
  readonly handleFlowControl = false;
  readonly writes: string[] = [];
  /** Records every resize(cols, rows) call so the resize-seam test can assert it. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private exitListeners: ExitListener[] = [];

  onData = (): { dispose(): void } => ({ dispose: () => undefined });
  onExit = (cb: ExitListener): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  clear(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
  on(): void {}

  fireExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }
}

// ---------------------------------------------------------------------------
// Fake TranscriptSource
// ---------------------------------------------------------------------------

class FakeTranscriptSource implements TranscriptSource {
  onLine: OnLineCallback | undefined;
  onTurnEnd: OnTurnEndCallback | undefined;
  stopped = false;

  async start(onLine: OnLineCallback, onTurnEnd?: OnTurnEndCallback): Promise<void> {
    this.onLine = onLine;
    this.onTurnEnd = onTurnEnd;
  }
  stop(): void {
    this.stopped = true;
  }
  async waitForFirstLine(_timeoutMs: number): Promise<void> {}
  getSessionUuid(): string | undefined {
    return undefined;
  }
  fireTurnEnd(marker: TurnEndMarker = 'stop_hook_summary'): void {
    this.onTurnEnd?.(marker);
  }
}

// ---------------------------------------------------------------------------
// Testable subclass (fakes the real-I/O hooks)
// ---------------------------------------------------------------------------

class TestableInteractiveClaudeManager extends InteractiveClaudeManager {
  readonly ptys: FakePty[] = [];
  readonly fakeSources: FakeTranscriptSource[] = [];
  /** Captured argv per spawn — the initial prompt now rides claude's positional arg. */
  readonly spawnArgs: string[][] = [];

  protected override async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: '1.0.0', path: '/fake/bin/claude' };
  }
  protected override async getCliExecutablePath(): Promise<string> {
    return '/fake/bin/claude';
  }
  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    return { PATH: '/usr/bin' };
  }
  protected override async spawnPtyProcess(_command: string, args: string[]): Promise<import('@homebridge/node-pty-prebuilt-multiarch').IPty> {
    this.spawnArgs.push(args);
    const fake = new FakePty();
    this.ptys.push(fake);
    return fake as unknown as import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  }
  protected override createTranscriptSource(): TranscriptSource {
    const src = new FakeTranscriptSource();
    this.fakeSources.push(src);
    return src;
  }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function createMockConfigManager(): ConfigManager {
  return { getConfig: vi.fn(() => ({})) } as unknown as ConfigManager;
}

function createLogger(): import('../../../../utils/logger').Logger {
  return {
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('../../../../utils/logger').Logger;
}

/** Poll until predicate() is true, draining microtasks + timers each tick. */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor: predicate never became true');
}

/** Race a promise against a timeout: returns 'pending' if it does not settle. */
async function settledOrPending(p: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending';
  const tracked = p.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  await Promise.race([tracked, new Promise((r) => setTimeout(r, ms))]);
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveClaudeManager — completion (turn-end driven)', () => {
  let db: Database.Database;
  let mgr: TestableInteractiveClaudeManager;

  beforeEach(() => {
    db = createTestDb();
    ApprovalRouter.initialize(dbAdapter(db));
    QuestionRouter.initialize(dbAdapter(db));
    mgr = new TestableInteractiveClaudeManager(
      createMockSessionManager(),
      createLogger(),
      createMockConfigManager(),
      db,
    );
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) PERSISTENT (production default): turn-end emits a 'turn-end' event and
  // writes NO EOF/exit (the REPL stays alive); explicit endSession writes
  // EOF/exit and onExit 0 resolves only after the settle window.
  // -------------------------------------------------------------------------
  it('persistent: turn-end emits a turn-end event with NO EOF; endSession writes EOF and resolves only after settle on exit 0', async () => {
    const panelId = 'panel-c1';

    // Capture the 'turn-end' event emitted by the persistent REPL.
    const turnEndEvents: Array<{ panelId: string; sessionId: string; runId: string }> = [];
    mgr.on('turn-end', (payload: unknown) => {
      turnEndEvents.push(payload as { panelId: string; sessionId: string; runId: string });
    });

    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-c1', worktreePath: '/tmp/c1', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0);

    const pty = mgr.ptys[0];
    const src = mgr.fakeSources[0];

    // The initial prompt rides claude's POSITIONAL argv (not a PTY byte-injection).
    expect(mgr.spawnArgs[0]?.some((a) => a.includes('go'))).toBe(true);
    const writesAfterPrompt = pty.writes.length;

    // Fire the turn-end signal: a persistent run must NOT write EOF/exit; it must
    // EMIT a 'turn-end' event with { panelId, sessionId, runId } and keep alive.
    src.fireTurnEnd();
    expect(turnEndEvents).toHaveLength(1);
    expect(turnEndEvents[0]).toEqual({ panelId, sessionId: 'sess-c1', runId: panelId });
    expect(pty.writes).not.toContain('\x04');
    expect(pty.writes.some((w) => w.includes('/exit'))).toBe(false);
    // No new bytes written to the PTY on turn-end (REPL untouched).
    expect(pty.writes.length).toBe(writesAfterPrompt);

    // The turn-end alone must NOT resolve the spawn promise — the REPL is alive.
    expect(await settledOrPending(spawn, 50)).toBe('pending');

    // Explicit end-session: NOW EOF (Ctrl-D) + /exit is written.
    await mgr.endSession(panelId);
    expect(pty.writes).toContain('\x04');
    expect(pty.writes.some((w) => w.includes('/exit'))).toBe(true);

    // Still pending until the PTY actually exits.
    expect(await settledOrPending(spawn, 50)).toBe('pending');

    // PTY exits cleanly. The spawn promise resolves ONLY after the settle window —
    // immediately after onExit it is still pending.
    pty.fireExit(0);
    expect(await settledOrPending(spawn, 50)).toBe('pending');

    // After the settle window elapses it resolves (awaiting_review path).
    expect(await settledOrPending(spawn, 700)).toBe('resolved');
    await spawn;
  });

  // -------------------------------------------------------------------------
  // (a2) PERSISTENT re-arm: a SECOND turn-end ALSO emits (per-turn re-armable,
  // not one-shot) and still writes no EOF.
  // -------------------------------------------------------------------------
  it('persistent: a second turn-end re-emits (re-armable) and still writes no EOF', async () => {
    const panelId = 'panel-rearm';

    const turnEndEvents: Array<{ panelId: string; sessionId: string; runId: string }> = [];
    mgr.on('turn-end', (payload: unknown) => {
      turnEndEvents.push(payload as { panelId: string; sessionId: string; runId: string });
    });

    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-rearm', worktreePath: '/tmp/rearm', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0);

    const pty = mgr.ptys[0];
    const src = mgr.fakeSources[0];

    src.fireTurnEnd();
    src.fireTurnEnd();

    // Both turn-ends re-emit; the flag is per-turn re-armable, not one-shot.
    expect(turnEndEvents).toHaveLength(2);
    expect(turnEndEvents[0].runId).toBe(panelId);
    expect(turnEndEvents[1].runId).toBe(panelId);
    // No EOF written across either turn — the REPL stayed alive.
    expect(pty.writes).not.toContain('\x04');

    // Clean up the still-pending spawn promise.
    await mgr.killProcess(panelId);
    void spawn;
  });

  // -------------------------------------------------------------------------
  // (b) onExit non-zero -> rejects (RunExecutor 'failed').
  // -------------------------------------------------------------------------
  it('rejects the spawn promise on a non-zero exit (failed path)', async () => {
    const panelId = 'panel-c2';
    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-c2', worktreePath: '/tmp/c2', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0);

    const pty = mgr.ptys[0];
    pty.fireExit(1);

    expect(await settledOrPending(spawn, 700)).toBe('rejected');
    await expect(spawn).rejects.toThrow(/exited with code 1/);
  });

  // -------------------------------------------------------------------------
  // (c) no turn-end + no exit -> never resolves (no spurious resolve).
  // -------------------------------------------------------------------------
  it('never resolves a run that has no turn-end and no exit', async () => {
    const panelId = 'panel-c3';
    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-c3', worktreePath: '/tmp/c3', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0);

    // No turn-end, no exit fired. The spawn promise must remain pending well past
    // the settle window.
    expect(await settledOrPending(spawn, 700)).toBe('pending');

    // Clean up so vitest does not flag a leaked pending promise / open handles.
    await mgr.killProcess(panelId);
    void spawn;
  });

  // -------------------------------------------------------------------------
  // (d) RESIZE SEAM (TASK-818, delivers TASK-817's deferred relayResize):
  // resizePanel(panelId, cols, rows) calls resize(cols, rows) on the live IPty;
  // no-op (no throw, no resize call) when no live process exists for the panel.
  // -------------------------------------------------------------------------
  it('resizePanel resizes the live IPty and no-ops when no live process exists', async () => {
    const panelId = 'panel-resize';
    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-resize', worktreePath: '/tmp/resize', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0);

    const pty = mgr.ptys[0];

    // A live process exists → resize is forwarded to the IPty.
    mgr.resizePanel(panelId, 120, 40);
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);

    // No live process for an unknown panel → no-op: no throw, no resize recorded.
    expect(() => mgr.resizePanel('panel-no-such', 80, 24)).not.toThrow();
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);

    // Clean up the still-pending spawn promise.
    await mgr.killProcess(panelId);
    void spawn;
  });
});

// ---------------------------------------------------------------------------
// Legacy single-turn (non-persistent) path — preserved for defensive / future
// non-interactive use. A subclass forces isPersistentRun() => false so the
// turn-end writes EOF/exit (the TASK-808 one-shot behavior), gated OFF for the
// production persistent default.
// ---------------------------------------------------------------------------

class NonPersistentTestableManager extends TestableInteractiveClaudeManager {
  protected override isPersistentRun(): boolean {
    return false;
  }
}

describe('InteractiveClaudeManager — completion (legacy non-persistent turn-end)', () => {
  let db: Database.Database;
  let mgr: NonPersistentTestableManager;

  beforeEach(() => {
    db = createTestDb();
    ApprovalRouter.initialize(dbAdapter(db));
    QuestionRouter.initialize(dbAdapter(db));
    mgr = new NonPersistentTestableManager(
      createMockSessionManager(),
      createLogger(),
      createMockConfigManager(),
      db,
    );
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('non-persistent: turn-end writes EOF/exit (one-shot) and emits NO turn-end event', async () => {
    const panelId = 'panel-legacy';

    const turnEndEvents: unknown[] = [];
    mgr.on('turn-end', (payload: unknown) => {
      turnEndEvents.push(payload);
    });

    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-legacy', worktreePath: '/tmp/legacy', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0);

    const pty = mgr.ptys[0];
    const src = mgr.fakeSources[0];

    // Legacy path: turn-end writes EOF (Ctrl-D) + /exit and emits NO event.
    src.fireTurnEnd();
    expect(pty.writes).toContain('\x04');
    expect(pty.writes.some((w) => w.includes('/exit'))).toBe(true);
    expect(turnEndEvents).toHaveLength(0);

    // One-shot: a second turn-end does not write EOF again.
    const eofCountAfterFirst = pty.writes.filter((w) => w === '\x04').length;
    src.fireTurnEnd();
    expect(pty.writes.filter((w) => w === '\x04').length).toBe(eofCountAfterFirst);

    // onExit(0) resolves after the settle window (legacy awaiting_review path).
    pty.fireExit(0);
    expect(await settledOrPending(spawn, 700)).toBe('resolved');
    await spawn;
  });
});
