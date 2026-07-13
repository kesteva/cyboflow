/**
 * Unit tests for ClaudeCodeManager's LIVE-STEER seam (monitor operator guidance
 * pushed into a running step agent's in-flight SDK turn):
 *   - listLiveSpawnKeys(runId) reports a run's spawnKeys whose turn is in flight
 *     and not tearing down (turnInFlight && !closing);
 *   - injectSteering(spawnKey, text) pushes into the turn's live input and returns
 *     true, stamping steeredThisTurn (the zombie-turn teardown defense's gate);
 *   - the refusal matrix: unknown spawnKey, turnInFlight === false, and
 *     closing === true each refuse (return false) and drop out of the live list;
 *   - a torn-down (killRun'd) spawn is no longer steerable.
 *
 * SDK mocking mirrors claudeCodeManager.parallelSpawn.test.ts: the mock query()
 * yields one system/init event then PARKS on the AbortController until aborted, so
 * a spawn stays "mid-stream" (turnInFlight === true, liveInput set) with its maps
 * populated until the test kills it. spawnCliProcess is fire-and-forget (awaiting it
 * before the kill deadlocks — the lock is held pending iterator drain, which only
 * the abort signal unblocks).
 *
 * Each query additionally registers a TurnControl (exposed via the mock module's
 * `__turnControls`) whose emitResult() makes the generator yield ONE result event
 * before re-parking on the abort signal — mirroring the real CLI, which stays
 * alive after a turn until stdin close/abort tears it down. That is what lets the
 * result-boundary zombie-turn guard be asserted here: a STEERED turn's result must
 * fire abortController.abort() (so the CLI can never dequeue an unconsumed
 * steering message as a phantom follow-on turn), while an UN-steered turn's result
 * must NOT abort (byte-identical pre-steer teardown).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';

// ---------------------------------------------------------------------------
// SDK mock — yield init, then park on the AbortController until aborted.
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  interface TurnControl {
    abortController: AbortController | undefined;
    emitResult: () => void;
  }
  const controls: TurnControl[] = [];
  const queryFn = vi.fn((params: { prompt: string; options?: { abortController?: AbortController } }) => {
    let releaseResult: (() => void) | null = null;
    const resultRequested = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    controls.push({
      abortController: params.options?.abortController,
      emitResult: () => releaseResult?.(),
    });
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown;
      const abortController = params.options?.abortController;
      const aborted = new Promise<void>((resolve) => {
        if (!abortController) return; // no controller ⇒ park forever (matches the old mock)
        if (abortController.signal.aborted) {
          resolve();
          return;
        }
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // Consume the streaming prompt input like the real CLI reads stdin: the
      // drain completes when the manager close()s the input, which is what lets a
      // post-result generator END on input close (production: CLI exits on stdin
      // close) rather than only on abort.
      const inputDrained = (async () => {
        const prompt = params.prompt as unknown;
        if (typeof prompt === 'string' || prompt === null || prompt === undefined) return;
        for await (const _msg of prompt as AsyncIterable<unknown>) {
          void _msg; // messages are irrelevant here — only stream end matters
        }
      })();
      const outcome = await Promise.race([
        aborted.then(() => 'abort' as const),
        resultRequested.then(() => 'result' as const),
      ]);
      if (outcome === 'result') {
        yield { type: 'result', subtype: 'success', is_error: false } as unknown;
        // Post-result the real CLI stays alive until stdin close or a kill tears
        // it down — end on whichever fires first (the zombie-turn guard's abort,
        // or the result branch's promptInput.close() draining the input).
        await Promise.race([aborted, inputDrained]);
      }
    })();
  });
  return { query: queryFn, __turnControls: controls };
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
import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

/** The per-query control record the SDK mock registers (see the mock factory). */
interface TurnControl {
  abortController: AbortController | undefined;
  emitResult: () => void;
}
const turnControls = (sdkModule as unknown as { __turnControls: TurnControl[] }).__turnControls;

/** No DB session ⇒ runId falls back to panelId (workflow-run identity). */
function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Private-map reach-in (index-signature, no `any`) — mirrors parallelSpawn test.
// ---------------------------------------------------------------------------

/** The subset of a ClaudeSdkRun record this test probes / mutates. */
interface SdkRunProbe {
  turnInFlight: boolean;
  closing: boolean;
  steeredThisTurn: boolean;
  liveInput: unknown;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, SdkRunProbe> {
  return (mgr as unknown as { sdkRuns: Map<string, SdkRunProbe> }).sdkRuns;
}
function getProcesses(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { processes: Map<string, unknown> }).processes;
}
function getPipelines(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { pipelines: Map<string, unknown> }).pipelines;
}

async function waitForSpawn(mgr: ClaudeCodeManager, spawnKey: string, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (getPipelines(mgr).has(spawnKey) && getSdkRuns(mgr).has(spawnKey) && getProcesses(mgr).has(spawnKey)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`waitForSpawn: maps did not populate for spawnKey=${spawnKey} after ${maxTicks} ticks`);
}

