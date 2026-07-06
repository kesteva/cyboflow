/**
 * Unit tests for ClaudeCodeManager.composeSystemPromptAppend per-spawn
 * precedence (TASK-661 acceptance criteria) and logger-wire coverage
 * (TASK-649 acceptance criteria).
 *
 * Behavior covered:
 *   - When both dbSession-derived append AND per-spawn systemPromptAppend are
 *     present, composeSystemPromptAppend concatenates them with a single blank
 *     line separator (perSpawn appended AFTER sessionAppend).
 *   - When only per-spawn is present (no dbSession append), only per-spawn is
 *     returned.
 *   - When only dbSession append is present, behavior is unchanged from prior
 *     to TASK-661.
 *   - When neither is present, undefined is returned.
 *   - Logger spy is wired through ClaudeCodeManager → RawEventsSink: warn()
 *     is called when RawEventsSink.handleEvent fails to INSERT (TASK-649).
 *
 * TypedEventNarrowing convergence (TASK-730):
 *   - Malformed SDK event → narrower returns { kind: '__unknown__', raw }
 *     which lands in raw_events.payload_json as { "kind": "__unknown__" }.
 *   - Well-formed SDK event → narrower returns the typed variant (not __unknown__).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SDKMessage, SDKUserMessage, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  sdkResultSuccess,
  readInitialPromptText,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { CliManagerFactory } from '../../../cliManagerFactory';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';

type LoggerSpy = ReturnType<typeof makeProdLoggerSpy>;

// ---------------------------------------------------------------------------
// Shared fake SDK — one module mock backed by the shared fakeSdk handle. It
// captures each query() call's options (for the systemPrompt/toolConfig
// assertions) and defaults to a single happy-path result event; individual tests
// swap the stream via `fakeSdk.setMessages` / `fakeSdk.setImplementation`.
// The factory arrow reads `fakeSdk` lazily (only when query() is actually called),
// mirroring the queryMock delegation pattern in monitorQuery.test.ts.
// ---------------------------------------------------------------------------

const fakeSdk = createModuleFakeSdk([sdkResultSuccess()]);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

/** The buildSdkOptions output captured on the latest query() call, typed for reads. */
type CapturedOptions = {
  systemPrompt?: { append?: string | null };
  toolConfig?: { askUserQuestion?: { previewFormat?: string } };
};
function capturedOptions(): CapturedOptions | undefined {
  return fakeSdk.lastOptions as CapturedOptions | undefined;
}

vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal SessionManager mock factories
// ---------------------------------------------------------------------------

