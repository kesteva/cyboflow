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
import { FakePty } from '../../../../test/fakes/fakePty';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { orchTokenRegistry } from '../../../../orchestrator/orchAuthToken';
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
// Fake TranscriptSource — lets the test push normalized lines + fire turn-end.
// ---------------------------------------------------------------------------

class FakeTranscriptSource implements TranscriptSource {
  onLine: OnLineCallback | undefined;
  onTurnEnd: OnTurnEndCallback | undefined;
  stopped = false;
  started = false;
  /** The manager's out-of-band bind channel (persists claude_session_id). */
  onLateBind: ((sessionUuid: string) => void) | undefined;
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

  /**
   * How the manager constructed this source: `deferDeadlineUntilArmed` is set
   * when the spawn started no turn, so the discovery clock waits for one.
   */
  deferDeadlineUntilArmed = false;
  /** The minted `--session-id` the manager pinned discovery to (fresh spawns). */
  expectedSessionUuid: string | undefined;

  /** Counts armDiscoveryDeadline() calls (the manager's turn-start edge). */
  armCalls = 0;
  armDiscoveryDeadline(): void {
    this.armCalls += 1;
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
  protected override async spawnPtyProcess(
    _command: string,
    args: string[],
  ): Promise<import('@homebridge/node-pty-prebuilt-multiarch').IPty> {
    const fake = new FakePty();
    fake.args = args; // the FULL argv the production spawn would hand claude
    this.ptys.push(fake);
    return fake as unknown as import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  }

  protected override createTranscriptSource(
    _worktreePath: string,
    callbacks?: {
      onLateBind?: (sessionUuid: string) => void;
      onGiveUp?: () => void;
      deferDeadlineUntilArmed?: boolean;
      expectedSessionUuid?: string;
    },
  ): TranscriptSource {
    const src = new FakeTranscriptSource(this.nextSessionUuid);
    src.deferDeadlineUntilArmed = callbacks?.deferDeadlineUntilArmed === true;
    src.expectedSessionUuid = callbacks?.expectedSessionUuid;
    src.onLateBind = callbacks?.onLateBind;
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
    // Fan-out dispatch mode, read once per spawn; this mock pins 'prose'
    // so these tests keep asserting the prose prompt/install path.
    getFanOutDispatch: vi.fn(() => 'prose'),
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

    it('omits --model when a stale Codex model value reaches Claude interactive', () => {
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        model: 'gpt-5.5',
      });

      expect(args).not.toContain('--model');
    });

    it('emits --append-system-prompt for sessionBriefing, and nothing when blank', () => {
      const withBriefing = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: '',
        sessionBriefing: 'You are running inside cyboflow.',
      });
      const idx = withBriefing.indexOf('--append-system-prompt');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(withBriefing[idx + 1]).toBe('You are running inside cyboflow.');

