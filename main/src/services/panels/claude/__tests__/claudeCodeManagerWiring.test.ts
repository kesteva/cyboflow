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
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import PQueue from 'p-queue';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';

// ---------------------------------------------------------------------------
// Logger spy factory (TASK-649)
//
// Structurally compatible with Pick<Logger, 'warn' | 'info' | 'verbose'>.
// The production Logger class (utils/logger.ts) exposes more methods; only
// these three are consumed by the ClaudeCodeManager / RawEventsSink pipeline.
// Pattern matches main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts.
// ---------------------------------------------------------------------------

type LoggerSpy = Pick<Logger, 'warn' | 'info' | 'verbose'>;

function makeLoggerSpy(): LoggerSpy {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  } as unknown as LoggerSpy;
}


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
      return (async function* () {
        // Yield one result event and finish immediately.
        yield { type: 'result', subtype: 'success' } as unknown;
      })();
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

const SCHEMA_PATH = join(process.cwd(), 'src/database/migrations/006_cyboflow_schema.sql');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

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
    logger = makeLoggerSpy();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
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

    // logger.warn must have been called by RawEventsSink.handleEvent.
    expect(logger.warn).toHaveBeenCalled();
    // Inspect warn.mock.calls[0] to verify the fail-soft message content.
    // (warn.mock.calls is the vitest Mock API surface; cast needed since LoggerSpy
    // types warn as a plain function, not a vi.fn Mock.)
    const warn = logger.warn as unknown as import('vitest').MockInstance;
    expect(warn.mock.calls[0][0]).toContain('[rawEventsSink]');
  });
});
