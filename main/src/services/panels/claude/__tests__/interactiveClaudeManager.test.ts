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
import { execSync } from 'child_process';
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
import { InteractiveMcpEnabler } from '../interactiveMcpEnabler';
import { QUICK_WORKFLOW_NAME } from '../../../../orchestrator/workflowRegistry';
import { getCyboflowSubdirectory } from '../../../../utils/cyboflowDirectory';
import type { PermissionMode } from '../../../../../../shared/types/workflows';
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

  /** Records no-fork resume binds; sets the uuid as the real source would. */
  readonly bindKnownFileFromEndCalls: string[] = [];
  bindKnownFileFromEnd(sessionUuid: string): boolean {
    this.bindKnownFileFromEndCalls.push(sessionUuid);
    this.uuid = sessionUuid;
    return true;
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
  callEnsureWorktreeExcludes(worktreePath: string): void {
    (this as unknown as { ensureWorktreeExcludesCyboflowDir(p: string): void }).ensureWorktreeExcludesCyboflowDir(worktreePath);
  }
  callInitializeCliEnvironment(options: Record<string, unknown>): Promise<{ [key: string]: string }> {
    return (this as unknown as {
      initializeCliEnvironment(o: Record<string, unknown>): Promise<{ [key: string]: string }>;
    }).initializeCliEnvironment(options);
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

function createMockConfigManager(
  claudeExecutablePath?: string,
  defaultAgentPermissionMode?: PermissionMode,
  theme?: 'paper' | 'light' | 'dark',
): ConfigManager {
  return {
    getConfig: vi.fn(() => ({ claudeExecutablePath, theme })),
    // Global 4-mode default consumed by resolveSessionAgentPermissionMode (the
    // quick/legacy-session seam mirrored from the SDK twin).
    getDefaultAgentPermissionMode: vi.fn(() => defaultAgentPermissionMode),
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

    it('emits a plain "--resume <uuid>" (NO --fork-session) when resumeSessionId is set', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'continue please',
        resumeSessionId: 'abc-123-uuid',
      });
      const idx = args.indexOf('--resume');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('abc-123-uuid');
      // NO fork: eager resume reopens the SAME id and appends to the existing
      // transcript (stable id, no rewind). Fork was rejected — it forks lazily on
      // the first turn, so an eager prompt-less resume would diverge from the id.
      expect(args).not.toContain('--fork-session');
    });

    it('omits --resume and --fork-session when resumeSessionId is unset', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--fork-session');
    });

    it('keeps resume flags before any end-of-options "--" separator', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        resumeSessionId: 'abc-123-uuid',
      });
      const sepIdx = args.indexOf('--');
      const flagIdx = args.indexOf('--resume');
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      if (sepIdx >= 0) {
        expect(flagIdx).toBeLessThan(sepIdx);
      }
    });

    it('emits "--permission-mode auto" when agentPermissionMode === "auto" (native auto-mode)', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        agentPermissionMode: 'auto',
      });
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('auto');
    });

    it('emits "--permission-mode auto" BEFORE any end-of-options "--" separator', () => {
      // buildCommandArgs does NOT push the "--" / positional prompt itself (that
      // happens in spawnCliProcess), but the flag must precede where it lands.
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        agentPermissionMode: 'auto',
      });
      const sepIdx = args.indexOf('--');
      const flagIdx = args.indexOf('--permission-mode');
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      // No separator emitted by buildCommandArgs; if one ever were, the flag must precede it.
      if (sepIdx >= 0) {
        expect(flagIdx).toBeLessThan(sepIdx);
      }
    });

    it('omits "--permission-mode" for non-auto agentPermissionMode values', () => {
      for (const mode of ['default', 'acceptEdits', 'dontAsk'] as const) {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: '/tmp/wt',
          prompt: 'hi',
          agentPermissionMode: mode,
        });
        expect(args).not.toContain('--permission-mode');
      }
    });

    it('omits "--permission-mode" when agentPermissionMode is unset', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(args).not.toContain('--permission-mode');
    });

    it('includes --mcp-config (pointing at the per-run config) and emits ONLY the inline fast-mode --settings (no dangling settings-FILE flag, TASK-819)', () => {
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
        // A single `--settings <inline-json>` is emitted carrying ALL
        // session-only keys: the fast-mode pin (OFF by default + per-session, so
        // a persisted `/fast` can't leak in) AND the PreToolUse `'*'` gating
        // hook (inline delivery — probe-verified that flag-tier hooks fire and
        // block; nothing is written into the worktree). Its value is INLINE
        // JSON, never a settings-file path. No ultracode key for a plain spawn.
        const settingsIdx = args.indexOf('--settings');
        expect(settingsIdx).toBeGreaterThanOrEqual(0);
        // exactly one --settings flag
        expect(args.filter((a) => a === '--settings')).toHaveLength(1);
        const inlineSettings = JSON.parse(args[settingsIdx + 1]) as {
          fastMode: boolean;
          fastModePerSessionOptIn: boolean;
          hooks?: { PreToolUse?: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[] };
        };
        expect(inlineSettings.fastMode).toBe(false);
        expect(inlineSettings.fastModePerSessionOptIn).toBe(true);
        // Default (no opt-out) → the gate rides the flag: '*' matcher, our
        // compiled hook script, the high human-decision timeout.
        const gate = inlineSettings.hooks?.PreToolUse?.[0];
        expect(gate?.matcher).toBe('*');
        expect(gate?.hooks?.[0]?.type).toBe('command');
        expect(gate?.hooks?.[0]?.command).toContain('preToolUseShellHook');
        expect(gate?.hooks?.[0]?.timeout).toBe(86_400);
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });

    /** Parse the inline --settings JSON out of a built args array. */
    function inlineSettingsOf(args: string[]): { hooks?: unknown } {
      const idx = args.indexOf('--settings');
      expect(idx).toBeGreaterThanOrEqual(0);
      return JSON.parse(args[idx + 1]) as { hooks?: unknown };
    }

    it.each(['ignore', 'auto', 'dontAsk'] as const)(
      'omits the inline gating hook for opt-out mode %s (single opt-out source: resolveInlineGatingHooks)',
      (mode) => {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: '/tmp/wt',
          prompt: 'hi',
          ...(mode === 'ignore' ? { permissionMode: 'ignore' } : { agentPermissionMode: mode }),
        });
        expect(inlineSettingsOf(args).hooks).toBeUndefined();
      },
    );

    it('keeps the inline gating hook for acceptEdits (edits fast-pathed in the handler, gate stays)', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        agentPermissionMode: 'acceptEdits',
      });
      expect(inlineSettingsOf(args).hooks).toBeDefined();
    });

    it('4-mode agentPermissionMode takes precedence over the legacy permissionMode for the gate decision', () => {
      // legacy 'approve' (gate) + 4-mode 'auto' (no gate) → no gate.
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        permissionMode: 'approve',
        agentPermissionMode: 'auto',
      });
      expect(inlineSettingsOf(args).hooks).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // initializeCliEnvironment — forces conversation-transcript persistence so a
  // leaked CLAUDE_CODE_CHILD_SESSION (cyboflow launched from inside a Claude
  // Code session) can't suppress the transcript the structured pipeline tails.
  // -------------------------------------------------------------------------
  describe('initializeCliEnvironment', () => {
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

    it('always sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1', async () => {
      const env = await mgr.callInitializeCliEnvironment({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
      });
      expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1');
    });

    // COLORFGBG signals the terminal background luminance so claude picks a
    // matching theme (notably the user-message banner fill). Light bg → "0;15",
    // dark bg → "15;0".
    const opts = { panelId: 'p1', sessionId: 's1', worktreePath: '/tmp/wt', prompt: 'hi' };

    function mgrWithTheme(theme?: 'paper' | 'light' | 'dark'): TestableInteractiveClaudeManager {
      return new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(undefined, undefined, theme),
        db,
      );
    }

    it('sets COLORFGBG="15;0" (dark) when config theme is dark', async () => {
      const env = await mgrWithTheme('dark').callInitializeCliEnvironment(opts);
      expect(env.COLORFGBG).toBe('15;0');
    });

    it.each(['paper', 'light'] as const)(
      'sets COLORFGBG="0;15" (light) when config theme is %s',
      async (theme) => {
        const env = await mgrWithTheme(theme).callInitializeCliEnvironment(opts);
        expect(env.COLORFGBG).toBe('0;15');
      },
    );

    it('defaults COLORFGBG to light ("0;15") when theme is unset', async () => {
      const env = await mgr.callInitializeCliEnvironment(opts);
      expect(env.COLORFGBG).toBe('0;15');
    });

    // CYBOFLOW_RUN_ARTIFACTS_DIR — SDK-substrate parity (claudeCodeManager.
    // composeRunEnv). The ui-prototype / visual-verify agent prose writes its
    // deliverables under "$CYBOFLOW_RUN_ARTIFACTS_DIR", so the interactive
    // REPL's shell env must export it too, keyed by the SAME resolved runId as
    // CYBOFLOW_RUN_ID (the id cyboflow_report_artifact derives the run from).
    it('exports CYBOFLOW_RUN_ARTIFACTS_DIR keyed by the resolved run id when an orch socket is injected', async () => {
      mgr.setOrchSocketPath('/tmp/orch.sock');
      const env = await mgr.callInitializeCliEnvironment({ ...opts, runId: 'run-42' });
      expect(env.CYBOFLOW_RUN_ID).toBe('run-42');
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBe(
        getCyboflowSubdirectory('artifacts', 'runs', 'run-42'),
      );
    });

    it('omits CYBOFLOW_RUN_ARTIFACTS_DIR when no orchestrator socket is injected', async () => {
      const env = await mgr.callInitializeCliEnvironment(opts);
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Worktree-local git exclude for .cyboflow/ — keeps cyboflow plumbing
  // (interactive-mcp.json) out of the session diff and out of `git add -A`
  // sweeps. Real-git round-trip on a temp repo.
  // -------------------------------------------------------------------------
  describe('ensureWorktreeExcludesCyboflowDir', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;
    let repo: string;

    beforeEach(() => {
      db = makeRawEventsDb();
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-exclude-'));
    });

    afterEach(() => {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('appends .cyboflow/ to the repo-local info/exclude of a real git checkout', () => {
      execSync('git init -q', { cwd: repo });
      mgr.callEnsureWorktreeExcludes(repo);
      const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
      expect(exclude.split('\n').map((l) => l.trim())).toContain('.cyboflow/');
      // The exclude is actually honored: an untracked .cyboflow file is invisible to git.
      fs.mkdirSync(path.join(repo, '.cyboflow'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.cyboflow', 'interactive-mcp.json'), '{}', 'utf-8');
      const status = execSync('git status --porcelain', { cwd: repo, encoding: 'utf-8' });
      expect(status).not.toContain('.cyboflow');
    });

    it('is idempotent — a second call appends nothing', () => {
      execSync('git init -q', { cwd: repo });
      mgr.callEnsureWorktreeExcludes(repo);
      const first = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
      mgr.callEnsureWorktreeExcludes(repo);
      const second = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
      expect(second).toBe(first);
      expect(second.split('\n').filter((l) => l.trim() === '.cyboflow/')).toHaveLength(1);
    });

    it('fail-soft on a non-git directory — warns, does not throw', () => {
      expect(() => mgr.callEnsureWorktreeExcludes(repo)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // PreToolUse shell-approval hook: INLINE --settings delivery. Spawn writes
  // NOTHING into the worktree's .claude/ — it only STRIPS a legacy on-disk
  // entry (double-fire guard) via settingsWriter.remove. Real-fs round-trip on
  // a temp worktree exercises the merge-safe strip.
  // -------------------------------------------------------------------------
  describe('shell-approval hook spawn side effects (inline --settings delivery)', () => {
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

    it('writes NOTHING into <worktree>/.claude on spawn — only the legacy strip (remove) runs, once, with the worktree path', async () => {
      const removeSpy = vi.spyOn(InteractiveSettingsWriter.prototype, 'remove');
      const worktreePath = freshWorktree();
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-hook',
        sessionId: 'sess-hook',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => mgr.ptys.length > 0);

      // Legacy double-fire guard invoked with the worktree path.
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy.mock.calls[0][0]).toBe(worktreePath);

      // The gate rides the inline --settings flag: NO settings.json is created.
      expect(readSettings(worktreePath)).toBeUndefined();

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('strips a LEGACY on-disk cyboflow entry from an older build (any path ending in the hook filename) while preserving user keys', async () => {
      const worktreePath = freshWorktree();
      const dotClaude = path.join(worktreePath, '.claude');
      fs.mkdirSync(dotClaude, { recursive: true });
      fs.writeFileSync(
        path.join(dotClaude, 'settings.json'),
        JSON.stringify({
          permissions: { allow: ['Bash(ls:*)'] },
          hooks: {
            PreToolUse: [
              // A packaged build's absolute path — different from this build's
              // resolved dev path, but same trailing filename.
              { matcher: '*', hooks: [{ type: 'command', command: '/Applications/Cyboflow.app/x/preToolUseShellHook.js', timeout: 86400 }] },
              // A user's own '*' hook pointing elsewhere must survive.
              { matcher: '*', hooks: [{ type: 'command', command: '/Users/me/my-own-hook.sh' }] },
            ],
          },
        }),
        'utf8',
      );

      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-legacy',
        sessionId: 'sess-legacy',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => mgr.ptys.length > 0);

      const settings = readSettings(worktreePath);
      expect(hasCyboflowHook(settings)).toBe(false);
      expect(settings?.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      const survivors = settings?.hooks?.PreToolUse ?? [];
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.hooks?.[0]?.command).toBe('/Users/me/my-own-hook.sh');

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('routes the opt-out diagnostic through the adapted logger (debug -> verbose shim wired)', async () => {
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
        permissionMode: 'ignore',
      });
      await waitFor(() => m.ptys.length > 0);

      // resolveInlineGatingHooks' opt-out diagnostic routed through the adapted
      // logger (debug -> verbose). A no-logger call would silently no-op this.
      expect(
        logger.verbose.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('opts out of gating'),
        ),
      ).toBe(true);

      m.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('in-place session (migration 046): skips mcpEnabler.enable so the user\'s real .claude/settings.local.json is never touched', async () => {
      const enableSpy = vi.spyOn(InteractiveMcpEnabler.prototype, 'enable');
      const m = new TestableInteractiveClaudeManager(
        createMockSessionManager({
          getDbSession: vi.fn(() => ({ id: 'sess-ip', in_place: 1 })),
        } as unknown as Parameters<typeof createMockSessionManager>[0]),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
      const worktreePath = freshWorktree();
      const spawn = m.spawnCliProcess({
        panelId: 'panel-ip',
        sessionId: 'sess-ip',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => m.ptys.length > 0);

      expect(enableSpy).not.toHaveBeenCalled();
      // And nothing was created under the checkout's .claude/.
      expect(readSettings(worktreePath)).toBeUndefined();

      m.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('worktree session (control): mcpEnabler.enable IS called', async () => {
      const enableSpy = vi.spyOn(InteractiveMcpEnabler.prototype, 'enable');
      const worktreePath = freshWorktree();
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-wt',
        sessionId: 'sess-wt',
        worktreePath,
        prompt: 'go',
      });
      await waitFor(() => mgr.ptys.length > 0);

      expect(enableSpy).toHaveBeenCalledTimes(1);
      expect(enableSpy.mock.calls[0][0]).toBe(worktreePath);

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

    it('strips a legacy \'*\' hook at teardown while preserving a pre-seeded user key (inline delivery writes none itself)', async () => {
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

      // Inline delivery: spawn writes NO hook on disk; the user key is intact.
      const afterSpawn = readSettings(worktreePath);
      expect(hasCyboflowHook(afterSpawn)).toBe(false);
      expect((afterSpawn as { permissions?: { allow?: string[] } }).permissions?.allow).toEqual(['Bash(ls)']);

      // Simulate a LEGACY on-disk entry appearing mid-session (older build wrote
      // it before this build took over the worktree) — teardown must strip it.
      const legacy = readSettings(worktreePath) as Record<string, unknown>;
      fs.writeFileSync(
        path.join(dotClaude, 'settings.json'),
        JSON.stringify({
          ...legacy,
          hooks: {
            PreToolUse: [
              { matcher: '*', hooks: [{ type: 'command', command: '/old/build/preToolUseShellHook.js', timeout: 86400 }] },
            ],
          },
        }),
        'utf8',
      );
      expect(hasCyboflowHook(readSettings(worktreePath))).toBe(true);

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

    it('no-fork resume binds the KNOWN transcript from EOF and re-persists the SAME id (idempotent)', async () => {
      const sessionDbUpdate = vi.fn();
      const sm = createMockSessionManager({
        db: { updateSession: sessionDbUpdate } as unknown as MockDb,
      });
      const mgr = new TestableInteractiveClaudeManager(
        sm,
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );

      const panelId = 'panel-resume';
      const sessionId = 'sess-resume';
      // EAGER resume spawn: empty prompt + a stored claude_session_id.
      const spawn = mgr.spawnCliProcess({
        panelId,
        sessionId,
        worktreePath: '/tmp/wt-resume',
        prompt: '',
        resumeSessionId: 'resume-uuid-abc',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      // The spawn binds the pre-existing transcript directly (discovery can't see
      // it) so the structured pipeline / token meter flows for the resumed session.
      expect(mgr.fakeSources[0].bindKnownFileFromEndCalls).toEqual(['resume-uuid-abc']);
      // getSessionUuid now returns the resumed id → persist re-writes it (no rewind).
      expect(sessionDbUpdate).toHaveBeenCalledWith(sessionId, { claude_session_id: 'resume-uuid-abc' });

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

  // -------------------------------------------------------------------------
  // (T2) 4-mode resolution on the quick-session panel seams (trap T3b):
  // startPanel + continuePanel + restartPanelWithHistory resolve the session's
  // agent permission mode (legacy 'ignore' wins; else per-session override;
  // else global default) and thread it into spawnCliProcess options — mirroring
  // the SDK twin's spawnClaudeCode seeding
  // (claudeCodeManager.ts resolveSessionAgentPermissionMode).
  // -------------------------------------------------------------------------
  describe('startPanel/continuePanel/restartPanelWithHistory 4-mode resolution', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = makeRawEventsDb();
    });

    afterEach(() => {
      db.close();
      vi.clearAllMocks();
    });

    /**
     * Build a manager whose session row stores `storedMode` (omit = no row
     * field) and optionally a legacy `permission_mode` (read by
     * restartPanelWithHistory, which has no permissionMode arg).
     */
    function makeMgr(opts: {
      storedMode?: unknown;
      globalDefault?: PermissionMode;
      legacyMode?: 'approve' | 'ignore';
    }): TestableInteractiveClaudeManager {
      const sm = createMockSessionManager({
        getDbSession: vi.fn(() => ({
          ...(opts.storedMode === undefined ? {} : { agent_permission_mode: opts.storedMode }),
          ...(opts.legacyMode === undefined ? {} : { permission_mode: opts.legacyMode }),
        })) as unknown as SessionManager['getDbSession'],
      });
      return new TestableInteractiveClaudeManager(
        sm,
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(undefined, opts.globalDefault),
        db,
      );
    }

    it('startPanel threads the per-session agent_permission_mode override into spawn options', async () => {
      const mgr = makeMgr({ storedMode: 'acceptEdits', globalDefault: 'default' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.startPanel('p-4m', 's-4m', '/tmp/wt-4m', 'hi', 'approve', 'auto');

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0][0]).toMatchObject({
        panelId: 'p-4m',
        sessionId: 's-4m',
        permissionMode: 'approve',
        // The per-session override wins over the global default.
        agentPermissionMode: 'acceptEdits',
      });
    });

    it('startPanel falls back to the GLOBAL default when no per-session override is stored', async () => {
      const mgr = makeMgr({ globalDefault: 'auto' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.startPanel('p-glob', 's-glob', '/tmp/wt-glob', 'hi');

      expect(spawnSpy.mock.calls[0][0].agentPermissionMode).toBe('auto');
    });

    it('startPanel preserves the legacy \'ignore\' branch — agentPermissionMode stays undefined', async () => {
      // Even with a stored override AND a global default, an explicit legacy
      // 'ignore' (don't-ask) is a stronger statement and wins (twin parity).
      const mgr = makeMgr({ storedMode: 'acceptEdits', globalDefault: 'auto' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.startPanel('p-ign', 's-ign', '/tmp/wt-ign', 'hi', 'ignore');

      expect(spawnSpy.mock.calls[0][0].permissionMode).toBe('ignore');
      expect(spawnSpy.mock.calls[0][0].agentPermissionMode).toBeUndefined();
    });

    it('an invalid stored override falls through to the global default (isPermissionMode guard)', async () => {
      const mgr = makeMgr({ storedMode: 'bogus-mode', globalDefault: 'dontAsk' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.startPanel('p-bogus', 's-bogus', '/tmp/wt-bogus', 'hi');

      expect(spawnSpy.mock.calls[0][0].agentPermissionMode).toBe('dontAsk');
    });

    it('continuePanel re-resolves the 4-mode from the DB row on respawn (restart-safe)', async () => {
      const mgr = makeMgr({ storedMode: 'dontAsk', globalDefault: 'default' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.continuePanel('p-cont', 's-cont', '/tmp/wt-cont', 'continue please', [], 'approve');

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0][0]).toMatchObject({
        panelId: 'p-cont',
        permissionMode: 'approve',
        agentPermissionMode: 'dontAsk',
      });
    });

    it('restartPanelWithHistory re-resolves the 4-mode from the DB row (no wildcard gate for auto)', async () => {
      const mgr = makeMgr({ storedMode: 'auto', globalDefault: 'default' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.restartPanelWithHistory('p-rst', 's-rst', '/tmp/wt-rst', 'restart prompt', []);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      // Mirrors startPanel/continuePanel: without this a restarted interactive
      // panel ALWAYS installed the wildcard PreToolUse gate, even for auto/dontAsk.
      expect(spawnSpy.mock.calls[0][0]).toMatchObject({
        panelId: 'p-rst',
        sessionId: 's-rst',
        prompt: 'restart prompt',
        agentPermissionMode: 'auto',
      });
    });

    it("restartPanelWithHistory carries the session's legacy 'ignore' through (agentPermissionMode stays undefined)", async () => {
      // The restart seam has no permissionMode arg — it must read the legacy
      // permission_mode off the DB row (twin parity with the SDK manager) so an
      // explicit session-level 'ignore' is not clobbered by the global default.
      const mgr = makeMgr({ storedMode: 'acceptEdits', globalDefault: 'auto', legacyMode: 'ignore' });
      const spawnSpy = vi.spyOn(mgr, 'spawnCliProcess').mockResolvedValue(undefined);

      await mgr.restartPanelWithHistory('p-rst-ign', 's-rst-ign', '/tmp/wt-rst-ign', 'restart', []);

      expect(spawnSpy.mock.calls[0][0].permissionMode).toBe('ignore');
      expect(spawnSpy.mock.calls[0][0].agentPermissionMode).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (T2) relayUserTurn — composer-relay seam for PTY-backed QUICK sessions:
  // submits the way a human paste+Enter does (body, then a SEPARATE '\r' after
  // SUBMIT_DELAY_MS) so bracketed-paste cannot swallow the submit.
  // -------------------------------------------------------------------------
  describe('relayUserTurn (composer-relay seam)', () => {
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

    it('writes the body immediately and a SEPARATE \'\\r\' keystroke after the paste-coalescing delay', async () => {
      const panelId = 'panel-relay';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-relay', worktreePath: '/tmp/wt-relay', prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);
      const pty = mgr.ptys[0];

      mgr.relayUserTurn(panelId, 'hello from composer');

      // Body written immediately; the submitting '\r' has NOT ridden the same
      // burst (bracketed-paste would capture it as a literal newline).
      expect(pty.writes).toContain('hello from composer');
      expect(pty.writes).not.toContain('\r');

      // After SUBMIT_DELAY_MS (300ms) the '\r' lands as its OWN keystroke.
      await new Promise((r) => setTimeout(r, 450));
      expect(pty.writes).toContain('\r');
      expect(pty.writes.indexOf('hello from composer')).toBeLessThan(pty.writes.indexOf('\r'));

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('no-ops when no live process exists for the panel', () => {
      expect(() => mgr.relayUserTurn('panel-ghost', 'hello')).not.toThrow();
    });

    it('guards the deferred \'\\r\' against teardown within the delay window', async () => {
      const panelId = 'panel-relay-kill';
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: 'sess-relay-kill', worktreePath: '/tmp/wt-rk', prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);
      const pty = mgr.ptys[0];

      mgr.relayUserTurn(panelId, 'doomed turn');
      expect(pty.writes).toContain('doomed turn');

      // Tear down before SUBMIT_DELAY_MS elapses — the deferred '\r' is guarded
      // on the processes map and must not fire after the panel is gone.
      await mgr.killProcess(panelId);
      await new Promise((r) => setTimeout(r, 450));
      expect(pty.writes).not.toContain('\r');

      void spawn;
    });
  });

  // -------------------------------------------------------------------------
  // (T2) __quick__ sentinel step-append suppression: a quick-session run row
  // points at the per-project __quick__ sentinel workflow, which has no real
  // steps — buildStepReportingAppendForRun must return '' BY NAME even when a
  // resolvable spec_json sits on the sentinel row (the '{}' seed already
  // resolves null; the name guard closes the leak for any future spec).
  // -------------------------------------------------------------------------
  describe('__quick__ sentinel step-append suppression', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;

    /** A spec that WOULD resolve to a definition (and thus a non-empty append). */
    const validSpecJson = JSON.stringify({
      id: 'spec-on-row',
      phases: [
        {
          id: 'phase-1',
          label: 'Phase 1',
          color: '#aabbcc',
          steps: [{ id: 'step-1', name: 'Step 1', agent: 'executor' }],
        },
      ],
    });

    /** Seed a workflow + run pair (integration-test fixture pattern). */
    function seedRunWithWorkflow(runId: string, workflowName: string, specJson: string): void {
      const workflowId = `wf-${runId}`;
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
      ).run(workflowId, workflowName, specJson);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, worktree_path, status, policy_json)
         VALUES (?, ?, 1, '/tmp/test', 'running', '{}')`,
      ).run(runId, workflowId);
    }

    function callAppendForRun(runId: string): string {
      return (mgr as unknown as { buildStepReportingAppendForRun(r: string): string })
        .buildStepReportingAppendForRun(runId);
    }

    beforeEach(() => {
      db = createTestDb();
      mgr = new TestableInteractiveClaudeManager(
        createMockSessionManager(),
        createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
        createMockConfigManager(),
        db,
      );
    });

    afterEach(() => {
      db.close();
      vi.clearAllMocks();
    });

    it('returns \'\' for a sentinel __quick__ run even when its row carries a RESOLVABLE spec_json', () => {
      seedRunWithWorkflow('run-quick-1', QUICK_WORKFLOW_NAME, validSpecJson);
      expect(callAppendForRun('run-quick-1')).toBe('');
    });

    it('returns \'\' for the sentinel as seeded by ensureQuickWorkflow (spec_json \'{}\')', () => {
      seedRunWithWorkflow('run-quick-2', QUICK_WORKFLOW_NAME, '{}');
      expect(callAppendForRun('run-quick-2')).toBe('');
    });

    it('control: the SAME spec under a non-sentinel name produces a non-empty append', () => {
      seedRunWithWorkflow('run-custom-1', 'my-custom-flow', validSpecJson);
      const append = callAppendForRun('run-custom-1');
      expect(append.length).toBeGreaterThan(0);
      expect(append).toContain('cyboflow_report_step');
      expect(append).toContain('`step-1`');
    });
  });
});
