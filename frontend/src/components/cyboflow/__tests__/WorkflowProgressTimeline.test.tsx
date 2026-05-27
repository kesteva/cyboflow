/**
 * WorkflowProgressTimeline component tests (TASK-768).
 *
 * Behaviors verified:
 *   1. On mount with non-null runId, calls getPhaseState.query once and re-calls on runId change.
 *   2. Opens onStepTransition subscription on mount; tears it down on unmount or runId change.
 *   3. Renders phase headers + step items with state-keyed border colors.
 *   4. Applies 1.4s pulse animation to running step bullet only.
 *   5. Projects log lines (degraded mode — window is null → empty log section).
 *   6. Incoming onStepTransition delta updates state; delta for different runId is ignored.
 *   7. runId=null renders placeholder and issues no tRPC calls.
 */
import '@testing-library/jest-dom';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi so store-level subscription does not attempt real IPC
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// tRPC mock — capture query and subscribe spies
// ---------------------------------------------------------------------------

const mockGetPhaseStateQuery = vi.fn();
const mockUnsubscribe = vi.fn();
const mockSubscribe = vi.fn();

// Captured onData from most recent subscribe call
let capturedOnData: ((evt: unknown) => void) | null = null;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        getPhaseState: {
          query: (...args: Parameters<typeof mockGetPhaseStateQuery>) =>
            mockGetPhaseStateQuery(...args),
        },
        onStepTransition: {
          subscribe: (input: { runId: string }, callbacks: { onData: (evt: unknown) => void; onError: (err: unknown) => void }) => {
            capturedOnData = callbacks.onData;
            mockSubscribe(input, callbacks);
            return { unsubscribe: mockUnsubscribe };
          },
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { WorkflowProgressTimeline } from '../WorkflowProgressTimeline';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import type { WorkflowDefinition, WorkflowStepState } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Helpers — build minimal test fixtures
// ---------------------------------------------------------------------------

function makePhaseState(overrides?: {
  currentStepId?: string | null;
  stepStatuses?: Record<string, WorkflowStepState['status']>;
}): {
  definition: WorkflowDefinition;
  currentStepId: string | null;
  stepStates: WorkflowStepState[];
} {
  const definition: WorkflowDefinition = {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'implement',
            name: 'Implement task',
            agent: 'executor',
            mcps: ['filesystem'],
            retries: 3,
            desc: 'Reads CODE-PATTERNS.md, writes the diff.',
          },
          {
            id: 'write-tests',
            name: 'Write tests',
            agent: 'test-writer',
            mcps: ['filesystem'],
            retries: 1,
            desc: 'Adds unit / integration tests.',
          },
          {
            id: 'task-verify',
            name: 'Task verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash'],
            retries: 3,
            desc: 'Checks acceptance criteria.',
          },
        ],
      },
    ],
  };

  const statuses = overrides?.stepStatuses ?? {};
  const stepStates: WorkflowStepState[] = [
    { stepId: 'implement',   status: statuses['implement']   ?? 'pending' },
    { stepId: 'write-tests', status: statuses['write-tests'] ?? 'pending' },
    { stepId: 'task-verify', status: statuses['task-verify'] ?? 'pending' },
  ];

  return {
    definition,
    currentStepId: overrides?.currentStepId ?? null,
    stepStates,
  };
}

