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
    // Migration-078 columns (verification-agent redesign §5.2/§5.6) — NULL on a
    // legacy/pre-078 row like this fixture.
    task_json: null,
    report_json: null,
    delivery_state: null,
    snapshot_sha: null,
    enqueue_key: null,
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

  it('keeps the same requests array reference when a poll repeats identical rows', async () => {
    vi.useFakeTimers();
    listQuerySpy.mockResolvedValue([row('vr-1')]);
    const { result } = renderHook(() =>
      useVerificationRequests({ projectId: 1, refetchIntervalMs: 1000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(listQuerySpy).toHaveBeenCalledTimes(1);
    const requestsAfterFirstLoad = result.current.requests;
    expect(requestsAfterFirstLoad).toHaveLength(1);

    // Next poll resolves a content-equal-but-distinct array/row objects.
    listQuerySpy.mockResolvedValue([row('vr-1')]);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(listQuerySpy).toHaveBeenCalledTimes(2);
    // Same reference — the unchanged-content poll should not have re-set state.
    expect(result.current.requests).toBe(requestsAfterFirstLoad);
  });

  it('updates the array reference when only migration-078 fields change (§5.11 stale-row fix)', async () => {
    // The delivery-outbox pattern (§5.6) can flip `delivery_state` from
    // 'pending' to 'delivered' on a LATER poll while every pre-078 field
    // (including `status`) is already settled — the equality check must catch
    // this or a just-delivered agent-engine row looks unchanged forever.
    vi.useFakeTimers();
    const terminalRow = (deliveryState: string): VerificationRequest => ({
      ...row('vr-1'),
      status: 'failed',
      task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
      report_json: JSON.stringify({ outcome: 'fail' }),
      delivery_state: deliveryState,
    });
    listQuerySpy.mockResolvedValue([terminalRow('pending')]);
    const { result } = renderHook(() =>
      useVerificationRequests({ projectId: 1, refetchIntervalMs: 1000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    const requestsAfterFirstLoad = result.current.requests;
    expect(requestsAfterFirstLoad[0].delivery_state).toBe('pending');

    listQuerySpy.mockResolvedValue([terminalRow('delivered')]);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(result.current.requests).not.toBe(requestsAfterFirstLoad);
    expect(result.current.requests[0].delivery_state).toBe('delivered');
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
