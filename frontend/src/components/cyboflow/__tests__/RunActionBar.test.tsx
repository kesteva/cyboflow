import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// setActiveRun starts a stream subscription — stub it so the store action is a no-op.
vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

// Mock the tRPC client — the bar calls trpc.cyboflow.runs.pause / .resume.mutate.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        pause: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        resume: { mutate: vi.fn().mockResolvedValue({ delivered: true }) },
      },
    },
  },
}));

const mockShowError = vi.fn();
vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ showError: mockShowError })),
  }),
}));

import { RunActionBar } from '../RunActionBar';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import { trpc } from '../../../trpc/client';

const pauseMutate = (trpc.cyboflow.runs as unknown as {
  pause: { mutate: ReturnType<typeof vi.fn> };
}).pause.mutate;
const resumeMutate = (trpc.cyboflow.runs as unknown as {
  resume: { mutate: ReturnType<typeof vi.fn> };
}).resume.mutate;

const makeActiveRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  workflow_id: 'wf-1',
  project_id: 1,
  status: 'running' as const,
  substrate: 'sdk' as const,
  worktree_path: '/tmp/wt',
  branch_name: 'cyboflow/run-1',
  created_at: '',
  updated_at: '',
  started_at: null,
  ended_at: null,
  stuck_reason: null,
  permission_mode_snapshot: 'default' as const,
  workflowName: 'planner',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  pauseMutate.mockResolvedValue({ success: true });
  resumeMutate.mockResolvedValue({ delivered: true });
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useActiveRunsStore.setState({ runsByProject: {} });
  });
});

afterEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useActiveRunsStore.setState({ runsByProject: {} });
  });
});

