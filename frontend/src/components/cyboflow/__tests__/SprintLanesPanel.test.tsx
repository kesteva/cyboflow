/**
 * SprintLanesPanel tests (feat/parallel-sprint, single-run lane model).
 *
 * Behaviors verified:
 *   1. Null runId — renders nothing and calls no tRPC.
 *   2. Empty lane snapshot — renders nothing (non-sprint runs / seed-less sprints).
 *   3. Lane rows render: ref (falling back to taskId), title, status pill, and
 *      the current lane-step label for a RUNNING lane only.
 *   4. A subscription lane-change event updates the matching row in place.
 *   5. Unmount unsubscribes the lane subscription.
 */
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SprintLaneChangedEvent,
  SprintLaneRow,
} from '../../../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Per-file tRPC mock (overrides the setup.ts global stub) — mirrors the
// useWorkflowPhaseState test's bare-spy pattern so onData can be captured.
// vi.hoisted because the static component import below hoists above plain
// consts, which would run the mock factory before the spies initialize.
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
import { SprintLanesPanel } from '../SprintLanesPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LANES: SprintLaneRow[] = [
  {
    batchId: 'batch-1',
    taskId: 'task-uuid-1',
    status: 'running',
    currentStepId: 'write-tests',
    ref: 'TASK-1',
    title: 'Implement the thing',
    updatedAt: '2026-06-11T00:00:00Z',
  },
  {
    // ref/title unresolved (task row missing) — the row falls back to taskId.
    batchId: 'batch-1',
    taskId: 'task-uuid-2',
    status: 'queued',
    currentStepId: null,
    ref: null,
    title: null,
    updatedAt: '2026-06-11T00:00:00Z',
  },
];

/** Capture the subscription onData handler from the first subscribe call. */
function capturedOnData(): (event: SprintLaneChangedEvent) => void {
  const subscribeCallArgs = subscribeSpy.mock.calls[0] as [
    { runId: string },
    { onData: (event: SprintLaneChangedEvent) => void; onError: (err: unknown) => void },
  ];
  return subscribeCallArgs[1].onData;
}

beforeEach(() => {
  vi.clearAllMocks();
  subscribeSpy.mockReturnValue({ unsubscribe: unsubscribeSpy });
  lanesQuerySpy.mockResolvedValue(LANES);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintLanesPanel', () => {
  it('renders nothing and calls no tRPC when runId is null', async () => {
    render(<SprintLanesPanel runId={null} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('sprint-lanes')).toBeNull();
    expect(lanesQuerySpy).not.toHaveBeenCalled();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it('renders nothing when the run has no lanes (empty snapshot)', async () => {
    lanesQuerySpy.mockResolvedValue([]);
    render(<SprintLanesPanel runId="run-1" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('sprint-lanes')).toBeNull();
    // The lifecycle still ran (subscribe-first, then snapshot).
    expect(subscribeSpy).toHaveBeenCalledWith(
      { runId: 'run-1' },
      expect.objectContaining({ onData: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(lanesQuerySpy).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  it('renders one row per lane with ref/title/status pill + running step label', async () => {
    render(<SprintLanesPanel runId="run-1" />);

    const section = await screen.findByTestId('sprint-lanes');
    expect(section).toHaveTextContent('Tasks');

    // Lane 1 — resolved ref + title, running pill, current step label.
    const lane1 = screen.getByTestId('sprint-lane-task-uuid-1');
    expect(lane1).toHaveTextContent('TASK-1');
    expect(lane1).toHaveTextContent('Implement the thing');
    expect(lane1).toHaveTextContent('running');
    expect(lane1).toHaveTextContent('Write tests');

    // Lane 2 — ref/title missing → taskId fallback, queued pill, NO step label.
    const lane2 = screen.getByTestId('sprint-lane-task-uuid-2');
    expect(lane2).toHaveTextContent('task-uuid-2');
    expect(lane2).toHaveTextContent('queued');
    expect(lane2).not.toHaveTextContent('Write tests');
  });

  it('merges a lane-change event from the subscription into the matching row', async () => {
    render(<SprintLanesPanel runId="run-1" />);
    await screen.findByTestId('sprint-lanes');

    // The queued lane's subagent completes its work and commits.
    await act(async () => {
      capturedOnData()({
        runId: 'run-1',
        batchId: 'batch-1',
        taskId: 'task-uuid-2',
        status: 'integrated',
        currentStepId: null,
        timestamp: '2026-06-11T00:01:00Z',
      });
    });

    const lane2 = screen.getByTestId('sprint-lane-task-uuid-2');
    expect(lane2).toHaveTextContent('integrated');
    expect(lane2).not.toHaveTextContent('queued');
    // The other lane is untouched.
    expect(screen.getByTestId('sprint-lane-task-uuid-1')).toHaveTextContent('running');
  });

  it('unsubscribes the lane subscription on unmount', async () => {
    const { unmount } = render(<SprintLanesPanel runId="run-1" />);
    await screen.findByTestId('sprint-lanes');

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });
});