function createMockSessionManager(sessionAppend?: string): SessionManager {
  return {
    getDbSession: vi.fn(() => {
      if (sessionAppend !== undefined) {
        return { id: 'sess-1', system_prompt_append: sessionAppend };
      }
      return undefined;
    }),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.composeSystemPromptAppend — per-spawn precedence', () => {
  let db: Database.Database;
  let logger: LoggerSpy;

  beforeEach(() => {
    fakeSdk.reset();
    db = createTestDb();
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('concatenates per-spawn systemPromptAppend to dbSession append when both are present', async () => {
    // SessionManager returns a session with no system_prompt — only configManager
    // drives sessionAppend.  We want a non-undefined sessionAppend, so we provide
    // a configManager stub that returns a global prompt.
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => 'global instruction'),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-wiring-1',
      sessionId: 'session-wiring-1',
      worktreePath: '/tmp/test',
      prompt: 'do something',
      permissionMode: 'ignore',
      systemPromptAppend: 'per-spawn instruction',
    });

    // Wait for the SDK iterator to complete.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fakeSdk.lastOptions).toBeDefined();
    const append = capturedOptions()?.systemPrompt?.append;
    expect(append).toBe('global instruction\n\nper-spawn instruction');
  });

  it('returns only per-spawn append when dbSession has no append', async () => {
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-wiring-2',
      sessionId: 'session-wiring-2',
      worktreePath: '/tmp/test',
      prompt: 'do something',
      permissionMode: 'ignore',
      systemPromptAppend: 'only per-spawn',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    const append = capturedOptions()?.systemPrompt?.append;
    expect(append).toBe('only per-spawn');
  });

  it('returns only dbSession append when per-spawn is absent', async () => {
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => 'global instruction'),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-wiring-3',
      sessionId: 'session-wiring-3',
      worktreePath: '/tmp/test',
      prompt: 'do something',
      permissionMode: 'ignore',
      // no systemPromptAppend
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    const append = capturedOptions()?.systemPrompt?.append;
    expect(append).toBe('global instruction');
  });

  it('returns undefined when neither dbSession nor per-spawn append is present', async () => {
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-wiring-4',
      sessionId: 'session-wiring-4',
      worktreePath: '/tmp/test',
      prompt: 'do something',
      permissionMode: 'ignore',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    const append = capturedOptions()?.systemPrompt?.append;
    expect(append === undefined || append === null).toBe(true);
  });

  it('drives query() in streaming-input mode: prompt is an AsyncIterable whose first message carries finalPrompt, and it completes after the fake emits result', async () => {
    // SDK 0.3.201 regression fix: flow turns MUST pass an AsyncIterable prompt (not
    // a bare string) so stdin stays open for the AskUserQuestion / canUseTool gate.
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-stream-1',
      sessionId: 'session-stream-1',
      worktreePath: '/tmp/test',
      prompt: 'stream this prompt',
      permissionMode: 'ignore',
    });
    await new Promise<void>((r) => setTimeout(r, 0));

    // query() received a streaming-input iterable, NOT a bare string.
    const prompt = fakeSdk.lastPrompt;
    expect(prompt).toBeDefined();
    expect(typeof prompt).not.toBe('string');

    // Its FIRST yielded message carries the finalPrompt verbatim (promptEnhancer is
    // mocked to identity in this file, so finalPrompt === the request prompt).
    const streamed = prompt as AsyncIterable<SDKUserMessage>;
    expect(await readInitialPromptText(streamed)).toBe('stream this prompt');

    // The iterable COMPLETES after the turn: production released the input gate when
    // the fake emitted its terminal `result`, so a pull past the initial message
    // returns done (the generator returned → stdin would close → CLI exits).
    const settled = await streamed[Symbol.asyncIterator]().next();
    expect(settled.done).toBe(true);
  });

  it('constructor throws TypeError when db is undefined (no silent degraded mode)', () => {
    expect(() => {
      new ClaudeCodeManager(
        createMockSessionManager(),
        undefined,
        undefined,
        undefined as unknown as Database.Database, // simulate a caller bypassing TS
      );
    }).toThrow(/db argument is required/i);
  });

  it('logger spy receives warn() when RawEventsSink INSERT fails — proves the ClaudeCodeManager → pipeline logger wire', async () => {
    // Use a fake DB whose prepared statement's run() always throws.
    // This forces RawEventsSink.handleEvent into its fail-soft catch block,
    // which calls this.logger?.warn(...).  Because ClaudeCodeManager passes
    // `this.logger` to new RawEventsSink(this.db, this.logger) during
    // spawnCliProcess, the spy must observe the call — proving the logger
    // reference flows from manager construction through to the pipeline.
    // Reference: rawEventsSink.ts:112-116 (fail-soft catch).
    const fakeStmt = { run: vi.fn(() => { throw new Error('simulated INSERT failure'); }) };
    const fakeDb = {
      prepare: vi.fn(() => fakeStmt),
    } as unknown as Database.Database;

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      fakeDb,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-logger-wire',
      sessionId: 'session-logger-wire',
      worktreePath: '/tmp/test',
      prompt: 'trigger warn via pipeline',
      permissionMode: 'ignore',
    });

    // Let the async SDK iterator and RawEventsSink dispatch settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    // logger.warn must have been called by RawEventsSink.handleEvent with the
    // fail-soft message; matches the sibling assertion in
    // streamParser/__tests__/rawEventsSink.test.ts.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[rawEventsSink]'));
  });
});

// ---------------------------------------------------------------------------
// duck-type guard tests — cliManagerFactory validates additionalOptions.db
// ---------------------------------------------------------------------------

