/**
 * Unit tests for useReviewItemActions — the review_items triage mutations hook.
 *
 * Covers:
 *   - resolve forwards { projectId, reviewItemId } and surfaces the backend
 *     `resumed` flag (decision flow-advancement signal).
 *   - dismiss forwards correctly and returns true on success.
 *   - promoteToTask forwards overrides and returns the minted { taskId }.
 *   - error path: a rejecting mutation sets `error` and returns null/false.
 *
 * The tRPC client is mocked at the canonical import path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockResolve, mockDismiss, mockPromote } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockDismiss: vi.fn(),
  mockPromote: vi.fn(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        resolve: { mutate: mockResolve },
        dismiss: { mutate: mockDismiss },
        promoteToTask: { mutate: mockPromote },
      },
    },
  },
}));

import { useReviewItemActions } from '../useReviewItemActions';

beforeEach(() => {
  mockResolve.mockReset();
  mockDismiss.mockReset();
  mockPromote.mockReset();
});

describe('useReviewItemActions', () => {
  it('resolve forwards the input and surfaces the backend resumed flag', async () => {
    mockResolve.mockResolvedValue({ reviewItemId: 'rvw_1', resumed: true });
    const { result } = renderHook(() => useReviewItemActions());

    let res: { resumed: boolean } | null = null;
    await act(async () => {
      res = await result.current.resolve(7, 'rvw_1', 'looks good');
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
});
