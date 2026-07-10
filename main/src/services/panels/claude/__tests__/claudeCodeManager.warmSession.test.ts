/**
 * Warm (persistent) SDK session lifecycle.
 *
 * The SDK substrate keeps its claude subprocess alive across turns: a
 * resume-continuation of the SAME conversation whose spawn-baked options are
 * unchanged is PUSHED into the live query() instead of respawning it (skipping the
 * ~5s per-turn bootstrap). This suite pins that lifecycle end to end:
 *
 *   (1) two resume-continuation turns run on ONE query() — the 2nd message is
 *       pushed into the live prompt iterable, the run stays registered warm-idle
 *       between turns;
 *   (2) an ineligible spawn (fingerprint drift / no resume signal) closes the warm
 *       session and cold-respawns — with --resume when the caller asked for it,
 *       without it when the caller wants a fresh conversation;
 *   (3) a TERMINAL turn error never parks the process warm — the next re-drive
 *       cold-spawns with --resume;
 *   (4) killProcess on a warm-IDLE process aborts it and clears every map, with no
 *       spurious extra 'exit';
 *   (5) a turn in flight rejects a second spawn with the today dup-guard message;
 *   (6) the CYBOFLOW_DISABLE_WARM_SDK kill switch forces the single-shot cold path;
 *   (7) the idle TTL closes an abandoned warm session; the next turn cold-spawns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  scenario,
  ScenarioBuilder,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';

const SESSION_UUID = 'sess-warm-uuid';

// ---------------------------------------------------------------------------
// Shared module fake — one query() mock the manager drives; tests swap the
// scenario per case and read `builder.pushed` for the pushed continuations.
// ---------------------------------------------------------------------------

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

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

/** getPanelClaudeSessionId returns the captured id so a resume continuation matches. */
function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => SESSION_UUID),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, { turnInFlight: boolean; warm: unknown }> {
  return (mgr as unknown as { sdkRuns: Map<string, { turnInFlight: boolean; warm: unknown }> }).sdkRuns;
}
function getProcesses(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { processes: Map<string, unknown> }).processes;
}
function getPipelines(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { pipelines: Map<string, unknown> }).pipelines;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Resume `resume` field of the nth query() call's options (undefined when absent). */
function callResume(n: number): unknown {
  return (fakeSdk.calls[n] as { resume?: unknown } | undefined)?.resume;
}
function callModel(n: number): unknown {
  return (fakeSdk.calls[n] as { model?: unknown } | undefined)?.model;
}

