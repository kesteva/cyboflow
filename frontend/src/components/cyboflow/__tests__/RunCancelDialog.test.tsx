import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tRPC client — the dialog calls trpc.cyboflow.runs.cancel.mutate.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        cancel: { mutate: vi.fn().mockResolvedValue({ success: true }) },
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

import { RunCancelDialog } from '../RunCancelDialog';
import { trpc } from '../../../trpc/client';

const cancelMutate = (trpc.cyboflow.runs as unknown as {
  cancel: { mutate: ReturnType<typeof vi.fn> };
}).cancel.mutate;

beforeEach(() => {
  vi.clearAllMocks();
  cancelMutate.mockResolvedValue({ success: true });
});

describe('RunCancelDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    runId: 'run-cancel-1',
    onSuccess: vi.fn(),
  };

  it('renders nothing when isOpen is false', () => {
    render(<RunCancelDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Cancel this run?')).not.toBeInTheDocument();
  });

  it('renders the git-neutral confirm with title, preserve-worktree copy, and labels', () => {
    render(<RunCancelDialog {...defaultProps} />);
    expect(screen.getByText('Cancel this run?')).toBeInTheDocument();
    // Copy must make clear the session + worktree are preserved (git-neutral).
    expect(screen.getByText(/preserved/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is merged or deleted/)).toBeInTheDocument();
    expect(screen.getByText('Cancel run')).toBeInTheDocument();
    expect(screen.getByText('Keep running')).toBeInTheDocument();
  });

  it('clicking confirm calls runs.cancel with the runId', async () => {
    render(<RunCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel run'));
    });

    expect(cancelMutate).toHaveBeenCalledWith({ runId: 'run-cancel-1' });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('clicking the back button (Keep running) calls onClose without calling the route', () => {
    render(<RunCancelDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Keep running'));

    expect(cancelMutate).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('on { success: true } calls onSuccess and not showError', async () => {
    cancelMutate.mockResolvedValue({ success: true });
    render(<RunCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel run'));
    });

    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('on a benign { noOp } (already-done / lost race) calls onSuccess and NOT showError', async () => {
    // A noOp is a benign already-done/lost-race outcome (e.g. double-click).
    // It must be treated as success-ish — never surfaced as an error.
    cancelMutate.mockResolvedValue({ noOp: true, reason: 'already_terminal' });
    render(<RunCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel run'));
    });

    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('on a rejected promise calls showError and does NOT call onSuccess', async () => {
    cancelMutate.mockRejectedValue(new Error('Network error'));
    render(<RunCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel run'));
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Cancel failed',
      error: 'Network error',
    }));
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });
});
