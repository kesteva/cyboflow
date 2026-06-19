/**
 * RunView rendering tests.
 *
 * RunView now backfills its raw event log from the durable `raw_events` store
 * via `cyboflow.runs.listRawEvents` (re-queried on runId change + debounced on
 * live deltas), instead of rendering the in-memory `cyboflowStore.streamEvents`
 * buffer (which is wiped on every `setActiveRun`, erasing the stream when you
 * clicked away from a run and returned). Tests therefore drive events through
 * the `listRawEvents` query mock and assert asynchronously.
 *
 * Behaviors verified:
 *   1. Renders a "No active run" placeholder when activeRunId is null.
 *   2. Renders the runId when an active run is set.
 *   3. Renders "Waiting for events…" once the (empty) backfill resolves.
 *   4. Renders each SDK discriminator (system / assistant / user / result /
 *      stream_event / unknown / session_info / rate_limit_event / run_started)
 *      through its dedicated typed branch (no raw JSON dump).
 *   5. Subscription is NOT managed by RunView (it is managed by the store).
 *   6. Backfill survives a run switch: re-querying on runId change repopulates
 *      the log instead of leaving it erased.
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
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock tRPC client — listRawEvents returns [] by default. Each test sets the
// backfill payload via mockListRawEvents.mockResolvedValue([...]).
// ---------------------------------------------------------------------------

import type { StreamEvent } from '../../../utils/cyboflowApi';

const mockListRawEvents = vi.fn<() => Promise<StreamEvent[]>>(async () => []);

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listRawEvents: {
          query: (...args: unknown[]) => mockListRawEvents(...(args as [])),
        },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunView } from '../RunView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { subscribeToStreamEvents } from '../../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set the backfill payload, activate the run, and render. Returns the render
 * result. Callers then `await screen.findByText(...)` to let the async backfill
 * settle before asserting.
 */
