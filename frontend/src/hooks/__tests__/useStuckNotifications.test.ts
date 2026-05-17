// @vitest-environment jsdom
/**
 * Unit tests for useStuckNotifications.
 *
 * Five cases:
 *   1. First stuck event per session fires a notification.
 *   2. Second event with the same sessionId is suppressed (constructor called once).
 *   3. Different sessionId fires a second notification.
 *   4. Remount resets the suppression set (in-memory only).
 *   5. notifications.enabled === false gates the hook — no notification fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { StuckDetectedEvent } from '../useStuckNotifications';

// ---------------------------------------------------------------------------
// Fake tRPC subscription factory
// ---------------------------------------------------------------------------

/** Callback the fake subscription will invoke when `emit()` is called. */
let onDataCallback: ((event: StuckDetectedEvent) => void) | null = null;

function makeFakeSubscription() {
  return {
    subscribe: (_input: undefined, callbacks: { onData: (e: StuckDetectedEvent) => void; onError: (e: unknown) => void }) => {
      onDataCallback = callbacks.onData;
      return {
        unsubscribe: () => { onDataCallback = null; },
      };
    },
  };
}

/** Emit a stuck event through the currently active subscription. */
function emitStuck(event: StuckDetectedEvent) {
  if (!onDataCallback) throw new Error('No active subscription — hook not mounted or already unmounted');
  onDataCallback(event);
}

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports of the module under test)
// ---------------------------------------------------------------------------

vi.mock('../../utils/trpcClient', () => ({
  trpc: {
    cyboflow: {
      events: {
        onStuckDetected: makeFakeSubscription(),
      },
    },
  },
}));

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
    sessionId: 'session-A',
    workflowName: 'My Workflow',
    reason: 'orphan_pty',
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
  // Reset the subscription callback before each test
  onDataCallback = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStuckNotifications', () => {
  it('fires a notification for the first stuck event in a session', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    // Allow the settings useEffect to resolve
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-A', workflowName: 'Alpha' }));
      // Let requestPermission() resolve
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = MockNotification.mock.calls[0] as [string, NotificationOptions];
    expect(title).toContain('⚠️');
    expect(opts.body).toMatch(/Run "Alpha" is stuck/);

    unmount();
  });

  it('suppresses a second stuck event for the same sessionId', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-A', runId: 'run-001' }));
      await Promise.resolve();
    });

    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-A', runId: 'run-002' }));
      await Promise.resolve();
    });

    // Only one notification despite two events with the same sessionId
    expect(MockNotification).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('fires a second notification for a different sessionId', async () => {
    const { unmount } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-A' }));
      await Promise.resolve();
    });

    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-B' }));
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
      emitStuck(makeEvent({ sessionId: 'session-A' }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);

    // Unmount (simulates app restart)
    unmount1();

    // Assert localStorage was not written (the hook must not persist state)
    expect(localStorage.getItem('stuck-notifications')).toBeNull();
    expect(sessionStorage.getItem('stuck-notifications')).toBeNull();

    // Second mount with a fresh hook instance
    const { unmount: unmount2 } = renderHook(() => useStuckNotifications());

    await act(async () => { await Promise.resolve(); });

    // Same sessionId that was suppressed before — must fire again because the
    // suppression set lives in-memory only (new ref on remount).
    await act(async () => {
      emitStuck(makeEvent({ sessionId: 'session-A' }));
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
      emitStuck(makeEvent({ sessionId: 'session-A' }));
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
        sessionId: 'session-C',
        workflowName: 'Test Flow',
        reason: 'self_deadlock',
      }));
      await Promise.resolve();
    });

    expect(MockNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = MockNotification.mock.calls[0] as [string, NotificationOptions];
    expect(title).toContain('⚠️');
    expect(opts.body).toMatch(/Run "Test Flow" is stuck: self-deadlock/);

    unmount();
  });
});