describe('RunActionBar', () => {
  const activate = (overrides: Record<string, unknown> = {}) => {
    const run = makeActiveRun(overrides);
    act(() => {
      useActiveRunsStore.setState({ runsByProject: { 1: [run] } });
      useCyboflowStore.getState().setActiveRun(run.id);
    });
    return run;
  };

  it('renders nothing when there is no active run', () => {
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
  });

  it('renders the Cancel button for an active, non-terminal run', () => {
    activate({ status: 'running' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.getByTestId('run-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('run-action-cancel')).toBeInTheDocument();
  });

  it.each(['queued', 'starting', 'running', 'awaiting_review', 'stuck', 'awaiting_input', 'paused'])(
    'shows Cancel for non-terminal status %s',
    (status) => {
      activate({ status });
      render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
      expect(screen.getByTestId('run-action-cancel')).toBeInTheDocument();
    },
  );

  it.each(['failed', 'completed'])(
    'shows the End-workflow gate (not the run controls) for self-terminated status %s',
    (status) => {
      activate({ status });
      render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
      expect(screen.getByTestId('run-action-bar')).toBeInTheDocument();
      expect(screen.getByTestId('run-action-end')).toBeInTheDocument();
      // The git-neutral run controls no longer apply once terminal.
      expect(screen.queryByTestId('run-action-cancel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('run-action-pause')).not.toBeInTheDocument();
      expect(screen.queryByTestId('run-action-resume')).not.toBeInTheDocument();
    },
  );

  it('hides the bar entirely for a canceled run (Cancel returns to rest via its own path)', () => {
    activate({ status: 'canceled' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-action-end')).not.toBeInTheDocument();
  });

  it('clicking End workflow calls onEndWorkflow', () => {
    activate({ status: 'completed' });
    const onEndWorkflow = vi.fn();
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={onEndWorkflow} />);
    fireEvent.click(screen.getByTestId('run-action-end'));
    expect(onEndWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does NOT show the End-workflow gate for a non-terminal run', () => {
    activate({ status: 'running' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.queryByTestId('run-action-end')).not.toBeInTheDocument();
  });

  it('renders nothing when the active run is not present in the store', () => {
    // activeRunId set but no matching row in runsByProject (e.g. legacy run).
    act(() => {
      useActiveRunsStore.setState({ runsByProject: {} });
      useCyboflowStore.getState().setActiveRun('run-missing');
    });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
  });

  it('clicking Cancel calls onCancel', () => {
    activate({ status: 'running' });
    const onCancel = vi.fn();
    render(<RunActionBar onCancel={onCancel} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Pause (SDK-only, Phase 4b)
  // -------------------------------------------------------------------------

  it.each(['running', 'awaiting_review'])(
    'shows an ENABLED Pause for an sdk run in status %s',
    (status) => {
      activate({ status, substrate: 'sdk' });
      render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
      const pause = screen.getByTestId('run-action-pause');
      expect(pause).toBeInTheDocument();
      expect(pause).not.toBeDisabled();
    },
  );

  it.each(['queued', 'starting', 'stuck', 'awaiting_input'])(
    'hides Pause for an sdk run that is not pausable (status %s)',
    (status) => {
      activate({ status, substrate: 'sdk' });
      render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
      expect(screen.queryByTestId('run-action-pause')).not.toBeInTheDocument();
    },
  );

  it('renders Pause DISABLED for an interactive run (SDK-only)', () => {
    activate({ status: 'running', substrate: 'interactive' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    const pause = screen.getByTestId('run-action-pause');
    expect(pause).toBeInTheDocument();
    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute('title', 'Pause/Resume is SDK-only');
  });

  it('clicking a disabled (interactive) Pause does NOT call the pause route', () => {
    activate({ status: 'running', substrate: 'interactive' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-pause'));
    expect(pauseMutate).not.toHaveBeenCalled();
  });

  it('clicking Pause calls runs.pause with the active runId', async () => {
    activate({ status: 'running', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-pause'));
    await waitFor(() => {
      expect(pauseMutate).toHaveBeenCalledWith({ runId: 'run-1' });
    });
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('a benign noOp pause result does NOT surface an error', async () => {
    pauseMutate.mockResolvedValue({ noOp: true, reason: 'not_pausable' });
    activate({ status: 'running', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-pause'));
    await waitFor(() => {
      expect(pauseMutate).toHaveBeenCalled();
    });
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('a rejected pause promise surfaces an error', async () => {
    pauseMutate.mockRejectedValue(new Error('Network error'));
    activate({ status: 'running', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-pause'));
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Pause failed', error: 'Network error' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Resume (SDK-only, Phase 4b)
  // -------------------------------------------------------------------------

  it('shows Resume only for a paused sdk run (and no Pause)', () => {
    activate({ status: 'paused', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    expect(screen.getByTestId('run-action-resume')).toBeInTheDocument();
    expect(screen.queryByTestId('run-action-pause')).not.toBeInTheDocument();
  });

  it.each(['running', 'awaiting_review', 'starting', 'queued', 'stuck'])(
    'hides Resume for non-paused status %s',
    (status) => {
      activate({ status, substrate: 'sdk' });
      render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
      expect(screen.queryByTestId('run-action-resume')).not.toBeInTheDocument();
    },
  );

  it('clicking Resume calls runs.resume with the active runId', async () => {
    activate({ status: 'paused', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-resume'));
    await waitFor(() => {
      expect(resumeMutate).toHaveBeenCalledWith({ runId: 'run-1' });
    });
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('a benign noOp resume result does NOT surface an error', async () => {
    resumeMutate.mockResolvedValue({ noOp: true, reason: 'not_paused' });
    activate({ status: 'paused', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-resume'));
    await waitFor(() => {
      expect(resumeMutate).toHaveBeenCalled();
    });
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('a rejected resume promise surfaces an error', async () => {
    resumeMutate.mockRejectedValue(new Error('boom'));
    activate({ status: 'paused', substrate: 'sdk' });
    render(<RunActionBar onCancel={vi.fn()} onEndWorkflow={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-action-resume'));
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Resume failed', error: 'boom' }),
      );
    });
  });
});