describe('ClaudeCodeManager — warm (persistent) SDK session', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    fakeSdk.reset();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(async () => {
    // Tear down any warm-idle process so its background loop cannot outlive the db.
    for (const key of Array.from(getSdkRuns(mgr).keys())) {
      await mgr.killProcess(key).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /** A scenario whose result is not the last step stays warm-idle after each turn. */
  function twoTurnScenario(): ScenarioBuilder {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .assistantText('turn one')
      .resultSuccess()
      .assistantText('turn two')
      .resultSuccess();
  }

  // -------------------------------------------------------------------------
  // (1) Two resume-continuation turns run on ONE query().
  // -------------------------------------------------------------------------
  it('pushes the 2nd turn into the live query() instead of respawning', async () => {
    const panelId = 'p-warm-1';
    const builder = twoTurnScenario();
    fakeSdk.setScenario(builder);

    // Turn 1 — cold spawn.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);
    // Warm-idle between turns: the run stays registered, no turn in flight.
    expect(getSdkRuns(mgr).has(panelId)).toBe(true);
    expect(getSdkRuns(mgr).get(panelId)?.turnInFlight).toBe(false);

    // Turn 2 — resume continuation → warm push (NO new query()).
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(1);
    expect(builder.pushed).toEqual(['second']);
    expect(builder.initialPrompt).toBe('first');
  });

  // -------------------------------------------------------------------------
  // (1b) A workflow nudge whose resumeSessionId matches the warm session pushes.
  // -------------------------------------------------------------------------
  it('pushes a workflow nudge whose resumeSessionId matches the warm session', async () => {
    const panelId = 'p-warm-1b';
    const builder = twoTurnScenario();
    fakeSdk.setScenario(builder);

    // Turn 1 — cold spawn (a flow run: panelId === runId, no resume signal yet).
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);

    // Nudge — RunExecutor threads resumeSessionId = run.claude_session_id, which
    // equals the captured warm session id → warm push, NO respawn.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'nudge',
      permissionMode: 'ignore',
      resumeSessionId: SESSION_UUID,
    });
    expect(fakeSdk.calls).toHaveLength(1);
    expect(builder.pushed).toEqual(['nudge']);
  });

  // -------------------------------------------------------------------------
  // (2a) Fingerprint drift → close warm + cold-spawn WITH --resume.
  // -------------------------------------------------------------------------
  it('respawns with --resume when a warm turn changes the model (fingerprint drift)', async () => {
    const panelId = 'p-warm-2a';
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);

    // Turn 2 resume-continues but pins a DIFFERENT model → fingerprint mismatch.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
      model: 'opus',
    });
    // A second query() ran, carrying --resume from the captured session id.
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBe(SESSION_UUID);
    expect(callModel(1)).toBe('claude-opus-4-8[1m]');
  });

  // -------------------------------------------------------------------------
  // (2b) No resume signal → close warm + cold-spawn WITHOUT --resume.
  // -------------------------------------------------------------------------
  it('closes the warm session and cold-spawns a fresh conversation with no resume signal', async () => {
    const panelId = 'p-warm-2b';
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);

    // Turn 2 with NO isResume/resumeSessionId → a fresh conversation is wanted.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (3) A terminal turn error never parks warm; the next re-drive is cold+resume.
  // -------------------------------------------------------------------------
  it('never parks a process warm after a terminal error; the next spawn cold-resumes', async () => {
    const panelId = 'p-warm-3';
    // A quick chat turn: getDbSession returns a row so runId ≠ panelId and a fatal
    // is_error result does NOT reject spawnCliProcess (Session Error stays inline).
    (mgr as unknown as { sessionManager: SessionManager }).sessionManager = {
      getDbSession: vi.fn(() => ({ id: panelId, run_id: 'chat-sentinel' })),
      getPanelClaudeSessionId: vi.fn(() => SESSION_UUID),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;

    fakeSdk.setScenario(
      scenario().systemInit({ sessionId: SESSION_UUID }).resultError({ subtype: 'error_during_execution' }),
    );
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // The errored process is GONE — never parked warm.
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    expect(getProcesses(mgr).has(panelId)).toBe(false);

    // Next re-drive cold-spawns with --resume from the stored session id.
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SESSION_UUID }).resultSuccess());
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBe(SESSION_UUID);
  });

  // -------------------------------------------------------------------------
  // (4) killProcess on a warm-IDLE process aborts it, clears maps, no extra exit.
  // -------------------------------------------------------------------------
  it('killProcess on a warm-idle process clears every map and emits no spurious extra exit', async () => {
    const panelId = 'p-warm-4';
    const exits: unknown[] = [];
    mgr.on('exit', (e: unknown) => exits.push(e));
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // One per-turn 'exit' fired for turn 1; the process is warm-idle.
    expect(exits).toHaveLength(1);
    expect(getSdkRuns(mgr).has(panelId)).toBe(true);

    await mgr.killProcess(panelId);
    // Aborting a warm-idle process (no turn in flight) emits NO extra 'exit'.
    expect(exits).toHaveLength(1);
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    expect(getProcesses(mgr).has(panelId)).toBe(false);
    expect(getPipelines(mgr).has(panelId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (5) The dup-guard: a registered process under the spawnKey with a FREE lock
  //     (the re-entrant / stale-registration path) still rejects a fresh spawn.
  //     While a turn is genuinely in flight the spawn LOCK serializes it (never
  //     reaching the guard), so the reachable guard is this lock-free case.
  // -------------------------------------------------------------------------
  it('rejects a spawn whose spawnKey already has a live process (dup-guard)', async () => {
    const panelId = 'p-warm-5';
    // Pre-seed a live process under the panelId (no lock held, no sdkRuns entry) —
    // the cold-path guard must reject a fresh spawn under that key.
    getProcesses(mgr).set(panelId, {
      process: undefined,
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
    });

    await expect(
      mgr.spawnCliProcess({
        panelId,
        sessionId: panelId,
        worktreePath: '/tmp/wt',
        prompt: 'second',
        permissionMode: 'ignore',
      }),
    ).rejects.toThrow(`Claude process already running for spawn ${panelId}`);
  });

  // -------------------------------------------------------------------------
  // (6) Kill switch forces the single-shot cold path (never parks warm).
  // -------------------------------------------------------------------------
  it('CYBOFLOW_DISABLE_WARM_SDK forces the cold single-shot path (no warm park)', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    const panelId = 'p-warm-6';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SESSION_UUID }).resultSuccess());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // The single-shot input closed at the result → process torn down (no warm-idle).
    expect(getSdkRuns(mgr).has(panelId)).toBe(false);

    // A second turn cold-spawns a fresh query() (no warm session to push into).
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SESSION_UUID }).resultSuccess());
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // (7) Idle TTL closes an abandoned warm session.
  // -------------------------------------------------------------------------
  it('closes a warm session after the idle TTL and cold-spawns the next turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const panelId = 'p-warm-7';
      fakeSdk.setScenario(twoTurnScenario());

      await mgr.spawnCliProcess({
        panelId,
        sessionId: panelId,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      });
      expect(getSdkRuns(mgr).has(panelId)).toBe(true);

      // Advance past the 15-min idle TTL → the warm session closes gracefully.
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
      await flush();
      expect(getSdkRuns(mgr).has(panelId)).toBe(false);
      expect(getProcesses(mgr).has(panelId)).toBe(false);

      // The next turn has no warm session → cold-spawns a fresh query().
      fakeSdk.setScenario(scenario().systemInit({ sessionId: SESSION_UUID }).resultSuccess());
      await mgr.spawnCliProcess({
        panelId,
        sessionId: panelId,
        worktreePath: '/tmp/wt',
        prompt: 'second',
        permissionMode: 'ignore',
        isResume: true,
      });
      expect(fakeSdk.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // (8) Close-then-spawn RACE: a follow-up that arrives while the warm input is
  //     closing but the maps are not yet torn down must NOT be silently dropped —
  //     the push is rejected and the manager cold-respawns with --resume, carrying
  //     the message to the fresh query().
  // -------------------------------------------------------------------------
  it('does not drop a follow-up that races a warm-session teardown; it cold-respawns', async () => {
    const panelId = 'p-race-8';
    const builder = twoTurnScenario();
    fakeSdk.setScenario(builder);

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);
    expect(getSdkRuns(mgr).has(panelId)).toBe(true);

    // Simulate a teardown-in-progress: close the persistent input directly WITHOUT
    // awaiting the loop's map deletion (the record is still in sdkRuns, warm-idle).
    // This reproduces the window an abort / TTL / terminal-error close opens.
    const warmInput = getSdkRuns(mgr).get(panelId)?.warm as { input: { close(): void } };
    warmInput.input.close();

    // Immediately issue a resume follow-up in the race window. The push into the
    // closing input is rejected → the manager closes the dying session and
    // cold-respawns with --resume, delivering 'raced' to the fresh query().
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'raced',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBe(SESSION_UUID);
    // The raced message reached the SECOND query as its initial prompt (not dropped).
    expect(builder.initialPrompt).toBe('raced');
  });

  // -------------------------------------------------------------------------
  // (9) Phantom-turn guard: the race above settles NO phantom turn — exactly the
  //     two real per-turn 'exit's fire (turn 1 of each query), never a third from
  //     a phantom turn committed on the dying record.
  // -------------------------------------------------------------------------
  it('emits no phantom exit when a follow-up races a warm-session teardown', async () => {
    const panelId = 'p-race-9';
    const exits: unknown[] = [];
    mgr.on('exit', (e: unknown) => exits.push(e));
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(exits).toHaveLength(1); // turn 1 of query 1

    const warmInput = getSdkRuns(mgr).get(panelId)?.warm as { input: { close(): void } };
    warmInput.input.close();

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'raced',
      permissionMode: 'ignore',
      isResume: true,
    });
    await flush();
    // Exactly two real per-turn exits (query1-turn1, query2-turn1) — no phantom.
    expect(exits).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // (10) The `closing` flag rejects reuse: a spawn whose warm record is already
  //      marked closing cold-respawns with --resume rather than pushing.
  // -------------------------------------------------------------------------
  it('rejects warm reuse of a record marked closing and cold-respawns with resume', async () => {
    const panelId = 'p-race-10';
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // Mark the warm-idle record closing (as abort / TTL / terminal close would),
    // WITHOUT closing the input yet — evaluateWarmReuse must reject on `closing`.
    const rec = getSdkRuns(mgr).get(panelId) as unknown as { closing: boolean };
    rec.closing = true;

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'follow',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBe(SESSION_UUID);
  });
});
