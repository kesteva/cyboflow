/**
 * Unit tests for the controller's RUN-LEVEL verification posture (CD1) and its
 * shared-build-break sweep (CD3).
 *
 * The behaviour under test is mostly about what does NOT happen: a run with no
 * verifiable modality must file ONE card instead of one per lane, must not
 * enqueue, must not park, and must still integrate every lane; a run with the
 * verifier switched OFF must be byte-identical to before the seam existed.
 *
 * Driven entirely through fake StepRunner + ControllerHost + FanOutDriver
 * collaborators (no SDK / DB / Electron), mirroring workflowController.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowController } from '../workflowController';
import type {
  BuildBreakGroup,
  ControllerHost,
  FanOutDriver,
  StepRunResult,
  StepRunner,
  TaskEnqueueResult,
  VerificationPosture,
  VisualGateOutcome,
  VisualVerifyGate,
} from '../types';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import type { WorkflowDefinition, WorkflowPhase, WorkflowStep } from '../../../../../shared/types/workflows';

// ── builders (mirrors workflowController.test.ts) ─────────────────────────────

function step(partial: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: partial.id, agent: partial.agent ?? 'executor', mcps: [], retries: partial.retries ?? 0, ...partial };
}
function phase(id: string, steps: WorkflowStep[]): WorkflowPhase {
  return { id, label: id, color: '#3b6dd6', steps };
}
function def(phases: WorkflowPhase[]): WorkflowDefinition {
  return { id: 'test', phases };
}

/** The sprint fan-out shape: implement → task-verify → visual-verify. */
function sprintFanStep(maxConcurrency = 1): WorkflowStep {
  return step({
    id: 'execute',
    agent: 'orchestrate',
    fanOut: {
      over: 'tasks',
      maxConcurrency,
      inner: [
        { id: 'implement', agent: 'implement' },
        { id: 'task-verify', agent: 'task-verify' },
        { id: 'visual-verify', agent: 'visual-verify' },
      ],
    },
  });
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

function makeRunner(resultText: string | null = verifyWithFence()): StepRunner {
  return {
    async runStep(s: WorkflowStep): Promise<StepRunResult> {
      if (s.id === 'task-verify' && resultText !== null) return { status: 'ok', resultText };
      return { status: 'ok' };
    },
  };
}

interface LaneWrite {
  itemId: string;
  status?: SprintBatchTaskStatus;
  currentStepId?: string | null;
}

function makeDriver(items: string[]): FanOutDriver & { lanes: LaneWrite[] } {
  const lanes: LaneWrite[] = [];
  return {
    lanes,
    resolveItems: () =>
      items.filter((id) => {
        const last = [...lanes].reverse().find((l) => l.itemId === id && l.status !== undefined);
        return last?.status !== 'integrated' && last?.status !== 'failed';
      }),
    driveLane({ itemId, status, currentStepId }) {
      lanes.push({ itemId, status, currentStepId });
    },
  };
}

function laneStatus(lanes: LaneWrite[], itemId: string): SprintBatchTaskStatus | undefined {
  return [...lanes].reverse().find((l) => l.itemId === itemId && l.status !== undefined)?.status;
}

interface PostureHost {
  host: ControllerHost;
  driver: ReturnType<typeof makeDriver>;
  /** Every run-level "no verifiable modality" declaration, in call order. */
  declarations: Array<{ runId: string; reason: string }>;
  /** Every PER-LANE skip finding, in call order. */
  laneSkips: Array<{ laneTaskRef: string; reason: string }>;
  /** Every visual-verification enqueue, in call order. */
  enqueues: string[];
  /** Every build-break group announced, in call order. */
  groupCards: BuildBreakGroup[];
  /** How many times the posture resolver was consulted. */
  postureCalls: () => number;
}

function makePostureHost(opts: {
  items: string[];
  posture?: VerificationPosture;
  /** Scripted enqueue outcomes; drained in order, defaulting to 'enqueued'. */
  enqueueOutcomes?: TaskEnqueueResult[];
  /** Scripted sweep results, drained in order, defaulting to []. */
  sweeps?: BuildBreakGroup[][];
  gateActive?: boolean;
  maxConcurrency?: number;
}): PostureHost {
  const driver = makeDriver(opts.items);
  const declarations: Array<{ runId: string; reason: string }> = [];
  const laneSkips: Array<{ laneTaskRef: string; reason: string }> = [];
  const enqueues: string[] = [];
  const groupCards: BuildBreakGroup[] = [];
  const enqueueQueue = [...(opts.enqueueOutcomes ?? [])];
  const sweepQueue = [...(opts.sweeps ?? [])];
  let postureCalls = 0;

  const gate: VisualVerifyGate = {
    isActive: () => opts.gateActive ?? true,
    async awaitVerdict(): Promise<VisualGateOutcome> {
      return { kind: 'advance' };
    },
  };

  const host: ControllerHost = {
    reportStep: () => undefined,
    async requestHumanGate() {
      return 'approve';
    },
    fanOut: driver,
    visualGate: gate,
    async enqueueVisualVerification(args: { laneTaskRef: string }): Promise<TaskEnqueueResult> {
      enqueues.push(args.laneTaskRef);
      return enqueueQueue.shift() ?? { outcome: 'enqueued', requestId: `req-${enqueues.length}` };
    },
    reportVerificationSkipped: (input) => {
      laneSkips.push({ laneTaskRef: input.laneTaskRef, reason: input.reason });
    },
    ...(opts.posture
      ? {
          async resolveVerificationPosture(): Promise<VerificationPosture> {
            postureCalls += 1;
            return opts.posture as VerificationPosture;
          },
        }
      : {}),
    reportNoVerifiableModality: (input) => {
      declarations.push(input);
    },
    ...(opts.sweeps
      ? {
          async sweepBuildBreaks(): Promise<BuildBreakGroup[]> {
            return sweepQueue.shift() ?? [];
          },
        }
      : {}),
    reportBuildBreakGroup: (input) => {
      groupCards.push(input.group);
    },
  };
  return { host, driver, declarations, laneSkips, enqueues, groupCards, postureCalls: () => postureCalls };
}

const THREE_LANES = ['t1', 't2', 't3'];

describe('WorkflowController — run-level verification posture', () => {
  it('files ONE declaration for a whole batch when no modality can serve the run, and no per-lane findings', async () => {
    const d = def([phase('p', [sprintFanStep(3)])]);
    const h = makePostureHost({
      items: THREE_LANES,
      posture: { kind: 'unavailable', reason: 'mobile modality is deferred' },
      maxConcurrency: 3,
    });

    const result = await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(result.outcome).toBe('completed');
    // ONE card for the run, not one per lane.
    expect(h.declarations).toEqual([{ runId: 'r', reason: 'mobile modality is deferred' }]);
    expect(h.laneSkips).toEqual([]);
    // No enqueue, and therefore no merge-gate park: the lane advances straight
    // through visual-verify, exactly as a verify-inactive run does.
    expect(h.enqueues).toEqual([]);
    expect(h.driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
    for (const id of THREE_LANES) expect(laneStatus(h.driver.lanes, id)).toBe('integrated');
  });

  it('resolves the posture ONCE per fan-out, before any lane is dispatched', async () => {
    const d = def([phase('p', [sprintFanStep(3)])]);
    const h = makePostureHost({
      items: THREE_LANES,
      posture: { kind: 'unavailable', reason: 'no proven native-screen runbook' },
    });
    await new WorkflowController(makeRunner(), h.host).run('r', d);
    expect(h.postureCalls()).toBe(1);
  });

  it('files NOTHING and changes nothing for a `disabled` posture (the deliberate off switch)', async () => {
    const d = def([phase('p', [sprintFanStep(3)])]);
    const h = makePostureHost({
      items: THREE_LANES,
      posture: { kind: 'disabled' },
      // The gate is what actually short-circuits a disabled run today; the
      // posture must not add a second, noisier mechanism on top of it.
      gateActive: false,
    });

    const result = await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(h.declarations).toEqual([]);
    expect(h.laneSkips).toEqual([]);
    expect(h.enqueues).toEqual([]);
    for (const id of THREE_LANES) expect(laneStatus(h.driver.lanes, id)).toBe('integrated');
  });

  it('leaves an `available` run completely unchanged: every lane enqueues and parks', async () => {
    const d = def([phase('p', [sprintFanStep(3)])]);
    const h = makePostureHost({ items: THREE_LANES, posture: { kind: 'available' } });

    const result = await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(h.declarations).toEqual([]);
    expect(h.enqueues.sort()).toEqual([...THREE_LANES]);
    expect(h.driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(true);
  });

  it('behaves as `available` when the host wires no posture resolver at all', async () => {
    const d = def([phase('p', [sprintFanStep(3)])]);
    const h = makePostureHost({ items: THREE_LANES });
    await new WorkflowController(makeRunner(), h.host).run('r', d);
    expect(h.declarations).toEqual([]);
    expect(h.enqueues.sort()).toEqual([...THREE_LANES]);
  });

  it('MID-FLIGHT FLIP: a modality decline collapses every LATER lane into the one declaration', async () => {
    // Serial pool so the order is deterministic: lane 1 declines with a
    // run-level reason, lanes 2 and 3 must then skip the enqueue entirely and
    // file nothing of their own.
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({
      items: THREE_LANES,
      posture: { kind: 'available' },
      enqueueOutcomes: [
        { outcome: 'skipped', reason: "unsupported modality 'mobile': deferred — pending Xcode MCP" },
      ],
    });

    const result = await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(result.outcome).toBe('completed');
    // Only the FIRST lane ever reached the enqueue seam.
    expect(h.enqueues).toEqual(['t1']);
    expect(h.declarations).toHaveLength(1);
    expect(h.declarations[0].reason).toContain('unsupported modality');
    // And the lane that triggered the flip files no per-lane card either: the
    // run-level declaration supersedes it from the moment it is filed.
    expect(h.laneSkips).toEqual([]);
    for (const id of THREE_LANES) expect(laneStatus(h.driver.lanes, id)).toBe('integrated');
  });

  it('does NOT flip on a per-lane accident, and keeps filing per-lane findings for it', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({
      items: ['t1', 't2'],
      posture: { kind: 'available' },
      enqueueOutcomes: [
        { outcome: 'skipped', reason: 'scheduler-unavailable' },
        { outcome: 'skipped', reason: 'scheduler-unavailable' },
      ],
    });

    await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(h.declarations).toEqual([]);
    expect(h.laneSkips.map((s) => s.laneTaskRef)).toEqual(['t1', 't2']);
  });

  it('never files a per-lane card for the deliberate off switch, flip or no flip', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({
      items: ['t1'],
      posture: { kind: 'available' },
      enqueueOutcomes: [{ outcome: 'skipped', reason: 'verification-disabled' }],
    });
    await new WorkflowController(makeRunner(), h.host).run('r', d);
    expect(h.laneSkips).toEqual([]);
    expect(h.declarations).toEqual([]);
  });

  it('suppresses the task-verify-produced-no-text per-lane finding under an unavailable posture', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({
      items: ['t1', 't2'],
      posture: { kind: 'unavailable', reason: 'mobile modality is deferred' },
    });
    // A substrate that captures no final text: the OTHER per-lane skip seam.
    await new WorkflowController(makeRunner(null), h.host).run('r', d);
    expect(h.laneSkips).toEqual([]);
    expect(h.declarations).toHaveLength(1);
  });
});

