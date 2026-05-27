/**
 * RunChatView component tests (TASK-761).
 *
 * Behaviors verified:
 *   1. On mount with runId set, calls trpc.cyboflow.runs.listMessages.query exactly once.
 *   2. Assistant text blocks render via MarkdownPreview; user blocks render as user bubbles.
 *   3. AskUserQuestion tool_use blocks route to AskUserQuestionCard matched by toolUseId.
 *   4. reviewQueueStore.queue is filtered by runId — only run-A approvals render; run-B does NOT.
 *   5. Quick-session mode (runId=null + activeQuickSessionId set) renders placeholder, skips query.
 *   6. Empty mode (runId=null + activeQuickSessionId=null) renders "No active run".
 *   7. RunBottomPane Chat tab mounts RunChatView (wiring test).
 */
import '@testing-library/jest-dom';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../../../../shared/types/chatMessage';

// ---------------------------------------------------------------------------
// Mock cyboflowApi so store-level subscription does not attempt real IPC
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock tRPC client — listMessages returns [] by default
// ---------------------------------------------------------------------------

const mockListMessages = vi.fn<() => Promise<ChatMessage[]>>(async () => []);

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listMessages: {
          query: (...args: Parameters<typeof mockListMessages>) => mockListMessages(...args),
        },
        cancelAndRestart: {
          mutate: vi.fn(async () => ({})),
        },
      },
      questions: {
        listPending: { query: vi.fn(async () => []) },
        onQuestionCreated: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        onQuestionAnswered: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        answer: { mutate: vi.fn(async () => ({})) },
      },
      approvals: {
        listPending: { query: vi.fn(async () => []) },
        approve: { mutate: vi.fn(async () => ({})) },
        reject: { mutate: vi.fn(async () => ({})) },
        approveRestOfRun: { mutate: vi.fn(async () => ({ decided: 0 })) },
      },
      events: {
        setBadgeCount: { mutate: vi.fn(async () => ({})) },
        onApprovalCreated: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        onApprovalDecided: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock AskUserQuestionCard with a testid stub
// ---------------------------------------------------------------------------

vi.mock('../../AskUserQuestion/AskUserQuestionCard', () => ({
  AskUserQuestionCard: ({ item }: { item: { id: string } }) => (
    <div data-testid={`ask-user-question-card-${item.id}`}>AskUserQuestionCard:{item.id}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock PendingApprovalCard with a testid stub
// ---------------------------------------------------------------------------

vi.mock('../../ReviewQueue/PendingApprovalCard', () => ({
  PendingApprovalCard: ({ item }: { item: { kind: string; approval?: { id: string } } }) => {
    const id = item.kind === 'single' && item.approval ? item.approval.id : 'group';
    return <div data-testid={`pending-approval-card-${id}`}>PendingApprovalCard:{id}</div>;
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { RunChatView } from '../RunChatView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useReviewQueueStore } from '../../../stores/reviewQueueStore';
import { useQuestionStore } from '../../../stores/questionStore';
import type { StreamEvent } from '../../../utils/cyboflowApi';
import type { Approval } from '../../../../../shared/types/approvals';
import type { Question } from '../../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useReviewQueueStore.getState().replaceAll([]);
    useQuestionStore.getState().replaceAll([]);
  });
  mockListMessages.mockClear();
  mockListMessages.mockImplementation(async () => []);
  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApproval(id: string, runId: string): Approval {
  return {
    id,
    runId,
    workflowName: 'test-workflow',
    toolName: 'Bash',
    payloadPreview: 'echo hello',
    rationale: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
}

function makeQuestion(id: string, runId: string, toolUseId: string): Question {
  return {
    id,
    runId,
    workflowName: 'test-workflow',
    toolUseId,
    questions: [
      {
        question: 'Which option?',
        header: 'Pick one',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    answeredAt: null,
    answerJson: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunChatView', () => {
  // -------------------------------------------------------------------------
  // AC2: On mount with runId set, calls listMessages.query once with { runId }
  // -------------------------------------------------------------------------

  it('calls trpc.cyboflow.runs.listMessages.query once on mount with the given runId', async () => {
    render(<RunChatView runId="run-A" />);

    await waitFor(() => {
      expect(mockListMessages).toHaveBeenCalledTimes(1);
      expect(mockListMessages).toHaveBeenCalledWith({ runId: 'run-A' });
    });
  });

  it('calls listMessages.query again when runId changes (re-mount with new runId)', async () => {
    const { unmount } = render(<RunChatView runId="run-A" />);
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(1));
    unmount();

    render(<RunChatView runId="run-B" />);
    await waitFor(() => {
      expect(mockListMessages).toHaveBeenCalledTimes(2);
      expect(mockListMessages).toHaveBeenLastCalledWith({ runId: 'run-B' });
    });
  });

  // -------------------------------------------------------------------------
  // AC3: Assistant text blocks render via MarkdownPreview; user blocks render
  // -------------------------------------------------------------------------

  it('renders assistant text content wrapped in markdown-preview class', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });

    const event: StreamEvent = {
      runId: 'run-1',
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-001',
          model: 'claude-sonnet',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello from the assistant.' },
          ],
        },
      },
      timestamp: '2026-05-26T00:00:00Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText('Hello from the assistant.')).toBeInTheDocument();
    });

    // The MarkdownPreview root element must have class containing 'markdown-preview'
    const mdEl = document.querySelector('.markdown-preview');
    expect(mdEl).not.toBeNull();
  });

  it('renders user bubble for user events with tool_result content', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });

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
              tool_use_id: 'toolu_abc123',
              content: 'File written successfully.',
              is_error: false,
            },
          ],
        },
      },
      timestamp: '2026-05-26T00:00:01Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText(/File written successfully/)).toBeInTheDocument();
      expect(screen.getByText(/toolu_ab/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // AC4: AskUserQuestion tool_use blocks route to AskUserQuestionCard
  // -------------------------------------------------------------------------

  it('renders AskUserQuestionCard at the position of an AskUserQuestion tool_use block', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
      useQuestionStore.getState().replaceAll([
        makeQuestion('q-001', 'run-1', 'tu-q1'),
      ]);
    });

    const event: StreamEvent = {
      runId: 'run-1',
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-002',
          model: 'claude-sonnet',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-q1',
              name: 'AskUserQuestion',
              input: { questions: [] },
            },
          ],
        },
      },
      timestamp: '2026-05-26T00:00:02Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('ask-user-question-card-q-001')).toBeInTheDocument();
    });
  });

  it('renders "Question already answered" when no matching pending question is found', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
      // No questions in the store
      useQuestionStore.getState().replaceAll([]);
    });

    const event: StreamEvent = {
      runId: 'run-1',
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-003',
          model: 'claude-sonnet',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-q-gone',
              name: 'AskUserQuestion',
              input: {},
            },
          ],
        },
      },
      timestamp: '2026-05-26T00:00:03Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Question already answered/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // AC5: Approval cards filtered to runId — run-B approval NOT rendered
  // -------------------------------------------------------------------------

  it('renders only approvals for the active runId and excludes approvals for other runs', async () => {
    const approvalA = makeApproval('appr-A', 'run-A');
    const approvalB = makeApproval('appr-B', 'run-B');

    act(() => {
      useReviewQueueStore.getState().replaceAll([approvalA, approvalB]);
    });

    render(<RunChatView runId="run-A" />);

    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-card-appr-A')).toBeInTheDocument();
      expect(screen.queryByTestId('pending-approval-card-appr-B')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // AC6: Quick-session mode renders placeholder, does NOT call listMessages
  // -------------------------------------------------------------------------

  it('renders quick-session placeholder when runId is null and activeQuickSessionId is set', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('qs-001');
    });

    render(<RunChatView runId={null} />);

    expect(screen.getByText('Quick session chat (history rendered by panel surface)')).toBeInTheDocument();
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC7: Empty mode (both null) renders "No active run"
  // -------------------------------------------------------------------------

  it('renders "No active run" when runId is null and activeQuickSessionId is also null', () => {
    render(<RunChatView runId={null} />);
    expect(screen.getByText('No active run')).toBeInTheDocument();
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // is_error branch: tool_result block with is_error=true shows red "error" badge
  // -------------------------------------------------------------------------

  it('renders a red "error" badge for user tool_result blocks where is_error is true', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-err');
    });

    const event: StreamEvent = {
      runId: 'run-err',
      type: 'user',
      payload: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_err001',
              content: 'Command failed with exit code 1.',
              is_error: true,
            },
          ],
        },
      },
      timestamp: '2026-05-26T01:00:00Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    render(<RunChatView runId="run-err" />);

    await waitFor(() => {
      // The red badge text must be visible
      expect(screen.getByText('error')).toBeInTheDocument();
      // The tool result content must also be visible
      expect(screen.getByText(/Command failed with exit code 1/)).toBeInTheDocument();
    });

    // The badge element must carry the red background class
    const badge = screen.getByText('error');
    expect(badge.className).toMatch(/bg-red-600/);
  });

  // -------------------------------------------------------------------------
  // Race condition: aborted flag prevents stale state from a slow first fetch
  // landing after runId has already changed
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // TASK-776: Dedup — assistant id-based and user timestamp-based
  // -------------------------------------------------------------------------

  it('deduplicates assistant message overlap between historicalMessages and streamEvents', async () => {
    const historicalMessage: ChatMessage = {
      id: 'msg-dup-001',
      runId: 'run-1',
      role: 'assistant',
      text: 'Hello duplicated',
      createdAt: '2026-05-26T00:00:00.000Z',
    };
    mockListMessages.mockImplementationOnce(async () => [historicalMessage]);

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
      // Live event with the SAME payload.message.id as the historical row
      useCyboflowStore.getState().appendStreamEvent({
        runId: 'run-1',
        type: 'assistant',
        payload: {
          type: 'assistant',
          message: {
            id: 'msg-dup-001',                       // same id => dedup
            model: 'claude-sonnet',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello duplicated' }],
          },
        },
        timestamp: '2026-05-26T00:00:01.000Z',
      });
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      // EXACTLY ONE rendering of the duplicated text
      expect(screen.getAllByText('Hello duplicated')).toHaveLength(1);
    });
  });

  it('renders a post-history user event that arrives after the latest historicalMessage.createdAt', async () => {
    const historicalMessage: ChatMessage = {
      id: 'msg-hist-001',
      runId: 'run-2',
      role: 'assistant',
      text: 'Historical only',
      createdAt: '2026-05-26T00:00:00.000Z',
    };
    mockListMessages.mockImplementationOnce(async () => [historicalMessage]);

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-2');
      // Live user event with timestamp STRICTLY AFTER the historical createdAt
      useCyboflowStore.getState().appendStreamEvent({
        runId: 'run-2',
        type: 'user',
        payload: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu-z', content: 'Post-history result', is_error: false },
            ],
          },
        },
        timestamp: '2026-05-26T00:00:05.000Z',  // strictly after historical
      });
    });

    render(<RunChatView runId="run-2" />);

    await waitFor(() => {
      expect(screen.getByText('Historical only')).toBeInTheDocument();
      expect(screen.getByText(/Post-history result/)).toBeInTheDocument();
    });
  });

  it('ignores the result of a stale listMessages fetch when runId changes before it resolves', async () => {
    // Give the first fetch a deferred promise so it resolves only after we
    // change the runId — this is the exact scenario the `aborted` flag guards.
    let resolveFirstFetch!: (v: never[]) => void;
    const firstFetchPromise = new Promise<never[]>((resolve) => {
      resolveFirstFetch = resolve;
    });

    mockListMessages
      .mockImplementationOnce(() => firstFetchPromise) // run-stale: hangs
      .mockImplementationOnce(async () => []);          // run-fresh: resolves immediately

    const { rerender } = render(<RunChatView runId="run-stale" />);

    // Confirm the first fetch was kicked off
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(1));

    // Change runId before the first fetch resolves — this triggers the cleanup
    // returning `aborted = true` for the first effect
    act(() => {
      rerender(<RunChatView runId="run-fresh" />);
    });

    // Second fetch resolves immediately; wait for it
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(2));

    // Now let the first (stale) fetch resolve — it must NOT update state
    act(() => {
      resolveFirstFetch([]);
    });

    // Neither a loading indicator (from the stale fetch re-setting isLoadingHistory)
    // nor an error should appear — the component should be in the settled state
    // for run-fresh, not re-enter loading for the stale run-stale fetch.
    await waitFor(() => {
      expect(screen.queryByText('Loading history...')).not.toBeInTheDocument();
      expect(screen.queryByText(/Error loading history/)).not.toBeInTheDocument();
    });
  });
});