function renderWithEvents(events: StreamEvent[], runId = 'run-1') {
  mockListRawEvents.mockResolvedValue(events);
  act(() => {
    useCyboflowStore.getState().setActiveRun(runId);
  });
  return render(<RunView />);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockListRawEvents.mockResolvedValue([]);
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
    renderWithEvents([], 'run-abc-123');
    expect(screen.queryByText('No active run')).not.toBeInTheDocument();
    expect(screen.getByText('run-abc-123')).toBeInTheDocument();
  });

  it('shows "Waiting for events…" once the empty backfill resolves', async () => {
    renderWithEvents([], 'run-abc-123');
    expect(await screen.findByText(/Waiting for events/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // SDK discriminator branch tests
  // -------------------------------------------------------------------------

  it('routes a system/init event to the typed system branch', async () => {
    const event: StreamEvent = {
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
    renderWithEvents([event]);
    expect(await screen.findByText(/claude-sonnet-4-5/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/wt/)).toBeInTheDocument();
    // Must NOT be a whole-event JSON dump.
    expect(screen.queryByText(/"session_id"/)).not.toBeInTheDocument();
  });

  it('routes an assistant event to the typed assistant branch', async () => {
    const event: StreamEvent = {
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-001',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, I am working on your task now.' }],
        },
      },
      timestamp: '2026-05-20T00:00:01Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText('Hello, I am working on your task now.')).toBeInTheDocument();
    expect(screen.queryByText(/"msg-001"/)).not.toBeInTheDocument();
  });

  it('routes a user event to the typed user branch and shows tool_result content', async () => {
    const event: StreamEvent = {
      type: 'user',
      payload: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01abc', content: 'File written successfully.', is_error: false },
          ],
        },
      },
      timestamp: '2026-05-20T00:00:02Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/File written successfully/)).toBeInTheDocument();
    expect(screen.getByText(/toolu_01/)).toBeInTheDocument();
    expect(screen.queryByText(/"tool_use_id"/)).not.toBeInTheDocument();
  });

  it('routes a result event to the typed result branch and shows subtype and num_turns', async () => {
    const event: StreamEvent = {
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
    renderWithEvents([event]);
    expect(await screen.findByText(/success/)).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument();
    expect(screen.queryByText(/"is_error"/)).not.toBeInTheDocument();
  });

  it('routes a stream_event to the typed stream_event branch as a compact one-line summary', async () => {
    const event: StreamEvent = {
      type: 'stream_event',
      payload: {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'partial text chunk' } },
      },
      timestamp: '2026-05-20T00:00:04Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/content_block_delta/)).toBeInTheDocument();
    expect(screen.queryByText(/"type": "stream_event"/)).not.toBeInTheDocument();
  });

  it('routes an unrecognized event type to the unknown branch with a visible warning', async () => {
    const event: StreamEvent = {
      type: 'unknown',
      payload: { raw: { some_field: 'some_value' } },
      timestamp: '2026-05-20T00:00:05Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/Unrecognized event/)).toBeInTheDocument();
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
    const details = document.querySelector('details');
    expect(details).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Additional edge-case tests
  // -------------------------------------------------------------------------

  it('routes a retired api_retry payload to UnknownEventRow — Unrecognized event', async () => {
    const event: StreamEvent = {
      type: 'unknown',
      payload: { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 1000 },
      timestamp: '2026-05-20T00:00:10Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/Unrecognized event/)).toBeInTheDocument();
    expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
  });

  it('routes a retired compact payload to UnknownEventRow — Unrecognized event', async () => {
    const event: StreamEvent = {
      type: 'unknown',
      payload: { type: 'system', subtype: 'compact', summary: 'Context compacted after 50k tokens.' },
      timestamp: '2026-05-20T00:00:11Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/Unrecognized event/)).toBeInTheDocument();
    expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
  });

  it('routes a system/compact_boundary event to the typed system branch (non-init subtype)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 98000 },
      },
      timestamp: '2026-05-20T00:00:12Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/system\/compact_boundary/)).toBeInTheDocument();
    expect(screen.getByText(/trigger=auto/)).toBeInTheDocument();
    expect(screen.queryByText(/"compact_metadata"/)).not.toBeInTheDocument();
  });

  it('renders assistant event with multiple mixed content blocks (text + tool_use + thinking)', async () => {
    const event: StreamEvent = {
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-multi',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me think about that.' },
            { type: 'thinking', thinking: 'The user wants X, so I should do Y.' },
            { type: 'tool_use', id: 'toolu_abc', name: 'bash', input: { command: 'echo hello' } },
          ],
        },
      },
      timestamp: '2026-05-20T00:00:13Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText('Let me think about that.')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText(/thinking…/)).toBeInTheDocument();
    expect(screen.queryByText(/"msg-multi"/)).not.toBeInTheDocument();
  });

  it('renders result event without total_cost_usd as "n/a"', async () => {
    const event: StreamEvent = {
      type: 'result',
      payload: {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        duration_ms: 9999,
        num_turns: 20,
      },
      timestamp: '2026-05-20T00:00:14Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/error_max_turns/)).toBeInTheDocument();
    expect(screen.getByText(/n\/a/)).toBeInTheDocument();
    expect(screen.queryByText(/"is_error"/)).not.toBeInTheDocument();
  });

  it('renders stream_event content_block_delta text inline in the compact summary', async () => {
    const event: StreamEvent = {
      type: 'stream_event',
      payload: {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streaming text token' } },
      },
      timestamp: '2026-05-20T00:00:15Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/content_block_delta/)).toBeInTheDocument();
    expect(screen.getByText(/streaming text token/)).toBeInTheDocument();
    expect(screen.queryByText(/"type": "stream_event"/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Typed event branch tests (session_info / rate_limit / hooks / status)
  // -------------------------------------------------------------------------

  it('routes a session_info event to the typed SessionInfoEventRow', async () => {
    const event: StreamEvent = {
      type: 'session_info',
      payload: {
        type: 'session_info',
        initial_prompt: 'Refactor the parser module.',
        claude_command: 'sdk-in-process',
        worktree_path: '/tmp/cyboflow-wt-test',
        model: 'claude-sonnet-4-5',
        permission_mode: 'approve',
        timestamp: '2026-05-21T00:00:00.000Z',
      },
      timestamp: '2026-05-21T00:00:00.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/Run started/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/cyboflow-wt-test/)).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet-4-5/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a rate_limit_event to the typed RateLimitEventRow (shows status text)', async () => {
    const event: StreamEvent = {
      type: 'rate_limit_event',
      payload: {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1747776000, rateLimitType: 'five_hour', utilization: 0.85 },
        uuid: 'b2c3d4e5-0000-0000-0000-000000000001',
        session_id: 'sess-rl-test',
      },
      timestamp: '2026-05-21T00:00:01.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/allowed_warning/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/hook_started event to the typed SystemEventRow (shows hook_name)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'hook-001',
        hook_name: 'pre-tool-use',
        hook_event: 'PreToolUse',
        uuid: 'c3d4e5f6-0000-0000-0000-000000000002',
        session_id: 'sess-hs-test',
      },
      timestamp: '2026-05-21T00:00:02.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/system\/hook_started/)).toBeInTheDocument();
    expect(screen.getByText(/pre-tool-use/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/hook_response event to the typed SystemEventRow (shows outcome)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hook-001',
        hook_name: 'pre-tool-use',
        hook_event: 'PreToolUse',
        output: 'ok',
        stdout: '',
        stderr: '',
        exit_code: 0,
        outcome: 'success',
        uuid: 'd4e5f6a7-0000-0000-0000-000000000003',
        session_id: 'sess-hr-test',
      },
      timestamp: '2026-05-21T00:00:03.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/system\/hook_response/)).toBeInTheDocument();
    expect(screen.getByText(/success/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/status event to the typed SystemEventRow (shows status value)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'status',
        status: 'requesting',
        uuid: 'e5f6a7b8-0000-0000-0000-000000000004',
        session_id: 'sess-st-test',
      },
      timestamp: '2026-05-21T00:00:04.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/system\/status/)).toBeInTheDocument();
    expect(screen.getByText(/requesting/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('renders system/status with status=null as the literal "null" string (null-coalesce branch)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'status',
        status: null,
        uuid: 'f6a7b8c9-0000-0000-0000-000000000005',
        session_id: 'sess-st-null',
      },
      timestamp: '2026-05-21T00:00:05.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/status=null/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('renders system/hook_response with outcome=error (error color branch, not UnknownEventRow)', async () => {
    const event: StreamEvent = {
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hook-002',
        hook_name: 'post-tool-use',
        hook_event: 'PostToolUse',
        output: '',
        stdout: '',
        stderr: 'hook script exited with code 1',
        exit_code: 1,
        outcome: 'error',
        uuid: 'a7b8c9d0-0000-0000-0000-000000000006',
        session_id: 'sess-hr-error',
      },
      timestamp: '2026-05-21T00:00:06.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(/system\/hook_response/)).toBeInTheDocument();
    expect(screen.getByText(/post-tool-use/)).toBeInTheDocument();
    const errorElements = screen.getAllByText(/^error$/);
    expect(errorElements.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('truncates session_info initial_prompt longer than 120 chars with an ellipsis', async () => {
    const longPrompt = 'A'.repeat(130);
    const event: StreamEvent = {
      type: 'session_info',
      payload: {
        type: 'session_info',
        initial_prompt: longPrompt,
        claude_command: 'sdk-in-process',
        worktree_path: '/tmp/cyboflow-wt-trunc',
        model: 'claude-sonnet-4-5',
        permission_mode: 'approve',
        timestamp: '2026-05-21T00:00:07.000Z',
      },
      timestamp: '2026-05-21T00:00:07.000Z',
    };
    renderWithEvents([event]);
    expect(await screen.findByText(`${'A'.repeat(120)}…`)).toBeInTheDocument();
    expect(screen.queryByText(longPrompt)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // run_started event branch tests
  // -------------------------------------------------------------------------

  it('routes a run_started event to RunStartedEventRow (shows "Starting" placeholder)', async () => {
    const event: StreamEvent = {
      type: 'run_started',
      payload: {
        type: 'run_started',
        runId: 'run-started-test',
        worktreePath: '/tmp/cyboflow-wt-starting',
        branchName: 'cyboflow/my-workflow-abc12345',
      },
      timestamp: '2026-05-21T00:00:08.000Z',
    };
    renderWithEvents([event], 'run-started-test');
    expect(await screen.findByText(/Starting/)).toBeInTheDocument();
    expect(screen.getByText(/cyboflow\/my-workflow-abc12345/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('RunStartedEventRow truncates runId to 8 chars followed by an ellipsis', async () => {
    const longRunId = 'abcdef1234567890'; // 16 chars; first 8 = 'abcdef12'
    const event: StreamEvent = {
      type: 'run_started',
      payload: {
        type: 'run_started',
        runId: longRunId,
        worktreePath: '/tmp/cyboflow-wt-truncid',
        branchName: 'cyboflow/trunc-id-branch',
      },
      timestamp: '2026-05-21T00:00:09.000Z',
    };
    renderWithEvents([event], longRunId);
    expect(await screen.findByText('abcdef12…')).toBeInTheDocument();
    expect(screen.getByText(/cyboflow\/trunc-id-branch/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Backfill-on-return: the original bug — switching runs must repopulate the
  // log from the durable store rather than leaving it erased.
  // -------------------------------------------------------------------------

  it('re-queries listRawEvents when the active run changes (backfill survives a switch)', async () => {
    const eventA: StreamEvent = {
      type: 'assistant',
      payload: { type: 'assistant', message: { id: 'm-a', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'History for run A' }] } },
      timestamp: '2026-05-22T00:00:00Z',
    };
    const eventB: StreamEvent = {
      type: 'assistant',
      payload: { type: 'assistant', message: { id: 'm-b', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'History for run B' }] } },
      timestamp: '2026-05-22T00:00:01Z',
    };

    const { rerender } = renderWithEvents([eventA], 'run-A');
    expect(await screen.findByText('History for run A')).toBeInTheDocument();

    // Switch to run B — its persisted history must repopulate (not stay erased).
    mockListRawEvents.mockResolvedValue([eventB]);
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-B');
    });
    rerender(<RunView />);
    expect(await screen.findByText('History for run B')).toBeInTheDocument();
    expect(screen.queryByText('History for run A')).not.toBeInTheDocument();
  });

  it('does NOT manage the stream-event subscription (subscription is in the store)', () => {
    const mockSubFn = vi.mocked(subscribeToStreamEvents);
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
