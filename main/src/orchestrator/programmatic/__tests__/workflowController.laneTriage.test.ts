/**
 * Unit tests for the WorkflowController's AUTONOMOUS LANE-RESCUE seam.
 *
 * When a sprint fan-out lane exhausts an automatic budget the controller now
 * consults `ControllerHost.triageLaneFailure` BEFORE settling the lane 'failed'.
 * A 'rescue' verdict re-drives that lane from an earlier inner step, threading
 * the supervisor's guidance into every later spawn of THAT lane, WITHOUT bumping
 * `laneAttempt` — the autonomous analogue of an operator lane rewind. This suite
 * pins:
 *
 *   - the FOUR exhaustion sites that consult (generic inner-step, code-review
 *     BLOCKING, task-verify FAIL, visual merge-gate) and the paths that must
 *     NEVER consult (systemic, aborted, dependency-blocked, contract violation);
 *   - give_up settling the lane exactly as it did before the seam existed;
 *   - MONITOR_LANE_RESCUE_CAP (per lane) and MONITOR_RUN_RESCUE_CAP (per walk);
 *   - laneAttempt NOT bumped, and the per-attempt state cleared so the rescue is
 *     not cosmetic;
 *   - guidance delivery scoped to the rescued lane (siblings untouched);
 *   - the merge-gate lane REVIVAL (the gate already wrote the row 'failed').
 *
 * Driven entirely through fake StepRunner + ControllerHost + FanOutDriver
 * collaborators (no SDK / DB / Electron), mirroring workflowController.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowController,
  MONITOR_LANE_RESCUE_CAP,
  MONITOR_RUN_RESCUE_CAP,
} from '../workflowController';
import type {
  ControllerHost,
  ControllerStepContext,
  FanOutDriver,
  LaneRescueOutcome,
  LaneTriageFailure,
  StepRunResult,
  StepRunner,
  SystemicPauseVerdict,
  TaskEnqueueResult,
  VisualGateOutcome,
  VisualVerifyGate,
} from '../types';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../../../shared/types/workflows';

// ── builders (mirrors workflowController.test.ts) ─────────────────────────────

function step(partial: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return {
    name: partial.id,
    agent: partial.agent ?? 'executor',
    mcps: [],
    retries: partial.retries ?? 0,
    ...partial,
  };
}

function phase(id: string, steps: WorkflowStep[]): WorkflowPhase {
  return { id, label: id, color: '#3b6dd6', steps };
}

function def(phases: WorkflowPhase[]): WorkflowDefinition {
  return { id: 'test', phases };
}

/** A fanOut outer step over `inner` (ids, with optional per-step loopback). */
function fanStep(
  id: string,
  inner: Array<{ id: string; loopback?: string }>,
  maxConcurrency = 1,
): WorkflowStep {
  return step({
    id,
    agent: 'orchestrate',
    fanOut: {
      over: 'tasks',
      maxConcurrency,
      inner: inner.map((s) => ({ id: s.id, agent: s.id, ...(s.loopback ? { loopback: s.loopback } : {}) })),
    },
  });
}

// ── fakes ────────────────────────────────────────────────────────────────────

/** One recorded inner-step invocation, with the ctx fields this suite asserts on. */
interface RunnerCall {
  id: string;
  itemId: string | undefined;
  attempt: number;
  laneGuidance: string | undefined;
  loopbackFeedback: string | undefined;
}

/**
 * A StepRunner driven by a per-`itemId:stepId` (falling back to per-stepId)
 * queue of results, defaulting to ok, recording the ctx each call was handed.
 */
