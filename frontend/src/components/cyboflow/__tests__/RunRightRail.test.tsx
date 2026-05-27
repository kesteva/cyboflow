/**
 * RunRightRail component tests (TASK-767, TASK-780).
 *
 * Behaviors verified:
 *   1. Renders three tabs (Workflow Progress / File Explorer / Diff);
 *      Workflow Progress is default selected; shows empty-state when activeRunId is null.
 *   2. Clicking File Explorer shows its placeholder and hides the Workflow Progress panel.
 *   3. Clicking Diff shows its placeholder and hides the other two.
 *   4. Mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set.
 *   5. Shows empty state in workflow-progress tab when activeRunId is null.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — WorkflowProgressTimeline calls subscribeToStreamEvents
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// tRPC mock — WorkflowProgressTimeline calls getPhaseState.query and
// onStepTransition.subscribe.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        list: { query: vi.fn().mockResolvedValue([]) },
        getPhaseState: {
          query: vi.fn().mockResolvedValue({
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
          }),
        },
        onStepTransition: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
      },
      workflows: {
        list: { query: vi.fn().mockResolvedValue([]) },
      },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        setBadgeCount: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      },
      approvals: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
      },
    },
  },
}));

// Import after mocks
import { RunRightRail } from '../RunRightRail';
import { useCyboflowStore } from '../../../stores/cyboflowStore';

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
    render(<RunRightRail />);

    // All three tabs are present
    const wpTab = screen.getByRole('tab', { name: 'Workflow Progress' });
    const feTab = screen.getByRole('tab', { name: 'File Explorer' });
    const diffTab = screen.getByRole('tab', { name: 'Diff' });

    expect(wpTab).toBeInTheDocument();
    expect(feTab).toBeInTheDocument();
    expect(diffTab).toBeInTheDocument();

    // Workflow Progress is selected; others are not
    expect(wpTab.getAttribute('aria-selected')).toBe('true');
    expect(feTab.getAttribute('aria-selected')).toBe('false');
    expect(diffTab.getAttribute('aria-selected')).toBe('false');

    // No activeRunId → empty state shown (not the old placeholder)
    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-workflow-progress-placeholder')).not.toBeInTheDocument();

    // Root has required layout classes
    const root = screen.getByTestId('run-right-rail');
    expect(root).toHaveClass('w-[296px]');
    expect(root).toHaveClass('shrink-0');
    expect(root).toHaveClass('border-l');
  });

  it('clicking File Explorer tab shows its placeholder and hides the Workflow Progress panel', () => {
    render(<RunRightRail />);

    // Default: Workflow Progress empty-state visible
    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();

    // Click File Explorer
    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));

    // File Explorer placeholder is now visible
    expect(screen.getByTestId('run-right-rail-file-explorer-placeholder')).toBeInTheDocument();

    // Workflow Progress panel is gone
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();

    // aria-selected reflects new selection
    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
  });

  it('clicking Diff tab shows its placeholder and hides the other two placeholders', () => {
    render(<RunRightRail />);

    // Click Diff
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    // Diff placeholder is visible
    expect(screen.getByTestId('run-right-rail-diff-placeholder')).toBeInTheDocument();

    // Other two panels are gone
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-file-explorer-placeholder')).not.toBeInTheDocument();

    // aria-selected reflects new selection
    expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('false');
  });

  it('shows empty state in workflow-progress tab when activeRunId is null', () => {
    // activeRunId is null (cleared in beforeEach)
    render(<RunRightRail />);

    expect(screen.getByTestId('run-right-rail-workflow-progress-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-workflow-progress-placeholder')).not.toBeInTheDocument();
  });

  it('mounts WorkflowProgressTimeline in the workflow-progress tab when activeRunId is set', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-test-rail-001');
    });

    render(<RunRightRail />);

    // The empty state should not be shown
    expect(screen.queryByTestId('run-right-rail-workflow-progress-empty')).not.toBeInTheDocument();

    // WorkflowProgressTimeline mounts; it starts loading and eventually shows phase-section
    // after the seed query resolves. In this test environment (synchronous mock promises),
    // we wait for the phase section to appear.
    // The timeline renders while loading; the phase section appears after promise resolves.
    // Wait for the phase section to appear
    await screen.findByTestId('phase-section-phase-1');
  });
});
