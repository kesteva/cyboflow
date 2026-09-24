/**
 * SprintSwimlaneCanvas tests (feat/parallel-sprint swim-lane canvas).
 *
 * Behaviors verified:
 *   1. Per-step derivation — integrated lane: the pre-verify steps done; running
 *      lane: before current done / current running / after pending; failed
 *      lane: current step failed; queued lane: all pending.
 *   1b. F8 — the "Visual check" card of an INTEGRATED lane is derived from the
 *      lane's real verification outcome (passed → done, low_confidence →
 *      advisory, failed → failed, skipped/timeout/no-row → skipped), with the
 *      reason + failure class on hover; non-integrated lanes are untouched.
 *   2. Chip mapping — MERGED / RUNNING / ESCALATED / BLOCKED (with
 *      "waiting on <refs>") / QUEUED ("waiting for worker slot") + escalated
 *      context text using attempts.
 *   3. Attempt loop edge — shown for running + attempts >= 2, absent at
 *      attempts = 0; integrated + attempts >= 2 shows "n attempts".
 *   4. Merge-gate count + summary row (parallel count, workers r/5, merged
 *      m/N, ESCALATED badge).
 *   5. Plan card + verify column render from phaseState (human badge on the
 *      human-review step).
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SprintLaneRow } from '../../../../../shared/types/sprintBatch';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';

// ---------------------------------------------------------------------------
// Per-file tRPC mock (overrides the setup.ts global stub) — mirrors
// SprintLanesPanel.test.tsx's bare-spy pattern.
// ---------------------------------------------------------------------------

const { unsubscribeSpy, subscribeSpy, lanesQuerySpy, forEntityQuerySpy } = vi.hoisted(() => ({
  unsubscribeSpy: vi.fn(),
  subscribeSpy: vi.fn(),
  lanesQuerySpy: vi.fn(),
  // Design affordance (Tier 2, item 8c) — a lane header mounts one only when a
  // sessionKey is passed; default to null (no button) so tests that don't
  // pass one are unaffected.
  forEntityQuerySpy: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        sprintLanes: { query: lanesQuerySpy },
        onSprintLaneChanged: { subscribe: subscribeSpy },
      },
      design: {
        forEntity: { query: forEntityQuerySpy },
        snapshotHtml: { query: vi.fn().mockResolvedValue(null) },
      },
      ideaComponents: {
        onComponentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import { SprintSwimlaneCanvas } from '../SprintSwimlaneCanvas';
import { MODEL_FAMILY_COLORS, stepModelKey, type ModelFamily } from '../../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Canonical 3-phase sprint definition (plan → execute → verify). */
const PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: {
    id: 'sprint',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'analyze-dependencies', name: 'Analyze dependencies', agent: 'planner', mcps: [], retries: 0 },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'execute-tasks', name: 'Execute tasks', agent: 'executor', mcps: [], retries: 0 },
        ],
      },
      {
        id: 'verify',
        label: 'Verify',
        color: '#2d8a5b',
        steps: [
          { id: 'sprint-verify', name: 'Sprint verify', agent: 'verifier', mcps: [], retries: 0 },
          { id: 'sprint-review', name: 'Sprint review', agent: 'reviewer', mcps: [], retries: 0 },
          { id: 'human-review', name: 'Human review', agent: 'human', mcps: [], retries: 0, human: true },
        ],
      },
    ],
  },
  currentStepId: 'execute-tasks',
  stepStates: [],
  isLoading: false,
  error: null,
};

const baseLane = {
  batchId: 'batch-1',
  // F8: the lane read-model carries its derived visual-verification outcome.
  // null = no verification request row is attributable to the lane.
  visualVerification: null,
  updatedAt: '2026-06-11T00:00:00Z',
};

