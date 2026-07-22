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
import { createTestDb, seedRun } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
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
/** The WorkflowBundleWriter the manager installs the co-located bundle through. */
function getBundleWriter(mgr: ClaudeCodeManager): { write(worktree: string, bundle: unknown): unknown } {
  return (mgr as unknown as { bundleWriter: { write(worktree: string, bundle: unknown): unknown } }).bundleWriter;
}
/** Read a warm-idle run's teardown flag (F21 eviction marks it before draining). */
function runClosing(mgr: ClaudeCodeManager, key: string): boolean | undefined {
  return (getSdkRuns(mgr).get(key) as unknown as { closing?: boolean } | undefined)?.closing;
}
/** Force a warm-idle run to look mid-turn (F21: a mid-turn run is never evicted). */
function setTurnInFlight(mgr: ClaudeCodeManager, key: string, value: boolean): void {
  const run = getSdkRuns(mgr).get(key) as unknown as { turnInFlight: boolean } | undefined;
  if (run) run.turnInFlight = value;
}
/** Force a warm-idle run's teardown flag (a `closing` run must not accept a drain). */
function setClosing(mgr: ClaudeCodeManager, key: string, value: boolean): void {
  const run = getSdkRuns(mgr).get(key) as unknown as { closing: boolean } | undefined;
  if (run) run.closing = value;
}