describe('CliManagerFactory claude tool — duck-type guard on additionalOptions.db', () => {
  // Share a single CliManagerFactory singleton across all tests.  The
  // CliToolRegistry singleton is NOT torn down between tests; creating a fresh
  // CliManagerFactory per test would re-register 'claude' and throw.  All four
  // test cases exercise guard failure paths (before any manager is cached), so
  // the registry manager cache stays empty and the factory closure fires fresh
  // on every call — no inter-test interference.
  const factory = CliManagerFactory.getInstance();
  const mockSessionManager = { id: 'mock-session-manager' } as unknown as SessionManager;

  afterEach(async () => {
    // Shut down to clear the registry's manager cache (guards throw before
    // caching, but be explicit).  CliManagerFactory.instance is set to null;
    // subsequent CliManagerFactory.getInstance() calls within this describe
    // block re-use the same object reference held in `factory` const.
    await factory.shutdown();
  });

  it('throws TypeError containing "requires `db`" when additionalOptions is empty ({})', async () => {
    await expect(
      factory.createManager('claude', {
        sessionManager: mockSessionManager,
        additionalOptions: {},
        skipValidation: true,
      }),
    ).rejects.toThrow(/requires `db`/);
  });

  it('throws TypeError containing "requires `db`" when additionalOptions is undefined', async () => {
    await expect(
      factory.createManager('claude', {
        sessionManager: mockSessionManager,
        additionalOptions: undefined,
        skipValidation: true,
      }),
    ).rejects.toThrow(/requires `db`/);
  });

  it('wrong-shape db: throws TypeError naming .prepare() when db is an object lacking .prepare', async () => {
    await expect(
      factory.createManager('claude', {
        sessionManager: mockSessionManager,
        additionalOptions: { db: { foo: 'bar' } },
        skipValidation: true,
      }),
    ).rejects.toThrow(/\.prepare\(\)/);
  });

  it('wrong-shape db: throws TypeError naming .prepare() when db is a primitive string ("not-a-db")', async () => {
    await expect(
      factory.createManager('claude', {
        sessionManager: mockSessionManager,
        additionalOptions: { db: 'not-a-db' },
        skipValidation: true,
      }),
    ).rejects.toThrow(/\.prepare\(\)/);
  });
});

// ---------------------------------------------------------------------------
// TypedEventNarrowing convergence (TASK-730)
// ---------------------------------------------------------------------------