/** Fire-and-forget a lane spawn (spawnKey ≠ runId ⇒ single-shot, warm === null). */
function spawnLane(mgr: ClaudeCodeManager, runId: string, spawnKey: string): Promise<void> {
  return mgr.spawnCliProcess({
    panelId: runId,
    sessionId: runId,
    runId,
    worktreePath: '/tmp/wt',
    prompt: 'lane work',
    permissionMode: 'ignore',
    spawnKey,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager — live-steer seam (listLiveSpawnKeys / injectSteering)', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    turnControls.length = 0;
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('lists a live in-flight lane and injects steering into it (returns true, stamps steeredThisTurn)', async () => {
    const runId = 'run-steer';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);

    // The lane's turn is in flight → it is steerable.
    expect(mgr.listLiveSpawnKeys(runId)).toEqual([key]);

    // The steer is accepted; the flag that arms the zombie-turn teardown defense is set.
    expect(mgr.injectSteering(key, 'focus on the failing test')).toBe(true);
    expect(getSdkRuns(mgr).get(key)?.steeredThisTurn).toBe(true);

    await mgr.killRun(runId);
    await spawn;
  });

  it('lists ALL live lanes of a fan-out run and can steer a single one', async () => {
    const runId = 'run-fan';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;
    const spawnA = spawnLane(mgr, runId, keyA);
    const spawnB = spawnLane(mgr, runId, keyB);
    await waitForSpawn(mgr, keyA);
    await waitForSpawn(mgr, keyB);

    // Both lanes are live (order follows spawnKeysByRunId insertion).
    expect(new Set(mgr.listLiveSpawnKeys(runId))).toEqual(new Set([keyA, keyB]));

    // Steering one lane leaves the other's flag untouched.
    expect(mgr.injectSteering(keyB, 'lane B guidance')).toBe(true);
    expect(getSdkRuns(mgr).get(keyB)?.steeredThisTurn).toBe(true);
    expect(getSdkRuns(mgr).get(keyA)?.steeredThisTurn).toBe(false);

    await mgr.killRun(runId);
    await Promise.all([spawnA, spawnB]);
  });

  it('refuses an unknown spawnKey / runId ([] and false, no throw)', () => {
    expect(mgr.listLiveSpawnKeys('no-such-run')).toEqual([]);
    expect(mgr.injectSteering('no-such-run:t1', 'nobody home')).toBe(false);
  });

  it('refuses when the turn is NOT in flight (record present, turnInFlight false)', async () => {
    const runId = 'run-idle';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);

    // Simulate a warm-parked / between-turns record: still registered, no live turn.
    const run = getSdkRuns(mgr).get(key);
    expect(run).toBeDefined();
    run!.turnInFlight = false;

    expect(mgr.listLiveSpawnKeys(runId)).toEqual([]);
    expect(mgr.injectSteering(key, 'no live turn')).toBe(false);

    run!.turnInFlight = true; // restore so killRun's teardown settles the turn cleanly
    await mgr.killRun(runId);
    await spawn;
  });

  it('refuses when the record is CLOSING (teardown initiated)', async () => {
    const runId = 'run-closing';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);

    // Teardown has begun (closing set before the maps are cleared) — a steer must
    // never push into a dying input, and the lane drops out of the live list.
    const run = getSdkRuns(mgr).get(key);
    run!.closing = true;

    expect(mgr.listLiveSpawnKeys(runId)).toEqual([]);
    expect(mgr.injectSteering(key, 'too late')).toBe(false);

    await mgr.killRun(runId);
    await spawn;
  });

  it('a torn-down (killRun) spawn is no longer steerable', async () => {
    const runId = 'run-dead';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);

    await mgr.killRun(runId);
    await spawn;

    // The record is gone → both surfaces report "not steerable".
    expect(mgr.listLiveSpawnKeys(runId)).toEqual([]);
    expect(mgr.injectSteering(key, 'ghost')).toBe(false);
  });

  it('zombie-turn guard: a STEERED turn aborts its query at the result boundary', async () => {
    const runId = 'run-guard-steered';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);
    const control = turnControls[turnControls.length - 1];
    expect(control.abortController).toBeDefined();

    // Steer mid-turn, then let the turn end — the guard must close the input AND
    // abort the query, so the CLI can never dequeue an unconsumed steering
    // message as a phantom follow-on turn.
    expect(mgr.injectSteering(key, 'guidance racing the turn end')).toBe(true);
    control.emitResult();

    // The spawn promise settles at finishTurn (the per-turn 'exit'), and the guard
    // fires abort right after the input close in the same result branch.
    await spawn;
    await vi.waitFor(() => expect(control.abortController!.signal.aborted).toBe(true));
    // The abort drains the parked generator → the drive loop's teardown removes
    // the record without any explicit kill.
    await vi.waitFor(() => expect(getSdkRuns(mgr).has(key)).toBe(false));
  });

  it('zombie-turn guard: an UN-steered turn does NOT abort at its result (byte-identical teardown)', async () => {
    const runId = 'run-guard-plain';
    const key = `${runId}:t1`;
    const spawn = spawnLane(mgr, runId, key);
    await waitForSpawn(mgr, key);
    const control = turnControls[turnControls.length - 1];

    control.emitResult();
    await spawn;

    // Drain a generous number of microtasks — the abort must stay un-fired (the
    // single-shot input still closes; in production the CLI exits on stdin close).
    for (let i = 0; i < 25; i++) await Promise.resolve();
    expect(control.abortController!.signal.aborted).toBe(false);

    // Cleanup: the mock generator parks on the abort signal post-result, so kill
    // the run to end the stream.
    await mgr.killRun(runId);
  });
});