function makeTwoPhaseState(): {
  definition: WorkflowDefinition;
  currentStepId: string | null;
  stepStates: WorkflowStepState[];
} {
  const definition: WorkflowDefinition = {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'implement', name: 'Implement', agent: 'executor', mcps: [], retries: 0 },
          { id: 'write-tests', name: 'Write tests', agent: 'tester', mcps: [], retries: 0 },
        ],
      },
      {
        id: 'verify',
        label: 'Sprint review',
        color: '#a87a2c',
        steps: [
          { id: 'sprint-verify', name: 'Sprint verification', agent: 'verifier', mcps: [], retries: 0 },
          { id: 'human-review', name: 'Human review', agent: 'human', mcps: [], retries: 0 },
        ],
      },
    ],
  };

  return {
    definition,
    currentStepId: null,
    stepStates: [
      { stepId: 'implement', status: 'pending' },
      { stepId: 'write-tests', status: 'pending' },
      { stepId: 'sprint-verify', status: 'pending' },
      { stepId: 'human-review', status: 'pending' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers — hex → rgb conversion for JSDOM style assertions
// ---------------------------------------------------------------------------

/**
 * Convert a 7-char hex color (#rrggbb) to the rgb() string that JSDOM
 * produces when reading back an inline style with that background value.
 */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });

  mockGetPhaseStateQuery.mockClear();
  mockSubscribe.mockClear();
  mockUnsubscribe.mockClear();
  capturedOnData = null;

  // Default: getPhaseState resolves with a simple fixture
  mockGetPhaseStateQuery.mockResolvedValue(makePhaseState());

  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowProgressTimeline', () => {

  // ── AC1: Seed query lifecycle ─────────────────────────────────────────────

  it('calls getPhaseState.query once on mount with { runId }', async () => {
    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      expect(mockGetPhaseStateQuery).toHaveBeenCalledTimes(1);
      expect(mockGetPhaseStateQuery).toHaveBeenCalledWith({ runId: 'run-A' });
    });
  });

  it('calls getPhaseState.query again when runId changes', async () => {
    const { rerender } = render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => expect(mockGetPhaseStateQuery).toHaveBeenCalledTimes(1));

    act(() => {
      rerender(<WorkflowProgressTimeline runId="run-B" />);
    });

    await waitFor(() => {
      expect(mockGetPhaseStateQuery).toHaveBeenCalledTimes(2);
      expect(mockGetPhaseStateQuery).toHaveBeenLastCalledWith({ runId: 'run-B' });
    });
  });

  // ── AC2: Subscription lifecycle ───────────────────────────────────────────

  it('opens onStepTransition subscription on mount with { runId }', async () => {
    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribe.mock.calls[0][0]).toEqual({ runId: 'run-A' });
    });
  });

  it('calls unsubscribe once when unmounted (runId → null)', async () => {
    const { rerender } = render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => expect(mockSubscribe).toHaveBeenCalledTimes(1));

    act(() => {
      rerender(<WorkflowProgressTimeline runId={null} />);
    });

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    // No new subscription should be opened when runId is null
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and resubscribes when runId changes to a new value', async () => {
    const { rerender } = render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => expect(mockSubscribe).toHaveBeenCalledTimes(1));

    act(() => {
      rerender(<WorkflowProgressTimeline runId="run-B" />);
    });

    await waitFor(() => {
      // Unsubscribe from run-A subscription
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
      // New subscription for run-B
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
      expect(mockSubscribe.mock.calls[1][0]).toEqual({ runId: 'run-B' });
    });
  });

  // ── AC3: State-keyed border colors ────────────────────────────────────────

  it('renders done step with border-status-success border class', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      const doneItem = screen.getByTestId('step-item-implement');
      expect(doneItem.className).toContain('border-status-success');
    });
  });

  it('renders running step with border-status-error border class (fallback — status-running absent)', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      const runningItem = screen.getByTestId('step-item-write-tests');
      expect(runningItem.className).toContain('border-status-error');
    });
  });

  it('renders pending step with border-border-primary border class', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      const pendingItem = screen.getByTestId('step-item-task-verify');
      expect(pendingItem.className).toContain('border-border-primary');
    });
  });

  // ── AC4: Pulse animation on running bullet only ───────────────────────────

  it("applies 1.4s infinite pulse animation to running step's bullet", async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      const runningBullet = screen.getByTestId('step-bullet-write-tests');
      expect(runningBullet.style.animation).toContain('1.4s');
      expect(runningBullet.style.animation).toContain('infinite');
    });
  });

  it('does NOT apply pulse animation to done or pending step bullets', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      // done bullet
      const doneBullet = screen.getByTestId('step-bullet-implement');
      expect(doneBullet.style.animation ?? '').toBe('');

      // pending bullet
      const pendingBullet = screen.getByTestId('step-bullet-task-verify');
      expect(pendingBullet.style.animation ?? '').toBe('');
    });
  });

  // ── AC5: Log lines — degraded mode (window is null → no log lines) ────────

  it('renders no log lines for non-pending steps when time-window is unavailable (degraded mode)', async () => {
    // In v1 degraded mode, getStepTimeWindow always returns null — no log lines rendered.
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      // The step items should render without any log-line children (testid pattern log-line-*)
      // done step: no log lines despite status !== pending
      const allLogLines = document.querySelectorAll('[data-testid^="log-line-implement"]');
      expect(allLogLines.length).toBe(0);

      const runningLogLines = document.querySelectorAll('[data-testid^="log-line-write-tests"]');
      expect(runningLogLines.length).toBe(0);
    });
  });

  // ── AC6: onStepTransition delta updates step state ────────────────────────

  it('updates step border to running when onStepTransition fires for active runId', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'pending', 'write-tests': 'pending', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    // Wait for initial render with pending states
    await waitFor(() => {
      expect(screen.getByTestId('step-item-implement').className).toContain('border-border-primary');
    });

    // Fire a step transition event for the active runId
    act(() => {
      capturedOnData?.({
        runId: 'run-A',
        stepId: 'implement',
        status: 'running',
        timestamp: new Date().toISOString(),
      });
    });

    // implement should now show running border
    await waitFor(() => {
      const item = screen.getByTestId('step-item-implement');
      expect(item.className).toContain('border-status-error'); // fallback for running
    });
  });

  it('ignores onStepTransition delta for a different runId', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(
      makePhaseState({ stepStatuses: { implement: 'pending', 'write-tests': 'pending', 'task-verify': 'pending' } }),
    );

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      expect(screen.getByTestId('step-item-implement').className).toContain('border-border-primary');
    });

    // Fire event for a DIFFERENT runId — should be ignored
    act(() => {
      capturedOnData?.({
        runId: 'run-DIFFERENT',
        stepId: 'implement',
        status: 'running',
        timestamp: new Date().toISOString(),
      });
    });

    // implement should still be pending
    await waitFor(() => {
      const item = screen.getByTestId('step-item-implement');
      expect(item.className).toContain('border-border-primary');
      expect(item.className).not.toContain('border-status-error');
    });
  });

  // ── AC7: runId=null renders placeholder, no tRPC calls ───────────────────

  it('renders "No active run" placeholder when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} />);

    expect(screen.getByTestId('workflow-progress-timeline-empty')).toBeInTheDocument();
    expect(screen.getByText('No active run')).toBeInTheDocument();
  });

  it('does not call getPhaseState.query when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} />);

    expect(mockGetPhaseStateQuery).not.toHaveBeenCalled();
  });

  it('does not open onStepTransition subscription when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} />);

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  // ── AC6 (phase headers): phase headers render with swatch + label + count ─

  it('renders phase headers with swatch background matching phase color, label text, and step count', async () => {
    mockGetPhaseStateQuery.mockResolvedValue(makeTwoPhaseState());

    render(<WorkflowProgressTimeline runId="run-A" />);

    await waitFor(() => {
      // Phase 'execute' header
      const execHeader = screen.getByTestId('phase-header-execute');
      expect(execHeader).toBeInTheDocument();

      const execSwatch = screen.getByTestId('phase-swatch-execute');
      // JSDOM normalizes hex to rgb() in style reads — compare against converted value
      expect(execSwatch.style.background).toBe(hexToRgb('#c96442'));

      // Phase label
      expect(screen.getByText('Execute')).toBeInTheDocument();
      // Step count — 2 steps in execute phase (both phases have 2, use getAllByText)
      const stepCounts = screen.getAllByText('2 steps');
      expect(stepCounts.length).toBeGreaterThanOrEqual(1);

      // Phase 'verify' header
      const verifyHeader = screen.getByTestId('phase-header-verify');
      expect(verifyHeader).toBeInTheDocument();

      const verifySwatch = screen.getByTestId('phase-swatch-verify');
      // JSDOM normalizes hex to rgb() in style reads — compare against converted value
      expect(verifySwatch.style.background).toBe(hexToRgb('#a87a2c'));

      expect(screen.getByText('Sprint review')).toBeInTheDocument();
      // Both phases have 2 steps — 2 step-count spans should be present
      expect(screen.getAllByText('2 steps').length).toBe(2);
    });
  });
});