      for (const blank of [undefined, '', '   ']) {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: '/tmp/wt',
          prompt: 'hi',
          ...(blank === undefined ? {} : { sessionBriefing: blank }),
        });
        expect(args).not.toContain('--append-system-prompt');
      }
    });

    it('NEVER emits systemPromptAppend as a flag — that field is the workflow channel', () => {
      // RunExecutor sets systemPromptAppend on EVERY run with the step-reporting
      // + fan-out appends; this substrate already prepends those to the prompt
      // body (composePromptBody). A flag here would deliver them twice, with the
      // degraded copy in the system prompt. Found in adversarial review.
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'do the step',
        systemPromptAppend: '## Step reporting\nCall cyboflow_report_step…',
      });
      expect(args).not.toContain('--append-system-prompt');
      expect(args.join(' ')).not.toContain('Step reporting');
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
          hooks?: {
            PreToolUse?: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[];
            Stop?: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[];
          };
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
        // The Stop turn-end hook (IDEA-030) rides the SAME flag, unconditionally
        // (no matcher, no permissionMode opt-out).
        const stop = inlineSettings.hooks?.Stop?.[0];
        expect(stop?.matcher).toBeUndefined();
        expect(stop?.hooks?.[0]?.type).toBe('command');
        expect(stop?.hooks?.[0]?.command).toContain('stopShellHook');
        expect(stop?.hooks?.[0]?.timeout).toBe(10);
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });

    /** Parse the inline --settings JSON out of a built args array. */
    function inlineSettingsOf(args: string[]): { hooks?: { PreToolUse?: unknown; Stop?: unknown } } {
      const idx = args.indexOf('--settings');
      expect(idx).toBeGreaterThanOrEqual(0);
      return JSON.parse(args[idx + 1]) as { hooks?: { PreToolUse?: unknown; Stop?: unknown } };
    }

    it.each(['ignore', 'auto', 'dontAsk'] as const)(
      'omits the inline PreToolUse gate for opt-out mode %s (single opt-out source: resolveInlineGatingHooks), but the Stop turn-end hook STILL rides the same flag (no opt-out, IDEA-030)',
      (mode) => {
        const args = mgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's1',
          worktreePath: '/tmp/wt',
          prompt: 'hi',
          ...(mode === 'ignore' ? { permissionMode: 'ignore' } : { agentPermissionMode: mode }),
        });
        // Opt-out drops the '*' wildcard GATE, but the non-gating AskUserQuestion
        // notify hook (the blocked-board signal) STILL rides unconditionally, as
        // does the Stop turn-end hook.
        const preToolUse = inlineSettingsOf(args).hooks?.PreToolUse as
          | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
          | undefined;
        expect(preToolUse).toHaveLength(1);
        expect(preToolUse?.[0]?.matcher).toBe('AskUserQuestion');
        expect(preToolUse?.[0]?.hooks?.[0]?.command).toContain('questionShellHook');
        expect(preToolUse?.some((g) => g.matcher === '*')).toBe(false);
        expect(inlineSettingsOf(args).hooks?.Stop).toBeDefined();
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
      expect(inlineSettingsOf(args).hooks?.PreToolUse).toBeDefined();
      expect(inlineSettingsOf(args).hooks?.Stop).toBeDefined();
    });

    it('points --mcp-config at the APP DATA dir path for an in-place session (never the checkout)', () => {
      const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-appdir-args-'));
      const prevCyboflowDir = process.env.CYBOFLOW_DIR;
      process.env.CYBOFLOW_DIR = appDir;
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-buildargs-ip-'));
      try {
        const inPlaceMgr = new TestableInteractiveClaudeManager(
          createMockSessionManager({
            getDbSession: vi.fn(() => ({ id: 's-ip', in_place: 1 })),
          } as unknown as Parameters<typeof createMockSessionManager>[0]),
          createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
          createMockConfigManager(),
          db,
        );
        const appConfigPath = path.join(appDir, 'interactive-mcp', 's-ip.json');
        fs.mkdirSync(path.dirname(appConfigPath), { recursive: true });
        fs.writeFileSync(appConfigPath, JSON.stringify({ mcpServers: {} }), 'utf8');
        // A stale worktree-located config must NOT win for in-place.
        fs.mkdirSync(path.join(wt, '.cyboflow'), { recursive: true });
        fs.writeFileSync(path.join(wt, '.cyboflow', 'interactive-mcp.json'), '{}', 'utf8');

        const args = inPlaceMgr.callBuildCommandArgs({
          panelId: 'p1',
          sessionId: 's-ip',
          worktreePath: wt,
          prompt: 'hi',
        });
        expect(args).toContain('--mcp-config');
        expect(args).toContain(appConfigPath);
        expect(args).not.toContain(path.join(wt, '.cyboflow', 'interactive-mcp.json'));
      } finally {
        if (prevCyboflowDir === undefined) delete process.env.CYBOFLOW_DIR;
        else process.env.CYBOFLOW_DIR = prevCyboflowDir;
        fs.rmSync(appDir, { recursive: true, force: true });
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });

    it('4-mode agentPermissionMode takes precedence over the legacy permissionMode for the gate decision', () => {
      // legacy 'approve' (gate) + 4-mode 'auto' (no gate) → no '*' PreToolUse gate
      // (the AskUserQuestion notify hook + Stop hook are unaffected — no opt-out).
      const args = mgr.callBuildCommandArgs({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/tmp/wt',
        prompt: 'hi',
        permissionMode: 'approve',
        agentPermissionMode: 'auto',
      });
      const preToolUse = inlineSettingsOf(args).hooks?.PreToolUse as
        | Array<{ matcher?: string }>
        | undefined;
      expect(preToolUse?.some((g) => g.matcher === '*')).toBe(false);
      expect(preToolUse?.some((g) => g.matcher === 'AskUserQuestion')).toBe(true);
      expect(inlineSettingsOf(args).hooks?.Stop).toBeDefined();
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

    // Bearer token (orchAuthToken.ts). The interactive substrate is the one
    // path whose MCP config lives ON DISK, so the token deliberately travels in
    // the PTY env instead — the claude CLI passes its full process env down to
    // stdio MCP servers and to the PreToolUse/Stop/Question shell hooks.
    it('exports a CYBOFLOW_ORCH_TOKEN that verifies against the resolved run id', async () => {
      mgr.setOrchSocketPath('/tmp/orch.sock');
      const env = await mgr.callInitializeCliEnvironment({ ...opts, runId: 'run-tok-i' });
      expect(env.CYBOFLOW_RUN_ID).toBe('run-tok-i');
      expect(orchTokenRegistry.verify('run-tok-i', env.CYBOFLOW_ORCH_TOKEN)).toBe(true);
      expect(orchTokenRegistry.verify('run-other', env.CYBOFLOW_ORCH_TOKEN)).toBe(false);
    });

    it('omits CYBOFLOW_ORCH_TOKEN when no orchestrator socket is injected', async () => {
      const env = await mgr.callInitializeCliEnvironment(opts);
      expect(env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
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
          (c) => typeof c[0] === 'string' && c[0].includes('opts out of wildcard PreToolUse gating'),
        ),
      ).toBe(true);

      m.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('in-place session (migration 047): skips mcpEnabler.enable so the user\'s real .claude/settings.local.json is never touched', async () => {
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

    it('in-place session with an orch socket: MCP config goes to the APP DATA dir — zero writes in the checkout, no exclude append, removed on teardown', async () => {
      const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-appdir-'));
      const prevCyboflowDir = process.env.CYBOFLOW_DIR;
      process.env.CYBOFLOW_DIR = appDir;
      try {
        const worktreePath = freshWorktree();
        // Real git checkout so an exclude append (the bug) would be observable.
        execSync('git init -q', { cwd: worktreePath });

        const m = new TestableInteractiveClaudeManager(
          createMockSessionManager({
            getDbSession: vi.fn(() => ({ id: 'sess-ip2', in_place: 1 })),
          } as unknown as Parameters<typeof createMockSessionManager>[0]),
          createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
          createMockConfigManager(),
          db,
        );
        m.setOrchSocketPath('/tmp/orch.sock');

        const panelId = 'panel-ip-mcp';
        const spawn = m.spawnCliProcess({ panelId, sessionId: 'sess-ip2', worktreePath, prompt: 'go' });
        await waitFor(() => m.fakeSources.length > 0 && m.fakeSources[0].started);

        // The config landed in the app data dir, keyed by sessionId…
        const appConfigPath = path.join(appDir, 'interactive-mcp', 'sess-ip2.json');
        expect(fs.existsSync(appConfigPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(appConfigPath, 'utf8')) as {
          mcpServers?: { cyboflow?: { env?: Record<string, string> } };
        };
        expect(written.mcpServers?.cyboflow?.env?.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/orch.sock');
        // The bearer token must NOT be in the file — it rides the PTY env.
        expect(written.mcpServers?.cyboflow?.env?.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
        expect(fs.readFileSync(appConfigPath, 'utf8')).not.toMatch(/[0-9a-f]{64}/);

        // …and the user's checkout was NOT touched: no .cyboflow dir, no
        // .git/info/exclude append.
        expect(fs.existsSync(path.join(worktreePath, '.cyboflow'))).toBe(false);
        const excludePath = path.join(worktreePath, '.git', 'info', 'exclude');
        const exclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        expect(exclude).not.toContain('.cyboflow/');

        // Teardown deletes the app-dir config (nothing else will ever sweep it).
        await m.killProcess(panelId);
        expect(fs.existsSync(appConfigPath)).toBe(false);

        void spawn;
      } finally {
        if (prevCyboflowDir === undefined) delete process.env.CYBOFLOW_DIR;
        else process.env.CYBOFLOW_DIR = prevCyboflowDir;
        fs.rmSync(appDir, { recursive: true, force: true });
      }
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
  // notifyTurnEnd — the Stop-hook seam (IDEA-030 turn-end-detection fix).
  // mcpQueryHandler's interactive-turn-end dispatch calls this directly (no PTY
  // spawn involved), so these tests seed `interactiveRuns` via the test
  // accessor rather than exercising the full spawn machinery.
  // -------------------------------------------------------------------------
  describe('notifyTurnEnd (Stop-hook seam, IDEA-030)', () => {
    let db: Database.Database;
    let mgr: TestableInteractiveClaudeManager;

    beforeEach(() => {
      db = makeRawEventsDb();
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

    /** Seed a minimal InteractiveRun entry directly (bypassing spawnCliProcess). */
    function seedInteractiveRun(panelId: string, runId: string): void {
      mgr.publicInteractiveRuns().set(panelId, {
        panelId,
        sessionId: `sess-${panelId}`,
        runId,
        worktreePath: '/tmp/wt',
        persistent: true,
        turnEnded: false,
        resolve: () => undefined,
        reject: () => undefined,
      });
    }

    it('returns true and emits "turn-end" with the matching panel/session for a tracked runId', () => {
      seedInteractiveRun('panel-x', 'run-x');
      const events: unknown[] = [];
      mgr.on('turn-end', (payload) => events.push(payload));

      expect(mgr.notifyTurnEnd('run-x')).toBe(true);
      expect(events).toEqual([{ panelId: 'panel-x', sessionId: 'sess-panel-x', runId: 'run-x' }]);
    });

    it('returns false and emits nothing for an unknown runId', () => {
      seedInteractiveRun('panel-y', 'run-y');
      const events: unknown[] = [];
      mgr.on('turn-end', (payload) => events.push(payload));

      expect(mgr.notifyTurnEnd('run-does-not-exist')).toBe(false);
      expect(events).toHaveLength(0);
    });

    it('scans across multiple tracked runs and drives the SAME "turn-end" event the transcript-marker path uses', () => {
      seedInteractiveRun('panel-a', 'run-a');
      seedInteractiveRun('panel-b', 'run-b');
      const events: Array<{ panelId: string; sessionId: string; runId: string }> = [];
      mgr.on('turn-end', (payload) => events.push(payload as { panelId: string; sessionId: string; runId: string }));

      expect(mgr.notifyTurnEnd('run-b')).toBe(true);
      expect(events).toEqual([{ panelId: 'panel-b', sessionId: 'sess-panel-b', runId: 'run-b' }]);
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
  // Transcript-discovery deadline: armed by a TURN, not by the spawn.
  // -------------------------------------------------------------------------
  describe('discovery deadline vs. a spawn that starts no turn', () => {
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

    afterEach(async () => {
      for (const pty of mgr.ptys) pty.fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      ApprovalRouter._resetForTesting();
      QuestionRouter._resetForTesting();
      db.close();
      vi.clearAllMocks();
    });

    it('an argv prompt spawns an UNDEFERRED source (spawn and first turn coincide)', async () => {
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd1',
        sessionId: 'sess-dd1',
        worktreePath: '/tmp/wt-dd1',
        prompt: 'go',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      expect(mgr.fakeSources[0].deferDeadlineUntilArmed).toBe(false);
      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a prompt-less spawn DEFERS the deadline and never arms it at spawn', async () => {
      // `claude` writes no transcript while its REPL idles, so a clock started
      // here would be timing the user; its latched give-up would permanently
      // detach the structured pipeline from a session that is merely quiet.
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd2',
        sessionId: 'sess-dd2',
        worktreePath: '/tmp/wt-dd2',
        prompt: '',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      expect(mgr.fakeSources[0].deferDeadlineUntilArmed).toBe(true);
      expect(mgr.fakeSources[0].armCalls).toBe(0);
      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it("arms the deadline on the first turn's arming edge, once — not on later turns", async () => {
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd3',
        sessionId: 'sess-dd3',
        worktreePath: '/tmp/wt-dd3',
        prompt: '',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);
      const src = mgr.fakeSources[0];

      // Composed body with no Enter yet starts nothing.
      mgr.sendInput('panel-dd3', 'first message');
      expect(src.armCalls).toBe(0);

      // The composer's deferred Enter submits — the turn starts here.
      mgr.sendInput('panel-dd3', '\r');
      expect(src.armCalls).toBe(1);

      // A second submit inside the SAME turn is not a new arming edge.
      mgr.sendInput('panel-dd3', 'more\r');
      expect(src.armCalls).toBe(1);

      // A later turn re-arms the edge; the source itself is idempotent, but the
      // manager should not be spraying calls per keystroke either.
      mgr.notifyTurnEnd('panel-dd3');
      mgr.sendInput('panel-dd3', 'second turn\r');
      expect(src.armCalls).toBe(2);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a fresh spawn mints a --session-id and pins discovery to that exact uuid', async () => {
      // The pin is what makes a long-lived source safe: the key dir is shared
      // with sibling panels and in-place sessions, and cwd cannot tell them
      // apart. The uuid claude is told to use IS the file we wait for.
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd6',
        sessionId: 'sess-dd6',
        worktreePath: '/tmp/wt-dd6',
        prompt: '',
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      const args = mgr.ptys[0].args;
      const idx = args.indexOf('--session-id');
      expect(idx).toBeGreaterThanOrEqual(0);
      const minted = args[idx + 1];
      expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(mgr.fakeSources[0].expectedSessionUuid).toBe(minted);
      expect(args).not.toContain('--resume');

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a briefing spawn puts --append-system-prompt BEFORE `--` and carries no positional prompt', async () => {
      // The `--mcp-config` variadic swallows anything after it that is not a
      // flag; only `--` ends option parsing. A briefing on the wrong side of it
      // would be parsed as prompt text (or as a bogus config path).
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd8',
        sessionId: 'sess-dd8',
        worktreePath: '/tmp/wt-dd8',
        prompt: '',
        sessionBriefing: 'You are running inside cyboflow.',
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      const args = mgr.ptys[0].args;
      const flagIdx = args.indexOf('--append-system-prompt');
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(args[flagIdx + 1]).toBe('You are running inside cyboflow.');
      // No positional prompt → no `--` at all: the REPL opens idle.
      expect(args).not.toContain('--');
      expect(mgr.fakeSources[0].deferDeadlineUntilArmed).toBe(true);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('with BOTH a briefing and a prompt, the flag precedes `--` and the prompt follows it', async () => {
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd9',
        sessionId: 'sess-dd9',
        worktreePath: '/tmp/wt-dd9',
        prompt: 'fix the parser',
        sessionBriefing: 'context',
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      const args = mgr.ptys[0].args;
      const sep = args.indexOf('--');
      expect(sep).toBeGreaterThanOrEqual(0);
      expect(args.indexOf('--append-system-prompt')).toBeLessThan(sep);
      expect(args[sep + 1]).toBe('fix the parser');
      expect(args.length).toBe(sep + 2);
      expect(mgr.fakeSources[0].deferDeadlineUntilArmed).toBe(false);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a resume reopens the known file: --resume, no --session-id, no pin', async () => {
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd7',
        sessionId: 'sess-dd7',
        worktreePath: '/tmp/wt-dd7',
        prompt: '',
        resumeSessionId: 'known-uuid-777',
      });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      const args = mgr.ptys[0].args;
      expect(args).not.toContain('--session-id');
      expect(args[args.indexOf('--resume') + 1]).toBe('known-uuid-777');
      expect(mgr.fakeSources[0].expectedSessionUuid).toBeUndefined();
      expect(mgr.fakeSources[0].bindKnownFileFromEndCalls).toEqual(['known-uuid-777']);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a bare Enter with no composed body arms nothing (it starts no turn)', async () => {
      const spawn = mgr.spawnCliProcess({
        panelId: 'panel-dd4',
        sessionId: 'sess-dd4',
        worktreePath: '/tmp/wt-dd4',
        prompt: '',
      });
      await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);

      mgr.sendInput('panel-dd4', '\r');
      expect(mgr.fakeSources[0].armCalls).toBe(0);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  it('a deferred source binding on the first turn still persists claude_session_id', async () => {
    // The spawn returned without awaiting discovery, so the bind arrives out of
    // band through onLateBind — the only channel left that can persist the id.
    const db = createTestDb({ disableForeignKeys: true });
    ApprovalRouter.initialize(dbAdapter(db));
    QuestionRouter.initialize(dbAdapter(db));
    const sessionDbUpdate = vi.fn();
    const mgr = new TestableInteractiveClaudeManager(
      createMockSessionManager({ db: { updateSession: sessionDbUpdate } as unknown as MockDb }),
      createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
      createMockConfigManager(),
      db,
    );

    const spawn = mgr.spawnCliProcess({
      panelId: 'panel-dd5',
      sessionId: 'sess-dd5',
      worktreePath: '/tmp/wt-dd5',
      prompt: '',
    });
    await waitFor(() => mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);
    expect(sessionDbUpdate).not.toHaveBeenCalled();

    mgr.fakeSources[0].onLateBind?.('first-turn-uuid');
    expect(sessionDbUpdate).toHaveBeenCalledWith('sess-dd5', { claude_session_id: 'first-turn-uuid' });

    mgr.ptys[0].fireExit(0);
    await new Promise((r) => setTimeout(r, 600));
    await spawn;
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
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

    it('two panels sharing ONE session (Add-chat): killing the second-spawned panel tears down ONLY that panel, not the first', async () => {
      // Regression for the sessionId->panelId lookup bug: cleanupCliResources
      // used to derive "the" panel for a sessionId via findPanelIdForSession,
      // which returned whichever panel happened to iterate first out of
      // interactiveRuns/processes (insertion order == panel-A, spawned first)
      // — REGARDLESS of which panel's process actually exited. Killing
      // panel-B (spawned second, sharing panel-A's session) used to tear down
      // panel-A's live run instead, because it was "the" panel for that
      // session. The fix threads panelId straight through from the base
      // contract, so this must tear down exactly the panel that was killed.
      const sharedSessionId = 'sess-shared';
      const spawnA = mgr.spawnCliProcess({ panelId: 'panel-A', sessionId: sharedSessionId, worktreePath: '/tmp/A', prompt: 'a' });
      await waitFor(() => mgr.fakeSources.length >= 1 && mgr.fakeSources[0].started);
      const spawnB = mgr.spawnCliProcess({ panelId: 'panel-B', sessionId: sharedSessionId, worktreePath: '/tmp/B', prompt: 'b' });
      await waitFor(() => mgr.fakeSources.length >= 2 && mgr.fakeSources[1].started);

      const srcA = mgr.fakeSources[0];
      const srcB = mgr.fakeSources[1];
      expect(mgr.publicInteractiveRuns().has('panel-A')).toBe(true);
      expect(mgr.publicInteractiveRuns().has('panel-B')).toBe(true);

      // Kill panel-B — the SECOND panel spawned into the shared session.
      await mgr.killProcess('panel-B');

      // Only B's TranscriptSource stopped; A (still live) must be untouched.
      expect(srcB.stopped).toBe(true);
      expect(srcA.stopped).toBe(false);

      // Router pending cleared under B's id, never A's.
      expect(clearApprovalSpy).toHaveBeenCalledWith('panel-B');
      expect(clearApprovalSpy).not.toHaveBeenCalledWith('panel-A');

      // B's maps cleared; A's sibling entries survive — no cross-panel leak.
      expect(mgr.publicInteractiveRuns().has('panel-B')).toBe(false);
      expect(mgr.publicTailSources().has('panel-B')).toBe(false);
      expect(mgr.publicPipelines().has('panel-B')).toBe(false);
      expect(mgr.publicInteractiveRuns().has('panel-A')).toBe(true);
      expect(mgr.publicTailSources().has('panel-A')).toBe(true);
      expect(mgr.publicPipelines().has('panel-A')).toBe(true);

      // Drain A cleanly to release its pending spawn promise.
      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawnA;

      void spawnB;
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
  // AskUserQuestion "blocked" flag lifecycle (quick-session status board):
  // notifyQuestionOpen SETS it; a turn-end must NOT clear it (asking a question
  // IS a turn-end in interactive mode); a SUBMITTED line (CR/LF through
  // sendInput) clears it; a bare navigation keystroke does not.
  // -------------------------------------------------------------------------
  describe('AskUserQuestion blocked-flag lifecycle', () => {
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

    /** Spawn a live REPL and return its runId (=== panelId for a plain mock row). */
    async function spawnLive(panelId: string): Promise<{ runId: string; spawn: Promise<void> }> {
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: `sess-${panelId}`, worktreePath: `/tmp/wt-${panelId}`, prompt: 'go' });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[0].started);
      // Guard the panelId === runId assumption this suite relies on.
      expect(mgr.notifyTurnEnd(panelId)).toBe(true);
      return { runId: panelId, spawn };
    }

    it('a turn-end does NOT clear the flag (asking the question is itself the turn-end)', async () => {
      const { runId, spawn } = await spawnLive('panel-q-turnend');
      mgr.notifyQuestionOpen(runId);
      expect(mgr.getAwaitingInputRunIds().has(runId)).toBe(true);

      // The Stop hook fires as the PTY parks on the open question — the flag must survive.
      mgr.notifyTurnEnd(runId);
      expect(mgr.getAwaitingInputRunIds().has(runId)).toBe(true);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a submitted line (CR) through sendInput clears the flag (the answer)', async () => {
      const { runId, spawn } = await spawnLive('panel-q-submit');
      mgr.notifyQuestionOpen(runId);
      expect(mgr.getAwaitingInputRunIds().has(runId)).toBe(true);

      mgr.sendInput(runId, '\r');
      expect(mgr.getAwaitingInputRunIds().has(runId)).toBe(false);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });

    it('a bare navigation keystroke (no CR/LF) leaves the flag set', async () => {
      const { runId, spawn } = await spawnLive('panel-q-nav');
      mgr.notifyQuestionOpen(runId);

      // Down-arrow escape sequence — the user is still choosing an option.
      mgr.sendInput(runId, '\x1b[B');
      expect(mgr.getAwaitingInputRunIds().has(runId)).toBe(true);

      mgr.ptys[0].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    });
  });

  // -------------------------------------------------------------------------
  // ROB-5 PTY turn-in-flight tracking — the settle-barrier / merge-gate answer
  // for the interactive substrate. Armed by the spawn's argv prompt or a
  // submitted composed line; cleared by the deterministic turn-end (Stop hook /
  // transcript marker) and teardown. See turnInFlightPanelIds.
  // -------------------------------------------------------------------------
  describe('ROB-5 turn-in-flight tracking (hasTurnInFlightForSession)', () => {
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

    /** Spawn a live REPL (prompt rides argv) WITHOUT the guard notifyTurnEnd call. */
    async function spawnLive(panelId: string, prompt = 'go'): Promise<{ sessionId: string; spawn: Promise<void> }> {
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: `sess-${panelId}`, worktreePath: `/tmp/wt-${panelId}`, prompt });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[mgr.fakeSources.length - 1].started);
      return { sessionId: `sess-${panelId}`, spawn };
    }

    async function drain(spawn: Promise<void>): Promise<void> {
      mgr.ptys[mgr.ptys.length - 1].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    }

    it('a non-empty argv prompt arms the flag at spawn; the Stop-hook turn-end clears it', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r1');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(true);

      mgr.notifyTurnEnd('panel-r1'); // runId === panelId for a plain mock row
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);

      await drain(spawn);
    });

    it('an empty prompt (eager resume) does NOT arm at spawn', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r2', '');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);
      await drain(spawn);
    });

    it('a submitted composed line re-arms (body write, then the deferred CR)', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r3');
      mgr.notifyTurnEnd('panel-r3');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);

      mgr.sendInput('panel-r3', 'fix the flaky test'); // composed body
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false); // not yet submitted
      mgr.sendInput('panel-r3', '\r'); // the composer's deferred Enter
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(true);

      mgr.notifyTurnEnd('panel-r3');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);
      await drain(spawn);
    });

    it('a bare Enter with no composed body since the last submit does NOT arm', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r4');
      mgr.notifyTurnEnd('panel-r4');

      mgr.sendInput('panel-r4', '\r');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);
      await drain(spawn);
    });

    it('inline body + CR in one write (raw terminal paste) arms', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r5');
      mgr.notifyTurnEnd('panel-r5');

      mgr.sendInput('panel-r5', 'run the suite\r');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(true);
      await drain(spawn);
    });

    it('process exit clears the answer even mid-turn (a dead PTY holds no turn)', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r6');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(true);

      await drain(spawn);
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(false);
    });

    it('answers per-session: an armed panel never leaks into a sibling session', async () => {
      const { sessionId, spawn } = await spawnLive('panel-r7');
      expect(mgr.hasTurnInFlightForSession(sessionId)).toBe(true);
      expect(mgr.hasTurnInFlightForSession('sess-someone-else')).toBe(false);
      await drain(spawn);
    });
  });

  // -------------------------------------------------------------------------
  // 'turn-start' — the per-turn START edge a persistent REPL otherwise cannot
  // report. 'spawned' fires once per PROCESS, so before this event only the
  // composer path (sessions:input -> markRunning) could flip a quick session to
  // 'running'; a turn started by raw terminal keystrokes (how a TUI
  // AskUserQuestion is answered) left the session at its resting status for the
  // whole turn, which froze sessions.idle_since and kept the row out of the
  // board's "Working" group. Emitted on the SAME edge the ROB-5 mark arms.
  // -------------------------------------------------------------------------
  describe("'turn-start' emission (the raw-keystroke status seam)", () => {
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

    async function spawnLive(panelId: string, prompt = 'go'): Promise<{ sessionId: string; spawn: Promise<void> }> {
      const spawn = mgr.spawnCliProcess({ panelId, sessionId: `sess-${panelId}`, worktreePath: `/tmp/wt-${panelId}`, prompt });
      await waitFor(() => mgr.ptys.length > 0 && mgr.fakeSources.length > 0 && mgr.fakeSources[mgr.fakeSources.length - 1].started);
      return { sessionId: `sess-${panelId}`, spawn };
    }

    async function drain(spawn: Promise<void>): Promise<void> {
      mgr.ptys[mgr.ptys.length - 1].fireExit(0);
      await new Promise((r) => setTimeout(r, 600));
      await spawn;
    }

    it('a submitted line that starts a turn emits turn-start with { panelId, sessionId, runId }', async () => {
      const { sessionId, spawn } = await spawnLive('panel-ts1');
      const seen: Array<{ panelId: string; sessionId: string; runId: string }> = [];
      mgr.on('turn-start', (p) => seen.push(p as { panelId: string; sessionId: string; runId: string }));

      mgr.notifyTurnEnd('panel-ts1'); // the REPL parks (e.g. on a question)
      mgr.sendInput('panel-ts1', 'yes, rebase and push\r'); // the raw-terminal answer

      expect(seen).toEqual([{ panelId: 'panel-ts1', sessionId, runId: 'panel-ts1' }]);
      await drain(spawn);
    });

    it('does NOT re-emit for a second submitted line inside the same turn (arming EDGE only)', async () => {
      const { spawn } = await spawnLive('panel-ts2');
      const seen: unknown[] = [];
      mgr.on('turn-start', (p) => seen.push(p));

      mgr.notifyTurnEnd('panel-ts2');
      mgr.sendInput('panel-ts2', 'first\r');
      mgr.sendInput('panel-ts2', 'second\r'); // already in flight
      expect(seen).toHaveLength(1);

      // A new turn boundary re-arms the edge, so the NEXT answer emits again.
      mgr.notifyTurnEnd('panel-ts2');
      mgr.sendInput('panel-ts2', 'third\r');
      expect(seen).toHaveLength(2);
      await drain(spawn);
    });

    it('a bare Enter with no composed body starts nothing and emits nothing', async () => {
      const { spawn } = await spawnLive('panel-ts3');
      const seen: unknown[] = [];
      mgr.on('turn-start', (p) => seen.push(p));

      mgr.notifyTurnEnd('panel-ts3');
      mgr.sendInput('panel-ts3', '\r');
      expect(seen).toHaveLength(0);

      // A navigation keystroke (no CR/LF) is not a submit either — but it DOES
      // leave composed body behind, so the following Enter is a real turn.
      mgr.sendInput('panel-ts3', '\x1b[B');
      expect(seen).toHaveLength(0);
      mgr.sendInput('panel-ts3', '\r');
      expect(seen).toHaveLength(1);
      await drain(spawn);
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
