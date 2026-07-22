/**
 * Background-subagent task tracking + the flow-turn hold-open boundary.
 *
 * SDK ≥0.3.201 runs Agent-tool subagents in the BACKGROUND by default: the
 * parent turn can produce a `result` while its subagents are still running, and
 * the CLI auto-continues the same conversation when they finish. Treating that
 * intermediate result as the turn boundary resolved spawnCliProcess, so
 * RunExecutor fired 'drained' (awaiting_review rest + run-level step-'done')
 * mid-flow — the false "Workflow complete". This suite pins:
 *
 *   (1) trackBackgroundTasks — the task_started / task_updated /
 *       task_notification lifecycle over the live set;
 *   (2) shouldHoldFlowTurnOpen — the boundary predicate's scope guards
 *       (flow-only, warm-only, never on terminal error / abort / kill switch);
 *   (3) the real streaming loop holds ONE logical turn across intermediate
 *       results while tasks are live: a flow spawn over a scripted
 *       auto-continuing stream emits exactly ONE 'exit', and spawnCliProcess
 *       resolves only after the final (task-free) result;
 *   (4) the kill switch (single-shot path) does NOT hold — the first result
 *       still ends the turn exactly as before.
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
  sdkSystemTaskStarted,
  sdkSystemTaskUpdated,
  sdkSystemTaskNotification,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import {
  ClaudeCodeManager,
  trackBackgroundTasks,
  shouldHoldFlowTurnOpen,
} from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';

const SESSION_UUID = 'sess-bg-uuid';

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
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

/** getDbSession → undefined = the FLOW-step identity path (runId === panelId). */
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

const flush = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// (1) trackBackgroundTasks — lifecycle over the live set.
// ---------------------------------------------------------------------------

