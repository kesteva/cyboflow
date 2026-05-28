import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

const mockShowError = vi.fn();
vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ showError: mockShowError })),
  }),
}));

import { SessionDismissDialog } from '../SessionDismissDialog';
import { API } from '../../../utils/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionDismissDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    sessionId: 'sess-dismiss-1',
    onSuccess: vi.fn(),
  };

  it('renders nothing when isOpen is false', () => {
    render(<SessionDismissDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Dismiss session?')).not.toBeInTheDocument();
  });

  it('renders ConfirmDialog with correct title, warning message, and destructive button', () => {
    render(<SessionDismissDialog {...defaultProps} />);
    expect(screen.getByText('Dismiss session?')).toBeInTheDocument();
    expect(screen.getByText(/unmerged/)).toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('clicking confirm calls API.sessions.delete with sessionId', async () => {
    render(<SessionDismissDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'));
    });

    expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('clicking cancel calls onClose without calling API.sessions.delete', () => {
    render(<SessionDismissDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('on delete failure calls showError and does NOT call onSuccess', async () => {
    vi.mocked(API.sessions.delete).mockRejectedValue(new Error('Network error'));

    render(<SessionDismissDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'));
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dismiss failed',
      error: 'Network error',
    }));
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });
});
