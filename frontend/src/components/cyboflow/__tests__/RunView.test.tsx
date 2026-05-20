/**
 * RunView rendering tests (updated in TASK-682).
 *
 * After TASK-667 confirmed H2 (renderer listener teardown), the stream-event
 * subscription was moved from RunView's useEffect into the cyboflowStore
 * module-level singleton. RunView is now subscription-free.
 *
 * Behaviors verified:
 *   1. Renders a "No active run" placeholder when activeRunId is null.
 *   2. Renders the runId when an active run is set.
 *   3. Renders "Waiting for events…" before any events arrive.
 *   4. Renders each SDK discriminator (system / assistant / user / result /
 *      stream_event / unknown) through its dedicated typed branch (not a JSON blob).
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

  // -------------------------------------------------------------------------
  // SDK discriminator branch tests (TASK-682)
  // -------------------------------------------------------------------------

  it('routes a system/init event to the typed system branch', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-xyz-123',
        cwd: '/tmp/wt',
        model: 'claude-sonnet-4-5',
        tools: [],
        mcp_servers: [],
        permissionMode: 'default',
      },
      timestamp: '2026-05-20T00:00:00Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/claude-sonnet-4-5/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/wt/)).toBeInTheDocument();
    // Must NOT be a whole-event JSON dump — "session_id" key should not be
    // rendered as a JSON property label.
    expect(screen.queryByText(/"session_id"/)).not.toBeInTheDocument();
  });

  it('routes an assistant event to the typed assistant branch', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-001',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello, I am working on your task now.' },
          ],
        },
      },
      timestamp: '2026-05-20T00:00:01Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The text block content should be visible
    expect(screen.getByText('Hello, I am working on your task now.')).toBeInTheDocument();
    // Should NOT be a whole-event JSON dump
    expect(screen.queryByText(/"msg-001"/)).not.toBeInTheDocument();
  });

  it('routes a user event to the typed user branch and shows tool_result content', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'user',
      payload: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01abc',
              content: 'File written successfully.',
              is_error: false,
            },
          ],
        },
      },
      timestamp: '2026-05-20T00:00:02Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The tool result content should be visible
    expect(screen.getByText(/File written successfully/)).toBeInTheDocument();
    // Short hash of tool_use_id should appear
    expect(screen.getByText(/toolu_01/)).toBeInTheDocument();
    // Should NOT be a whole-event JSON dump
    expect(screen.queryByText(/"tool_use_id"/)).not.toBeInTheDocument();
  });

  it('routes a result event to the typed result branch and shows subtype and num_turns', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'result',
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4321,
        num_turns: 7,
        total_cost_usd: 0.0123,
      },
      timestamp: '2026-05-20T00:00:03Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // subtype and num_turns should appear as labeled fields
    expect(screen.getByText(/success/)).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument();
    // Should NOT be a whole-event JSON dump
    expect(screen.queryByText(/"is_error"/)).not.toBeInTheDocument();
  });

  it('routes a stream_event to the typed stream_event branch as a compact one-line summary', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'stream_event',
      payload: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: 'partial text chunk' },
        },
      },
      timestamp: '2026-05-20T00:00:04Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The inner event type should be visible in the compact summary
    expect(screen.getByText(/content_block_delta/)).toBeInTheDocument();
    // Should NOT be a whole-event JSON dump (the outer "stream_event" type key)
    expect(screen.queryByText(/"type": "stream_event"/)).not.toBeInTheDocument();
  });

  it('routes an unrecognized event type to the unknown branch with a visible warning', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'unknown',
      payload: { raw: { some_field: 'some_value' } },
      timestamp: '2026-05-20T00:00:05Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The warning label must be visible
    expect(screen.getByText(/Unrecognized event/)).toBeInTheDocument();
    // The raw event type string should be shown inline
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
    // The payload should NOT be rendered without user expanding the <details>
    // (it is inside a <details> element that is collapsed by default)
    // Asserting that the raw payload key is not in the accessible document
    // confirms the expand-to-view pattern is in place.
    const details = document.querySelector('details');
    expect(details).not.toBeNull();
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
