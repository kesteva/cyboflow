/**
 * SprintSwimlaneCanvas tests (feat/parallel-sprint swim-lane canvas).
 *
 * Behaviors verified:
 *   1. Per-step derivation — integrated lane: all five steps done; running
 *      lane: before current done / current running / after pending; failed
 *      lane: current step failed; queued lane: all pending.
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
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SprintLaneRow } from '../../../../../shared/types/sprintBatch';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';

// ---------------------------------------------------------------------------
// Per-file tRPC mock (overrides the setup.ts global stub) — mirrors
// SprintLanesPanel.test.tsx's bare-spy pattern.
// ---------------------------------------------------------------------------

const { unsubscribeSpy, subscribeSpy, lanesQuerySpy } = vi.hoisted(() => ({
  unsubscribeSpy: vi.fn(),
  subscribeSpy: vi.fn(),
  lanesQuerySpy: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        sprintLanes: { query: lanesQuerySpy },
        onSprintLaneChanged: { subscribe: subscribeSpy },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import { SprintSwimlaneCanvas } from '../SprintSwimlaneCanvas';

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

async function renderCanvas() {
  render(
    <SprintSwimlaneCanvas runId="run-1" phaseState={PHASE_STATE} sprintStatus="running" />,
  );
  // Wait for the lane snapshot to land.
  await screen.findByTestId('swimlane-lane-t1');
}

const stepStatus = (taskId: string, stepId: string): string | null =>
  screen.getByTestId(`swimlane-step-${taskId}-${stepId}`).getAttribute('data-status');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintSwimlaneCanvas — per-step derivation', () => {
  it('marks all five steps done for an integrated lane', async () => {
    await renderCanvas();

    for (const stepId of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(stepStatus('t1', stepId)).toBe('done');
    }
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
