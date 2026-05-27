/**
 * RunRightRail component tests (TASK-767, TASK-780, TASK-783).
 *
 * After TASK-783, RunRightRail accepts phaseState as a required prop and forwards
 * it to WorkflowProgressTimeline.  Tests pass EMPTY_PHASE_STATE or LOADED_PHASE_STATE
 * fixtures directly — no tRPC mock needed.
 *
 * Behaviors verified:
 *   1. Renders three tabs (Workflow Progress / File Explorer / Diff);
 *      Workflow Progress is default selected; shows empty-state when activeRunId is null.
 *   2. Clicking File Explorer shows its placeholder and hides the Workflow Progress panel.
 *   3. Clicking Diff shows its placeholder and hides the other two.
 *   4. Mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set
 *      (timeline renders phase sections from the phaseState prop).
 *   5. Shows empty state in workflow-progress tab when activeRunId is null.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — WorkflowProgressTimeline reads streamEvents from the store
// which is seeded via subscribeToStreamEvents.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Import after mocks
import { RunRightRail } from '../RunRightRail';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';

// ---------------------------------------------------------------------------
// Phase state fixtures
// ---------------------------------------------------------------------------

const EMPTY_PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: null,
  currentStepId: null,
  stepStates: [],
  isLoading: false,
  error: null,
};

const LOADED_PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: {
    id: 'sprint',
    phases: [
      {
        id: 'phase-1',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
        ],
      },
    ],
  },
  currentStepId: 'step-a',
  stepStates: [{ stepId: 'step-a', status: 'running' }],
  isLoading: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunRightRail', () => {
  it('renders three tabs; Workflow Progress is selected by default and shows empty state when no activeRunId', () => {
    render(<RunRightRail phaseState={EMPTY_PHASE_STATE} />);

    const wpTab = screen.getByRole('tab', { name: 'Workflow Progress' });
    const feTab = screen.getByRole('tab', { name: 'File Explorer' });
    const diffTab = screen.getByRole('tab', { name: 'Diff' });

    expect(wpTab).toBeInTheDocument();
    expect(feTab).toBeInTheDocument();
    expect(diffTab).toBeInTheDocument();

    expect(wpTab.getAttribute('aria-selected')).toBe('true');
    expect(feTab.getAttribute('aria-selected')).toBe('false');
    expect(diffTab.getAttribute('aria-selected')).toBe('false');

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();

    const root = screen.getByTestId('run-right-rail');
    expect(root).toHaveClass('w-[296px]');
    expect(root).toHaveClass('shrink-0');
    expect(root).toHaveClass('border-l');
  });

  it('clicking File Explorer tab shows its placeholder and hides the Workflow Progress panel', () => {
    render(<RunRightRail phaseState={EMPTY_PHASE_STATE} />);

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));

    expect(screen.getByTestId('run-right-rail-file-explorer-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
  });

  it('clicking Diff tab shows its placeholder and hides the other two placeholders', () => {
    render(<RunRightRail phaseState={EMPTY_PHASE_STATE} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    expect(screen.getByTestId('run-right-rail-diff-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-file-explorer-placeholder')).not.toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows empty state in workflow-progress tab when activeRunId is null', () => {
    render(<RunRightRail phaseState={EMPTY_PHASE_STATE} />);

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();
  });

  it('mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-test-rail-001');
    });

    render(<RunRightRail phaseState={LOADED_PHASE_STATE} />);

    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('phase-section-phase-1')).toBeInTheDocument();
  });
});
