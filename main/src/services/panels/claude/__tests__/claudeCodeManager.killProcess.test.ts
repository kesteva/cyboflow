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
 *
 * IMPORTANT — why spawnPromise must NOT be awaited before killProcess (TASK-697):
 * spawnCliProcess wraps its body in withLock and then does `await iteratorDone`
 * at the end (claudeCodeManager.ts:313). The mock query parks the async iterator
 * until AbortController fires. Awaiting spawnPromise before killProcess therefore
 * deadlocks: the lock is held waiting for iterator drain, but the only thing that
 * unblocks the iterator is the abort signal, which is only fired by killProcess.
 * Fix: fire-and-forget spawnCliProcess, drain maps via microtask polling, then
 * killProcess (which aborts the run and fires the iterator's finally block), then
 * await spawnPromise to collect any spawn-time exceptions.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';
import PQueue from 'p-queue';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
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
// Microtask polling helper
// ---------------------------------------------------------------------------

/**
 * Poll until all three maps (pipelines, sdkRuns, processes) contain panelId,
 * draining the microtask queue on each tick. Throws if maps are not populated
 * within maxTicks microtask yields. This is safe because spawnCliProcess has no
 * setTimeout in its map-population path — only microtask-yielding async steps
 * (withLock uses Promises internally).
 */
async function waitForMaps(mgr: ClaudeCodeManager, panelId: string, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (
      getPipelines(mgr).has(panelId) &&
      getSdkRuns(mgr).has(panelId) &&
      getProcesses(mgr).has(panelId)
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `waitForMaps: maps did not populate for panelId=${panelId} after ${maxTicks} microtask ticks`
  );
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
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
    // Spy on clearPendingForRun to assert it is called from runSdkQuery's
    // finally block (single-sourced), not directly from killProcess.
    clearPendingForRunSpy = vi.spyOn(
      ApprovalRouter.getInstance(),
      'clearPendingForRun',
    );
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: killProcess mid-stream leaves all maps empty
  // -------------------------------------------------------------------------
  it('killProcess mid-stream clears pipelines, sdkRuns, and processes maps', async () => {
    const panelId = 'panel-kill-1';
    const sessionId = 'session-kill-1';

    // The mock query parks on the AbortController signal until aborted,
    // simulating a mid-stream run. Fire-and-forget: do NOT await spawnPromise
    // here — awaiting before killProcess deadlocks (see file-top comment).
    const spawnPromise = mgr.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath: '/tmp/test-worktree',
      prompt: 'do something',
      permissionMode: 'ignore', // skip PreToolUse hook wiring
    });

    // Drain microtasks until maps are populated, then verify.
    await waitForMaps(mgr, panelId);

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

    // Now that killProcess has aborted the run (unlocking spawnPromise),
    // await to surface any spawn-time exceptions.
    await spawnPromise;
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
