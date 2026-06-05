import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// setActiveRun starts a stream subscription — stub it so the store action is a no-op.
vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

import { RunActionBar } from '../RunActionBar';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';

const makeActiveRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  workflow_id: 'wf-1',
  project_id: 1,
  status: 'running' as const,
  worktree_path: '/tmp/wt',
  branch_name: 'cyboflow/run-1',
  created_at: '',
  updated_at: '',
  started_at: null,
  ended_at: null,
  stuck_reason: null,
  workflowName: 'planner',
  ...overrides,
});

beforeEach(() => {
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
    render(<RunActionBar onCancel={vi.fn()} />);
    expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
  });

  it('renders the Cancel button for an active, non-terminal run', () => {
    activate({ status: 'running' });
    render(<RunActionBar onCancel={vi.fn()} />);
    expect(screen.getByTestId('run-action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('run-action-cancel')).toBeInTheDocument();
  });

  it.each(['queued', 'starting', 'running', 'awaiting_review', 'stuck', 'awaiting_input'])(
    'shows Cancel for non-terminal status %s',
    (status) => {
      activate({ status });
      render(<RunActionBar onCancel={vi.fn()} />);
      expect(screen.getByTestId('run-action-cancel')).toBeInTheDocument();
    },
  );

  it.each(['canceled', 'failed', 'completed'])(
    'hides the bar for terminal status %s',
    (status) => {
      activate({ status });
      render(<RunActionBar onCancel={vi.fn()} />);
      expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
    },
  );

  it('renders nothing when the active run is not present in the store', () => {
    // activeRunId set but no matching row in runsByProject (e.g. legacy run).
    act(() => {
      useActiveRunsStore.setState({ runsByProject: {} });
      useCyboflowStore.getState().setActiveRun('run-missing');
    });
    render(<RunActionBar onCancel={vi.fn()} />);
    expect(screen.queryByTestId('run-action-bar')).not.toBeInTheDocument();
  });

  it('clicking Cancel calls onCancel', () => {
    activate({ status: 'running' });
    const onCancel = vi.fn();
    render(<RunActionBar onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('run-action-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