describe('trackBackgroundTasks', () => {
  it('registers on task_started and retires on task_notification', () => {
    const live = new Set<string>();
    trackBackgroundTasks(sdkSystemTaskStarted('t1'), live);
    trackBackgroundTasks(sdkSystemTaskStarted('t2'), live);
    expect([...live].sort()).toEqual(['t1', 't2']);
    trackBackgroundTasks(sdkSystemTaskNotification('t1'), live);
    expect([...live]).toEqual(['t2']);
  });

  it('retires on a settled task_updated patch but keeps live statuses', () => {
    const live = new Set<string>(['t1', 't2', 't3']);
    trackBackgroundTasks(sdkSystemTaskUpdated('t1', { status: 'completed' }), live);
    trackBackgroundTasks(sdkSystemTaskUpdated('t2', { status: 'running' }), live);
    // A patch with no status (e.g. a description update) never settles.
    trackBackgroundTasks(sdkSystemTaskUpdated('t3', { description: 'still going' }), live);
    expect([...live].sort()).toEqual(['t2', 't3']);
    // Unknown status vocabulary defaults to SETTLED (fail toward closing turns).
    trackBackgroundTasks(sdkSystemTaskUpdated('t2', { status: 'exploded' }), live);
    expect([...live]).toEqual(['t3']);
  });

  it('ignores non-system events, missing task ids, and non-object events', () => {
    const live = new Set<string>(['t1']);
    trackBackgroundTasks({ type: 'assistant', task_id: 't1', subtype: 'task_notification' }, live);
    trackBackgroundTasks({ type: 'system', subtype: 'task_notification' }, live);
    trackBackgroundTasks(null, live);
    trackBackgroundTasks('result', live);
    expect([...live]).toEqual(['t1']);
  });

  it('is idempotent for repeated notifications of an already-settled task', () => {
    const live = new Set<string>();
    trackBackgroundTasks(sdkSystemTaskNotification('never-seen'), live);
    expect(live.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (2) shouldHoldFlowTurnOpen — scope guards.
// ---------------------------------------------------------------------------

describe('shouldHoldFlowTurnOpen', () => {
  const holdable = {
    spawnKey: 'run-1',
    runId: 'run-1',
    liveBackgroundTaskCount: 1,
    hasWarmInput: true,
    warmDisabled: false,
    terminalError: null,
    aborted: false,
  };

  it('holds a warm flow turn with live tasks', () => {
    expect(shouldHoldFlowTurnOpen(holdable)).toBe(true);
  });

  it.each([
    ['no live tasks', { liveBackgroundTaskCount: 0 }],
    ['quick chat turn (spawnKey ≠ runId)', { runId: '__quick__sentinel' }],
    ['fan-out lane (composite spawnKey)', { spawnKey: 'run-1:item-2' }],
    ['single-shot process (no warm input)', { hasWarmInput: false }],
    ['warm kill switch', { warmDisabled: true }],
    ['terminal error', { terminalError: 'usage limit' }],
    ['aborted', { aborted: true }],
  ] as const)('never holds: %s', (_label, override) => {
    expect(shouldHoldFlowTurnOpen({ ...holdable, ...override })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (3)+(4) The real streaming loop over the fake SDK.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager — flow turn held open while background tasks run', () => {
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
    for (const key of Array.from(getSdkRuns(mgr).keys())) {
      await mgr.killProcess(key).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /**
   * The observed production stream shape: two subagents spawn, the parent's turn
   * produces TWO intermediate results while they run (the CLI auto-continues past
   * each), and only the third result arrives with no live task.
   */
  function autoContinuingScenario() {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .taskStarted('task-a')
      .taskStarted('task-b')
      .assistantText('spawned both context agents')
      .resultSuccess({ result: 'waiting for agents' })
      .autoContinue()
      .taskNotification('task-a')
      .assistantText('one done, one to go')
      .resultSuccess({ result: 'still waiting' })
      .autoContinue()
      .taskNotification('task-b')
      .assistantText('both done — continuing the flow')
      .resultSuccess({ result: 'walk finished' })
      // Trailing step: the generator PARKS at the final result awaiting a push
      // (the multi-turn warm shape), so the process stays warm-idle for the
      // park assertions instead of draining to process death.
      .assistantText('next turn — never reached');
  }

  it('a flow spawn spans intermediate results: ONE exit, resolution after the final result', async () => {
    const panelId = 'p-bg-flow';
    fakeSdk.setScenario(autoContinuingScenario());

    // Ordered log of boundary-relevant emissions: result outputs + exits.
    const log: string[] = [];
    mgr.on('output', (evt: { data?: { type?: string; result?: string } }) => {
      if (evt.data?.type === 'result') log.push(`result:${evt.data.result}`);
    });
    mgr.on('exit', () => log.push('exit'));

    // Flow identity: panelId === sessionId (mock getDbSession → undefined ⇒ runId === panelId).
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'plan the ideas',
      permissionMode: 'ignore',
    });
    await flush();

    // ONE logical turn: the two intermediate results ended nothing.
    expect(log).toEqual([
      'result:waiting for agents',
      'result:still waiting',
      'result:walk finished',
      'exit',
    ]);
    // The process parks warm-idle after the real boundary, ready for the next turn.
    expect(getSdkRuns(mgr).get(panelId)?.turnInFlight).toBe(false);
    expect(getSdkRuns(mgr).get(panelId)?.warm).not.toBeNull();
  });

  it('kill switch (single-shot path): the first result still ends the turn', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    const panelId = 'p-bg-coldpath';
    fakeSdk.setScenario(autoContinuingScenario());

    const log: string[] = [];
    mgr.on('output', (evt: { data?: { type?: string; result?: string } }) => {
      if (evt.data?.type === 'result') log.push(`result:${evt.data.result}`);
    });
    mgr.on('exit', () => log.push('exit'));

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'plan the ideas',
      permissionMode: 'ignore',
    });
    await flush();

    // Pre-fix behavior preserved: the FIRST result is the boundary ('exit' right
    // after it), regardless of live tasks — the single-shot process is closing.
    expect(log[0]).toBe('result:waiting for agents');
    expect(log[1]).toBe('exit');
  });
});