function makeRunner(scripts: Record<string, StepRunResult[]> = {}): StepRunner & { calls: RunnerCall[] } {
  const queues: Record<string, StepRunResult[]> = {};
  for (const [k, v] of Object.entries(scripts)) queues[k] = [...v];
  const calls: RunnerCall[] = [];
  return {
    calls,
    async runStep(s: WorkflowStep, ctx: ControllerStepContext) {
      calls.push({
        id: s.id,
        itemId: ctx.item?.id,
        attempt: ctx.attempt,
        laneGuidance: ctx.laneGuidance,
        loopbackFeedback: ctx.loopbackFeedback,
      });
      const keyed = ctx.item ? queues[`${ctx.item.id}:${s.id}`] : undefined;
      return keyed?.shift() ?? queues[s.id]?.shift() ?? { status: 'ok' };
    },
  };
}

interface LaneWrite {
  itemId: string;
  status?: SprintBatchTaskStatus;
  currentStepId?: string | null;
  attempt?: number;
}

/** A recording FanOutDriver over a fixed item set, with the revive seam wired. */
function makeDriver(
  items: string[],
  deps?: Map<string, string[]>,
): FanOutDriver & { lanes: LaneWrite[]; revived: string[] } {
  const lanes: LaneWrite[] = [];
  const revived: string[] = [];
  return {
    lanes,
    revived,
    resolveItems: () => items.filter((id) => !isSettled(lanes, id)),
    ...(deps ? { dependencies: () => deps } : {}),
    driveLane({ itemId, status, currentStepId, attempt }) {
      lanes.push({ itemId, status, currentStepId, attempt });
    },
    reviveLane({ itemId }) {
      revived.push(itemId);
      // Mirror the store: the row leaves 'failed', so the next re-resolution
      // returns the lane again instead of filtering it out as settled.
      lanes.push({ itemId, status: 'running' });
    },
  };
}

/** The production driver filters settled lanes out of resolveItems; mirror that. */
function isSettled(lanes: LaneWrite[], itemId: string): boolean {
  const last = [...lanes].reverse().find((l) => l.itemId === itemId && l.status !== undefined);
  return last?.status === 'integrated' || last?.status === 'failed';
}

/** The final persisted status of one lane. */
function laneStatus(lanes: LaneWrite[], itemId: string): SprintBatchTaskStatus | undefined {
  return [...lanes].reverse().find((l) => l.itemId === itemId && l.status !== undefined)?.status;
}

/** A rescue outcome re-driving from `targetStepId`. */
function rescue(targetStepId: string, guidance = 'do it the other way'): LaneRescueOutcome {
  return { kind: 'rescue', targetStepId, guidance, adjusted: false };
}

interface TriageHost {
  host: ControllerHost;
  driver: ReturnType<typeof makeDriver>;
  consults: LaneTriageFailure[];
  /** The `attempt` of every visual-verification enqueue, in call order. */
  enqueueAttempts: number[];
  /** Every systemic-park consult, in call order (empty unless `pauses` is set). */
  pauseCalls: Array<{ stepId: string; error: string | undefined }>;
}

/**
 * A ControllerHost with a fan-out driver and a `triageLaneFailure` that replays
 * a scripted outcome queue (defaulting to `give_up` once drained), recording
 * every consult. `visualGate` is attached only when a gate is supplied.
 */
