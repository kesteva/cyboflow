import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tRPC client — the dialog calls trpc.cyboflow.experiments.abandon.mutate.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        abandon: { mutate: vi.fn().mockResolvedValue({ status: 'abandoned', winnerRunId: null }) },
      },
    },
  },
}));

import { ExperimentCancelDialog } from '../ExperimentCancelDialog';
import { trpc } from '../../../trpc/client';

const abandonMutate = (trpc.cyboflow.experiments as unknown as {
  abandon: { mutate: ReturnType<typeof vi.fn> };
}).abandon.mutate;

beforeEach(() => {
  vi.clearAllMocks();
  abandonMutate.mockResolvedValue({ status: 'abandoned', winnerRunId: null });
});

describe('ExperimentCancelDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    experimentId: 'exp-cancel-1',
    experimentName: 'sprint A/B · terse-prompts',
    onSuccess: vi.fn(),
  };

  it('renders nothing when isOpen is false', () => {
    render(<ExperimentCancelDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Cancel this experiment?')).not.toBeInTheDocument();
  });

  it('renders the confirm with the experiment name and destructive copy', () => {
    render(<ExperimentCancelDialog {...defaultProps} />);
    expect(screen.getByText('Cancel this experiment?')).toBeInTheDocument();
    expect(screen.getByText(/sprint A\/B · terse-prompts/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is merged or kept/)).toBeInTheDocument();
    expect(screen.getByText('Cancel experiment')).toBeInTheDocument();
    expect(screen.getByText('Keep running')).toBeInTheDocument();
  });

  it('clicking confirm calls abandon with the experiment id, then onSuccess + onClose', async () => {
    render(<ExperimentCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel experiment'));
    });

    expect(abandonMutate).toHaveBeenCalledWith({ experimentId: 'exp-cancel-1' });
    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('clicking "Keep running" closes without calling the route', () => {
    render(<ExperimentCancelDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Keep running'));

    expect(abandonMutate).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });

  it('on a rejected promise surfaces the error inline and does NOT call onSuccess/onClose', async () => {
    abandonMutate.mockRejectedValue(new Error('experiment exp-cancel-1 is already decided'));
    render(<ExperimentCancelDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Cancel experiment'));
    });

    expect(screen.getByText('experiment exp-cancel-1 is already decided')).toBeInTheDocument();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });
});
