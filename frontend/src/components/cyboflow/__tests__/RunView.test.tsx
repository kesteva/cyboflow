/**
 * RunView rendering tests (updated in TASK-667).
 *
 * After TASK-667 confirmed H2 (renderer listener teardown), the stream-event
 * subscription was moved from RunView's useEffect into the cyboflowStore
 * module-level singleton. RunView is now subscription-free.
 *
 * Behaviors verified:
 *   1. Renders a "No active run" placeholder when activeRunId is null.
 *   2. Renders the runId when an active run is set.
 *   3. Renders "Waiting for events…" before any events arrive.
 *   4. Renders stream events from the store as JSON blobs.
 *   5. Subscription is NOT managed by RunView (it is managed by the store).
 *
 * Subscription lifecycle tests live in
 * frontend/src/stores/__tests__/cyboflowStore.test.ts.
 */
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi so the store-level subscription does not attempt real IPC.
// We mock the named export used by the store singleton (_startSubscription).
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    listWorkflows: vi.fn(),
    startRun: vi.fn(),
    approveRun: vi.fn(),
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunView } from '../RunView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { subscribeToStreamEvents } from '../../../utils/cyboflowApi';
import type { StreamEvent } from '../../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw and tests can focus on rendering behaviour.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunView', () => {
  it('shows "No active run" placeholder when activeRunId is null', () => {
    render(<RunView />);
    expect(screen.getByText('No active run')).toBeInTheDocument();
  });

  it('renders the active runId header when a run is set', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-123');
    });
    render(<RunView />);

    expect(screen.queryByText('No active run')).not.toBeInTheDocument();
    expect(screen.getByText('run-abc-123')).toBeInTheDocument();
  });

  it('shows "Waiting for events…" before any events arrive', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-123');
    });
    render(<RunView />);
    expect(screen.getByText(/Waiting for events/)).toBeInTheDocument();
  });

  it('renders stream events from the store as JSON blobs', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-abc-123');
    });
    const testEvent: StreamEvent = {
      runId: 'run-abc-123',
      type: 'system',
      payload: { type: 'system', subtype: 'init' },
      timestamp: '2026-05-20T00:00:00Z',
    };
    act(() => {
      useCyboflowStore.getState().appendStreamEvent(testEvent);
    });

    render(<RunView />);

    // Should not show the "waiting" placeholder anymore
    expect(screen.queryByText(/Waiting for events/)).not.toBeInTheDocument();

    // The JSON blob should be visible
    expect(screen.getByText(/system/)).toBeInTheDocument();
  });

  it('does NOT manage the stream-event subscription (subscription is in the store)', () => {
    // Get the mocked subscribeToStreamEvents from the module-level mock.
    const mockSubFn = vi.mocked(subscribeToStreamEvents);

    // Rendering RunView must NOT trigger any additional subscribeToStreamEvents calls
    // (the store already called it when setActiveRun was invoked above).
    const callsBefore = mockSubFn.mock.calls.length;

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-render-test');
    });
    const callsAfterSetActiveRun = mockSubFn.mock.calls.length;
    expect(callsAfterSetActiveRun).toBe(callsBefore + 1); // store called it once

    const { unmount } = render(<RunView />);
    // Mounting RunView should NOT call subscribeToStreamEvents again
    expect(mockSubFn.mock.calls.length).toBe(callsAfterSetActiveRun);

    unmount();
    // Unmounting RunView should NOT trigger additional subscribe calls
    expect(mockSubFn.mock.calls.length).toBe(callsAfterSetActiveRun);
  });
});