function makeTriageHost(opts: {
  items: string[];
  outcomes?: LaneRescueOutcome[];
  triage?: boolean;
  visualGate?: VisualVerifyGate;
  deps?: Map<string, string[]>;
  maxConcurrency?: number;
  /** Wires `awaitSystemicPause`, replaying these verdicts (default 'giveup'). */
  pauses?: SystemicPauseVerdict[];
}): TriageHost {
  const driver = makeDriver(opts.items, opts.deps);
  const queue = [...(opts.outcomes ?? [])];
  const consults: LaneTriageFailure[] = [];
  const enqueueAttempts: number[] = [];
  const pauseQueue = [...(opts.pauses ?? [])];
  const pauseCalls: Array<{ stepId: string; error: string | undefined }> = [];
  const host: ControllerHost = {
    reportStep: () => undefined,
    async requestHumanGate() {
      return 'approve';
    },
    fanOut: driver,
    ...(opts.visualGate ? { visualGate: opts.visualGate } : {}),
    ...(opts.visualGate
      ? {
          // Records each call's `attempt`: the production scheduler dedups on
          // `${runId}:${ref}:${attempt}`, so a re-verification is only real when
          // the attempt advanced — the merge-gate rescue tests pin exactly that.
          enqueueVisualVerification: async (args: { attempt: number }): Promise<TaskEnqueueResult> => {
            enqueueAttempts.push(args.attempt);
            return {
              outcome: 'enqueued',
              requestId: `req-${enqueueAttempts.length}`,
            };
          },
        }
      : {}),
    ...(opts.pauses
      ? {
          async awaitSystemicPause(s: WorkflowStep, _ctx: ControllerStepContext, error?: string) {
            pauseCalls.push({ stepId: s.id, error });
            return pauseQueue.shift() ?? 'giveup';
          },
        }
      : {}),
    ...(opts.triage === false
      ? {}
      : {
          async triageLaneFailure(req: LaneTriageFailure): Promise<LaneRescueOutcome> {
            consults.push(req);
            return queue.shift() ?? { kind: 'give_up' };
          },
        }),
  };
  return { host, driver, consults, enqueueAttempts, pauseCalls };
}

/** A visual gate that replays scripted verdicts (default 'advance'). */
function makeVisualGate(verdicts: VisualGateOutcome[]): VisualVerifyGate {
  const queue = [...verdicts];
  return {
    isActive: () => true,
    async awaitVerdict() {
      return queue.shift() ?? { kind: 'advance' };
    },
  };
}

/** A task-verify result text with the given verdict + a NOT-APPLICABLE line. */
function verifyText(verdict: 'PASS' | 'FAIL'): string {
  return `VISUAL-VERIFICATION: NOT-APPLICABLE — no UI\nVERDICT: ${verdict}`;
}

/** A task-verify PASS carrying a valid `## Visual verification task` fence. */
function verifyWithFence(): string {
  const task = {
    version: 1,
    summary: 'Check the UI',
    behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
  };
  return `VERDICT: PASS\n\n## Visual verification task\n\n\`\`\`json\n${JSON.stringify(task)}\n\`\`\`\n`;
}

