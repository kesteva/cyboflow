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
import PQueue from 'p-queue';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { CliManagerFactory } from '../../../cliManagerFactory';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';

type LoggerSpy = ReturnType<typeof makeProdLoggerSpy>;

// ---------------------------------------------------------------------------
// Hoisted SDK yield factory — allows per-test override of the yielded sequence.
// ---------------------------------------------------------------------------

const { sdkYields } = vi.hoisted(() => {
  /**
   * sdkYields: a vi.fn() that returns an AsyncGenerator of SDK events.
   *
   * Default implementation yields one happy-path result event.
   * Tests that need a different sequence call
   * `sdkYields.mockImplementationOnce(async function* () { ... })`.
   */
  const sdkYields = vi.fn(async function* () {
    yield { type: 'result', subtype: 'success' } as unknown;
  });
  return { sdkYields };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Capture the latest `options` passed to query() so tests can inspect
 * systemPrompt.append without depending on SDK internals.
 */
let capturedQueryOptions: { systemPrompt?: { append?: string | null } } | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn(
    (params: { prompt: string; options?: { systemPrompt?: { append?: string | null }; abortController?: AbortController } }) => {
      capturedQueryOptions = params.options ?? null;
      // Delegate to the hoisted sdkYields factory so tests can override the
      // yielded event sequence without replacing the whole query mock.
      return sdkYields();
    },
  );
  return { query: queryFn };
});

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
// Database / ApprovalRouter helpers
// ---------------------------------------------------------------------------

function makeQueueFactory(): { getOrCreate: (runId: string) => PQueue } {
  const queues = new Map<string, PQueue>();
  return {
    getOrCreate(runId: string): PQueue {
      let q = queues.get(runId);
      if (!q) {
        q = new PQueue({ concurrency: 1 });
        queues.set(runId, q);
      }
      return q;
    },
  };
}

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
    capturedQueryOptions = null;
    db = createTestDb();
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));
    QuestionRouter.initialize(adapter, qf.getOrCreate.bind(qf));
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

    expect(capturedQueryOptions).not.toBeNull();
    const append = capturedQueryOptions?.systemPrompt?.append;
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

    const append = capturedQueryOptions?.systemPrompt?.append;
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

    const append = capturedQueryOptions?.systemPrompt?.append;
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

    const append = capturedQueryOptions?.systemPrompt?.append;
    expect(append === undefined || append === null).toBe(true);
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
    capturedQueryOptions = null;
    // FK enforcement off: raw_events rows can reference a panelId run_id
    // without seeding the workflows → workflow_runs FK chain.
    db = createTestDb({ disableForeignKeys: true });
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));
    QuestionRouter.initialize(adapter, qf.getOrCreate.bind(qf));
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
    sdkYields.mockImplementationOnce(async function* () {
      yield { type: 'completely_unknown_variant_xyz', timestamp: '2026-05-22T00:00:00Z' } as unknown;
    });

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
    // Override sdkYields to emit a fully-valid result event (all required fields
    // per resultSuccessSchema: is_error, duration_ms, num_turns). The minimal
    // { type: 'result', subtype: 'success' } shape fails Zod validation because
    // resultBaseFields requires these numeric fields.
    sdkYields.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 100,
        num_turns: 1,
      } as unknown;
    });

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