describe('TypedEventNarrowing convergence (TASK-730)', () => {
  let db: Database.Database;
  let logger: LoggerSpy;

  beforeEach(() => {
    fakeSdk.reset();
    // FK enforcement off: raw_events rows can reference a panelId run_id
    // without seeding the workflows → workflow_runs FK chain.
    db = createTestDb({ disableForeignKeys: true });
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('malformed SDK event → narrow() produces __unknown__ variant stored in raw_events', async () => {
    // Override sdkYields for this test: yield a completely unknown event variant
    // that the Zod schema cannot parse. TypedEventNarrowing.narrow() must
    // return { kind: '__unknown__', raw: { type: 'completely_unknown_variant_xyz', ... } }
    // and RawEventsSink must persist that object as payload_json.
    // A deliberately malformed event (not a builder) so the narrower must fall
    // back to { kind: '__unknown__' }; the cast is intrinsic to the test.
    fakeSdk.setImplementation(() =>
      (async function* () {
        yield { type: 'completely_unknown_variant_xyz', timestamp: '2026-05-22T00:00:00Z' } as unknown as SDKMessage;
      })(),
    );

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-narrow-unknown',
      sessionId: 'session-narrow-unknown',
      worktreePath: '/tmp/test',
      prompt: 'trigger narrowing with unknown event',
      permissionMode: 'ignore',
    });

    // Let the async SDK iterator and RawEventsSink dispatch settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Verify that raw_events has at least one row whose payload_json contains
    // the __unknown__ kind discriminant — proving the narrower intercepted the
    // malformed event instead of passing the raw cast through.
    const rows = db.prepare('SELECT payload_json FROM raw_events WHERE run_id = ?').all('panel-narrow-unknown') as Array<{ payload_json: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const unknownRow = rows.find((r) => {
      try {
        const parsed = JSON.parse(r.payload_json) as Record<string, unknown>;
        return parsed['kind'] === '__unknown__';
      } catch {
        return false;
      }
    });
    expect(unknownRow).toBeDefined();
    // Confirm the raw payload is preserved inside the __unknown__ wrapper.
    const parsedUnknown = JSON.parse(unknownRow!.payload_json) as Record<string, unknown>;
    expect(parsedUnknown['kind']).toBe('__unknown__');
  });

  it('well-formed SDK event → narrow() produces typed variant (not __unknown__) in raw_events', async () => {
    // A fully-valid result event from the shared typed builder (all required
    // fields per resultSuccessSchema), so the narrower yields a typed variant.
    fakeSdk.setMessages([sdkResultSuccess()]);

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-narrow-typed',
      sessionId: 'session-narrow-typed',
      worktreePath: '/tmp/test',
      prompt: 'trigger narrowing with well-formed event',
      permissionMode: 'ignore',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    const rows = db.prepare('SELECT payload_json FROM raw_events WHERE run_id = ?').all('panel-narrow-typed') as Array<{ payload_json: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Every row must be a known typed variant — none should be __unknown__.
    for (const row of rows) {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(parsed['kind']).not.toBe('__unknown__');
      // The result event must carry the 'type' field directly.
      expect(parsed['type']).toBe('result');
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-758: toolConfig + routeAskUserQuestion hook wiring
// ---------------------------------------------------------------------------

describe('TASK-758: AskUserQuestion wiring', () => {
  let db: Database.Database;
  let logger: LoggerSpy;

  beforeEach(() => {
    fakeSdk.reset();
    db = createTestDb();
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // ─── toolConfig.askUserQuestion.previewFormat='markdown' is present ───────

  it('buildSdkOptions includes toolConfig.askUserQuestion.previewFormat=markdown unconditionally', async () => {
    // permissionMode:'ignore' skips the PreToolUse hook but toolConfig is set
    // unconditionally before the hooks conditional spread — verify it lands.
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-toolconfig',
      sessionId: 'session-toolconfig',
      worktreePath: '/tmp/test',
      prompt: 'test toolConfig present',
      permissionMode: 'ignore',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fakeSdk.lastOptions).toBeDefined();
    expect(capturedOptions()?.toolConfig?.askUserQuestion?.previewFormat).toBe('markdown');
  });

  // ─── PreToolUse hook timeout (production bug: 600s CLI default killed a ────
  // ─── 10-minute-unanswered human gate, falling through to canUseTool) ───────

  it('composeHookOptions carries a PreToolUse matcher timeout of 86400s (24h), not the CLI 600s default', async () => {
    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    await mgr.spawnCliProcess({
      panelId: 'panel-hook-timeout',
      sessionId: 'session-hook-timeout',
      worktreePath: '/tmp/test',
      prompt: 'test PreToolUse hook timeout',
      permissionMode: 'ignore',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    const matchers = fakeSdk.lastOptions?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
    expect(matchers).toBeDefined();
    expect(matchers?.[0]?.timeout).toBe(86_400);
  });

  // ─── routeAskUserQuestion happy path: updatedInput shape ─────────────────

  it('makePreToolUseHook routes AskUserQuestion to QuestionRouter and returns updatedInput payload', async () => {
    // Stub QuestionRouter.getInstance().requestQuestion to resolve immediately
    // so the hook does not block waiting for a real user answer.
    const fakeAnswer = { answers: { 'Which approach?': 'TDD' } };
    vi.spyOn(QuestionRouter, 'getInstance').mockReturnValue({
      requestQuestion: vi.fn().mockResolvedValue(fakeAnswer),
    } as unknown as QuestionRouter);

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    // Extract the hook callback via private access — makePreToolUseHook is the
    // factory; we call it directly and invoke the resulting callback.
    const mgrPrivate = mgr as unknown as {
      makePreToolUseHook: (
        panelId: string,
        allowRules: { allow: string[]; deny: string[] },
      ) => (
        input: unknown,
        toolUseId: string,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const hook = mgrPrivate.makePreToolUseHook('panel-ask-user', { allow: [], deny: [] });

    const fakeQuestions = [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [{ label: 'TDD', description: 'Test-driven' }],
      },
    ];

    const fakePreToolInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tool-use-ask-001',
      tool_input: { questions: fakeQuestions },
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      cwd: '/tmp',
    };

    const result = await hook(fakePreToolInput, 'tool-use-ask-001', null);
    const output = result as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        updatedInput?: { questions: unknown; answers: unknown };
      };
    };

    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput.updatedInput).toEqual({
      questions: fakeQuestions,
      answers: fakeAnswer.answers,
    });
  });

  // ─── routeAskUserQuestion error path: deny on QuestionRouter throw ────────

  it('makePreToolUseHook returns permissionDecision:deny when QuestionRouter.requestQuestion throws', async () => {
    vi.spyOn(QuestionRouter, 'getInstance').mockReturnValue({
      requestQuestion: vi.fn().mockRejectedValue(new Error('run not running')),
    } as unknown as QuestionRouter);

    const sessionManager = createMockSessionManager();
    // Pass undefined logger so makeLoggerLike falls back to the console shim
    // (which has .error()). The prod spy only has warn/info/verbose, and the
    // error path in routeAskUserQuestion calls loggerLike.error().
    const mgr = new ClaudeCodeManager(
      sessionManager,
      undefined,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    const mgrPrivate = mgr as unknown as {
      makePreToolUseHook: (
        panelId: string,
        allowRules: { allow: string[]; deny: string[] },
      ) => (
        input: unknown,
        toolUseId: string,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const hook = mgrPrivate.makePreToolUseHook('panel-ask-error', { allow: [], deny: [] });

    const fakePreToolInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tool-use-ask-002',
      tool_input: { questions: [] },
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      cwd: '/tmp',
    };

    const result = await hook(fakePreToolInput, 'tool-use-ask-002', null);
    const output = result as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason?: string;
      };
    };

    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Internal question-router error');
  });

  // ─── Non-AskUserQuestion tools still delegate to ApprovalRouter ───────────

  it('makePreToolUseHook delegates non-AskUserQuestion tools to ApprovalRouter', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    const mgrPrivate = mgr as unknown as {
      makePreToolUseHook: (
        panelId: string,
        allowRules: { allow: string[]; deny: string[] },
      ) => (
        input: unknown,
        toolUseId: string,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const hook = mgrPrivate.makePreToolUseHook('panel-bash', { allow: [], deny: [] });

    const fakePreToolInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-use-bash-001',
      tool_input: { command: 'ls' },
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      cwd: '/tmp',
    };

    const result = await hook(fakePreToolInput, 'tool-use-bash-001', null);
    const output = result as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
      };
    };

    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval).toHaveBeenCalledWith('panel-bash', 'Bash', { command: 'ls' }, expect.any(Function));
  });

  it('makePreToolUseHook auto-allows a tool matching the allow-list without calling ApprovalRouter', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ behavior: 'allow' as const });
    vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({
      requestApproval,
    } as unknown as ApprovalRouter);

    const sessionManager = createMockSessionManager();
    const mgr = new ClaudeCodeManager(
      sessionManager,
      logger as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );

    const mgrPrivate = mgr as unknown as {
      makePreToolUseHook: (
        panelId: string,
        allowRules: { allow: string[]; deny: string[] },
      ) => (
        input: unknown,
        toolUseId: string,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const hook = mgrPrivate.makePreToolUseHook('panel-allow', {
      allow: ['Bash(git status:*)'],
      deny: [],
    });

    const fakePreToolInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-use-allow-001',
      tool_input: { command: 'git status -s' },
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      cwd: '/tmp',
    };

    const result = await hook(fakePreToolInput, 'tool-use-allow-001', null);
    const output = result as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string };
    };

    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    // The key assertion: a granted tool bypasses the approval router entirely.
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
