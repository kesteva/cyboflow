/**
 * ClaudeCodeManager — mid-turn panel input queue ("always allow messaging a
 * running quick session").
 *
 * Acceptance:
 *   1. enqueue / list / dequeue are pure buffer ops (FIFO, id-targeted removal).
 *   2. A mid-turn enqueue does NOT abort the live run (no killProcess / abort) —
 *      the queue never destructively interrupts the in-flight turn.
 *   3. At the turn's REST boundary (natural, non-abort end) the queued messages
 *      are delivered ONCE as a single blank-line-joined continuation via the
 *      injected deliverer, and the buffer is cleared.
 *
 * The mock SDK query has two modes (module-level flag): a park-until-abort run
 * (for the "no abort" assertion) and a natural-end run that yields a `result`
 * event and returns (for the drain assertion).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';

// Mock mode: 'park' waits for abort; 'natural' yields a result then returns.
const mockState = { mode: 'park' as 'park' | 'natural' };

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn((params: { prompt: unknown; options?: { abortController?: AbortController } }) => {
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' } as unknown;
      if (mockState.mode === 'natural') {
        yield { type: 'result', subtype: 'success' } as unknown;
        return;
      }
      const abortController = params.options?.abortController;
      if (abortController) {
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) return resolve();
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
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

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function getProcesses(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { processes: Map<string, unknown> }).processes;
}

async function waitForProcess(mgr: ClaudeCodeManager, panelId: string, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (getProcesses(mgr).has(panelId)) return;
    await Promise.resolve();
  }
  throw new Error(`waitForProcess: process not populated for ${panelId}`);
}

const flushImmediate = () => new Promise<void>((r) => setImmediate(r));

describe('ClaudeCodeManager — panel input queue', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    mockState.mode = 'park';
    db = createTestDb();
    ApprovalRouter.initialize(dbAdapter(db));
    QuestionRouter.initialize(dbAdapter(db));
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('enqueue / list / dequeue are FIFO and id-targeted', () => {
    mgr.enqueuePanelInput('p1', 'a', 'first');
    mgr.enqueuePanelInput('p1', 'b', 'second');
    mgr.enqueuePanelInput('p1', 'c', '   '); // blank-after-trim → ignored
    expect(mgr.listPanelInputQueue('p1')).toEqual([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);

    expect(mgr.dequeuePanelInput('p1', 'a')).toBe(true);
    expect(mgr.listPanelInputQueue('p1')).toEqual([{ id: 'b', text: 'second' }]);
    expect(mgr.dequeuePanelInput('p1', 'missing')).toBe(false);
    expect(mgr.dequeuePanelInput('p1', 'b')).toBe(true);
    expect(mgr.listPanelInputQueue('p1')).toEqual([]);
  });

  it('a mid-turn enqueue does NOT abort the live run', async () => {
    const panelId = 'panel-q-1';
    const killSpy = vi.spyOn(mgr, 'killProcess');
    const spawnPromise = mgr.spawnCliProcess({
      panelId,
      sessionId: 'session-q-1',
      worktreePath: '/tmp/wt',
      prompt: 'do work',
      permissionMode: 'ignore',
    });
    await waitForProcess(mgr, panelId);

    // Queue a message mid-turn — the run must stay alive and untouched.
    mgr.enqueuePanelInput(panelId, 'mid', 'while you work');
    expect(getProcesses(mgr).has(panelId)).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mgr.listPanelInputQueue(panelId)).toEqual([{ id: 'mid', text: 'while you work' }]);

    // Clean up: abort the parked run.
    await mgr.killProcess(panelId);
    await spawnPromise;
  });

  it('delivers queued messages ONCE as a joined continuation at the turn rest boundary', async () => {
    mockState.mode = 'natural';
    const panelId = 'panel-q-2';
    const deliver = vi.fn();
    mgr.setPanelInputDeliverer(deliver);

    mgr.enqueuePanelInput(panelId, 'e1', 'first message');
    mgr.enqueuePanelInput(panelId, 'e2', 'second message');

    // Natural-end run drains on its own.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: 'session-q-2',
      worktreePath: '/tmp/wt',
      prompt: 'go',
      permissionMode: 'ignore',
    });
    // The drain is deferred via setImmediate so the turn's locks release first.
    await flushImmediate();

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(panelId, 'first message\n\nsecond message');
    // Buffer cleared BEFORE dispatch.
    expect(mgr.listPanelInputQueue(panelId)).toEqual([]);
  });

  it('does not deliver (or clear) when the queue is empty at rest', async () => {
    mockState.mode = 'natural';
    const deliver = vi.fn();
    mgr.setPanelInputDeliverer(deliver);
    await mgr.spawnCliProcess({
      panelId: 'panel-q-3',
      sessionId: 'session-q-3',
      worktreePath: '/tmp/wt',
      prompt: 'go',
      permissionMode: 'ignore',
    });
    await flushImmediate();
    expect(deliver).not.toHaveBeenCalled();
  });
});
