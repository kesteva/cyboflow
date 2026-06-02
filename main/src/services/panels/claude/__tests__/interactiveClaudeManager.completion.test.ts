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
  private exitListeners: ExitListener[] = [];

  onData = (): { dispose(): void } => ({ dispose: () => undefined });
  onExit = (cb: ExitListener): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };
  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}
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

  protected override async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: '1.0.0', path: '/fake/bin/claude' };
  }
  protected override async getCliExecutablePath(): Promise<string> {
    return '/fake/bin/claude';
  }
  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    return { PATH: '/usr/bin' };
  }
  protected override async spawnPtyProcess(): Promise<import('@homebridge/node-pty-prebuilt-multiarch').IPty> {
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
  // (a) onTurnEnd -> EOF/exit written; onExit 0 resolves only after settle.
  // -------------------------------------------------------------------------
  it('writes EOF/exit on turn-end and resolves only after the settle window on exit code 0', async () => {
    const panelId = 'panel-c1';
    const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-c1', worktreePath: '/tmp/c1', prompt: 'go' });
    await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0);

    const pty = mgr.ptys[0];
    const src = mgr.fakeSources[0];

    // The initial prompt was written.
    expect(pty.writes.some((w) => w.includes('go'))).toBe(true);

    // Fire the turn-end signal: EOF (Ctrl-D) + /exit must be written.
    src.fireTurnEnd();
    expect(pty.writes).toContain('\x04');
    expect(pty.writes.some((w) => w.includes('/exit'))).toBe(true);

    // The turn-end alone must NOT resolve the spawn promise.
    expect(await settledOrPending(spawn, 50)).toBe('pending');

    // Now the PTY exits cleanly. The spawn promise must resolve ONLY after the
    // settle window — immediately after onExit it is still pending.
    pty.fireExit(0);
    expect(await settledOrPending(spawn, 50)).toBe('pending');

    // After the settle window elapses it resolves (awaiting_review path).
    expect(await settledOrPending(spawn, 700)).toBe('resolved');
    await spawn;
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
});
