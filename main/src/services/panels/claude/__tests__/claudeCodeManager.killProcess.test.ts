/**
 * Unit tests for ClaudeCodeManager.killProcess cleanup ordering.
 *
 * Acceptance criteria: after killProcess() returns, all of pipelines,
 * sdkRuns, and processes maps must be empty. Pipeline disposal is
 * single-sourced through runSdkQuery's finally block — killProcess must NOT
 * call cleanupPipeline directly.
 *
 * Two cases:
 * 1. killProcess mid-stream: a running query is aborted, all maps cleared.
 * 2. killProcess with no active run: idempotent, no throw, maps still empty.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import PQueue from 'p-queue';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import type { DatabaseLike } from '../../../../orchestrator/types';
import { ClaudeCodeManager } from '../claudeCodeManager';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn((params: { prompt: string; options?: { abortController?: AbortController } }) => {
    // Return an AsyncGenerator that yields one system/init event then parks
    // until the AbortController fires, simulating a mid-stream run that only
    // ends when aborted.
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown;
      const abortController = params.options?.abortController;
      if (abortController) {
        // Park here until aborted
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) {
            resolve();
            return;
          }
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
  return { query: queryFn };
});

// Mock heavy filesystem / path helpers to avoid real I/O
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
// Database / ApprovalRouter helpers (mirrors approvalRouter.test.ts)
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(
  process.cwd(),
  'src/database/migrations/006_cyboflow_schema.sql',
);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function dbAdapter(db: Database.Database): DatabaseLike {
  return {
    prepare: (sql) => db.prepare(sql),
    transaction: <T>(fn: (...args: unknown[]) => T) =>
      db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
  };
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
// Minimal SessionManager mock
// ---------------------------------------------------------------------------

import type { SessionManager } from '../../../sessionManager';

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Map accessor helpers — reach into private maps via index signature
// ---------------------------------------------------------------------------

function getPipelines(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { pipelines: Map<string, unknown> }).pipelines;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { sdkRuns: Map<string, unknown> }).sdkRuns;
}

function getProcesses(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { processes: Map<string, unknown> }).processes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.killProcess', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;
  let clearPendingForRunSpy: MockInstance;

  beforeEach(() => {
    db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));
    ClaudeCodeManager.setSharedDb(db);
    mgr = new ClaudeCodeManager(createMockSessionManager());
    // Spy on clearPendingForRun to assert it is called from runSdkQuery's
    // finally block (single-sourced), not directly from killProcess.
    clearPendingForRunSpy = vi.spyOn(
      ApprovalRouter.getInstance(),
      'clearPendingForRun',
    );
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    ClaudeCodeManager.setSharedDb(null);
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: killProcess mid-stream leaves all maps empty
  // -------------------------------------------------------------------------
  it('killProcess mid-stream clears pipelines, sdkRuns, and processes maps', async () => {
    const panelId = 'panel-kill-1';
    const sessionId = 'session-kill-1';

    // The mock query parks on the AbortController signal until aborted,
    // simulating a mid-stream run. Spawn the SDK run (registers entries in all three maps)
    const spawnPromise = mgr.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath: '/tmp/test-worktree',
      prompt: 'do something',
      permissionMode: 'ignore', // skip PreToolUse hook wiring
    });
    await spawnPromise;

    // Confirm all three maps are populated after spawn
    expect(getPipelines(mgr).has(panelId)).toBe(true);
    expect(getSdkRuns(mgr).has(panelId)).toBe(true);
    expect(getProcesses(mgr).has(panelId)).toBe(true);

    // Kill mid-stream — this must abort the run and wait for finally to fire
    await mgr.killProcess(panelId);

    // All maps must be empty after kill
    expect(getPipelines(mgr).has(panelId)).toBe(false);
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    expect(getProcesses(mgr).has(panelId)).toBe(false);

    // clearPendingForRun must have been called exactly once with panelId,
    // from runSdkQuery's finally block — not directly from killProcess.
    // This guards the single-sourced disposal invariant: if the call ever
    // moves to (or is duplicated in) killProcess, the call-count check will
    // catch an erroneous double-call.
    expect(clearPendingForRunSpy).toHaveBeenCalledOnce();
    expect(clearPendingForRunSpy).toHaveBeenCalledWith(panelId);
  });

  // -------------------------------------------------------------------------
  // Case 2: killProcess on a panel with no active run is idempotent
  // -------------------------------------------------------------------------
  it('killProcess on a panel with no active run does not throw and all maps remain empty', async () => {
    const panelId = 'panel-kill-2';

    // Verify maps are empty before anything
    expect(getPipelines(mgr).has(panelId)).toBe(false);
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    expect(getProcesses(mgr).has(panelId)).toBe(false);

    // Must not throw
    await expect(mgr.killProcess(panelId)).resolves.toBeUndefined();

    // Maps must still be empty
    expect(getPipelines(mgr).has(panelId)).toBe(false);
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    expect(getProcesses(mgr).has(panelId)).toBe(false);

    // No runSdkQuery finally block was entered, so clearPendingForRun must not
    // have been called at all (no pending approvals exist for a never-started run).
    expect(clearPendingForRunSpy).not.toHaveBeenCalled();
  });
});
