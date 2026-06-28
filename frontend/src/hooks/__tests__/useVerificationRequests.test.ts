/**
 * Unit tests for useVerificationRequests (L6 Verify-Queue panel, S7).
 *
 * Behaviors verified:
 *   1. Null projectId — returns [] / not loading and never queries.
 *   2. Seeds from the list query (projectId passed through) and reports the rows.
 *   3. Optional runId + status are forwarded only when provided.
 *   4. Polls on the configured interval (re-queries + updates the list).
 *   5. A query rejection surfaces an Error and leaves the last list intact.
 *   6. Unmount stops the polling interval (no further queries).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { VerificationRequest } from '../useVerificationRequests';

// ---------------------------------------------------------------------------
// Controllable tRPC mock — a single list.query spy whose resolved value the
// tests swap between calls.
// ---------------------------------------------------------------------------

const { listQuerySpy } = vi.hoisted(() => ({ listQuerySpy: vi.fn() }));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      verificationRequests: {
        list: { query: listQuerySpy },
      },
    },
  },
}));

import { useVerificationRequests } from '../useVerificationRequests';

function row(id: string): VerificationRequest {
  return {
    id,
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify({ intent: 'looks right' }),
    chain_json: '["capturePage"]',
    current_backend: null,
    attempt: 0,
    verdict_json: null,
    error_message: null,
    enqueued_at: '2026-06-28T00:00:01.000Z',
    leased_at: null,
    ended_at: null,
  };
}

beforeEach(() => {
  listQuerySpy.mockReset();
  listQuerySpy.mockResolvedValue([row('vr-1')]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useVerificationRequests', () => {
  it('returns [] and never queries when projectId is null', () => {
    const { result } = renderHook(() => useVerificationRequests({ projectId: null }));
    expect(result.current.requests).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(listQuerySpy).not.toHaveBeenCalled();
  });

  it('seeds from the list query and passes projectId through', async () => {
    const { result } = renderHook(() => useVerificationRequests({ projectId: 1 }));

    await waitFor(() => expect(result.current.requests).toHaveLength(1));
    expect(result.current.requests[0].id).toBe('vr-1');
    expect(result.current.isLoading).toBe(false);
    expect(listQuerySpy).toHaveBeenCalledWith({ projectId: 1 });
  });

  it('forwards optional runId + status only when provided', async () => {
    const { result } = renderHook(() =>
      useVerificationRequests({ projectId: 2, runId: 'run-x', status: 'failed' }),
    );

    await waitFor(() => expect(listQuerySpy).toHaveBeenCalled());
    expect(listQuerySpy).toHaveBeenCalledWith({ projectId: 2, runId: 'run-x', status: 'failed' });
    expect(result.current).toBeTruthy();
  });

  it('polls on the configured interval and updates the list', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useVerificationRequests({ projectId: 1, refetchIntervalMs: 1000 }),
    );

    // Resolve the initial seed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listQuerySpy).toHaveBeenCalledTimes(1);

    // Next poll returns a different list.
    listQuerySpy.mockResolvedValue([row('vr-1'), row('vr-2')]);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(listQuerySpy).toHaveBeenCalledTimes(2);
    expect(result.current.requests.map((r) => r.id)).toEqual(['vr-1', 'vr-2']);
  });

  it('surfaces a query rejection as an Error', async () => {
    listQuerySpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useVerificationRequests({ projectId: 1 }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.isLoading).toBe(false);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useVerificationRequests({ projectId: 1, refetchIntervalMs: 1000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(listQuerySpy).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    // No further queries after unmount.
    expect(listQuerySpy).toHaveBeenCalledTimes(1);
  });
});
