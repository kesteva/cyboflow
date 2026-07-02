/**
 * Mid-call graceful model fallback (Fable 5 pulled from release).
 *
 * The Claude Code CLI reports an unusable `--model` NOT as a thrown error but as
 * a terminal `result` event with `is_error: true` — so it arrives inside
 * runSdkQuery's `for await` iterator, never its catch. This suite pins the
 * behavior the reactive guard must provide on that path:
 *
 *   (a) a guarded model (Fable 5) that fails mid-call is marked unavailable AND
 *       the SAME turn is retried ONCE on the fallback family (Opus) — query() is
 *       invoked a second time with the fallback model, the Fable error result is
 *       SUPPRESSED (never emitted to the UI / no 'error' event), and the fallback
 *       attempt's output flows through normally;
 *   (b) a NON-model error result (e.g. error_max_turns) is NOT retried — query()
 *       runs once and the error result is emitted normally (no over-eager retry);
 *   (c) a guarded model already KNOWN-unavailable pre-falls-back at buildSdkOptions
 *       so query() is invoked ONCE, already on Opus (no wasted Fable attempt).
 *
 * SDK mocking uses vi.hoisted() to share a stateful call-log with the hoisted
 * vi.mock factory: each query() call records its resolved `options.model` and,
 * by call index, yields either the Fable error result or a normal success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';

const FABLE = 'claude-fable-5';
const FABLE_ERROR =
  "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it. Run --model to pick a different model.";

// ---------------------------------------------------------------------------
// Stateful SDK mock — shared with the hoisted vi.mock factory via vi.hoisted().
// The generator yielded per call is chosen by `mode`, which each test sets.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const calls: Array<{ model?: string }> = [];
  // 'fable-then-success' | 'maxturns' — set per test before spawning.
  const state = { mode: 'fable-then-success' as 'fable-then-success' | 'maxturns' };
  return { calls, state };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn(
    (params: { prompt: string; options?: { model?: string; abortController?: AbortController } }) => {
      const model = params.options?.model;
      h.calls.push({ model });
      const attempt = h.calls.length;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: `sess-${attempt}` } as unknown;
        if (h.state.mode === 'maxturns') {
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
        // 'fable-then-success': the model-unavailable error is emitted ONLY when the
        // call actually ran on the guarded Fable model (attempt 1, OR a pre-fallback
        // spawn that resolves straight to Opus never sees it). Gating on `model`
        // keeps the mock faithful: a real Opus attempt succeeds — it would never
        // yield a Fable error — so the terminal-error path does not wrongly fail it.
        if (attempt === 1 && model === FABLE) {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: FABLE_ERROR,
            duration_ms: 800,
            num_turns: 0,
          } as unknown;
          return;
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello from opus' }] },
        } as unknown;
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          duration_ms: 500,
          num_turns: 1,
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

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

interface OutputEvent {
  data?: { type?: unknown; is_error?: unknown; result?: unknown };
}

describe('ClaudeCodeManager — mid-call model fallback', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    h.calls.length = 0;
    h.state.mode = 'fable-then-success';
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Fable fails mid-call → mark unavailable + retry once on Opus, suppress
  //     the Fable error, surface the Opus output.
  // -------------------------------------------------------------------------
  it('retries a mid-call Fable-unavailable turn on Opus and suppresses the error result', async () => {
    const outputs: OutputEvent[] = [];
    const errors: unknown[] = [];
    const fallbacks: Array<Record<string, unknown>> = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));
    mgr.on('error', (e: unknown) => errors.push(e));
    mgr.on('model-fallback', (e: Record<string, unknown>) => fallbacks.push(e));

    // spawnCliProcess resolves once the iterator drains (mock generators are
    // finite — no AbortController parking), so awaiting is safe here.
    await mgr.spawnCliProcess({
      panelId: 'p-fallback',
      sessionId: 'p-fallback',
      worktreePath: '/tmp/test-worktree',
      prompt: 'Are you available?',
      permissionMode: 'ignore',
      model: 'fable',
    });

    // query() invoked twice: first on Fable, then retried on Opus.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].model).toBe(FABLE);
    expect(h.calls[1].model).toBe('claude-opus-4-8[1m]');

    // Fable was marked unavailable (greys the pickers + pre-falls-back later spawns).
    expect(ModelAvailabilityService.getInstance().isUsable(FABLE)).toBe(false);

    // The Fable error result was SUPPRESSED — no is_error result reached the UI,
    // and no 'error' event fired (the turn recovered instead of hard-failing).
    const emittedErrorResults = outputs.filter(
      (o) => o.data?.type === 'result' && o.data?.is_error === true,
    );
    expect(emittedErrorResults).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // The Opus attempt's output DID flow through (assistant + success result).
    const successResults = outputs.filter(
      (o) => o.data?.type === 'result' && o.data?.result === 'ok',
    );
    expect(successResults).toHaveLength(1);

    // A single 'model-fallback' event fired for the renderer (toast + pill swap),
    // carrying the panel/session identity and the guarded → fallback aliases.
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      panelId: 'p-fallback',
      sessionId: 'p-fallback',
      unavailableAlias: 'fable',
      unavailableLabel: 'Fable 5',
      fallbackAlias: 'opus',
    });
  });

  // -------------------------------------------------------------------------
  // (b) A non-model error result is NOT retried and IS surfaced.
  // -------------------------------------------------------------------------
  it('does not retry a non-model error result (error_max_turns) and emits it', async () => {
    h.state.mode = 'maxturns';
    const outputs: OutputEvent[] = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));

    await mgr.spawnCliProcess({
      panelId: 'p-maxturns',
      sessionId: 'p-maxturns',
      worktreePath: '/tmp/test-worktree',
      prompt: 'loop',
      permissionMode: 'ignore',
      model: 'fable',
    });

    // Single attempt — no retry for a non-model failure.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model).toBe(FABLE);
    // Fable is NOT marked unavailable (the failure wasn't a model problem).
    expect(ModelAvailabilityService.getInstance().isUsable(FABLE)).toBe(true);
    // The error result IS emitted normally (not suppressed).
    const emittedErrorResults = outputs.filter(
      (o) => o.data?.type === 'result' && o.data?.is_error === true,
    );
    expect(emittedErrorResults).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (c) A guarded model already known-unavailable pre-falls-back at spawn — one
  //     query() call, already on Opus, no wasted Fable attempt.
  // -------------------------------------------------------------------------
  it('pre-falls-back a known-unavailable Fable at buildSdkOptions (single Opus call)', async () => {
    ModelAvailabilityService.getInstance().markUnavailable(FABLE, 'pulled');

    await mgr.spawnCliProcess({
      panelId: 'p-known',
      sessionId: 'p-known',
      worktreePath: '/tmp/test-worktree',
      prompt: 'hi',
      permissionMode: 'ignore',
      model: 'fable',
    });

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model).toBe('claude-opus-4-8[1m]');
  });
});