const LANES: SprintLaneRow[] = [
  {
    ...baseLane,
    taskId: 't1',
    status: 'integrated',
    currentStepId: null,
    ref: 'TASK-1',
    title: 'First task',
    attempts: 0,
    blockedByRefs: [],
  },
  {
    ...baseLane,
    taskId: 't2',
    status: 'running',
    currentStepId: 'code-review',
    ref: 'TASK-2',
    title: 'Second task',
    attempts: 2,
    blockedByRefs: [],
  },
  {
    // queued + in-batch blocking prereq not yet integrated → BLOCKED chip.
    ...baseLane,
    taskId: 't3',
    status: 'queued',
    currentStepId: null,
    ref: 'TASK-3',
    title: 'Third task',
    attempts: 0,
    blockedByRefs: ['TASK-2'],
  },
  {
    ...baseLane,
    taskId: 't4',
    status: 'queued',
    currentStepId: null,
    ref: 'TASK-4',
    title: 'Fourth task',
    attempts: 0,
    blockedByRefs: [],
  },
  {
    ...baseLane,
    taskId: 't5',
    status: 'failed',
    currentStepId: 'task-verify',
    ref: 'TASK-5',
    title: 'Fifth task',
    attempts: 3,
    blockedByRefs: [],
  },
  {
    // integrated after a re-delegation — renders "2 attempts" next to MERGED.
    ...baseLane,
    taskId: 't6',
    status: 'integrated',
    currentStepId: null,
    ref: 'TASK-6',
    title: 'Sixth task',
    attempts: 2,
    blockedByRefs: [],
  },
  {
    // running first pass — NO attempt loop edge.
    ...baseLane,
    taskId: 't7',
    status: 'running',
    currentStepId: 'implement',
    ref: 'TASK-7',
    title: 'Seventh task',
    attempts: 0,
    blockedByRefs: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  subscribeSpy.mockReturnValue({ unsubscribe: unsubscribeSpy });
  lanesQuerySpy.mockResolvedValue(LANES);
});

async function renderCanvas(
  props: {
    projectId?: number | null;
    sessionKey?: string;
    stepModels?: ReadonlyMap<string, { label: string; family: ModelFamily }> | null;
    pausedStepId?: string | null;
  } = {},
) {
  render(
    <SprintSwimlaneCanvas
      runId="run-1"
      phaseState={PHASE_STATE}
      sprintStatus="running"
      {...props}
    />,
  );
  // Wait for the lane snapshot to land.
  await screen.findByTestId('swimlane-lane-t1');
}

const stepStatus = (taskId: string, stepId: string): string | null =>
  screen.getByTestId(`swimlane-step-${taskId}-${stepId}`).getAttribute('data-status');

