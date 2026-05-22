/**
 * CyboflowRoot component tests (TASK-688).
 *
 * Behaviors verified:
 *   1. Renders "Choose a workflow to start" empty state when activeRunId is null.
 *   2. Renders RunView when activeRunId is set and hides the empty-state CTA.
 *   3. Opening and closing the workflow picker modal toggles its visibility.
 *   4. Modal closes automatically after a successful run start (onWorkflowStarted fires).
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — same pattern as RunView.test.tsx
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    listWorkflows: vi.fn().mockResolvedValue([
      { id: 'wf-1', name: 'soloflow' },
      { id: 'wf-2', name: 'planner' },
    ]),
    startRun: vi.fn().mockResolvedValue({
      runId: 'run-test-001',
      worktreePath: '/tmp/wt',
      branchName: 'run/run-test-001',
    }),
    approveRun: vi.fn(),
  },
}));

// Mock API.sessions so getOrCreateMainRepoSession returns data:null, keeping mainRepoSessionId null.
// This means the new {mainRepoSessionId && …} panel surface block does NOT render, and
// the four existing assertions about empty-state CTA / RunView / modal toggling pass unchanged.
vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      getOrCreateMainRepoSession: vi.fn().mockResolvedValue({ success: true, data: null }),
    },
  },
}));

// Mock panelApi so the loadPanelsForSession call (gated on mainRepoSessionId) does not
// cause errors if it somehow fires, and to silence unhandled-promise warnings.
vi.mock('../../../services/panelApi', () => ({
  panelApi: {
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    createPanel: vi.fn(),
    deletePanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { CyboflowRoot } from '../CyboflowRoot';
import { useCyboflowStore } from '../../../stores/cyboflowStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw when RunView is mounted inside CyboflowRoot.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CyboflowRoot', () => {
  it('renders Choose a workflow to start empty state when activeRunId is null', () => {
    render(<CyboflowRoot projectId={1} />);
    expect(screen.getByText('Choose a workflow to start')).toBeInTheDocument();
    // CTA button is also present
    expect(screen.getByRole('button', { name: 'Choose a workflow' })).toBeInTheDocument();
  });

  it('renders RunView when activeRunId is set and hides the empty-state CTA', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-999');
    });
    render(<CyboflowRoot projectId={1} />);

    // RunView renders the active run ID
    expect(screen.getByText('run-abc-999')).toBeInTheDocument();
    // Empty-state CTA text is gone
    expect(screen.queryByText('Choose a workflow to start')).not.toBeInTheDocument();
  });

  it('opening and closing the workflow picker modal toggles its visibility', async () => {
    render(<CyboflowRoot projectId={1} />);

    // Modal not visible initially (WorkflowPicker select is not in the DOM)
    expect(screen.queryByLabelText('Select workflow')).not.toBeInTheDocument();

    // Open via the empty-state CTA button
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));

    // WorkflowPicker is now rendered inside the modal
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Close via the modal close button (aria-label="Close modal")
    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('modal closes automatically after a successful run start', async () => {
    const { cyboflowApi } = await import('../../../utils/cyboflowApi');
    vi.mocked(cyboflowApi.startRun).mockResolvedValue({
      runId: 'run-auto-close',
      worktreePath: '/tmp/wt-auto',
      branchName: 'run/run-auto-close',
    });

    render(<CyboflowRoot projectId={1} />);

    // Open the picker modal via the CTA
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));

    // Wait for the dialog and the Start Run button within WorkflowPicker
    const startRunBtn = await screen.findByRole('button', { name: 'Start Run' });

    // Click Start Run
    await act(async () => {
      fireEvent.click(startRunBtn);
    });

    // Modal should close automatically (onWorkflowStarted fires setIsPickerOpen(false))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // RunView should now be rendered (activeRunId was set by the store)
    expect(screen.getByText('run-auto-close')).toBeInTheDocument();
  });
});
