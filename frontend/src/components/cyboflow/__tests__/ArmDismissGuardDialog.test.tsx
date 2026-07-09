import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tRPC client — the dialog calls trpc.cyboflow.experiments.abandon.mutate.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        abandon: {
          mutate: vi
            .fn()
            .mockResolvedValue({ experimentId: 'exp-1', status: 'abandoned', winnerRunId: null }),
        },
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

import { ArmDismissGuardDialog } from '../ArmDismissGuardDialog';
import { trpc } from '../../../trpc/client';

const abandonMutate = (trpc.cyboflow.experiments as unknown as {
  abandon: { mutate: ReturnType<typeof vi.fn> };
}).abandon.mutate;

beforeEach(() => {
  vi.clearAllMocks();
  abandonMutate.mockResolvedValue({ experimentId: 'exp-1', status: 'abandoned', winnerRunId: null });
});

describe('ArmDismissGuardDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    experimentId: 'exp-1',
    arm: 'A' as const,
    status: 'running' as const,
    onDismissArm: vi.fn(),
  };

  it('renders nothing when isOpen is false', () => {
    render(<ArmDismissGuardDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText(/A\/B experiment/)).not.toBeInTheDocument();
  });

  it('renders the arm letter and all three actions for a running experiment', () => {
    render(<ArmDismissGuardDialog {...defaultProps} />);
    expect(
      screen.getByText('This session is arm A of a running A/B experiment'),
    ).toBeInTheDocument();
    expect(screen.getByText('Cancel whole experiment')).toBeInTheDocument();
    expect(screen.getByText('Dismiss only this arm')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });

  it('uses "awaiting its verdict" copy for a grading experiment and arm B', () => {
    render(<ArmDismissGuardDialog {...defaultProps} arm="B" status="grading" />);
    expect(
      screen.getByText('This session is arm B of an A/B experiment awaiting its verdict'),
    ).toBeInTheDocument();
  });

  it('renders the optional enriched experiment name when provided', () => {
    render(<ArmDismissGuardDialog {...defaultProps} experimentName="sprint A/B · fast-mode" />);
    expect(screen.getByText('sprint A/B · fast-mode')).toBeInTheDocument();
  });

  it('"Cancel whole experiment" calls experiments.abandon with the id and NOT the dismiss path', async () => {
    render(<ArmDismissGuardDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel whole experiment'));
    });

    expect(abandonMutate).toHaveBeenCalledWith({ experimentId: 'exp-1' });
    // abandon dismisses both sessions server-side — the normal per-arm dismiss
    // continuation must NOT run.
    expect(defaultProps.onDismissArm).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('"Dismiss only this arm" invokes the original dismiss continuation and NOT abandon', () => {
    render(<ArmDismissGuardDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Dismiss only this arm'));

    expect(defaultProps.onDismissArm).toHaveBeenCalledTimes(1);
    expect(abandonMutate).not.toHaveBeenCalled();
  });

  it('"Keep" closes without abandoning or dismissing', () => {
    render(<ArmDismissGuardDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Keep'));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    expect(abandonMutate).not.toHaveBeenCalled();
    expect(defaultProps.onDismissArm).not.toHaveBeenCalled();
  });

  it('surfaces showError and stays open when abandon rejects', async () => {
    abandonMutate.mockRejectedValue(new Error('Network error'));
    render(<ArmDismissGuardDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel whole experiment'));
    });

    expect(mockShowError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cancel experiment failed', error: 'Network error' }),
    );
    expect(defaultProps.onClose).not.toHaveBeenCalled();
    expect(defaultProps.onDismissArm).not.toHaveBeenCalled();
  });
});