describe('SprintSwimlaneCanvas — lane header Design affordance (Tier 2, item 8c)', () => {
  it('renders no Design affordance when no sessionKey is passed (default)', async () => {
    await renderCanvas();
    expect(screen.queryByTestId('design-affordance')).not.toBeInTheDocument();
    expect(forEntityQuerySpy).not.toHaveBeenCalled();
  });

  it('renders no Design affordance for a lane with no bound design, given a sessionKey', async () => {
    await renderCanvas({ projectId: 7, sessionKey: 'sess-1' });
    await waitFor(() => expect(forEntityQuerySpy).toHaveBeenCalled());
    expect(screen.queryByTestId('design-affordance')).not.toBeInTheDocument();
  });

  it('renders the Design affordance for lanes whose task has a bound design, given a sessionKey', async () => {
    forEntityQuerySpy.mockImplementation((args: { entityId: string }) =>
      Promise.resolve(
        args.entityId === 't1'
          ? {
              ideaId: 'idea-1',
              ideaRef: 'IDEA-014',
              ideaTitle: 'Spend flow',
              approvedAt: '2026-09-10T00:00:00.000Z',
              source: 'flow',
              sourceRunId: 'run-1',
            }
          : null,
      ),
    );
    await renderCanvas({ projectId: 7, sessionKey: 'sess-1' });

    await waitFor(() => expect(screen.getAllByTestId('design-affordance')).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintSwimlaneCanvas — per-step derivation', () => {
  it('marks the pre-verify steps done for an integrated lane', async () => {
    await renderCanvas();

    for (const stepId of ['implement', 'write-tests', 'code-review', 'task-verify']) {
      expect(stepStatus('t1', stepId)).toBe('done');
    }
    // F8: t1 carries NO verification request row, so the visual check is NOT
    // painted green just because the lane integrated — the merge gate integrates
    // on skipped/timeout/low_confidence too.
    expect(stepStatus('t1', 'visual-verify')).toBe('skipped');
  });

  it('derives before/current/after for a running lane', async () => {
    await renderCanvas();

    expect(stepStatus('t2', 'implement')).toBe('done');
    expect(stepStatus('t2', 'write-tests')).toBe('done');
    expect(stepStatus('t2', 'code-review')).toBe('running');
    expect(stepStatus('t2', 'task-verify')).toBe('pending');
    expect(stepStatus('t2', 'visual-verify')).toBe('pending');
  });

  it('styles the current step failed on a failed lane and leaves later steps pending', async () => {
    await renderCanvas();

    expect(stepStatus('t5', 'code-review')).toBe('done');
    expect(stepStatus('t5', 'task-verify')).toBe('failed');
    expect(stepStatus('t5', 'visual-verify')).toBe('pending');
  });

  it('keeps all steps pending for a queued lane', async () => {
    await renderCanvas();

    for (const stepId of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(stepStatus('t4', stepId)).toBe('pending');
    }
  });
});

describe('SprintSwimlaneCanvas — chips + context labels', () => {
  it('maps lane statuses to MERGED / RUNNING / ESCALATED / BLOCKED / QUEUED chips', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-chip-t1')).toHaveTextContent('MERGED');
    expect(screen.getByTestId('swimlane-chip-t2')).toHaveTextContent('RUNNING');
    expect(screen.getByTestId('swimlane-chip-t5')).toHaveTextContent('ESCALATED');
    // queued + blockedByRefs → BLOCKED; queued without refs → QUEUED.
    expect(screen.getByTestId('swimlane-chip-t3')).toHaveTextContent('BLOCKED');
    expect(screen.getByTestId('swimlane-chip-t4')).toHaveTextContent('QUEUED');
  });

  it('shows "waiting on <refs>" for a BLOCKED lane and the worker-slot text for a QUEUED lane', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-context-t3')).toHaveTextContent('waiting on TASK-2');
    expect(screen.getByTestId('swimlane-context-t4')).toHaveTextContent('waiting for worker slot');
  });

  it('shows the attempts-aware escalation text for a failed lane', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-context-t5')).toHaveTextContent('3/3 failed → human review');
  });
});

describe('SprintSwimlaneCanvas — attempt loop edge', () => {
  it('renders the dashed ATTEMPT n/3 edge for a running lane with attempts >= 2', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-attempt-t2')).toHaveTextContent('ATTEMPT 2/3');
  });

  it('renders no attempt edge for a first-pass (attempts = 0) running lane', async () => {
    await renderCanvas();

    expect(screen.queryByTestId('swimlane-attempt-t7')).toBeNull();
  });

  it('shows "n attempts" next to the MERGED chip for an integrated lane with attempts >= 2', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-context-t6')).toHaveTextContent('2 attempts');
    // First-pass integrated lane carries no context label.
    expect(screen.queryByTestId('swimlane-context-t1')).toBeNull();
  });
});

