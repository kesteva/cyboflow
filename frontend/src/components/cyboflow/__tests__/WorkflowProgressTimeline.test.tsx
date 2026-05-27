/**
 * WorkflowProgressTimeline component tests (TASK-781 retrofit).
 *
 * Behaviors verified:
 *   1. Hook receives runId on every render; changing the prop forwards the new runId.
 *   2. Renders phase headers + step items with state-keyed border colors.
 *   3. Applies 1.4s pulse animation to running step bullet only.
 *   4. Projects log lines (degraded mode — window is null → empty log section).
 *   5. Delta-driven re-render: changing the hook return shape causes border updates.
 *   6. runId=null renders placeholder, no hook phase-state consumed.
 *   7. isLoading → 'Loading workflow state…' placeholder.
 *   8. error !== null → 'Failed to load workflow state: <message>' placeholder.
 *   9. definition === null (not loading, no error) → 'No workflow data' placeholder.
 */
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
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
// Mock useWorkflowPhaseState — component imports this hook for all phase state
// ---------------------------------------------------------------------------

import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';

const makeDefaultHookReturn = (): UseWorkflowPhaseStateResult => ({
  definition: null,
  currentStepId: null,
  stepStates: [],
  isLoading: false,
  error: null,
});

let mockHookReturn: UseWorkflowPhaseStateResult = makeDefaultHookReturn();
const useWorkflowPhaseStateMock = vi.fn((_runId: string | null) => mockHookReturn);

vi.mock('../../../hooks/useWorkflowPhaseState', () => ({
  useWorkflowPhaseState: (...args: Parameters<typeof useWorkflowPhaseStateMock>) =>
    useWorkflowPhaseStateMock(...args),
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
}): UseWorkflowPhaseStateResult {
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
    isLoading: false,
    error: null,
  };
}

function makeTwoPhaseState(): UseWorkflowPhaseStateResult {
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
    isLoading: false,
    error: null,
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

  mockHookReturn = makeDefaultHookReturn();
  useWorkflowPhaseStateMock.mockClear();

  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowProgressTimeline', () => {

  // ── AC1: Hook receives runId ──────────────────────────────────────────────

  it('passes runId to useWorkflowPhaseState on mount', () => {
    mockHookReturn = makePhaseState();
    render(<WorkflowProgressTimeline runId="run-A" />);

    expect(useWorkflowPhaseStateMock).toHaveBeenCalledWith('run-A');
  });

  it('forwards the new runId to the hook when the prop changes', () => {
    mockHookReturn = makePhaseState();
    const { rerender } = render(<WorkflowProgressTimeline runId="run-A" />);

    mockHookReturn = makePhaseState();
    act(() => {
      rerender(<WorkflowProgressTimeline runId="run-B" />);
    });

    expect(useWorkflowPhaseStateMock).toHaveBeenLastCalledWith('run-B');
  });

  // ── AC2: State-keyed border colors ────────────────────────────────────────

  it('renders done step with border-status-success border class', () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    const doneItem = screen.getByTestId('step-item-implement');
    expect(doneItem.className).toContain('border-status-success');
  });

  it('renders running step with border-status-error border class (fallback — status-running absent)', () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    const runningItem = screen.getByTestId('step-item-write-tests');
    expect(runningItem.className).toContain('border-status-error');
  });

  it('renders pending step with border-border-primary border class', () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    const pendingItem = screen.getByTestId('step-item-task-verify');
    expect(pendingItem.className).toContain('border-border-primary');
  });

  // ── AC3: Pulse animation on running bullet only ───────────────────────────

  it("applies 1.4s infinite pulse animation to running step's bullet", () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    const runningBullet = screen.getByTestId('step-bullet-write-tests');
    expect(runningBullet.style.animation).toContain('1.4s');
    expect(runningBullet.style.animation).toContain('infinite');
  });

  it('does NOT apply pulse animation to done or pending step bullets', () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    // done bullet
    const doneBullet = screen.getByTestId('step-bullet-implement');
    expect(doneBullet.style.animation ?? '').toBe('');

    // pending bullet
    const pendingBullet = screen.getByTestId('step-bullet-task-verify');
    expect(pendingBullet.style.animation ?? '').toBe('');
  });

  // ── AC4: Log lines — degraded mode (window is null → no log lines) ────────

  it('renders no log lines for non-pending steps when time-window is unavailable (degraded mode)', () => {
    // In v1 degraded mode, getStepTimeWindow always returns null — no log lines rendered.
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" />);

    // done step: no log lines despite status !== pending
    const allLogLines = document.querySelectorAll('[data-testid^="log-line-implement"]');
    expect(allLogLines.length).toBe(0);

    const runningLogLines = document.querySelectorAll('[data-testid^="log-line-write-tests"]');
    expect(runningLogLines.length).toBe(0);
  });

  // ── AC5: Delta-driven re-render ───────────────────────────────────────────

  it('updates step border when hook returns updated step states on rerender', () => {
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'pending', 'write-tests': 'pending', 'task-verify': 'pending' },
    });

    const { rerender } = render(<WorkflowProgressTimeline runId="run-A" />);

    expect(screen.getByTestId('step-item-implement').className).toContain('border-border-primary');

    // Simulate delta arrival: hook now returns updated state
    mockHookReturn = makePhaseState({
      stepStatuses: { implement: 'running', 'write-tests': 'pending', 'task-verify': 'pending' },
    });

    act(() => {
      rerender(<WorkflowProgressTimeline runId="run-A" />);
    });

    expect(screen.getByTestId('step-item-implement').className).toContain('border-status-error');
  });

  // ── AC6: runId=null renders placeholder ──────────────────────────────────

  it('renders "No active run" placeholder when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} />);

    expect(screen.getByTestId('workflow-progress-timeline-empty')).toBeInTheDocument();
    expect(screen.getByText('No active run')).toBeInTheDocument();
  });

  it('passes null to the hook when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} />);

    expect(useWorkflowPhaseStateMock).toHaveBeenCalledWith(null);
  });

  // ── AC7: isLoading placeholder ────────────────────────────────────────────

  it('renders "Loading workflow state…" placeholder when hook returns isLoading=true', () => {
    mockHookReturn = { ...makeDefaultHookReturn(), isLoading: true };

    render(<WorkflowProgressTimeline runId="run-A" />);

    expect(screen.getByText('Loading workflow state…')).toBeInTheDocument();
  });

  // ── AC8: error placeholder ────────────────────────────────────────────────

  it('renders "Failed to load workflow state:" placeholder when hook returns a non-null error', () => {
    mockHookReturn = {
      ...makeDefaultHookReturn(),
      error: new Error('network timeout'),
    };

    render(<WorkflowProgressTimeline runId="run-A" />);

    expect(screen.getByText(/Failed to load workflow state:.*network timeout/)).toBeInTheDocument();
  });

  // ── AC9: null definition (not loading, no error) ──────────────────────────

  it('renders "No workflow data" when hook returns null definition with no loading and no error', () => {
    mockHookReturn = makeDefaultHookReturn(); // definition=null, isLoading=false, error=null

    render(<WorkflowProgressTimeline runId="run-A" />);

    expect(screen.getByText('No workflow data')).toBeInTheDocument();
  });

  // ── Phase headers ─────────────────────────────────────────────────────────

  it('renders phase headers with swatch background matching phase color, label text, and step count', () => {
    mockHookReturn = makeTwoPhaseState();

    render(<WorkflowProgressTimeline runId="run-A" />);

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
