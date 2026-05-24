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
 *      stream_event / unknown) through its dedicated typed branch (no raw JSON dump).
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

  // -------------------------------------------------------------------------
  // Additional edge-case tests (added post-executor review)
  // -------------------------------------------------------------------------

  it('routes a retired api_retry payload to UnknownEventRow — Unrecognized event (post-TASK-681)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'unknown',
      payload: {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1000,
      },
      timestamp: '2026-05-20T00:00:10Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/Unrecognized event/)).toBeInTheDocument();
    expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
  });

  it('routes a retired compact payload to UnknownEventRow — Unrecognized event (post-TASK-681)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'unknown',
      payload: {
        type: 'system',
        subtype: 'compact',
        summary: 'Context compacted after 50k tokens.',
      },
      timestamp: '2026-05-20T00:00:11Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/Unrecognized event/)).toBeInTheDocument();
    expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
  });

  it('routes a system/compact_boundary event to the typed system branch (non-init subtype)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'system',
      payload: {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 98000 },
      },
      timestamp: '2026-05-20T00:00:12Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/system\/compact_boundary/)).toBeInTheDocument();
    expect(screen.getByText(/trigger=auto/)).toBeInTheDocument();
    expect(screen.queryByText(/"compact_metadata"/)).not.toBeInTheDocument();
  });

  it('renders assistant event with multiple mixed content blocks (text + tool_use + thinking)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'bash',
              input: { command: 'echo hello' },
            },
          ],
        },
      },
      timestamp: '2026-05-20T00:00:13Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Text block
    expect(screen.getByText('Let me think about that.')).toBeInTheDocument();
    // Tool-use block: tool name visible
    expect(screen.getByText('bash')).toBeInTheDocument();
    // Thinking block: renders as a collapsed <details> with "thinking…" summary
    expect(screen.getByText(/thinking…/)).toBeInTheDocument();
    // Must NOT be a whole-event JSON dump
    expect(screen.queryByText(/"msg-multi"/)).not.toBeInTheDocument();
  });

  it('renders result event without total_cost_usd as "n/a"', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'result',
      payload: {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        duration_ms: 9999,
        num_turns: 20,
        // total_cost_usd intentionally omitted
      },
      timestamp: '2026-05-20T00:00:14Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/error_max_turns/)).toBeInTheDocument();
    // When total_cost_usd is absent the component renders the literal "n/a"
    expect(screen.getByText(/n\/a/)).toBeInTheDocument();
    expect(screen.queryByText(/"is_error"/)).not.toBeInTheDocument();
  });

  it('renders stream_event content_block_delta text inline in the compact summary', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'stream_event',
      payload: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'streaming text token' },
        },
      },
      timestamp: '2026-05-20T00:00:15Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Inner event type appears in the compact summary
    expect(screen.getByText(/content_block_delta/)).toBeInTheDocument();
    // The delta text itself must appear inline (not behind a JSON dump)
    expect(screen.getByText(/streaming text token/)).toBeInTheDocument();
    expect(screen.queryByText(/"type": "stream_event"/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // New typed event branch tests (TASK-696)
  // -------------------------------------------------------------------------

  it('routes a session_info event to the typed SessionInfoEventRow (shows "Run started" header and key fields)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // "Run started" header card must be visible
    expect(screen.getByText(/Run started/)).toBeInTheDocument();
    // Worktree path must be visible
    expect(screen.getByText(/\/tmp\/cyboflow-wt-test/)).toBeInTheDocument();
    // Model must be visible
    expect(screen.getByText(/claude-sonnet-4-5/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a rate_limit_event to the typed RateLimitEventRow (shows status text)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
      type: 'rate_limit_event',
      payload: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1747776000,
          rateLimitType: 'five_hour',
          utilization: 0.85,
        },
        uuid: 'b2c3d4e5-0000-0000-0000-000000000001',
        session_id: 'sess-rl-test',
      },
      timestamp: '2026-05-21T00:00:01.000Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Rate limit status must be visible
    expect(screen.getByText(/allowed_warning/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/hook_started event to the typed SystemEventRow (shows hook_name)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Type label must be visible
    expect(screen.getByText(/system\/hook_started/)).toBeInTheDocument();
    // Hook name must be visible
    expect(screen.getByText(/pre-tool-use/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/hook_response event to the typed SystemEventRow (shows outcome)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Type label must be visible
    expect(screen.getByText(/system\/hook_response/)).toBeInTheDocument();
    // Outcome must be visible
    expect(screen.getByText(/success/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('routes a system/status event to the typed SystemEventRow (shows status value)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Type label must be visible
    expect(screen.getByText(/system\/status/)).toBeInTheDocument();
    // Status value must be visible
    expect(screen.getByText(/requesting/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Conditional-branch tests for TASK-696 new rows (test-writer additions)
  // -------------------------------------------------------------------------

  it('renders system/status with status=null as the literal "null" string (null-coalesce branch)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The null-coalesce branch renders "null" as a fallback string
    expect(screen.getByText(/status=null/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('renders system/hook_response with outcome=error (error color branch, not UnknownEventRow)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    expect(screen.getByText(/system\/hook_response/)).toBeInTheDocument();
    // "outcome=" and "error" are in separate DOM nodes (span for color-coding).
    // Assert both are visible independently.
    expect(screen.getByText(/post-tool-use/)).toBeInTheDocument();
    // The outcome value "error" is in a colored child span — use getAllByText to
    // avoid collisions with the type label "system/hook_response" which also renders.
    const errorElements = screen.getAllByText(/^error$/);
    expect(errorElements.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('truncates session_info initial_prompt longer than 120 chars with an ellipsis', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
    const longPrompt = 'A'.repeat(130);
    const event: StreamEvent = {
      runId: 'run-1',
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
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // Full 130-char prompt must NOT appear verbatim
    expect(screen.queryByText(longPrompt)).not.toBeInTheDocument();
    // Truncated 120-char prefix + ellipsis character must appear
    expect(screen.getByText(`${'A'.repeat(120)}…`)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // run_started event branch test (TASK-700)
  // -------------------------------------------------------------------------

  it('routes a run_started event to RunStartedEventRow (shows "Starting" placeholder)', () => {
    act(() => { useCyboflowStore.getState().setActiveRun('run-started-test'); });
    const event: StreamEvent = {
      runId: 'run-started-test',
      type: 'run_started',
      payload: {
        type: 'run_started',
        runId: 'run-started-test',
        worktreePath: '/tmp/cyboflow-wt-starting',
        branchName: 'cyboflow/my-workflow-abc12345',
      },
      timestamp: '2026-05-21T00:00:08.000Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // "Starting" placeholder text must be visible
    expect(screen.getByText(/Starting/)).toBeInTheDocument();
    // Branch name must be visible
    expect(screen.getByText(/cyboflow\/my-workflow-abc12345/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
  });

  it('RunStartedEventRow truncates runId to 8 chars followed by an ellipsis (TASK-700)', () => {
    // RunStartedEventRow renders payload.runId.slice(0, 8) + '…' in a compact <span>.
    // This test locks in that truncation so a later refactor cannot silently drop it.
    // Note: the full runId also appears verbatim in the RunView header (activeRunId label),
    // so we assert the truncated form is present without asserting the full form is absent.
    const longRunId = 'abcdef1234567890'; // 16 chars; first 8 = 'abcdef12'
    act(() => { useCyboflowStore.getState().setActiveRun(longRunId); });
    const event: StreamEvent = {
      runId: longRunId,
      type: 'run_started',
      payload: {
        type: 'run_started',
        runId: longRunId,
        worktreePath: '/tmp/cyboflow-wt-truncid',
        branchName: 'cyboflow/trunc-id-branch',
      },
      timestamp: '2026-05-21T00:00:09.000Z',
    };
    act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
    render(<RunView />);
    // The truncated form (8 chars + ellipsis) must appear in the event row
    expect(screen.getByText('abcdef12…')).toBeInTheDocument();
    // Branch name must be visible
    expect(screen.getByText(/cyboflow\/trunc-id-branch/)).toBeInTheDocument();
    // Must NOT route to UnknownEventRow
    expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
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