describe('SprintSwimlaneCanvas — summary, merge gate, plan + verify columns', () => {
  it('renders the summary row with parallel/workers/merged counts and the ESCALATED badge', async () => {
    await renderCanvas();

    const summary = screen.getByTestId('swimlane-summary');
    expect(summary).toHaveTextContent('7 parallel tasks');
    // r = running lanes (t2, t7), cap literal 5 (SPRINT_BATCH_CAP).
    expect(summary).toHaveTextContent('workers 2/5');
    expect(summary).toHaveTextContent('merged 2/7');
    expect(screen.getByTestId('swimlane-summary-escalated')).toHaveTextContent('1 ESCALATED');
  });

  it('renders the merge-gate bar with the integrated count', async () => {
    await renderCanvas();

    expect(screen.getByTestId('swimlane-merge-gate')).toHaveTextContent('MERGE GATE · 2/7 MERGED');
  });

  it('renders the collapsed plan card (done while execute runs) and the verify column with the human badge', async () => {
    await renderCanvas();

    // Plan phase precedes the current execute step → collapsed card is done.
    const plan = screen.getByTestId('swimlane-plan');
    expect(plan).toHaveTextContent('Analyze dependencies');
    expect(screen.getByTestId('step-card-check-analyze-dependencies')).toBeInTheDocument();

    // Verify column — three step cards, human-review keeps the human-gate badge.
    expect(screen.getByTestId('step-card-sprint-verify')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-sprint-review')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-human-review')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-human-badge-human-review')).toBeInTheDocument();

    // Center header strip carries the parallel count.
    expect(screen.getByTestId('swimlane-execute-header')).toHaveTextContent('EXECUTE / PARALLEL ×7');
  });

  it('renders the resolved model on the plan and verify cards when stepModels is supplied', async () => {
    // Regression: a sprint run's outer cards showed `agent ×N` with no model,
    // because SprintSwimlaneCanvas never received the map even though these
    // cards are ordinary phases[].steps that getStepModels already resolves.
    await renderCanvas({
      stepModels: new Map([
        [stepModelKey('plan', 'analyze-dependencies'), { label: 'Opus 5', family: 'opus' as const }],
        [stepModelKey('verify', 'sprint-verify'), { label: 'Sonnet 5', family: 'sonnet' as const }],
      ]),
    });

    expect(screen.getByTestId('swimlane-plan')).toHaveTextContent('Opus 5');
    expect(screen.getByTestId('step-card-model-analyze-dependencies')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-model-dot-analyze-dependencies')).toHaveStyle({
      backgroundColor: MODEL_FAMILY_COLORS.opus,
    });

    expect(screen.getByTestId('step-card-sprint-verify')).toHaveTextContent('Sonnet 5');
    expect(screen.getByTestId('step-card-model-dot-sprint-verify')).toHaveStyle({
      backgroundColor: MODEL_FAMILY_COLORS.sonnet,
    });

    // A step with no entry keeps today's bare row, and the human gate never
    // gets a model segment at all.
    expect(screen.queryByTestId('step-card-model-sprint-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-model-human-review')).not.toBeInTheDocument();
  });

  it('renders exactly today\'s cards when stepModels is omitted', async () => {
    await renderCanvas();
    expect(screen.queryByTestId('step-card-model-analyze-dependencies')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-model-sprint-verify')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Generalized lane strip — derives the per-lane step cards from the active
// fanOut step's inner ids (sprint = byte-identical; non-sprint defs render
// their own inner-chain ids).
// ---------------------------------------------------------------------------

describe('SprintSwimlaneCanvas — generalized fanOut lane strip', () => {
  it('renders the canonical 5 sprint lane step cards for a sprint def (regression)', async () => {
    await renderCanvas();

    // The fixed SPRINT_LANE_STEP_IDS strip survives the generalization unchanged.
    for (const stepId of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(screen.getByTestId(`swimlane-step-t1-${stepId}`)).toBeInTheDocument();
    }
    // No extra/foreign step cards leak in.
    expect(screen.queryByTestId('swimlane-step-t1-deploy')).toBeNull();
  });

  it('derives the lane step strip from a non-sprint fanOut def with 3 inner ids', async () => {
    // A synthetic non-sprint definition whose middle step declares a 3-step
    // fanOut chain — the lane strip must derive those 3 ids, not the sprint 5.
    const fanOutPhaseState: UseWorkflowPhaseStateResult = {
      definition: {
        id: 'custom-fan',
        phases: [
          {
            id: 'plan',
            label: 'Plan',
            color: '#3b6dd6',
            steps: [{ id: 'scope', name: 'Scope', agent: 'planner', mcps: [], retries: 0 }],
          },
          {
            id: 'execute',
            label: 'Execute',
            color: '#c96442',
            steps: [
              {
                id: 'fan-step',
                name: 'Fan step',
                agent: 'executor',
                mcps: [],
                retries: 0,
                fanOut: {
                  over: 'tasks',
                  inner: [
                    { id: 'build', agent: 'builder', name: 'Build' },
                    { id: 'lint', agent: 'linter', name: 'Lint' },
                    { id: 'deploy', agent: 'deployer', optional: true },
                  ],
                },
              },
            ],
          },
          {
            id: 'verify',
            label: 'Verify',
            color: '#2d8a5b',
            steps: [{ id: 'final-review', name: 'Final review', agent: 'reviewer', mcps: [], retries: 0 }],
          },
        ],
      },
      currentStepId: 'fan-step',
      stepStates: [],
      isLoading: false,
      error: null,
    };

    // A single running lane on the second inner step ('lint').
    const customLanes: SprintLaneRow[] = [
      {
        ...baseLane,
        taskId: 'tc1',
        status: 'running',
        currentStepId: 'lint',
        ref: 'TASK-C1',
        title: 'Custom task',
        attempts: 0,
        blockedByRefs: [],
      },
    ];
    lanesQuerySpy.mockResolvedValue(customLanes);

    render(
      <SprintSwimlaneCanvas runId="run-2" phaseState={fanOutPhaseState} sprintStatus="running" />,
    );
    await screen.findByTestId('swimlane-lane-tc1');

    // Exactly the 3 fanOut inner ids render (label = name ?? id).
    expect(screen.getByTestId('swimlane-step-tc1-build')).toHaveTextContent('Build');
    expect(screen.getByTestId('swimlane-step-tc1-lint')).toHaveTextContent('Lint');
    // 'deploy' has no name → falls back to its id as the label.
    expect(screen.getByTestId('swimlane-step-tc1-deploy')).toHaveTextContent('deploy');

    // The sprint vocabulary is absent for a non-sprint def.
    expect(screen.queryByTestId('swimlane-step-tc1-implement')).toBeNull();
    expect(screen.queryByTestId('swimlane-step-tc1-code-review')).toBeNull();

    // Status derivation honors the derived strip order: before-current done,
    // current running, after pending.
    expect(
      screen.getByTestId('swimlane-step-tc1-build').getAttribute('data-status'),
    ).toBe('done');
    expect(
      screen.getByTestId('swimlane-step-tc1-lint').getAttribute('data-status'),
    ).toBe('running');
    expect(
      screen.getByTestId('swimlane-step-tc1-deploy').getAttribute('data-status'),
    ).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Worker cap denominator — derived from the active fanOut step's
// effectiveMaxConcurrency (Phase E: editor UI + swimlane cap display).
// ---------------------------------------------------------------------------

describe('SprintSwimlaneCanvas — worker cap denominator', () => {
  it('falls back to SPRINT_BATCH_CAP when the active fanOut step declares no maxConcurrency', async () => {
    // PHASE_STATE's execute-tasks step carries no fanOut at all.
    await renderCanvas();

    expect(screen.getByTestId('swimlane-summary')).toHaveTextContent('workers 2/5');
  });

  it("uses the active fanOut step's explicit maxConcurrency as the denominator", async () => {
    const cappedPhaseState: UseWorkflowPhaseStateResult = {
      definition: {
        id: 'custom-fan',
        phases: [
          {
            id: 'plan',
            label: 'Plan',
            color: '#3b6dd6',
            steps: [{ id: 'scope', name: 'Scope', agent: 'planner', mcps: [], retries: 0 }],
          },
          {
            id: 'execute',
            label: 'Execute',
            color: '#c96442',
            steps: [
              {
                id: 'fan-step',
                name: 'Fan step',
                agent: 'executor',
                mcps: [],
                retries: 0,
                fanOut: {
                  over: 'tasks',
                  maxConcurrency: 3,
                  inner: [{ id: 'build', agent: 'builder', name: 'Build' }],
                },
              },
            ],
          },
          {
            id: 'verify',
            label: 'Verify',
            color: '#2d8a5b',
            steps: [{ id: 'final-review', name: 'Final review', agent: 'reviewer', mcps: [], retries: 0 }],
          },
        ],
      },
      currentStepId: 'fan-step',
      stepStates: [],
      isLoading: false,
      error: null,
    };

    const customLanes: SprintLaneRow[] = [
      { ...baseLane, taskId: 'tc1', status: 'running', currentStepId: 'build', ref: 'TASK-C1', title: 'Custom 1', attempts: 0, blockedByRefs: [] },
      { ...baseLane, taskId: 'tc2', status: 'running', currentStepId: 'build', ref: 'TASK-C2', title: 'Custom 2', attempts: 0, blockedByRefs: [] },
    ];
    lanesQuerySpy.mockResolvedValue(customLanes);

    render(<SprintSwimlaneCanvas runId="run-3" phaseState={cappedPhaseState} sprintStatus="running" />);
    await screen.findByTestId('swimlane-lane-tc1');

    // Denominator is the step's own cap (3), not the global SPRINT_BATCH_CAP (5).
    expect(screen.getByTestId('swimlane-summary')).toHaveTextContent('workers 2/3');
  });
});

// ---------------------------------------------------------------------------
// F8 — the "Visual check" card is derived from the lane's REAL verification
// outcome, not from lane status (docs/proposals/visual-verification-
// brittleness-fixes.md §F8 / Codex #9). The merge gate integrates a lane on
// passed, low_confidence, skipped AND timeout, so an integrated lane alone says
// nothing about whether a visual check ran.
// ---------------------------------------------------------------------------

describe('SprintSwimlaneCanvas — visual-check state (F8)', () => {
  function integratedLane(
    taskId: string,
    visualVerification: SprintLaneRow['visualVerification'],
  ): SprintLaneRow {
    return {
      ...baseLane,
      taskId,
      status: 'integrated',
      currentStepId: null,
      ref: `TASK-${taskId.toUpperCase()}`,
      title: `Task ${taskId}`,
      attempts: 0,
      blockedByRefs: [],
      visualVerification,
    };
  }

  async function renderLanes(lanes: SprintLaneRow[]): Promise<void> {
    lanesQuerySpy.mockResolvedValue(lanes);
    render(<SprintSwimlaneCanvas runId="run-f8" phaseState={PHASE_STATE} sprintStatus="running" />);
    await screen.findByTestId(`swimlane-lane-${lanes[0].taskId}`);
  }

  const stepTitle = (taskId: string, stepId: string): string | null =>
    screen.getByTestId(`swimlane-step-${taskId}-${stepId}`).getAttribute('title');

  it('paints passed → done, low_confidence → advisory, failed → failed', async () => {
    await renderLanes([
      integratedLane('vp', { status: 'passed', failureClass: null, errorMessage: null, laneAttempt: 1, stale: false }),
      integratedLane('vl', { status: 'low_confidence', failureClass: null, errorMessage: 'judge unsure', laneAttempt: 1, stale: false }),
      integratedLane('vf', { status: 'failed', failureClass: 'deliverable', errorMessage: 'button missing', laneAttempt: 2, stale: false }),
    ]);

    expect(stepStatus('vp', 'visual-verify')).toBe('done');
    expect(stepStatus('vl', 'visual-verify')).toBe('advisory');
    expect(stepStatus('vf', 'visual-verify')).toBe('failed');
  });

  it('paints skipped / timeout / no-row → skipped', async () => {
    await renderLanes([
      integratedLane('vs', { status: 'skipped', failureClass: null, errorMessage: 'no proven runbook', laneAttempt: 0, stale: false }),
      integratedLane('vt', { status: 'timeout', failureClass: 'env', errorMessage: 'deadline exceeded', laneAttempt: 1, stale: false }),
      integratedLane('vn', null),
    ]);

    expect(stepStatus('vs', 'visual-verify')).toBe('skipped');
    expect(stepStatus('vt', 'visual-verify')).toBe('skipped');
    expect(stepStatus('vn', 'visual-verify')).toBe('skipped');
  });

  it('carries the reason (and the failure class) in the hover title', async () => {
    await renderLanes([
      integratedLane('vs', { status: 'skipped', failureClass: null, errorMessage: 'no proven runbook', laneAttempt: 0, stale: false }),
      integratedLane('vt', { status: 'timeout', failureClass: 'env', errorMessage: 'deadline exceeded', laneAttempt: 1, stale: false }),
      integratedLane('vn', null),
      integratedLane('vl', { status: 'low_confidence', failureClass: null, errorMessage: 'judge unsure', laneAttempt: 1, stale: false }),
    ]);

    expect(stepTitle('vs', 'visual-verify')).toContain('no proven runbook');
    expect(stepTitle('vt', 'visual-verify')).toContain('deadline exceeded');
    expect(stepTitle('vt', 'visual-verify')).toContain('env');
    expect(stepTitle('vn', 'visual-verify')).toContain('Visual check did not run');
    expect(stepTitle('vl', 'visual-verify')).toContain('needs human review');
  });

  it('renders a STALE verdict as "did not run", never as this attempt\'s outcome', async () => {
    // Attempt 1 FAILED; the lane looped back and attempt 2's verification was
    // dropped before a request row existed, so the newest attributable row is
    // still attempt 1's FAIL. Painting it red would quote a verdict about a diff
    // that no longer exists.
    await renderLanes([
      integratedLane('vst', {
        status: 'failed',
        failureClass: 'deliverable',
        errorMessage: 'button missing',
        laneAttempt: 1,
        stale: true,
      }),
    ]);

    expect(stepStatus('vst', 'visual-verify')).toBe('skipped');
    expect(stepTitle('vst', 'visual-verify')).toContain('did not run on this attempt');
    expect(stepTitle('vst', 'visual-verify')).toContain('attempt 1');
    expect(stepTitle('vst', 'visual-verify')).not.toContain('button missing');
  });

  it('a STALE pass is not painted done either', async () => {
    await renderLanes([
      integratedLane('vsp', {
        status: 'passed',
        failureClass: null,
        errorMessage: null,
        laneAttempt: 1,
        stale: true,
      }),
    ]);

    expect(stepStatus('vsp', 'visual-verify')).toBe('skipped');
  });

  it('leaves every OTHER step of an integrated lane done', async () => {
    await renderLanes([
      integratedLane('vs', { status: 'skipped', failureClass: null, errorMessage: 'no proven runbook', laneAttempt: 0, stale: false }),
    ]);

    for (const stepId of ['implement', 'write-tests', 'code-review', 'task-verify']) {
      expect(stepStatus('vs', stepId)).toBe('done');
    }
  });

  it('leaves the non-integrated branches untouched (a running lane is unaffected)', async () => {
    await renderLanes([
      {
        ...baseLane,
        taskId: 'vr',
        status: 'running',
        currentStepId: 'code-review',
        ref: 'TASK-VR',
        title: 'Running task',
        attempts: 0,
        blockedByRefs: [],
        // A stale terminal row from a prior attempt must not repaint a live lane.
        visualVerification: { status: 'skipped', failureClass: null, errorMessage: 'stale', laneAttempt: 1, stale: false },
      },
    ]);

    expect(stepStatus('vr', 'code-review')).toBe('running');
    expect(stepStatus('vr', 'visual-verify')).toBe('pending');
    expect(stepTitle('vr', 'visual-verify')).toBeNull();
  });
});

describe('SprintSwimlaneCanvas — systemic pause on an outer step', () => {
  it('renders the collapsed PLAN card as PAUSED when the run is parked on a plan step', async () => {
    await renderCanvas({ pausedStepId: 'analyze-dependencies' });
    const plan = screen.getByTestId('swimlane-plan');
    expect(plan.querySelector('[data-testid="step-card-analyze-dependencies"]')).toHaveTextContent('PAUSED');
  });

  it('renders a SPRINT-REVIEW card as PAUSED when the run is parked on it, leaving the lanes alone', async () => {
    await renderCanvas({ pausedStepId: 'sprint-verify' });
    expect(screen.getByTestId('step-card-sprint-verify')).toHaveTextContent('PAUSED');
    expect(screen.getByTestId('step-card-sprint-review')).toHaveTextContent('PENDING');
  });
});
