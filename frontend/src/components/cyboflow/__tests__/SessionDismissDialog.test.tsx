import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      delete: vi.fn().mockResolvedValue({ success: true }),
      // Default: not delivered/landed — keeps the plain-confirm path so
      // existing behavior-only tests don't need to know about the probe.
      getDeliveryState: vi.fn().mockResolvedValue({
        success: true,
        data: { delivered: false, landed: false, ownCommits: 0, completedNoCode: false },
      }),
      markComplete: vi.fn().mockResolvedValue({ success: true, data: { stamped: 1 } }),
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
  vi.mocked(API.sessions.delete).mockResolvedValue({ success: true });
  vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
    success: true,
    data: { delivered: false, landed: false, ownCommits: 0, completedNoCode: false },
  });
  vi.mocked(API.sessions.markComplete).mockResolvedValue({ success: true, data: { stamped: 1 } });
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
    expect(screen.queryByTestId('dismiss-probe-loading')).not.toBeInTheDocument();
  });

  it('renders ConfirmDialog with correct title, warning message, and destructive button once the probe settles', async () => {
    render(<SessionDismissDialog {...defaultProps} />);
    expect(await screen.findByText('Dismiss session?')).toBeInTheDocument();
    expect(screen.getByText(/unmerged/)).toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('clicking confirm calls API.sessions.delete with sessionId', async () => {
    render(<SessionDismissDialog {...defaultProps} />);
    const dismissButton = await screen.findByText('Dismiss');

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('clicking cancel calls onClose without calling API.sessions.delete', () => {
    // Fires during the probe-loading state (synchronous click, before the
    // mocked probe's microtask resolves) — Cancel is non-destructive in
    // either state, so this is valid coverage of both.
    render(<SessionDismissDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('on delete failure calls showError and does NOT call onSuccess', async () => {
    vi.mocked(API.sessions.delete).mockRejectedValue(new Error('Network error'));

    render(<SessionDismissDialog {...defaultProps} />);
    const dismissButton = await screen.findByText('Dismiss');

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dismiss failed',
      error: 'Network error',
    }));
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });

  it('on result.success === false (e.g. already archived) calls showError and does NOT call onSuccess', async () => {
    // The handler RESOLVES with an unsuccessful IPCResponse — the dialog must
    // NOT fire the success toast (the bug: it ignored result.success and showed
    // "Session dismissed" while nothing changed).
    vi.mocked(API.sessions.delete).mockResolvedValue({ success: false, error: 'Session is already archived' });

    render(<SessionDismissDialog {...defaultProps} />);
    const dismissButton = await screen.findByText('Dismiss');

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dismiss failed',
      error: 'Session is already archived',
    }));
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });

  it('on result.success === true calls onSuccess and not showError', async () => {
    vi.mocked(API.sessions.delete).mockResolvedValue({ success: true });

    render(<SessionDismissDialog {...defaultProps} />);
    const dismissButton = await screen.findByText('Dismiss');

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  describe('delivered/landed session — three-way choice', () => {
    it('offers Mark complete, Dismiss anyway, and Cancel when the session is delivered', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: true, landed: false, ownCommits: 0, completedNoCode: false },
      });

      render(<SessionDismissDialog {...defaultProps} />);

      expect(await screen.findByText('Mark complete')).toBeInTheDocument();
      expect(screen.getByText('Dismiss anyway')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      // The plain confirm's own copy must not also be showing.
      expect(screen.queryByText('Dismiss session?')).not.toBeInTheDocument();
    });

    it('offers the choice when landed is true even if delivered is false', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: false, landed: true, ownCommits: 0, completedNoCode: false },
      });

      render(<SessionDismissDialog {...defaultProps} />);

      expect(await screen.findByText('Mark complete')).toBeInTheDocument();
    });

    it('TASK-296: shows the moved-task count on the button when landed carries an integratedLaneCount, and forwards tasksMovedToDone to onSuccess', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: false, landed: true, ownCommits: 3, completedNoCode: false, integratedLaneCount: 2 },
      });
      vi.mocked(API.sessions.markComplete).mockResolvedValue({
        success: true,
        data: { stamped: 1, tasksMovedToDone: 2 },
      });

      render(<SessionDismissDialog {...defaultProps} />);

      const markCompleteButton = await screen.findByText('Mark complete (moves 2 tasks to Done)');

      await act(async () => {
        fireEvent.click(markCompleteButton);
      });

      expect(defaultProps.onSuccess).toHaveBeenCalledWith(true, 2);
    });

    it('Mark complete calls markComplete BEFORE delete, then onSuccess(true) and onClose', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: true, landed: false, ownCommits: 0, completedNoCode: false },
      });

      const callOrder: string[] = [];
      vi.mocked(API.sessions.markComplete).mockImplementation(async () => {
        callOrder.push('markComplete');
        return { success: true, data: { stamped: 1 } };
      });
      vi.mocked(API.sessions.delete).mockImplementation(async () => {
        callOrder.push('delete');
        return { success: true };
      });

      render(<SessionDismissDialog {...defaultProps} />);
      const markCompleteButton = await screen.findByText('Mark complete');

      await act(async () => {
        fireEvent.click(markCompleteButton);
      });

      expect(callOrder).toEqual(['markComplete', 'delete']);
      expect(defaultProps.onSuccess).toHaveBeenCalledWith(true, undefined);
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('a failed markComplete does NOT call delete, and shows an error', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: true, landed: false, ownCommits: 0, completedNoCode: false },
      });
      vi.mocked(API.sessions.markComplete).mockResolvedValue({ success: false, error: 'stamp failed' });

      render(<SessionDismissDialog {...defaultProps} />);
      const markCompleteButton = await screen.findByText('Mark complete');

      await act(async () => {
        fireEvent.click(markCompleteButton);
      });

      expect(API.sessions.delete).not.toHaveBeenCalled();
      expect(defaultProps.onSuccess).not.toHaveBeenCalled();
      expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Mark complete failed',
        error: 'stamp failed',
      }));
    });

    it('Dismiss anyway calls delete directly (no markComplete) and fires onSuccess without the completed flag', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: true, landed: false, ownCommits: 0, completedNoCode: false },
      });

      render(<SessionDismissDialog {...defaultProps} />);
      const dismissAnywayButton = await screen.findByText('Dismiss anyway');

      await act(async () => {
        fireEvent.click(dismissAnywayButton);
      });

      expect(API.sessions.markComplete).not.toHaveBeenCalled();
      expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
      expect(defaultProps.onSuccess).toHaveBeenCalledWith();
    });
  });

  describe('completedNoCode session (DB-only Planner/Launch run) — three-way choice', () => {
    it('offers Mark complete, Dismiss anyway, and Cancel, with copy that does not mention unmerged changes', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: false, landed: false, ownCommits: 0, completedNoCode: true },
      });

      render(<SessionDismissDialog {...defaultProps} />);

      expect(await screen.findByText('Mark complete')).toBeInTheDocument();
      expect(screen.getByText('Dismiss anyway')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      // Neither the plain confirm's own copy nor its "unmerged" claim should show.
      expect(screen.queryByText('Dismiss session?')).not.toBeInTheDocument();
      expect(screen.queryByText(/unmerged/)).not.toBeInTheDocument();
      expect(screen.getByText(/completed without changing the repository/)).toBeInTheDocument();
    });

    it('Mark complete calls markComplete BEFORE delete, then onSuccess(true) and onClose', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: false, landed: false, ownCommits: 0, completedNoCode: true },
      });

      const callOrder: string[] = [];
      vi.mocked(API.sessions.markComplete).mockImplementation(async () => {
        callOrder.push('markComplete');
        return { success: true, data: { stamped: 1 } };
      });
      vi.mocked(API.sessions.delete).mockImplementation(async () => {
        callOrder.push('delete');
        return { success: true };
      });

      render(<SessionDismissDialog {...defaultProps} />);
      const markCompleteButton = await screen.findByText('Mark complete');

      await act(async () => {
        fireEvent.click(markCompleteButton);
      });

      expect(callOrder).toEqual(['markComplete', 'delete']);
      expect(defaultProps.onSuccess).toHaveBeenCalledWith(true, undefined);
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('Dismiss anyway calls delete directly (no markComplete)', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockResolvedValue({
        success: true,
        data: { delivered: false, landed: false, ownCommits: 0, completedNoCode: true },
      });

      render(<SessionDismissDialog {...defaultProps} />);
      const dismissAnywayButton = await screen.findByText('Dismiss anyway');

      await act(async () => {
        fireEvent.click(dismissAnywayButton);
      });

      expect(API.sessions.markComplete).not.toHaveBeenCalled();
      expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
      expect(defaultProps.onSuccess).toHaveBeenCalledWith();
    });
  });

  describe('non-delivered / probe-failure fallback', () => {
    it('a non-delivered session keeps the plain confirm and calls delete directly', async () => {
      render(<SessionDismissDialog {...defaultProps} />);

      const dismissButton = await screen.findByText('Dismiss');

      await act(async () => {
        fireEvent.click(dismissButton);
      });

      expect(API.sessions.markComplete).not.toHaveBeenCalled();
      expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
    });

    it('a failing delivery probe falls back to the plain confirm', async () => {
      vi.mocked(API.sessions.getDeliveryState).mockRejectedValue(new Error('probe down'));

      render(<SessionDismissDialog {...defaultProps} />);

      const dismissButton = await screen.findByText('Dismiss');

      await act(async () => {
        fireEvent.click(dismissButton);
      });

      expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
    });
  });

  describe('probe-in-flight and watchdog', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('while the probe is in flight, the destructive confirm is NOT rendered and delete cannot be triggered', async () => {
      // A promise that never resolves during this test — the probe is
      // permanently "in flight" from the component's perspective.
      vi.mocked(API.sessions.getDeliveryState).mockReturnValue(new Promise(() => {}));

      render(<SessionDismissDialog {...defaultProps} />);

      // The loading state renders immediately (synchronously, on first
      // paint) — no destructive control is present yet.
      expect(screen.getByTestId('dismiss-probe-loading')).toBeInTheDocument();
      expect(screen.queryByText('Dismiss session?')).not.toBeInTheDocument();
      expect(screen.queryByText('Dismiss')).not.toBeInTheDocument();
      expect(screen.queryByText('Dismiss anyway')).not.toBeInTheDocument();

      // Give any pending microtasks a chance to flush — still nothing
      // destructive shows up, and delete is never reachable.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('dismiss-probe-loading')).toBeInTheDocument();
      expect(API.sessions.delete).not.toHaveBeenCalled();

      // Cancel is the only available action while loading.
      fireEvent.click(screen.getByText('Cancel'));
      expect(defaultProps.onClose).toHaveBeenCalled();
      expect(API.sessions.delete).not.toHaveBeenCalled();
    });

    it('watchdog: a never-resolving probe falls back to the plain confirm after the timeout, and Dismiss works normally', async () => {
      vi.useFakeTimers();
      vi.mocked(API.sessions.getDeliveryState).mockReturnValue(new Promise(() => {}));

      render(<SessionDismissDialog {...defaultProps} />);
      expect(screen.getByTestId('dismiss-probe-loading')).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.getByText('Dismiss session?')).toBeInTheDocument();
      expect(screen.queryByTestId('dismiss-probe-loading')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Dismiss'));
      });

      expect(API.sessions.delete).toHaveBeenCalledWith('sess-dismiss-1');
    });
  });
});
