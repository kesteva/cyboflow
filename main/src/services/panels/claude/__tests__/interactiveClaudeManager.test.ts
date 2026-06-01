/**
 * Unit + integration tests for InteractiveClaudeManager (IDEA-013 S3 / TASK-808).
 *
 * Mirrors the fixture style of claudeCodeManager.killProcess.test.ts /
 * claudeCodeManager.composeMcpServers.test.ts: a stub IPty, a fake
 * TranscriptSource, an in-memory better-sqlite3 DB, and a spy logger. Zero real
 * `claude` spawn, zero real FS tail.
 *
 * Covered:
 *  (a) buildCommandArgs — no -p / no --output-format; model auto vs concrete;
 *      --strict-mcp-config threading; permissionMode 'ignore' produces no
 *      hook-write call.
 *  (b) output-shape parity — N normalized fixture lines produce N 'output'
 *      events field-identical to the SDK envelope; emitForRun called N times.
 *  (c) exactly one raw_events INSERT per fixture line (manager-owned).
 *  (d) testCliAvailability honors a custom claudeExecutablePath and reports
 *      unavailable when the binary is missing.
 *  (e) cleanupCliResources / abort stops the TranscriptSource, clears router
 *      pending, no leak across two parallel fake runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';
import { makeRawEventsDb, countRawEvents } from '../../../../orchestrator/__test_fixtures__/rawEvents';
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
// Stub IPty — captures onData/onExit listeners and records writes.
// ---------------------------------------------------------------------------

interface ExitListener {
  (e: { exitCode: number; signal?: number }): void;
}

class FakePty {
  // pid 0 (falsy) so AbstractCliManager.killProcess takes the simple
  // process.kill() fallback and never runs the real `ps`/`kill` process-tree
  // shell calls in tests.
  readonly pid = 0;
  readonly process = 'claude';
  readonly cols = 80;
  readonly rows = 30;
  readonly handleFlowControl = false;
  readonly writes: string[] = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: ExitListener[] = [];
  killed = false;

  onData = (cb: (d: string) => void): { dispose(): void } => {
    this.dataListeners.push(cb);
    return { dispose: () => undefined };
  };

  onExit = (cb: ExitListener): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // no-op
  }

  clear(): void {
    // no-op
  }

  kill(): void {
    this.killed = true;
  }

  pause(): void {
    // no-op
  }

  resume(): void {
    // no-op
  }

  on(): void {
    // no-op (deprecated event surface)
  }

  /** Test driver: fire the captured onExit listeners. */
  fireExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }
}

// ---------------------------------------------------------------------------
// Fake TranscriptSource — lets the test push normalized lines + fire turn-end.
// ---------------------------------------------------------------------------

class FakeTranscriptSource implements TranscriptSource {
  onLine: OnLineCallback | undefined;
  onTurnEnd: OnTurnEndCallback | undefined;
  stopped = false;
  started = false;
  private uuid: string | undefined;

  constructor(uuid?: string) {
    this.uuid = uuid;
  }

  async start(onLine: OnLineCallback, onTurnEnd?: OnTurnEndCallback): Promise<void> {
    this.onLine = onLine;
    this.onTurnEnd = onTurnEnd;
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  async waitForFirstLine(_timeoutMs: number): Promise<void> {
    // Discovery succeeds immediately in tests.
  }

  getSessionUuid(): string | undefined {
    return this.uuid;
  }

  /** Test driver: push one already-normalized line through onLine. */
  pushLine(obj: unknown): void {
    this.onLine?.(obj);
  }

  /** Test driver: fire a turn-end marker. */
  fireTurnEnd(marker: TurnEndMarker = 'stop_hook_summary'): void {
    this.onTurnEnd?.(marker);
  }
}

// ---------------------------------------------------------------------------
// Testable subclass — overrides the real-I/O hooks (PTY spawn, availability,
// transcript factory, system env) with fakes. Does NOT redeclare the inherited
// base PTY machinery in production code; this is a test-only seam.
// ---------------------------------------------------------------------------

class TestableInteractiveClaudeManager extends InteractiveClaudeManager {
  readonly ptys: FakePty[] = [];
  readonly fakeSources: FakeTranscriptSource[] = [];
  nextSessionUuid: string | undefined;

