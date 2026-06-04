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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { makeRawEventsDb, countRawEvents } from '../../../../orchestrator/__test_fixtures__/rawEvents';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import { InteractiveSettingsWriter } from '../interactiveSettingsWriter';
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

  /** Test driver: push a raw chunk through every captured onData listener. */
  fireData(chunk: string): void {
    for (const cb of this.dataListeners) cb(chunk);
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

function createMockSessionManager(overrides?: Partial<Omit<SessionManager, 'db'>> & { db?: MockDb }): SessionManager {
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
// .claude/settings.json helpers (real-fs round-trip for the writer integration).
// ---------------------------------------------------------------------------

interface HookCommandEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommandEntry[];
}
interface ClaudeSettingsShape {
  hooks?: { PreToolUse?: HookMatcherGroup[]; [k: string]: HookMatcherGroup[] | undefined };
  [k: string]: unknown;
}

/** Make a fresh, unique, real temp worktree dir. */
function makeTempWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icm-task819-'));
}

/** Read the worktree's `.claude/settings.json`, or undefined when absent/unreadable. */
function readSettings(worktreePath: string): ClaudeSettingsShape | undefined {
  const p = path.join(worktreePath, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ClaudeSettingsShape;
  } catch {
    return undefined;
  }
}

/** True iff the settings carry the cyboflow PreToolUse `'*'` shell-hook group. */
function hasCyboflowHook(settings: ClaudeSettingsShape | undefined): boolean {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (g) =>
      g.matcher === '*' &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => h.type === 'command' && typeof h.command === 'string' && h.command.includes('preToolUseShellHook')),
  );
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

    it('includes --mcp-config (pointing at the per-run config) and does NOT emit the dangling --settings flag (TASK-819)', () => {
      // buildCommandArgs emits --mcp-config ONLY when the per-run config exists on
      // disk — writeInteractiveMcpConfig writes `<worktree>/.cyboflow/interactive-
      // mcp.json` before args are built, and a MISSING path would make `claude`
      // exit 1, so the flag is existence-guarded. Create the file so the guard
      // passes and the assertion exercises the real contract.
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-buildargs-'));
      const mcpConfigPath = path.join(wt, '.cyboflow', 'interactive-mcp.json');
      fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), 'utf8');
      try {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: wt,
          prompt: 'hi',
        });
        expect(args).toContain('--mcp-config');
        expect(args).toContain(mcpConfigPath);
        // The dangling `--settings <.cyboflow/interactive-settings.json>` flag is
        // dropped (TASK-819): the PreToolUse hook is installed by the writer into
        // the worktree's default `.claude/settings.json` that `claude` reads, so
        // no `--settings` flag is emitted.
        expect(args).not.toContain('--settings');
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // (TASK-819) PreToolUse shell-approval hook: write on spawn + ignore skip.
  // Real-fs round-trip on a temp worktree exercises the writer's merge.
  // -------------------------------------------------------------------------
  describe('shell-approval hook write on spawn (TASK-819)', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;
    const worktrees: string[] = [];

    function freshWorktree(): string {
      const wt = makeTempWorktree();
      worktrees.push(wt);
      return wt;
    }

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
    });

    afterEach(() => {
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      for (const wt of worktrees.splice(0)) {
        fs.rmSync(wt, { recursive: true, force: true });
      }
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('installs the PreToolUse \'*\' hook into <worktree>/.claude/settings.json once on spawn, passing the worktree path', async () => {
      const writeSpy = vi.spyOn(InteractiveSettingsWriter.prototype, 'write');
      const worktreePath = freshWorktree();
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-hook',
        sessionId: 'sess-hook',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => mgr.ptys.length > 0);

      // write() invoked exactly once with the worktree path + permissionMode opts.
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][0]).toBe(worktreePath);
      expect(writeSpy.mock.calls[0][1]).toEqual({ permissionMode: undefined });

      // The real writer wrote the cyboflow '*' PreToolUse entry to disk.
      expect(hasCyboflowHook(readSettings(worktreePath))).toBe(true);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('constructs the writer with a logger PASSED (write/skip diagnostics enabled)', async () => {
      // A logger whose debug() fires when the writer logs the install. The
      // manager adapts its Logger (debug -> verbose) to LoggerLike, so a verbose
      // call on the manager logger proves the shim is wired.
      const logger = createLoggerSpy();
      const m = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        logger as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      const worktreePath = freshWorktree();
      const spawn = m.spawnCliProcess({
        panelId: 'panel-log',
        sessionId: 'sess-log',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => m.ptys.length > 0);

      // The writer's install-diagnostic routed through the adapted logger
      // (debug -> verbose). A no-arg writer would have silently no-op'd this.
      expect(
        logger.verbose.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('installed PreToolUse shell hook'),
        ),
      ).toBe(true);

      m.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('writes NO gating hook when permissionMode === \'ignore\' (writer opt-out consumed, not a manager gate)', async () => {
      const writeSpy = vi.spyOn(InteractiveSettingsWriter.prototype, 'write');
      const worktreePath = freshWorktree();
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-ign',
        sessionId: 'sess-ign',
        worktreePath,
        prompt: 'go',
        permissionMode: 'ignore',
      });
      await waitFor(() => mgr.ptys.length > 0);

      // write() is still CALLED (no manager gate) but with permissionMode 'ignore'
      // — the writer returns null and writes nothing (its own opt-out branch).
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][1]).toEqual({ permissionMode: 'ignore' });
      expect(writeSpy.mock.results[0].value).toBeNull();
      expect(hasCyboflowHook(readSettings(worktreePath))).toBe(false);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // (TASK-819) teardown: deny in-flight shell approvals (ordered before
  // clearPendingForRun) + remove the generated hook entry.
  // -------------------------------------------------------------------------
  describe('shell-approval teardown (TASK-819)', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;
    const worktrees: string[] = [];

    function freshWorktree(): string {
      const wt = makeTempWorktree();
      worktrees.push(wt);
      return wt;
    }

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
    });

    afterEach(() => {
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      for (const wt of worktrees.splice(0)) {
        fs.rmSync(wt, { recursive: true, force: true });
      }
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('calls the injected canceller with the run\'s runId on teardown, BEFORE clearPendingForRun', async () => {
      const callOrder: string[] = [];
      const cancellerSpy = vi.fn((_runId: string): number => {
        callOrder.push('cancel');
        return 1;
      });
      const clearSpy = vi
        .spyOn(ApprovalRouter.getInstance(), 'clearPendingForRun')
        .mockImplementation((_runId: string) => {
          callOrder.push('clear');
        });
      mgr.setShellApprovalCanceller(cancellerSpy);

      const worktreePath = freshWorktree();
      const panelId = 'panel-deny';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-deny', worktreePath, prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      await mgr.killProcess(panelId);

      // runId falls back to panelId (no run_id on the session row).
      expect(cancellerSpy).toHaveBeenCalledTimes(1);
      expect(cancellerSpy).toHaveBeenCalledWith(panelId);
      // deny precedes the router DB settle.
      expect(callOrder.indexOf('cancel')).toBeLessThan(callOrder.indexOf('clear'));
      expect(callOrder.indexOf('cancel')).toBeGreaterThanOrEqual(0);

      void spawn;
    });

    it('teardown does NOT throw when no canceller is wired (null-safe seam)', async () => {
      const worktreePath = freshWorktree();
      const panelId = 'panel-nocancel';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-nocancel', worktreePath, prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      await expect(mgr.killProcess(panelId)).resolves.toBeUndefined();
      expect(mgr.publicInteractiveRuns().has(panelId)).toBe(false);

      void spawn;
    });

    it('removes the generated \'*\' hook on teardown while preserving a pre-seeded user key', async () => {
      const worktreePath = freshWorktree();
      // Pre-seed a user settings.json with an unrelated key the writer must keep.
      const dotClaude = path.join(worktreePath, '.claude');
      fs.mkdirSync(dotClaude, { recursive: true });
      fs.writeFileSync(
        path.join(dotClaude, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2),
        'utf8',
      );

      const panelId = 'panel-remove';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-remove', worktreePath, prompt: 'go' });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // Spawn installed our '*' hook alongside the user key.
      const afterSpawn = readSettings(worktreePath);
      expect(hasCyboflowHook(afterSpawn)).toBe(true);
      expect((afterSpawn as { permissions?: { allow?: string[] } }).permissions?.allow).toEqual(['Bash(ls)']);

      await mgr.killProcess(panelId);

      // Teardown stripped ONLY the cyboflow entry; the user key survives.
      const afterTeardown = readSettings(worktreePath);
      expect(hasCyboflowHook(afterTeardown)).toBe(false);
      expect((afterTeardown as { permissions?: { allow?: string[] } }).permissions?.allow).toEqual(['Bash(ls)']);

      void spawn;
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
  // (TASK-814) raw-PTY byte path: the second additive ptyProcess.onData listener
  // emits exactly ONE 'pty-output' per onData call carrying the VERBATIM chunk
  // (no line-split, no \n re-join) plus the per-run identity fields. The base
  // 'output'/type:'json' path stays byte-identical (Q3 panel-preservation) and
  // parseCliOutput still returns [].
  // -------------------------------------------------------------------------
  describe('raw-PTY pty-output path', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;

    beforeEach(() => {
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

    it('emits exactly one pty-output per onData call with the VERBATIM chunk and full identity', async () => {
      const panelId = 'panel-pty';
      const sessionId = 'sess-pty';
      const runId = panelId; // no run_id on the session row -> falls back to panelId

      const ptyOutputs: Array<{ panelId: string; sessionId: string; runId: string; type: string; data: string; timestamp: unknown }> = [];
      mgr.on('pty-output', (evt) => {
        ptyOutputs.push(evt);
      });

      const spawn = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/wt-pty', prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // A multi-line ANSI chunk with cursor/control sequences and an embedded
      // newline — the listener MUST forward it byte-for-byte (no split, no \n
      // mutation), or xterm rendering downstream (TASK-815) corrupts.
      const chunk = '\x1b[2J\x1b[Hline1\nline2\x1b[K';
      mgr.ptys[0].fireData(chunk);

      // Exactly ONE pty-output per onData call (the second additive listener only).
      expect(ptyOutputs).toHaveLength(1);
      const evt = ptyOutputs[0];
      // VERBATIM: byte-equal to the chunk, no split, no \n re-join.
      expect(evt.data).toBe(chunk);
      // Full per-run identity fields present.
      expect(Object.keys(evt).sort()).toEqual(['data', 'panelId', 'runId', 'sessionId', 'timestamp', 'type']);
      expect(evt.panelId).toBe(panelId);
      expect(evt.sessionId).toBe(sessionId);
      expect(evt.runId).toBe(runId);
      expect(evt.type).toBe('pty');
      expect(evt.timestamp).toBeInstanceOf(Date);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a second onData chunk yields a second VERBATIM pty-output (one per call)', async () => {
      const ptyOutputs: Array<{ data: string }> = [];
      mgr.on('pty-output', (evt) => ptyOutputs.push(evt as { data: string }));

      const spawn = mgr.spawnCliProcess({ panelId: 'p2', sessionId: 's2', worktreePath: '/tmp/wt2', prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      const a = 'first\nchunk';
      const b = '\x1b[31msecond\x1b[0m';
      mgr.ptys[0].fireData(a);
      mgr.ptys[0].fireData(b);

      expect(ptyOutputs.map((e) => e.data)).toEqual([a, b]);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('raw PTY bytes never ride the output channel and parseCliOutput stays []', async () => {
      const panelId = 'panel-iso';
      const sessionId = 'sess-iso';

      const outputs: Array<{ type: string }> = [];
      mgr.on('output', (evt) => outputs.push(evt as { type: string }));

      const spawn = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/wt-iso', prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // session_info emitted once at spawn on the output channel.
      const outputCountBeforeChunk = outputs.length;
      expect(outputCountBeforeChunk).toBeGreaterThanOrEqual(1);

      // A raw PTY chunk produces a pty-output, never an output. The base
      // setupProcessHandlers.onData line-splits 'line1\n' and feeds it to
      // parseCliOutput, which returns [] — so NO new output emit fires.
      mgr.ptys[0].fireData('\x1b[2Jline1\nline2');
      expect(outputs.length).toBe(outputCountBeforeChunk);

      // parseCliOutput returns [] for any raw line (no structured panel events).
      const parsed = (mgr as unknown as {
        parseCliOutput(d: string, p: string, s: string): unknown[];
      }).parseCliOutput('line1\n', panelId, sessionId);
      expect(parsed).toEqual([]);

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