const flush = () => new Promise<void>((r) => setImmediate(r));
/** Flush several macrotasks so a fire-and-forget warm-session drain fully settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

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
    delete process.env.CYBOFLOW_WARM_MAX_IDLE;
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
    delete process.env.CYBOFLOW_WARM_MAX_IDLE;
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
  // (2a') Effective-agent drift → close warm + cold-spawn WITH --resume.
  //       A mid-run Agents-pane edit (a new agent_overrides row) changes the
  //       run's effective agent set, which the overlay .md files are written
  //       from. The digest of that set is folded into the options fingerprint,
  //       so the warm parent (which read its agent defs at process start) is
  //       closed and cold-respawned to re-install the edited overlay.
  // -------------------------------------------------------------------------
  it('respawns with --resume when the run\'s effective agents change mid-run (agent edit)', async () => {
    const panelId = 'p-warm-agents';
    // A real run row so resolveRunEffectiveAgents resolves a project (else the
    // digest is a stable []), plus the agent_overrides table it reads.
    seedRun(db, { id: panelId });
    db.exec(`CREATE TABLE IF NOT EXISTS agent_overrides (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, agent_key TEXT NOT NULL,
      base_agent_key TEXT, name TEXT NOT NULL, role TEXT, description TEXT NOT NULL,
      system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL,
      enabled_mcps_json TEXT NOT NULL DEFAULT '[]', is_custom INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, model TEXT, runtime TEXT, codex_model TEXT,
      created_at TEXT, updated_at TEXT
    )`);
    fakeSdk.setScenario(twoTurnScenario());

    // Turn 1 — cold spawn; the effective set is the built-ins only.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(fakeSdk.calls).toHaveLength(1);

    // Agents-pane edit: mint a custom agent for this run's project → the effective
    // agent set (and thus the fingerprint digest) changes.
    db.prepare(
      `INSERT INTO agent_overrides
         (id, project_id, agent_key, base_agent_key, name, role, description,
          system_prompt, tools_json, enabled_mcps_json, is_custom, version,
          model, runtime, codex_model, created_at, updated_at)
       VALUES ('ago_helper', 1, 'my-helper', NULL, 'cyboflow-my-helper', 'custom',
          'A helper', 'You help.', '["Read"]', '[]', 1, 1, NULL, NULL, NULL,
          '2026-07-17', '2026-07-17')`,
    ).run();

    // Turn 2 resume-continues, but the changed agent set drifts the fingerprint.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    // A second query() ran (cold respawn), carrying --resume from the captured id.
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callResume(1)).toBe(SESSION_UUID);
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

  // -------------------------------------------------------------------------
  // (F5a) An unchanged warm turn does NOT re-install the co-located bundle — the
  //       SDK reads .claude/agents|commands only at process start, so re-writing
  //       per push (git rev-parse + dir scans + N+M file writes) is pure waste.
  //       The cold turn installed it once; the warm push installs nothing.
  // -------------------------------------------------------------------------
  it('(F5) skips the bundle install on an unchanged warm turn; the cold turn installed it once', async () => {
    const panelId = 'p-warm-f5a';
    const builder = twoTurnScenario();
    fakeSdk.setScenario(builder);
    const writeSpy = vi.spyOn(getBundleWriter(mgr), 'write');

    // Turn 1 — cold spawn installs the bundle once.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Turn 2 — resume continuation → warm push. NO respawn, NO re-install.
    writeSpy.mockClear();
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(1); // warm push, no cold respawn
    expect(builder.pushed).toEqual(['second']);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (F5b) Config drift that fails warm reuse (a changed model → fingerprint
  //       mismatch) cold-respawns — and the cold path re-installs the bundle, so
  //       the install seam is exercised exactly when a fresh process needs it.
  // -------------------------------------------------------------------------
  it('(F5) a fingerprint-drift cold respawn DOES re-install the bundle', async () => {
    const panelId = 'p-warm-f5b';
    fakeSdk.setScenario(twoTurnScenario());
    const writeSpy = vi.spyOn(getBundleWriter(mgr), 'write');

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Turn 2 pins a different model → fingerprint mismatch → close warm + cold spawn.
    writeSpy.mockClear();
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
      model: 'opus',
    });
    expect(fakeSdk.calls).toHaveLength(2); // cold respawn
    expect(writeSpy).toHaveBeenCalledTimes(1); // re-installed on the cold path
  });

  // -------------------------------------------------------------------------
  // (F21) Parking past the app-wide idle-warm cap evicts the least-recently-used
  //       idle session via the same graceful close the TTL uses.
  // -------------------------------------------------------------------------
  it('(F21) evicts the LRU idle warm session when a park exceeds the idle cap', async () => {
    process.env.CYBOFLOW_WARM_MAX_IDLE = '2';
    // Three conversations each park warm-idle; the 3rd park pushes the idle count
    // to 3 > cap 2, evicting the LRU (the first, smallest parkSeq).
    for (let i = 0; i < 3; i++) {
      fakeSdk.setScenario(twoTurnScenario());
      await mgr.spawnCliProcess({
        panelId: `p-cap-${i}`,
        sessionId: `p-cap-${i}`,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      });
    }
    // The eviction close fires synchronously at the 3rd park; let its drain settle.
    await settle();
    expect(getSdkRuns(mgr).has('p-cap-0')).toBe(false); // LRU evicted
    expect(getSdkRuns(mgr).has('p-cap-1')).toBe(true);
    expect(getSdkRuns(mgr).has('p-cap-2')).toBe(true);
    expect(getSdkRuns(mgr).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // (F21) An evicted conversation loses no data: its next turn cold-resumes with
  //       --resume from the captured claude session id.
  // -------------------------------------------------------------------------
  it('(F21) an evicted conversation cold-resumes on its next turn', async () => {
    process.env.CYBOFLOW_WARM_MAX_IDLE = '2';
    for (let i = 0; i < 3; i++) {
      fakeSdk.setScenario(twoTurnScenario());
      await mgr.spawnCliProcess({
        panelId: `p-evq-${i}`,
        sessionId: `p-evq-${i}`,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      });
    }
    await settle();
    expect(getSdkRuns(mgr).has('p-evq-0')).toBe(false);
    const coldCallsBefore = fakeSdk.calls.length; // 3 cold spawns so far

    // Re-drive the evicted conversation → a fresh cold query() carrying --resume.
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SESSION_UUID }).resultSuccess());
    await mgr.spawnCliProcess({
      panelId: 'p-evq-0',
      sessionId: 'p-evq-0',
      worktreePath: '/tmp/wt',
      prompt: 'again',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls.length).toBe(coldCallsBefore + 1);
    expect(callResume(coldCallsBefore)).toBe(SESSION_UUID);
  });

  // -------------------------------------------------------------------------
  // (F21) A mid-turn session is NEVER evicted — even when it is the LRU by
  //       parkSeq. The cap skips it (turnInFlight) and evicts the next LRU idle.
  // -------------------------------------------------------------------------
  it('(F21) never evicts a mid-turn session, even when it is the oldest', async () => {
    process.env.CYBOFLOW_WARM_MAX_IDLE = '2';
    // Park sessions 0 and 1 idle.
    for (let i = 0; i < 2; i++) {
      fakeSdk.setScenario(twoTurnScenario());
      await mgr.spawnCliProcess({
        panelId: `p-mid-${i}`,
        sessionId: `p-mid-${i}`,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      });
    }
    // Session 0 is the LRU by parkSeq; flip it to look mid-turn so the cap must skip it.
    setTurnInFlight(mgr, 'p-mid-0', true);

    // Park two more idle sessions → idle set = {1,2,3} = 3 > cap 2. The LRU IDLE is
    // session 1 (session 0 excluded as mid-turn), so session 1 is the victim.
    for (let i = 2; i < 4; i++) {
      fakeSdk.setScenario(twoTurnScenario());
      await mgr.spawnCliProcess({
        panelId: `p-mid-${i}`,
        sessionId: `p-mid-${i}`,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      });
    }
    await settle();
    expect(getSdkRuns(mgr).has('p-mid-0')).toBe(true); // mid-turn LRU survives
    expect(getSdkRuns(mgr).has('p-mid-1')).toBe(false); // LRU idle evicted instead
    expect(runClosing(mgr, 'p-mid-0')).not.toBe(true);

    // Restore so the afterEach teardown does not treat it as a live turn.
    setTurnInFlight(mgr, 'p-mid-0', false);
  });

  // -------------------------------------------------------------------------
  // (queued-input drain race) A warm-IDLE session stays in the base `processes`
  // map while parked, so isPanelRunning() reports it "running" even with no turn
  // in flight. The enqueue-then-check guard (flushPanelInputQueueIfIdle) must
  // read idleness from the SDK run record, NOT isPanelRunning — otherwise a
  // message enqueued in the park window (turn already drained an empty queue) is
  // stranded until a rest-point drain that never comes.
  // -------------------------------------------------------------------------
  it('flushPanelInputQueueIfIdle drains a message enqueued against a parked warm session', async () => {
    const panelId = 'p-drain-idle';
    const deliver = vi.fn();
    mgr.setPanelInputDeliverer(deliver);
    fakeSdk.setScenario(twoTurnScenario());

    // Turn 1 parks warm-idle: process retained (isPanelRunning true) but no turn.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(getProcesses(mgr).has(panelId)).toBe(true); // base map → isPanelRunning true
    expect(mgr.isPanelRunning(panelId)).toBe(true);
    expect(getSdkRuns(mgr).get(panelId)?.turnInFlight).toBe(false);

    // A message lands AFTER the turn's rest-point drain fired against an empty queue.
    mgr.enqueuePanelInput(panelId, 'raced', 'sent right after the turn ended');
    mgr.flushPanelInputQueueIfIdle(panelId);
    await settle();

    // Delivered despite isPanelRunning being true, and the buffer is cleared.
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(panelId, 'sent right after the turn ended');
    expect(mgr.listPanelInputQueue(panelId)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The opposite guard: while a turn is genuinely in flight, the enqueue-then-
  // check path must NOT drain — the turn's own rest-point drain delivers it, so
  // a mid-turn flush leaves the message buffered (no double-delivery, no abort).
  // -------------------------------------------------------------------------
  it('flushPanelInputQueueIfIdle does NOT drain while a turn is in flight', async () => {
    const panelId = 'p-drain-inflight';
    const deliver = vi.fn();
    mgr.setPanelInputDeliverer(deliver);
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // Force the parked run to look mid-turn.
    setTurnInFlight(mgr, panelId, true);

    mgr.enqueuePanelInput(panelId, 'mid', 'while you work');
    mgr.flushPanelInputQueueIfIdle(panelId);
    await settle();

    // Not delivered; the message stays buffered for the real rest-point drain.
    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.listPanelInputQueue(panelId)).toEqual([{ id: 'mid', text: 'while you work' }]);

    // Restore so the afterEach teardown does not treat it as a live turn.
    setTurnInFlight(mgr, panelId, false);
  });

  // -------------------------------------------------------------------------
  // A `closing` warm run (teardown initiated) is NOT idle for a drain — its warm
  // input is being torn down, so a message must not be pushed into a dying input;
  // it re-drains at the next cold-respawn's rest boundary.
  // -------------------------------------------------------------------------
  it('flushPanelInputQueueIfIdle does NOT drain a run whose teardown has begun (closing)', async () => {
    const panelId = 'p-drain-closing';
    const deliver = vi.fn();
    mgr.setPanelInputDeliverer(deliver);
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    // turnInFlight is false, but teardown has begun.
    setClosing(mgr, panelId, true);

    mgr.enqueuePanelInput(panelId, 'late', 'arrived during teardown');
    mgr.flushPanelInputQueueIfIdle(panelId);
    await settle();

    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.listPanelInputQueue(panelId)).toEqual([{ id: 'late', text: 'arrived during teardown' }]);

    // Restore so the afterEach teardown path settles cleanly.
    setClosing(mgr, panelId, false);
  });

  // -------------------------------------------------------------------------
  // Typed step-output channel (verification-agent redesign §5.3): spawnCliProcess
  // resolves with the turn's captured SUCCESS result text.
  //   (a) a clean cold turn resolves with the SDK result text;
  //   (b) a warm SECOND turn resolves with ITS OWN text (per-turn capture, never
  //       inheriting the first turn's);
  //   (c) a terminal-error turn still REJECTS (the result-text path never swallows
  //       the failure).
  // -------------------------------------------------------------------------
  it('(§5.3) resolves spawnCliProcess with the SUCCESS turn\'s final result text', async () => {
    const panelId = 'p-out-clean';
    fakeSdk.setScenario(
      scenario()
        .systemInit({ sessionId: SESSION_UUID })
        .assistantText('working on it')
        .resultSuccess({ result: 'the final answer' }),
    );

    const outcome = await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });

    expect(outcome).toEqual({ resultText: 'the final answer' });
  });

  it('(§5.3) a warm second turn resolves with ITS OWN result text, not the first turn\'s', async () => {
    const panelId = 'p-out-warm';
    fakeSdk.setScenario(
      scenario()
        .systemInit({ sessionId: SESSION_UUID })
        .assistantText('one')
        .resultSuccess({ result: 'first-answer' })
        .assistantText('two')
        .resultSuccess({ result: 'second-answer' }),
    );

    // Turn 1 — cold spawn.
    const first = await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(first).toEqual({ resultText: 'first-answer' });

    // Turn 2 — resume continuation → warm push (NO respawn) resolves with the
    // SECOND turn's text, proving the per-turn capture never leaks turn 1's.
    const second = await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(1); // warm push, not a cold respawn
    expect(second).toEqual({ resultText: 'second-answer' });
  });

  it('(§5.3) a terminal-error turn still REJECTS (the result-text path does not swallow it)', async () => {
    const panelId = 'p-out-err';
    // Default mock: getDbSession → undefined, so runId === panelId (a FLOW run) and
    // a fatal is_error result REJECTS spawnCliProcess (the false-complete guard).
    fakeSdk.setScenario(
      scenario().systemInit({ sessionId: SESSION_UUID }).resultError({ subtype: 'error_during_execution' }),
    );

    await expect(
      mgr.spawnCliProcess({
        panelId,
        sessionId: panelId,
        worktreePath: '/tmp/wt',
        prompt: 'first',
        permissionMode: 'ignore',
      }),
    ).rejects.toThrow();
  });
});