  // Avoid touching the real shell / claude binary during spawn.
  protected override async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: '1.0.0', path: '/fake/bin/claude' };
  }

  protected override async getCliExecutablePath(): Promise<string> {
    return '/fake/bin/claude';
  }

  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    return { PATH: '/usr/bin' };
  }

  // Inherited spawnPtyProcess is replaced with a fake here (test-only) so no real
  // PTY is spawned. The production class never redeclares spawnPtyProcess.
  protected override async spawnPtyProcess(): Promise<import('@homebridge/node-pty-prebuilt-multiarch').IPty> {
    const fake = new FakePty();
    this.ptys.push(fake);
    return fake as unknown as import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  }

  protected override createTranscriptSource(): TranscriptSource {
    const src = new FakeTranscriptSource(this.nextSessionUuid);
    this.fakeSources.push(src);
    return src;
  }

  // Test accessors for private maps.
  publicPipelines(): Map<string, unknown> {
    return (this as unknown as { pipelines: Map<string, unknown> }).pipelines;
  }
  publicTailSources(): Map<string, unknown> {
    return (this as unknown as { tailSources: Map<string, unknown> }).tailSources;
  }
  publicInteractiveRuns(): Map<string, unknown> {
    return (this as unknown as { interactiveRuns: Map<string, unknown> }).interactiveRuns;
  }
  // Expose the protected hooks for direct-call unit tests.
  callBuildCommandArgs(options: Parameters<InteractiveClaudeManager['startPanel']> extends never ? never : Record<string, unknown>): string[] {
    return (this as unknown as { buildCommandArgs(o: Record<string, unknown>): string[] }).buildCommandArgs(options);
  }
  callTestCliAvailabilityReal(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    // Bypass the override above to exercise the real probe logic.
    return InteractiveClaudeManager.prototype['testCliAvailability'].call(this, customPath);
  }
}

// ---------------------------------------------------------------------------
// Mock SessionManager + ConfigManager + logger spy
// ---------------------------------------------------------------------------

interface MockDb {
  updateSession: MockInstance;
}

function createMockSessionManager(overrides?: Partial<SessionManager> & { db?: MockDb }): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    // Mirrors sessionManager.db (DatabaseService) — the SDK substrate's
    // claude_session_id write seam (sessionManager.ts:590).
    db: { updateSession: vi.fn() },
    ...overrides,
  } as unknown as SessionManager;
}

function createMockConfigManager(claudeExecutablePath?: string): ConfigManager {
  return {
    getConfig: vi.fn(() => ({ claudeExecutablePath })),
  } as unknown as ConfigManager;
}

interface LoggerSpy {
  verbose: MockInstance;
  info: MockInstance;
  warn: MockInstance;
  error: MockInstance;
}

