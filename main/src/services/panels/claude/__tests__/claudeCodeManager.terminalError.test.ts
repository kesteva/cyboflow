/**
 * TERMINAL turn-error propagation (workflow-run failure fix).
 *
 * A fatal turn — usage limit, auth failure, spawn error — is surfaced by the
 * Claude Code CLI as a terminal `result` event with `is_error: true` (or, for a
 * network/auth failure, a thrown SDK error). Neither rejects the query() iterator,
 * so before the fix spawnCliProcess RESOLVED on a hard Session Error and the
 * driving RunExecutor rested the run in `awaiting_review` — the false "Workflow
 * complete" state. This suite pins the corrected behavior:
 *
 *   (a) a FLOW-RUN spawn (runId === panelId) whose turn ends on a fatal is_error
 *       result REJECTS spawnCliProcess with SdkSessionTerminalError carrying the
 *       error text, while STILL emitting the error result as output (so the
 *       "Session Error" stays visible); the RunExecutor's catch then drives the
 *       run to `failed`;
 *   (b) `error_max_turns` is RECOVERABLE — the run rests and can be nudged — so
 *       spawnCliProcess RESOLVES (no false failure);
 *   (c) a QUICK CHAT turn (getDbSession resolves a row → runId is the chat
 *       sentinel, ≠ panelId) is NOT re-marked: spawnCliProcess RESOLVES and the
 *       Session Error stays inline exactly as before;
 *   (d) a THROWN SDK error (auth / network / spawn failure) on a flow run also
 *       REJECTS with SdkSessionTerminalError.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager, SdkSessionTerminalError } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';

const LIMIT_MESSAGE = "You've hit your limit · resets 7:10pm";

// ---------------------------------------------------------------------------
// Stateful SDK mock — shared with the hoisted vi.mock factory via vi.hoisted().
// `mode` selects what the single query() call yields.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const calls: Array<{ model?: string }> = [];
  const state = {
    mode: 'usage-limit' as 'usage-limit' | 'maxturns' | 'throws',
  };
  return { calls, state };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn(
    (params: { prompt: string; options?: { model?: string; abortController?: AbortController } }) => {
      h.calls.push({ model: params.options?.model });
      const mode = h.state.mode;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' } as unknown;
        if (mode === 'throws') {
          throw new Error('Invalid API key · please run /login');
        }
        if (mode === 'maxturns') {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
            is_error: true,
            result: 'reached the maximum number of turns',
            duration_ms: 500,
            num_turns: 8,
          } as unknown;
          return;
        }
        // 'usage-limit': a fatal execution error result (is_error, non-max-turns).
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: LIMIT_MESSAGE,
          duration_ms: 400,
          num_turns: 0,
        } as unknown;
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

import type { SessionManager } from '../../../sessionManager';

/** A session-manager mock whose getDbSession result is controlled per test. */
function createMockSessionManager(dbSession: { id: string; run_id?: string | null } | undefined): SessionManager {
  return {
    getDbSession: vi.fn(() => dbSession),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

interface OutputEvent {
  data?: { type?: unknown; is_error?: unknown; result?: unknown };
}

describe('ClaudeCodeManager — terminal turn-error propagation', () => {
  let db: Database.Database;

  beforeEach(() => {
    h.calls.length = 0;
    h.state.mode = 'usage-limit';
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Flow run + fatal is_error result → reject; still emit the error result.
  // -------------------------------------------------------------------------
  it('rejects a flow-run spawn whose turn ends on a fatal is_error result', async () => {
    const mgr = new ClaudeCodeManager(createMockSessionManager(undefined), undefined, undefined, db);
    const outputs: OutputEvent[] = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));

    const spawn = mgr.spawnCliProcess({
      panelId: 'p-run',
      sessionId: 'p-run',
      worktreePath: '/tmp/test-worktree',
      prompt: 'go',
      permissionMode: 'ignore',
    });

    await expect(spawn).rejects.toBeInstanceOf(SdkSessionTerminalError);
    await expect(spawn).rejects.toThrow(LIMIT_MESSAGE);

    // query ran exactly once (no retry), and the error result STILL reached the UI.
    expect(h.calls).toHaveLength(1);
    const emittedErrorResults = outputs.filter(
      (o) => o.data?.type === 'result' && o.data?.is_error === true,
    );
    expect(emittedErrorResults).toHaveLength(1);
    expect(emittedErrorResults[0].data?.result).toBe(LIMIT_MESSAGE);
  });

  // -------------------------------------------------------------------------
  // (b) error_max_turns is recoverable → resolve (no false failure).
  // -------------------------------------------------------------------------
  it('resolves (does not fail) a flow-run turn that only hit error_max_turns', async () => {
    h.state.mode = 'maxturns';
    const mgr = new ClaudeCodeManager(createMockSessionManager(undefined), undefined, undefined, db);

    await expect(
      mgr.spawnCliProcess({
        panelId: 'p-maxturns',
        sessionId: 'p-maxturns',
        worktreePath: '/tmp/test-worktree',
        prompt: 'go',
        permissionMode: 'ignore',
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (c) Quick CHAT turn (runId resolves to the sentinel, ≠ panelId) → resolve.
  // -------------------------------------------------------------------------
  it('does not re-mark a quick chat turn that ends on a fatal is_error result', async () => {
    // getDbSession returns a row with run_id → resolveGateRunId returns that (the
    // uninjected chat sentinel fallback), which is ≠ panelId, so the terminal-error
    // scoping (runId === displayPanelId) excludes it.
    const mgr = new ClaudeCodeManager(
      createMockSessionManager({ id: 's-quick', run_id: 'chat-sentinel-quick' }),
      undefined,
      undefined,
      db,
    );
    const outputs: OutputEvent[] = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));

    await expect(
      mgr.spawnCliProcess({
        panelId: 's-quick',
        sessionId: 's-quick',
        worktreePath: '/tmp/test-worktree',
        prompt: 'go',
        permissionMode: 'ignore',
      }),
    ).resolves.toBeUndefined();

    // The error result still flowed through as output (Session Error stays inline).
    const emittedErrorResults = outputs.filter(
      (o) => o.data?.type === 'result' && o.data?.is_error === true,
    );
    expect(emittedErrorResults).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (d) Thrown SDK error on a flow run → reject.
  // -------------------------------------------------------------------------
  it('rejects a flow-run spawn whose turn throws an SDK error', async () => {
    h.state.mode = 'throws';
    const mgr = new ClaudeCodeManager(createMockSessionManager(undefined), undefined, undefined, db);
    const errors: unknown[] = [];
    mgr.on('error', (e: unknown) => errors.push(e));

    const spawn = mgr.spawnCliProcess({
      panelId: 'p-throw',
      sessionId: 'p-throw',
      worktreePath: '/tmp/test-worktree',
      prompt: 'go',
      permissionMode: 'ignore',
    });

    await expect(spawn).rejects.toBeInstanceOf(SdkSessionTerminalError);
    await expect(spawn).rejects.toThrow('Invalid API key');
    // The 'error' event still fired for the UI toast.
    expect(errors).toHaveLength(1);
  });
});