describe('WorkflowController — autonomous lane rescue', () => {
  // ── The four exhaustion sites ──────────────────────────────────────────────

  it('consults at the generic inner-step site and completes the lane on the rescued traversal', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'verify' }])])]);
    // `implement` has no declared loopback, so its first failure IS exhaustion.
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'tsc: 4 errors' }] });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({
      itemId: 't1',
      stepId: 'implement',
      failureKind: 'inner-step',
      errorExcerpt: 'tsc: 4 errors',
      innerStepIds: ['implement', 'verify'],
    });
    // The lane completed on the extra traversal instead of settling failed.
    expect(laneStatus(driver.lanes, 't1')).toBe('integrated');
    expect(runner.calls.filter((c) => c.id === 'implement')).toHaveLength(2);
  });

  it('consults at the code-review BLOCKING site once its loopback budget is spent', async () => {
    const d = def([
      phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'code-review', loopback: 'implement' }])]),
    ]);
    const blocking: StepRunResult = {
      status: 'ok',
      resultText: '## Blocking\n\n- a real defect\n\nREVIEW: BLOCKING',
    };
    // Three BLOCKING reviews exhaust FAN_OUT_LANE_ATTEMPT_CAP (1 → 2 → 3), then
    // the fourth (post-rescue) review is clean.
    const runner = makeRunner({ 'code-review': [blocking, blocking, blocking] });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({ failureKind: 'code-review', stepId: 'code-review', attempt: 3 });
    // The excerpt is the `## Blocking` section — the defects themselves.
    expect(consults[0].errorExcerpt).toContain('a real defect');
    expect(laneStatus(driver.lanes, 't1')).toBe('integrated');
  });

  it('consults at the task-verify FAIL site once its loopback budget is spent', async () => {
    const d = def([
      phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'task-verify', loopback: 'implement' }])]),
    ]);
    const fail: StepRunResult = { status: 'ok', resultText: verifyText('FAIL') };
    const runner = makeRunner({ 'task-verify': [fail, fail, fail] });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({ failureKind: 'task-verify', stepId: 'task-verify' });
    expect(consults[0].errorExcerpt).toContain('VERDICT: FAIL');
    expect(laneStatus(driver.lanes, 't1')).toBe('integrated');
  });

  it('consults at the visual merge-gate, REVIVES the already-failed lane row, and re-drives it', async () => {
    const d = def([
      phase('p', [
        fanStep('execute', [
          { id: 'implement' },
          { id: 'task-verify' },
          { id: 'visual-verify', loopback: 'implement' },
        ]),
      ]),
    ]);
    // task-verify must COMPOSE a task (a fence, not NOT-APPLICABLE) or the
    // agentless visual-verify step skips without ever parking on the gate.
    const runner = makeRunner({
      'task-verify': [
        { status: 'ok', resultText: verifyWithFence() },
        { status: 'ok', resultText: verifyWithFence() },
      ],
    });
    // The gate FAILS at its own cap first, then passes on the rescued attempt.
    const visualGate = makeVisualGate([{ kind: 'failed' }, { kind: 'advance' }]);
    const { host, driver, consults, enqueueAttempts } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
      visualGate,
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({ failureKind: 'merge-gate' });
    // The merge-gate driver already wrote the row 'failed' — the rescue must
    // un-settle it or the lane would re-run under a failed chip.
    expect(driver.revived).toEqual(['t1']);
    expect(laneStatus(driver.lanes, 't1')).toBe('integrated');
    expect(runner.calls.filter((c) => c.id === 'implement')).toHaveLength(2);
    // The rescued traversal must re-verify under a FRESH attempt: the production
    // scheduler dedups on `${runId}:${ref}:${attempt}`, and the request that just
    // FAILED owns the pre-rescue number — an un-bumped re-enqueue would bind the
    // rescued lane to that terminal request's stale verdict and fail it without
    // ever verifying the new code.
    expect(enqueueAttempts).toEqual([1, 2]);
    // ...and the advanced attempt is synced onto the lane row at the target
    // step's spawn, so the gate's DB-side cap keeps reading the true count.
    const rowAttempts = driver.lanes.filter((l) => l.attempt !== undefined).map((l) => l.attempt);
    expect(rowAttempts).toContain(2);
  });

  // ── give_up: byte-identical to the pre-seam behavior ───────────────────────

  it("settles the lane failed on 'give_up', exactly as it did before the seam", async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }]), step({ id: 'after' })])]);
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
    const { host, driver, consults } = makeTriageHost({ items: ['t1'] }); // queue drained ⇒ give_up

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(1);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
    // The incomplete lane still gates the closing stages (skipToHumanGate).
    expect(result.steps.find((s) => s.stepId === 'after')).toMatchObject({ outcome: 'skipped' });
    expect(runner.calls.filter((c) => c.id === 'implement')).toHaveLength(1);
  });

  it('settles the lane failed when no host implements the seam at all (unchanged hosts)', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
    const { host, driver } = makeTriageHost({ items: ['t1'], triage: false });

    await new WorkflowController(runner, host).run('r', d);

    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  it('settles the lane failed when the rescue names a step outside this fan-out chain', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('some-other-flow-step')],
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(1);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  // ── Budgets ───────────────────────────────────────────────────────────────

  it(`caps rescues at MONITOR_LANE_RESCUE_CAP (${MONITOR_LANE_RESCUE_CAP}) per lane — the second failure settles WITHOUT consulting`, async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({
      implement: [
        { status: 'failed', error: 'first' },
        { status: 'failed', error: 'second' },
      ],
    });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement'), rescue('implement')],
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(1);
    expect(runner.calls.filter((c) => c.id === 'implement')).toHaveLength(2);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  it(`caps rescues at MONITOR_RUN_RESCUE_CAP (${MONITOR_RUN_RESCUE_CAP}) across the whole walk`, async () => {
    const items = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    // Every lane fails its first implement; a rescued lane succeeds on the retry.
    const scripts: Record<string, StepRunResult[]> = {};
    for (const id of items) scripts[`${id}:implement`] = [{ status: 'failed', error: 'boom' }];
    const runner = makeRunner(scripts);
    const { host, driver, consults } = makeTriageHost({
      items,
      outcomes: items.map(() => rescue('implement')),
    });

    await new WorkflowController(runner, host).run('r', d);

    // Only the first four lanes to fail get a consult; the rest settle directly.
    expect(consults).toHaveLength(MONITOR_RUN_RESCUE_CAP);
    const rescued = items.filter((id) => laneStatus(driver.lanes, id) === 'integrated');
    const abandoned = items.filter((id) => laneStatus(driver.lanes, id) === 'failed');
    expect(rescued).toHaveLength(MONITOR_RUN_RESCUE_CAP);
    expect(abandoned).toHaveLength(items.length - MONITOR_RUN_RESCUE_CAP);
  });

  it('a give_up consult does NOT spend the run budget (the caps bound intervention, not consultation)', async () => {
    const items = ['t1', 't2'];
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const scripts: Record<string, StepRunResult[]> = {};
    for (const id of items) scripts[`${id}:implement`] = [{ status: 'failed', error: 'boom' }];
    const runner = makeRunner(scripts);
    // t1 gives up; t2 is rescued — which requires t1's reservation to be released.
    const { host, driver, consults } = makeTriageHost({
      items,
      outcomes: [{ kind: 'give_up' }, rescue('implement')],
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(2);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
    expect(laneStatus(driver.lanes, 't2')).toBe('integrated');
  });

  // ── Rescue semantics: attempt + per-attempt state ──────────────────────────

  it('does NOT bump laneAttempt (a rescue must not burn the lane re-delegate budget)', async () => {
    const d = def([
      phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'code-review', loopback: 'implement' }])]),
    ]);
    const blocking: StepRunResult = {
      status: 'ok',
      resultText: '## Blocking\n\n- defect\n\nREVIEW: BLOCKING',
    };
    const runner = makeRunner({ 'code-review': [blocking, blocking, blocking] });
    const { host, consults } = makeTriageHost({ items: ['t1'], outcomes: [rescue('implement')] });

    await new WorkflowController(runner, host).run('r', d);

    // The lane reached attempt 3 through its own loopbacks...
    expect(consults[0].attempt).toBe(3);
    const implementAttempts = runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt);
    // ...and the RESCUED traversal re-runs at 3, not 4 (which would exceed the cap).
    expect(implementAttempts).toEqual([1, 2, 3, 3]);
  });

  it('clears the superseded attempt’s one-shot loopback feedback (the rescue is not cosmetic)', async () => {
    const d = def([
      phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'code-review', loopback: 'implement' }])]),
    ]);
    const blocking: StepRunResult = {
      status: 'ok',
      resultText: '## Blocking\n\n- defect\n\nREVIEW: BLOCKING',
    };
    const runner = makeRunner({ 'code-review': [blocking, blocking, blocking] });
    const { host } = makeTriageHost({ items: ['t1'], outcomes: [rescue('implement')] });

    await new WorkflowController(runner, host).run('r', d);

    const implementCalls = runner.calls.filter((c) => c.id === 'implement');
    // The two mid-lane loopbacks carried the review's defects...
    expect(implementCalls[1].loopbackFeedback).toContain('defect');
    expect(implementCalls[2].loopbackFeedback).toContain('defect');
    // ...but the RESCUED traversal starts clean: that section described the
    // attempt the rescue is discarding, and the guidance replaces it.
    expect(implementCalls[3].loopbackFeedback).toBeUndefined();
  });

  // ── Guidance delivery ─────────────────────────────────────────────────────

  it('threads the rescue guidance into EVERY later spawn of that lane, and into no sibling lane', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'verify' }])])]);
    const runner = makeRunner({ 't1:implement': [{ status: 'failed', error: 'boom' }] });
    const { host } = makeTriageHost({
      items: ['t1', 't2'],
      outcomes: [rescue('implement', 'mock the clock instead of sleeping')],
    });

    await new WorkflowController(runner, host).run('r', d);

    const t1 = runner.calls.filter((c) => c.itemId === 't1');
    const t2 = runner.calls.filter((c) => c.itemId === 't2');
    // Pre-rescue spawn: no guidance yet.
    expect(t1[0]).toMatchObject({ id: 'implement', laneGuidance: undefined });
    // Every spawn after the rescue carries it — not just the re-driven step.
    expect(t1.slice(1).map((c) => c.id)).toEqual(['implement', 'verify']);
    for (const call of t1.slice(1)) {
      expect(call.laneGuidance).toBe('mock the clock instead of sleeping');
    }
    // The sibling lane's prompts are untouched (this is why guidance is keyed by
    // ITEM and not written into the shared, step-keyed stepGuidance map).
    expect(t2.every((c) => c.laneGuidance === undefined)).toBe(true);
  });

  // ── Paths that must NEVER consult ─────────────────────────────────────────

  it('never consults for a SYSTEMIC failure (it has its own park path)', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({
      implement: [{ status: 'failed', systemic: true, error: 'usage limit reached' }],
    });
    // No systemicGate wired ⇒ the paused lane is failed like a blocked lane.
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(0);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  it('never consults for an ABORTED result (the run was canceled)', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const ac = new AbortController();
    const runner: StepRunner = {
      async runStep() {
        ac.abort();
        return { status: 'aborted' };
      },
    };
    const { host, consults } = makeTriageHost({ items: ['t1'], outcomes: [rescue('implement')] });

    const result = await new WorkflowController(runner, host).run('r', d, ac.signal);

    expect(result.outcome).toBe('canceled');
    expect(consults).toHaveLength(0);
  });

  it('never consults for a lane BLOCKED by a failed prerequisite (markBlocked)', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({ 't1:implement': [{ status: 'failed', error: 'boom' }] });
    const deps = new Map<string, string[]>([['t2', ['t1']]]);
    // t1 gives up (queue drained) and t2 is blocked by it.
    const { host, driver, consults } = makeTriageHost({ items: ['t1', 't2'], deps });

    await new WorkflowController(runner, host).run('r', d);

    // Exactly ONE consult — t1's own exhaustion. t2 never reaches a budget.
    expect(consults.map((c) => c.itemId)).toEqual(['t1']);
    // …and t2 settles 'blocked' (never started), not 'failed' — it has no defect
    // to triage, and reporting one would manufacture a second failure.
    expect(laneStatus(driver.lanes, 't2')).toBe('blocked');
  });

  it('never consults for a task-verify OUTPUT-CONTRACT exhaustion', async () => {
    const d = def([
      phase('p', [
        fanStep('execute', [{ id: 'implement' }, { id: 'task-verify' }, { id: 'visual-verify' }]),
      ]),
    ]);
    // A PASS carrying neither a fence nor a NOT-APPLICABLE line, twice ⇒ the
    // lane fails on the contract, which no guidance could have reasoned about.
    const bad: StepRunResult = { status: 'ok', resultText: 'VERDICT: PASS' };
    const runner = makeRunner({ 'task-verify': [bad, bad] });
    const { host, driver, consults } = makeTriageHost({
      items: ['t1'],
      outcomes: [rescue('implement')],
      visualGate: makeVisualGate([]),
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(0);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  // ── Systemic triage: the consult itself died on the environment ───────────

  /** The verbatim 2026-09-05 sprint-2 cascade text the supervisor's own turn hit. */
  const LIMIT = "You've hit your session limit · resets 6pm (America/Los_Angeles)";

  /** Every 'failed' status this driver ever persisted, in write order. */
  function failedWrites(lanes: LaneWrite[]): string[] {
    return lanes.filter((l) => l.status === 'failed').map((l) => l.itemId);
  }

  it('PARKS the fan-out (never fails the lane) when lane triage dies on a systemic condition', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'verify' }])])]);
    // `implement` declares no loopback, so its first failure IS exhaustion and
    // the lane consults triage — whose own SDK turn hits the session limit.
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'tsc: 4 errors' }] });
    const { host, driver, consults, pauseCalls } = makeTriageHost({
      items: ['t1'],
      outcomes: [{ kind: 'systemic', error: LIMIT }],
      pauses: ['retry'],
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(consults).toHaveLength(1);
    // The fan-out parked on the triage error — not on the lane's own failure text.
    expect(pauseCalls).toEqual([{ stepId: 'execute', error: LIMIT }]);
    // The environment is not this task's defect: the lane was NEVER written failed…
    expect(failedWrites(driver.lanes)).toEqual([]);
    // …and it re-dispatched after 'retry', completing on the second traversal.
    expect(laneStatus(driver.lanes, 't1')).toBe('integrated');
    expect(runner.calls.filter((c) => c.id === 'implement')).toHaveLength(2);
  });

  it('LATCHES the systemic verdict for the whole park epoch: five failing lanes, one pause, no lane failed', async () => {
    // Regression: MONITOR_RUN_RESCUE_CAP is 4, so without the latch five concurrent
    // lanes make four doomed consults against a dead quota and the fifth lane —
    // refused a consult because the budget is "spent" — settles 'failed' on an
    // environment condition no task caused.
    const items = ['t1', 't2', 't3', 't4', 't5'];
    const d = def([
      phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'review' }, { id: 'verify' }], 5)]),
    ]);
    // t1 fails FIRST (at step 0) so its consult resolves while the siblings are
    // still working; they then fail two steps later and hit the latch.
    const runner = makeRunner({
      't1:implement': [{ status: 'failed', error: 'tsc: 4 errors' }],
      ...Object.fromEntries(
        items.slice(1).map((id) => [`${id}:verify`, [{ status: 'failed', error: 'tsc: 4 errors' }]]),
      ),
    });
    const { host, driver, consults, pauseCalls } = makeTriageHost({
      items,
      // ONE systemic outcome: any further consult would drain to `give_up` and
      // fail its lane, which is exactly what the latch must prevent.
      outcomes: [{ kind: 'systemic', error: LIMIT }],
      pauses: ['retry'],
      maxConcurrency: 5,
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    // The siblings park on the latch instead of consulting (and instead of
    // burning the run's rescue budget on a monitor that cannot answer).
    expect(consults.length).toBeLessThanOrEqual(2);
    // ONE park for the whole epoch, carrying the triage error.
    expect(pauseCalls).toEqual([{ stepId: 'execute', error: LIMIT }]);
    // No lane blamed for the environment — including the one past the cap.
    expect(failedWrites(driver.lanes)).toEqual([]);
    for (const id of items) expect(laneStatus(driver.lanes, id)).toBe('integrated');
  });

  it('SERIALIZES consults so five lanes failing BEFORE the first consult resolves still park as one', async () => {
    // Regression (Codex F1): the latch is read before the consult, and lanes
    // fail concurrently — five lanes that all fail at step 0 pass the latch
    // check together. Unserialized, four consults reserve MONITOR_RUN_RESCUE_CAP
    // and the fifth is refused on a "spent" budget and settles 'failed'.
    // Corroboration cannot rescue it either: every lane fails with DIFFERENT
    // text, and the systemic lanes carry the monitor's error, not the step's.
    const items = ['t1', 't2', 't3', 't4', 't5'];
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }, { id: 'verify' }], 5)])]);
    const runner = makeRunner(
      Object.fromEntries(items.map((id, n) => [`${id}:implement`, [{ status: 'failed', error: `tsc: ${n + 1} errors` }]])),
    );
    const { host, driver, consults, pauseCalls } = makeTriageHost({
      items,
      outcomes: [{ kind: 'systemic', error: LIMIT }],
      pauses: ['retry'],
      maxConcurrency: 5,
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    // Exactly ONE consult: the four that queued behind it re-read the latch.
    expect(consults).toHaveLength(1);
    expect(pauseCalls).toEqual([{ stepId: 'execute', error: LIMIT }]);
    expect(failedWrites(driver.lanes)).toEqual([]);
    for (const id of items) expect(laneStatus(driver.lanes, id)).toBe('integrated');
  });

  it('CLEARS the latch when a park ends WITHOUT a resume: a later unrelated failure is still consulted', async () => {
    // The park arm is skipped entirely when there is no `awaitSystemicPause`
    // seam (and equally when the pause budget is spent, or give-up has latched):
    // the parked lanes fall straight through to 'failed' with no resume event.
    // If the triage latch survived that, every later lane in the run would park
    // un-consulted and then fail — a 15-lane sprint losing lane triage for lanes
    // 3-15 because lane 2's consult hit a transient quota error once.
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({
      't1:implement': [{ status: 'failed', error: 'tsc: 4 errors' }],
      't2:implement': [{ status: 'failed', error: 'eslint: 2 problems' }],
    });
    // No `pauses` ⇒ no awaitSystemicPause seam at all. t1's consult dies
    // systemically; t2 then fails for an entirely unrelated reason.
    const { host, driver, consults } = makeTriageHost({
      items: ['t1', 't2'],
      outcomes: [{ kind: 'systemic', error: LIMIT }, { kind: 'give_up' }],
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    // TWO consults: t1's (which died) and t2's, which the cleared latch allowed.
    expect(consults).toHaveLength(2);
    expect(consults.map((c) => c.itemId)).toEqual(['t1', 't2']);
    // Both settled failed — t1 through the seam-less park, t2 through its consult.
    expect(failedWrites(driver.lanes)).toEqual(['t1', 't2']);
  });

  it('treats a systemic triage verdict at the MERGE GATE exactly like a give_up', async () => {
    // The gate already PERSISTED this lane 'failed' and the verification request
    // it just resolved owns the lane's current attempt number, so a park would
    // re-drive it at attempt 1 and dedup onto that terminal request. The lane
    // settles failed there; only the non-gate arms park.
    const d = def([
      phase('p', [
        fanStep('execute', [
          { id: 'implement' },
          { id: 'task-verify' },
          { id: 'visual-verify', loopback: 'implement' },
        ]),
      ]),
    ]);
    const runner = makeRunner({
      'task-verify': [{ status: 'ok', resultText: verifyWithFence() }],
    });
    const { host, driver, consults, pauseCalls } = makeTriageHost({
      items: ['t1'],
      outcomes: [{ kind: 'systemic', error: LIMIT }],
      pauses: ['retry'],
      visualGate: makeVisualGate([{ kind: 'failed' }]),
    });

    await new WorkflowController(runner, host).run('r', d);

    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({ failureKind: 'merge-gate' });
    expect(pauseCalls).toEqual([]);
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });

  // ── Fail-soft ─────────────────────────────────────────────────────────────

  it('settles the lane failed when the consult itself throws (the host contract says it cannot)', async () => {
    const d = def([phase('p', [fanStep('execute', [{ id: 'implement' }])])]);
    const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
    const driver = makeDriver(['t1']);
    const host: ControllerHost = {
      reportStep: () => undefined,
      async requestHumanGate() {
        return 'approve';
      },
      fanOut: driver,
      triageLaneFailure: vi.fn().mockRejectedValue(new Error('host boom')),
    };

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(laneStatus(driver.lanes, 't1')).toBe('failed');
  });
});