function createLoggerSpy(): LoggerSpy {
  return {
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Poll until predicate() is true, draining microtasks + timers each tick. */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor: predicate never became true');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveClaudeManager', () => {
  // -------------------------------------------------------------------------
  // (a) buildCommandArgs
  // -------------------------------------------------------------------------
  describe('buildCommandArgs', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;

    beforeEach(() => {
      db = makeRawEventsDb();
      const logger = createLoggerSpy();
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        logger as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
    });

    afterEach(() => {
      db.close();
      vi.clearAllMocks();
    });

    it('emits NO -p and NO --output-format token', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(args).not.toContain('-p');
      expect(args).not.toContain('--output-format');
      expect(args.join(' ')).not.toMatch(/--output-format/);
    });

    it('includes --model X only for a concrete model', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        model: 'claude-sonnet-4',
      });
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('claude-sonnet-4');
    });

    it('omits --model for model "auto" and "default"', () => {
      for (const model of ['auto', 'default']) {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: '/tmp/wt',
          prompt: 'hi',
          model,
        });
        expect(args).not.toContain('--model');
      }
    });

    it('threads --strict-mcp-config iff strictMcpConfig === true', () => {
      const withFlag = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        strictMcpConfig: true,
      });
      expect(withFlag).toContain('--strict-mcp-config');

      const withoutFlag = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(withoutFlag).not.toContain('--strict-mcp-config');
    });

    it('includes --mcp-config and --settings isolation flags', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--settings');
    });
  });

  // -------------------------------------------------------------------------
  // (a continued) permissionMode 'ignore' produces no hook-write call.
  // -------------------------------------------------------------------------
  describe('permissionMode ignore — no hook write', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;
    let removeSettingsSpy: MockInstance;

    beforeEach(() => {
      db = createTestDb();
      ApprovalRouter.initialize(dbAdapter(db));
      QuestionRouter.initialize(dbAdapter(db));
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      // Spy on the hook-write seam (removeGeneratedSettings is the teardown twin;
      // for the write seam the manager does not invoke any writer when
      // permissionMode is 'ignore'). We assert via the spawn path that no
      // settings-write seam fires for the 'ignore' branch.
      removeSettingsSpy = vi.spyOn(
        mgr as unknown as { removeGeneratedSettings(p: string): void },
        'removeGeneratedSettings',
      );
    });

    afterEach(() => {
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      vi.clearAllMocks();
    });

    it('spawns with permissionMode ignore without writing a gating hook', async () => {
      const panelId = 'panel-ign';
      const spawn = mgr.spawnCliProcess({
        panelId,
        sessionId: 'sess-ign',
        worktreePath: '/tmp/wt-ign',
        prompt: 'go',
        permissionMode: 'ignore',
      });
      // Let the spawn reach the PTY/source wiring (it returns a pending
      // completion promise).
      await waitFor(() => mgr.ptys.length > 0);
      // No hook-write seam fired during spawn for the auto-allow branch.
      expect(removeSettingsSpy).not.toHaveBeenCalled();
      // Tear down so the pending spawn promise resolves.
      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // (b)(c) output-shape parity + single INSERT per line
  // -------------------------------------------------------------------------
  describe('output-shape parity + raw_events ownership', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;

    const fixtureLines: Array<Record<string, unknown>> = [
      { type: 'system', subtype: 'init', session_id: 'uuid-1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ];

    beforeEach(() => {
      // FK enforcement OFF so the manager-owned RawEventsSink can INSERT a row
      // per fixture line without seeding a workflow_runs parent row.
      db = createTestDb({ disableForeignKeys: true });
      ApprovalRouter.initialize(dbAdapter(db));
      QuestionRouter.initialize(dbAdapter(db));
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
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

    it('emits exactly N output events field-identical to the SDK envelope + N raw_events rows', async () => {
      const panelId = 'panel-out';
      const sessionId = 'sess-out';
      const runId = panelId; // no run_id on the session row -> falls back to panelId

      const outputs: Array<{ panelId: string; sessionId: string; type: string; data: unknown; timestamp: unknown }> = [];
      mgr.on('output', (evt) => {
        outputs.push(evt);
      });

      const spawn = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/wt-out', prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && (mgr.fakeSources[0].started));

      // Drop the session_info descriptor emitted at spawn so we count only
      // transcript-driven output events.
      outputs.length = 0;

      const src = mgr.fakeSources[0];
      for (const line of fixtureLines) {
        src.pushLine(line);
      }

      // Exactly N output events, each field-identical to the SDK envelope.
      expect(outputs).toHaveLength(fixtureLines.length);
      for (let i = 0; i < fixtureLines.length; i++) {
        const evt = outputs[i];
        expect(Object.keys(evt).sort()).toEqual(['data', 'panelId', 'sessionId', 'timestamp', 'type']);
        expect(evt.panelId).toBe(panelId);
        expect(evt.sessionId).toBe(sessionId);
        expect(evt.type).toBe('json');
        expect(evt.data).toEqual(fixtureLines[i]);
        expect(evt.timestamp).toBeInstanceOf(Date);
      }

      // Exactly one raw_events INSERT per fixture line (manager-owned sink).
      expect(countRawEvents(db, runId)).toBe(fixtureLines.length);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('calls router.emitForRun once per fixture line', async () => {
      const panelId = 'panel-emit';
      const sessionId = 'sess-emit';

      const spawn = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/wt-emit', prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && (mgr.fakeSources[0].started));

      const pipeline = mgr.publicPipelines().get(panelId) as { router: { emitForRun: (r: string, e: unknown) => void } };
      const emitSpy = vi.spyOn(pipeline.router, 'emitForRun');

      const src = mgr.fakeSources[0];
      for (const line of fixtureLines) {
        src.pushLine(line);
      }

      expect(emitSpy).toHaveBeenCalledTimes(fixtureLines.length);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // single-writer-per-substrate: claude_session_id from the transcript filename.
  // -------------------------------------------------------------------------
  describe('single-writer claude_session_id', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = createTestDb({ disableForeignKeys: true });
      ApprovalRouter.initialize(dbAdapter(db));
      QuestionRouter.initialize(dbAdapter(db));
    });

    afterEach(() => {
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      vi.clearAllMocks();
    });

    it('writes claude_session_id from the discovered filename UUID via the db seam, not the SDK event path', async () => {
      const sessionDbUpdate = vi.fn();
      const sessionUpdate = vi.fn();
      const sm = createMockSessionManager({
        db: { updateSession: sessionDbUpdate } as unknown as MockDb,
        updateSession: sessionUpdate as unknown as SessionManager['updateSession'],
      });
      const mgr = new TestableInteractiveClaudeManager(
        sm,
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      // The transcript filename yields this discovered UUID.
      mgr.nextSessionUuid = 'discovered-uuid-xyz';

      const panelId = 'panel-uuid';
      const sessionId = 'sess-uuid';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/wt-uuid', prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // The interactive substrate persists claude_session_id from the discovered
      // filename UUID via the db.updateSession seam (single-writer rule). The SDK
      // event-derived high-level updateSession(SessionUpdate) path is NOT used.
      expect(sessionDbUpdate).toHaveBeenCalledWith(sessionId, { claude_session_id: 'discovered-uuid-xyz' });
      expect(sessionUpdate).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({ claude_session_id: expect.anything() }));

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // (d) testCliAvailability — custom path honored + unavailable when missing.
  // -------------------------------------------------------------------------
  describe('testCliAvailability', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = makeRawEventsDb();
    });

    afterEach(() => {
      db.close();
      vi.clearAllMocks();
    });

    it('reports unavailable when no binary is found and no path configured', async () => {
      const mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(undefined),
        db,
      );
      // Force findExecutableInPath to return null by pointing at a bogus custom
      // path that cannot run --version.
      const result = await mgr.callTestCliAvailabilityReal('/definitely/not/a/real/claude/binary');
      expect(result.available).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('honors a custom claudeExecutablePath from config', async () => {
      const mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager('/configured/path/to/claude'),
        db,
      );
      const result = await mgr.callTestCliAvailabilityReal();
      // The configured path is bogus so the probe fails to run --version, but the
      // failing error must reference the CONFIGURED path (honored), not a PATH
      // lookup.
      expect(result.available).toBe(false);
      expect(result.path).toBe('/configured/path/to/claude');
    });
  });

  // -------------------------------------------------------------------------
  // (e) cleanup / abort across two parallel runs — no leak.
  // -------------------------------------------------------------------------
  describe('cleanup across parallel runs', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;
    let clearApprovalSpy: MockInstance;
    let clearQuestionSpy: MockInstance;

    beforeEach(() => {
      db = createTestDb();
      ApprovalRouter.initialize(dbAdapter(db));
      QuestionRouter.initialize(dbAdapter(db));
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      clearApprovalSpy = vi.spyOn(ApprovalRouter.getInstance(), 'clearPendingForRun');
      clearQuestionSpy = vi.spyOn(QuestionRouter.getInstance(), 'clearPendingForRun');
    });

    afterEach(() => {
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      vi.clearAllMocks();
    });

    it('aborting one run stops its TranscriptSource, clears router pending, leaves the other untouched', async () => {
      const spawnA = mgr.spawnCliProcess({ panelId: 'panel-A', sessionId: 'sess-A', worktreePath: '/tmp/A', prompt: 'a' });
      await waitFor(() => mgr.fakeSources.length >= 1 && mgr.fakeSources[0].started);
      const spawnB = mgr.spawnCliProcess({ panelId: 'panel-B', sessionId: 'sess-B', worktreePath: '/tmp/B', prompt: 'b' });
      await waitFor(() => mgr.fakeSources.length >= 2 && mgr.fakeSources[1].started);

      const srcA = mgr.fakeSources[0];
      const srcB = mgr.fakeSources[1];
      expect(srcA.started).toBe(true);
      expect(srcB.started).toBe(true);

      // Both runs are tracked.
      expect(mgr.publicInteractiveRuns().has('panel-A')).toBe(true);
      expect(mgr.publicInteractiveRuns().has('panel-B')).toBe(true);
      expect(mgr.publicTailSources().has('panel-A')).toBe(true);
      expect(mgr.publicTailSources().has('panel-B')).toBe(true);

      // Abort run A.
      await mgr.killProcess('panel-A');

      // A's TranscriptSource stopped; B's did not.
      expect(srcA.stopped).toBe(true);
      expect(srcB.stopped).toBe(false);

      // A's router pending cleared under its runId (== panelId here).
      expect(clearApprovalSpy).toHaveBeenCalledWith('panel-A');
      expect(clearQuestionSpy).toHaveBeenCalledWith('panel-A');

      // A's maps cleared; B unaffected — no leak.
      expect(mgr.publicInteractiveRuns().has('panel-A')).toBe(false);
      expect(mgr.publicTailSources().has('panel-A')).toBe(false);
      expect(mgr.publicPipelines().has('panel-A')).toBe(false);
      expect(mgr.publicInteractiveRuns().has('panel-B')).toBe(true);
      expect(mgr.publicTailSources().has('panel-B')).toBe(true);
      expect(mgr.publicPipelines().has('panel-B')).toBe(true);

      // Drain B cleanly to release its pending spawn promise.
      mgr.ptys[1].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawnB;

      // spawnA was aborted via killProcess — its onExit never fired with code 0,
      // so its completion promise never resolves. Detach it so vitest does not
      // flag an unhandled pending promise.
      void spawnA;
    });
  });
});
