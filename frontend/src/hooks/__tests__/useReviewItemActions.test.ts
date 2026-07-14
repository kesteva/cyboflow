/**
 * Unit tests for useReviewItemActions — the review_items triage mutations hook.
 *
 * Covers:
 *   - resolve forwards { projectId, reviewItemId } and surfaces the backend
 *     `resumed` flag (decision flow-advancement signal).
 *   - acceptFinding (target PINNED to 'docs' | 'prompt') resolves with the
 *     'triaged:accepted-<target>' note — 'fix' can never reach this path.
 *   - dismiss forwards correctly and returns true on success.
 *   - promoteToTask forwards overrides and returns the minted { taskId }.
 *   - error path: a rejecting mutation sets `error` and returns null/false.
 *
 * The tRPC client is mocked at the canonical import path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const {
  mockResolve,
  mockDismiss,
  mockPromote,
  mockLaunchSeparatePlanner,
  mockReturnIdeaToBacklog,
  mockEnsureSessionForLaunch,
} = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockDismiss: vi.fn(),
  mockPromote: vi.fn(),
  mockLaunchSeparatePlanner: vi.fn(),
  mockReturnIdeaToBacklog: vi.fn(),
  mockEnsureSessionForLaunch: vi.fn(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        resolve: { mutate: mockResolve },
        dismiss: { mutate: mockDismiss },
        promoteToTask: { mutate: mockPromote },
      },
      runs: {
        launchSeparatePlanner: { mutate: mockLaunchSeparatePlanner },
        returnIdeaToBacklog: { mutate: mockReturnIdeaToBacklog },
      },
    },
  },
}));

// launchSeparatePlanner creates the child's FRESH host session before mutating —
// stub the session helper (its real IPC/panel bootstrap is covered elsewhere).
vi.mock('../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: mockEnsureSessionForLaunch,
}));

import { useReviewItemActions } from '../useReviewItemActions';

beforeEach(() => {
  mockResolve.mockReset();
  mockDismiss.mockReset();
  mockPromote.mockReset();
  mockLaunchSeparatePlanner.mockReset();
  mockReturnIdeaToBacklog.mockReset();
  mockEnsureSessionForLaunch.mockReset();
  mockEnsureSessionForLaunch.mockResolvedValue('sess-child');
});

describe('useReviewItemActions', () => {
  it('resolve forwards the input and surfaces the backend resumed flag', async () => {
    mockResolve.mockResolvedValue({ reviewItemId: 'rvw_1', resumed: true });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { resumed: boolean } | null = null;
    await act(async () => {
      res = await result.current.resolve(7, 'rvw_1', { resolution: 'looks good' });
    });

    expect(mockResolve).toHaveBeenCalledWith({
      projectId: 7,
      reviewItemId: 'rvw_1',
      resolution: 'looks good',
    });
    expect(res).toEqual({ resumed: true });
    // pendingItemId resets after the mutation settles.
    expect(result.current.pendingItemId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('resolve forwards an explicit gate outcome', async () => {
    mockResolve.mockResolvedValue({ reviewItemId: 'rvw_g', resumed: true });
    const { result } = renderHook(() => useReviewItemActions());

    await act(async () => {
      await result.current.resolve(3, 'rvw_g', { outcome: 'approve' });
    });

    expect(mockResolve).toHaveBeenCalledWith({
      projectId: 3,
      reviewItemId: 'rvw_g',
      outcome: 'approve',
    });
  });

  it('resolve omits resolution when not provided', async () => {
    mockResolve.mockResolvedValue({ reviewItemId: 'rvw_2', resumed: false });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { resumed: boolean } | null = null;
    await act(async () => {
      res = await result.current.resolve(1, 'rvw_2');
    });

    expect(mockResolve).toHaveBeenCalledWith({ projectId: 1, reviewItemId: 'rvw_2' });
    expect(res).toEqual({ resumed: false });
  });

  it('acceptFinding resolves with the triaged:accepted-<target> note', async () => {
    // The target param is pinned to 'docs' | 'prompt' so a widened
    // FindingProposedTarget ('fix') can never reach the manual-accept path.
    mockResolve.mockResolvedValue({ reviewItemId: 'rvw_a', resumed: false });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { resumed: boolean } | null = null;
    await act(async () => {
      res = await result.current.acceptFinding(5, 'rvw_a', 'docs');
    });

    expect(mockResolve).toHaveBeenCalledWith({
      projectId: 5,
      reviewItemId: 'rvw_a',
      resolution: 'triaged:accepted-docs',
    });
    expect(res).toEqual({ resumed: false });
  });

  it('dismiss forwards the input and returns true on success', async () => {
    mockDismiss.mockResolvedValue({ reviewItemId: 'rvw_3' });
    const { result } = renderHook(() => useReviewItemActions());

    let ok = false;
    await act(async () => {
      ok = await result.current.dismiss(2, 'rvw_3');
    });

    expect(mockDismiss).toHaveBeenCalledWith({ projectId: 2, reviewItemId: 'rvw_3' });
    expect(ok).toBe(true);
  });

  it('promoteToTask forwards overrides and returns the minted taskId', async () => {
    mockPromote.mockResolvedValue({ reviewItemId: 'rvw_4', taskId: 'tsk_99' });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { taskId: string } | null = null;
    await act(async () => {
      res = await result.current.promoteToTask(3, 'rvw_4', { title: 'Fix it', body: 'details' });
    });

    expect(mockPromote).toHaveBeenCalledWith({
      projectId: 3,
      reviewItemId: 'rvw_4',
      title: 'Fix it',
      body: 'details',
    });
    expect(res).toEqual({ taskId: 'tsk_99' });
  });

  it('sets error and returns null when resolve rejects', async () => {
    mockResolve.mockRejectedValue(new Error('invalid_status: already resolved'));
    const { result } = renderHook(() => useReviewItemActions());

    let res: { resumed: boolean } | null = { resumed: false };
    await act(async () => {
      res = await result.current.resolve(1, 'rvw_x');
    });

    expect(res).toBeNull();
    expect(result.current.error).toContain('invalid_status');
    expect(result.current.pendingItemId).toBeNull();
  });

  it('sets error and returns false when dismiss rejects', async () => {
    mockDismiss.mockRejectedValue(new Error('not_found'));
    const { result } = renderHook(() => useReviewItemActions());

    let ok = true;
    await act(async () => {
      ok = await result.current.dismiss(1, 'rvw_y');
    });

    expect(ok).toBe(false);
    expect(result.current.error).toContain('not_found');
  });

  it('sets error and returns null when promoteToTask rejects', async () => {
    mockPromote.mockRejectedValue(new Error('invalid_entity: already linked'));
    const { result } = renderHook(() => useReviewItemActions());

    let res: { taskId: string } | null = { taskId: 'x' };
    await act(async () => {
      res = await result.current.promoteToTask(1, 'rvw_z');
    });

    expect(res).toBeNull();
    expect(result.current.error).toContain('invalid_entity');
  });

  it('launchSeparatePlanner creates a FRESH host session then forwards it with the input', async () => {
    mockLaunchSeparatePlanner.mockResolvedValue({
      runId: 'run_child',
      worktreePath: '/tmp/wt',
      branchName: 'quick-child',
    });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { runId: string; worktreePath: string; branchName: string } | null = null;
    await act(async () => {
      res = await result.current.launchSeparatePlanner(4, 'rvw_guard');
    });

    // forceNew is REQUIRED: the parent run's session is parked non-terminal
    // behind the guard, so reusing the current selection would be rejected by
    // the backend's one-running-per-session guard.
    expect(mockEnsureSessionForLaunch).toHaveBeenCalledWith(4, { forceNew: true });
    expect(mockLaunchSeparatePlanner).toHaveBeenCalledWith({
      projectId: 4,
      reviewItemId: 'rvw_guard',
      sessionId: 'sess-child',
    });
    expect(res).toEqual({ runId: 'run_child', worktreePath: '/tmp/wt', branchName: 'quick-child' });
    expect(result.current.pendingItemId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets error and returns null when launchSeparatePlanner rejects (already-resolved guard)', async () => {
    mockLaunchSeparatePlanner.mockRejectedValue(new Error("Review item rvw_guard is already 'resolved'"));
    const { result } = renderHook(() => useReviewItemActions());

    let res: { runId: string; worktreePath: string; branchName: string } | null = { runId: 'x', worktreePath: 'x', branchName: 'x' };
    await act(async () => {
      res = await result.current.launchSeparatePlanner(4, 'rvw_guard');
    });

    expect(res).toBeNull();
    expect(result.current.error).toContain('already');
  });

  it('sets error and skips the mutation when the session create itself fails', async () => {
    mockEnsureSessionForLaunch.mockRejectedValue(new Error('Failed to create session for launch'));
    const { result } = renderHook(() => useReviewItemActions());

    let res: { runId: string; worktreePath: string; branchName: string } | null = { runId: 'x', worktreePath: 'x', branchName: 'x' };
    await act(async () => {
      res = await result.current.launchSeparatePlanner(4, 'rvw_guard');
    });

    expect(res).toBeNull();
    expect(mockLaunchSeparatePlanner).not.toHaveBeenCalled();
    expect(result.current.error).toContain('Failed to create session');
  });

  it('returnIdeaToBacklog forwards the input and returns the resolved ids', async () => {
    mockReturnIdeaToBacklog.mockResolvedValue({ reviewItemId: 'rvw_guard', ideaId: 'idea_9' });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { reviewItemId: string; ideaId: string } | null = null;
    await act(async () => {
      res = await result.current.returnIdeaToBacklog(4, 'rvw_guard');
    });

    expect(mockReturnIdeaToBacklog).toHaveBeenCalledWith({ projectId: 4, reviewItemId: 'rvw_guard' });
    expect(res).toEqual({ reviewItemId: 'rvw_guard', ideaId: 'idea_9' });
  });

  it('sets error and returns null when returnIdeaToBacklog rejects (already-resolved guard)', async () => {
    mockReturnIdeaToBacklog.mockRejectedValue(new Error("Review item rvw_guard is already 'resolved'"));
    const { result } = renderHook(() => useReviewItemActions());

    let res: { reviewItemId: string; ideaId: string } | null = { reviewItemId: 'x', ideaId: 'x' };
    await act(async () => {
      res = await result.current.returnIdeaToBacklog(4, 'rvw_guard');
    });

    expect(res).toBeNull();
    expect(result.current.error).toContain('already');
  });
});
