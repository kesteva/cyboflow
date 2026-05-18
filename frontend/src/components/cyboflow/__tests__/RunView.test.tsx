// @vitest-environment jsdom
/**
 * RunView subscription lifecycle tests (TASK-602).
 *
 * Behaviors verified:
 *   1. Renders a "No active run" placeholder when activeRunId is null.
 *   2. Calls subscribeToStreamEvents with the correct runId when activeRunId
 *      is set.
 *   3. Calls the returned unsubscribe when the component unmounts (cleanup).
 *   4. Calls unsubscribe for the old runId and subscribes to the new runId
 *      when activeRunId changes.
 *
 * Design:
 *   - cyboflowApi is mocked at module level.  Because vi.mock factories are
 *     hoisted before variable initialization, the subscribe spy is installed
 *     via vi.mocked() AFTER import rather than referenced in the factory.
 *   - useCyboflowStore is used directly (real Zustand store, reset between
 *     tests via clearActiveRun / act).
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi before importing the component.
// The factory cannot reference top-level variables (hoisting), so we return
// a vi.fn() directly and retrieve the spy later via vi.mocked().
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(),
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunView } from '../RunView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { cyboflowApi } from '../../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Convenience aliases for the mocked functions
// ---------------------------------------------------------------------------

const mockSubscribe = vi.mocked(cyboflowApi.subscribeToStreamEvents);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setActiveRun(runId: string) {
  act(() => {
    useCyboflowStore.getState().setActiveRun(runId);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockReset();
  // Default: each call returns a fresh unsubscribe spy
  mockSubscribe.mockReturnValue(vi.fn());
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw and tests can focus on subscription behaviour.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunView', () => {
  it('shows "No active run" placeholder when activeRunId is null', () => {
    render(<RunView />);
    expect(screen.getByText('No active run')).toBeInTheDocument();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('calls subscribeToStreamEvents with the active runId when a run is set', () => {
    setActiveRun('run-abc-123');
    render(<RunView />);

    expect(mockSubscribe).toHaveBeenCalledOnce();
    const callArg = mockSubscribe.mock.calls[0][0] as {
      runId: string;
      onEvent: (e: unknown) => void;
    };
    expect(callArg.runId).toBe('run-abc-123');
    expect(typeof callArg.onEvent).toBe('function');
  });

  it('calls unsubscribe when the component unmounts', () => {
    const unsubscribeSpy = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribeSpy);

    setActiveRun('run-unmount-test');
    const { unmount } = render(<RunView />);

    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });

  it('unsubscribes from old runId and subscribes to new runId when activeRunId changes', () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);

    setActiveRun('run-first');
    const { rerender } = render(<RunView />);

    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect((mockSubscribe.mock.calls[0][0] as { runId: string }).runId).toBe('run-first');

    // Switch to a new run — triggers useEffect cleanup + re-subscribe
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-second');
    });
    rerender(<RunView />);

    // The old subscription must have been cleaned up
    expect(firstUnsubscribe).toHaveBeenCalledOnce();

    // A new subscription must have been opened for the new runId
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect((mockSubscribe.mock.calls[1][0] as { runId: string }).runId).toBe('run-second');
  });
});