describe('WorkflowController — shared build-break detection', () => {
  const group = (normalized: string, count = 2): BuildBreakGroup => ({
    normalized,
    itemIds: Array.from({ length: count }, (_, i) => `rv${i + 1}`),
    count,
    laneRefs: [],
    sampleTitle: `Build break: ${normalized}`,
  });

  it('announces each group ONCE per run even though the sweep runs at every quiesced instant', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const g = group('cannot find name foo');
    const h = makePostureHost({
      items: ['t1', 't2'],
      // The same group comes back from every sweep — it only ever grows.
      sweeps: [[g], [g], [g], [g], [g]],
    });

    await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(h.groupCards).toHaveLength(1);
    expect(h.groupCards[0].normalized).toBe('cannot find name foo');
  });

  it('announces a SECOND, different group when one appears later in the run', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const first = group('cannot find name foo');
    const second = group('module not found: ./missing');
    const h = makePostureHost({
      items: ['t1', 't2'],
      sweeps: [[first], [first, second], [first, second], [first, second]],
    });

    await new WorkflowController(makeRunner(), h.host).run('r', d);

    expect(h.groupCards.map((c) => c.normalized)).toEqual([
      'cannot find name foo',
      'module not found: ./missing',
    ]);
  });

  it('announces nothing when the sweep finds no group, and never blocks the walk', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({ items: ['t1', 't2'], sweeps: [[], [], []] });
    const result = await new WorkflowController(makeRunner(), h.host).run('r', d);
    expect(result.outcome).toBe('completed');
    expect(h.groupCards).toEqual([]);
  });

  it('survives a throwing sweep (a detector must never cost the run its lanes)', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const driver = makeDriver(['t1', 't2']);
    const host: ControllerHost = {
      reportStep: () => undefined,
      async requestHumanGate() {
        return 'approve';
      },
      fanOut: driver,
      async sweepBuildBreaks(): Promise<BuildBreakGroup[]> {
        throw new Error('db gone');
      },
    };
    const result = await new WorkflowController(makeRunner(), host).run('r', d);
    expect(result.outcome).toBe('completed');
    expect(laneStatus(driver.lanes, 't2')).toBe('integrated');
  });

  it('does not sweep at all on a host that wires no sweep seam', async () => {
    const d = def([phase('p', [sprintFanStep(1)])]);
    const h = makePostureHost({ items: ['t1'] });
    await new WorkflowController(makeRunner(), h.host).run('r', d);
    expect(h.groupCards).toEqual([]);
  });
});
