/**
 * Unit tests for useStuckNotifications.
 *
 * Six cases:
 *   1. First stuck event per runId fires a notification.
 *   2. Second event with the same runId is suppressed (constructor called once).
 *   3. Different runId fires a second notification.
 *   4. Remount resets the suppression set (in-memory only).
 *   5. notifications.enabled === false gates the hook — no notification fired.
 *   6. Notification title contains warning emoji and body matches new format using stuck reason from reason.kind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { StuckDetectedEvent } from '../../../../shared/types/stuckDetection';
import { useReviewQueueSlice } from '../../stores/reviewQueueSlice';

// ---------------------------------------------------------------------------
// Slice-driven emitter helper
// ---------------------------------------------------------------------------

/** Drive the hook by setting slice state directly via applyStuckEvent. */
function emitStuck(event: StuckDetectedEvent) {
  act(() => {
    useReviewQueueSlice.getState().applyStuckEvent({
      runId: event.runId,
      reason: event.reason,
      detectedAt: event.detectedAt,
    });
  });
}

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports of the module under test)
// ---------------------------------------------------------------------------

// Mock tRPC client to prevent Electron IPC bridge initialization in tests.
// reviewQueueSlice imports trpc for its subscribeToStuckEvents action; this
// mock prevents the `electronTRPC` global requirement from being thrown.
// Note: reviewQueueSlice's subscribeToStuckEvents action is never called by the
// hook under test — the hook only reads slice state. The mock is a stub to
// satisfy the module import, not to drive any test behavior.
vi.mock('../../trpc/client', () => {
  const noopSubscription = { unsubscribe: vi.fn() };
  const noopSubscribable = { subscribe: vi.fn().mockReturnValue(noopSubscription) };
  return {
    trpc: {
      cyboflow: {
        events: new Proxy({}, { get: () => noopSubscribable }),
        approvals: {
          listPending: { query: vi.fn().mockResolvedValue([]) },
        },
      },
    },
  };
});

// Mutable mock for API.config.get — tests override `notificationsEnabled`.
let notificationsEnabled = true;

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: () =>
        Promise.resolve({
          success: true,
          data: {
            notifications: { enabled: notificationsEnabled },
          },
        }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

const { useStuckNotifications } = await import('../useStuckNotifications');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<StuckDetectedEvent> = {}): StuckDetectedEvent {
  return {
    runId: 'run-001',
    approvalId: 'approval-001',
    reason: { kind: 'orphan_pty' },
    detectedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const MockNotification = vi.fn().mockImplementation((_title: string, _opts: NotificationOptions) => ({}));
(MockNotification as unknown as { permission: string }).permission = 'granted';

beforeEach(() => {
  MockNotification.mockClear();
  vi.stubGlobal('Notification', MockNotification);
  notificationsEnabled = true;
  // Reset slice state before each test
  useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStuckNotifications', () => {
  it('fires a notification for the first stuck event for a runId', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    // Allow the settings useEffect to resolve
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001' }));
      // Let requestPermission() resolve
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = MockNotification.mock.calls[0] as [string, NotificationOptions];
    expect(title).toContain('⚠️');
    expect(opts.body).toMatch(/Run run-001 is stuck/);

    unmount();
  });

  it('suppresses a second stuck event for the same runId', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001', approvalId: 'approval-001' }));
      await Promise.resolve();
    });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001', approvalId: 'approval-002' }));
      await Promise.resolve();
    });

    // Only one notification despite two events with the same runId
    expect(MockNotification).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('fires a second notification for a different runId', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001' }));
      await Promise.resolve();
    });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-002' }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('resets the suppression set on remount (in-memory only, no localStorage)', async () => {
    // First mount — trigger a notification
    const { unmount: unmount1 } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001' }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);

    // Unmount (simulates app restart)
    unmount1();

    // Assert localStorage was not written (the hook must not persist state)
    expect(localStorage.getItem('stuck-notifications')).toBeNull();
    expect(sessionStorage.getItem('stuck-notifications')).toBeNull();

    // Reset slice state between mounts so prevStuck initialization on mount 2
    // does NOT see the run-001 entry (otherwise it would be in prevStuck and
    // the transition would not be detected).
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });

    // Second mount with a fresh hook instance
    const { unmount: unmount2 } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    // Same runId that was suppressed before — must fire again because the
    // suppression set lives in-memory only (new ref on remount).
    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001' }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(2);

    unmount2();
  });

  it('does not fire a notification when notifications.enabled === false', async () => {
    notificationsEnabled = false;

    const { unmount } = renderHook(() => useStuckNotifications());

    // Wait for the settings useEffect to resolve and settings to update
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve(); // extra tick for setState + re-render
    });

    await act(async () => {
      emitStuck(makeEvent({ runId: 'run-001' }));
      await Promise.resolve();
    });

    expect(MockNotification).not.toHaveBeenCalled();

    unmount();
  });

  it('notification title contains warning emoji and body matches expected format', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({
        runId: 'run-003',
        reason: { kind: 'self_deadlock' },
      }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = MockNotification.mock.calls[0] as [string, NotificationOptions];
    expect(title).toContain('⚠️');
    expect(opts.body).toMatch(/is stuck: self-deadlock/);

    unmount();
  });
});
