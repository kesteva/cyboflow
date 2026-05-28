/**
 * RunChatView component tests (Phase 3 chat unification).
 *
 * RunChatView now renders through the shared <ChatTranscript> fed by
 * `cyboflow.runs.listUnifiedMessages`. Behaviors verified:
 *   1. On mount with runId set, calls listUnifiedMessages.query once with { runId }.
 *   2. Re-queries with the new runId when runId changes.
 *   3. UnifiedMessage assistant/user text renders through the transcript.
 *   4. AskUserQuestion tool_call segments route to an inline AskUserQuestionCard
 *      via the renderToolCallExtra hook, matched by toolUseId.
 *   5. PendingApprovalsForRun is filtered by runId — only run-A approvals render.
 *   6. Quick-session mode (runId=null + activeQuickSessionId set) renders placeholder, skips query.
 *   7. Empty mode (runId=null + activeQuickSessionId=null) renders "No active run".
 *   8. A debounced live re-query fires after streamEvents change.
 */
import '@testing-library/jest-dom';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

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
// Mock tRPC client — listUnifiedMessages returns [] by default
// ---------------------------------------------------------------------------

const mockListUnifiedMessages = vi.fn<() => Promise<UnifiedMessage[]>>(async () => []);

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listUnifiedMessages: {
          query: (...args: Parameters<typeof mockListUnifiedMessages>) => mockListUnifiedMessages(...args),
        },
        listMessages: {
          query: vi.fn(async () => []),
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
  mockListUnifiedMessages.mockClear();
  mockListUnifiedMessages.mockImplementation(async () => []);
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

function assistantText(id: string, text: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    timestamp: '2026-05-26T00:00:00Z',
    segments: [{ type: 'text', content: text }],
  };
}

function userText(id: string, text: string): UnifiedMessage {
  return {
    id,
    role: 'user',
    timestamp: '2026-05-26T00:00:00Z',
    segments: [{ type: 'text', content: text }],
  };
}

function askQuestionMessage(id: string, toolUseId: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    timestamp: '2026-05-26T00:00:02Z',
    segments: [
      {
        type: 'tool_call',
        tool: {
          id: toolUseId,
          name: 'AskUserQuestion',
          input: { questions: [] },
          status: 'pending',
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunChatView', () => {
  it('calls listUnifiedMessages.query once on mount with the given runId', async () => {
    render(<RunChatView runId="run-A" />);

    await waitFor(() => {
      expect(mockListUnifiedMessages).toHaveBeenCalledTimes(1);
      expect(mockListUnifiedMessages).toHaveBeenCalledWith({ runId: 'run-A' });
    });
  });

  it('re-queries listUnifiedMessages when runId changes (re-mount with new runId)', async () => {
    const { unmount } = render(<RunChatView runId="run-A" />);
    await waitFor(() => expect(mockListUnifiedMessages).toHaveBeenCalledTimes(1));
    unmount();

    render(<RunChatView runId="run-B" />);
    await waitFor(() => {
      expect(mockListUnifiedMessages).toHaveBeenCalledTimes(2);
      expect(mockListUnifiedMessages).toHaveBeenLastCalledWith({ runId: 'run-B' });
    });
  });

  it('renders assistant and user text from the unified projection', async () => {
    mockListUnifiedMessages.mockImplementationOnce(async () => [
      userText('u-1', 'A user prompt.'),
      assistantText('a-1', 'Hello from the assistant.'),
    ]);

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText('Hello from the assistant.')).toBeInTheDocument();
      expect(screen.getByText('A user prompt.')).toBeInTheDocument();
    });
  });

  it('renders an inline AskUserQuestionCard at the AskUserQuestion tool_call position', async () => {
    mockListUnifiedMessages.mockImplementationOnce(async () => [
      askQuestionMessage('a-q', 'tu-q1'),
    ]);

    act(() => {
      useQuestionStore.getState().replaceAll([makeQuestion('q-001', 'run-1', 'tu-q1')]);
    });

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('ask-user-question-card-q-001')).toBeInTheDocument();
    });
  });

  it('does not render a question card when no pending question matches the tool_call id', async () => {
    mockListUnifiedMessages.mockImplementationOnce(async () => [
      askQuestionMessage('a-q', 'tu-gone'),
    ]);

    render(<RunChatView runId="run-1" />);

    await waitFor(() => {
      expect(mockListUnifiedMessages).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('ask-user-question-card-q-001')).not.toBeInTheDocument();
  });

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

  it('renders quick-session placeholder when runId is null and activeQuickSessionId is set', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('qs-001');
    });

    render(<RunChatView runId={null} />);

    expect(screen.getByText('Quick session chat (history rendered by panel surface)')).toBeInTheDocument();
    expect(mockListUnifiedMessages).not.toHaveBeenCalled();
  });

  it('renders "No active run" when runId is null and activeQuickSessionId is also null', () => {
    render(<RunChatView runId={null} />);
    expect(screen.getByText('No active run')).toBeInTheDocument();
    expect(mockListUnifiedMessages).not.toHaveBeenCalled();
  });

  it('fires a debounced live re-query after streamEvents change', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });

    render(<RunChatView runId="run-1" />);

    // Initial mount fetch
    await waitFor(() => expect(mockListUnifiedMessages).toHaveBeenCalledTimes(1));

    const event: StreamEvent = {
      runId: 'run-1',
      type: 'assistant',
      payload: {
        type: 'assistant',
        message: {
          id: 'msg-001',
          model: 'claude-sonnet',
          role: 'assistant',
          content: [{ type: 'text', text: 'live delta' }],
        },
      },
      timestamp: '2026-05-26T00:00:00Z',
    };

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(event);
    });

    // Debounced re-query should fire after the debounce window.
    await waitFor(() => {
      expect(mockListUnifiedMessages).toHaveBeenCalledTimes(2);
    }, { timeout: 2000 });
  });

  it('ignores the result of a stale fetch when runId changes before it resolves', async () => {
    let resolveFirst!: (v: UnifiedMessage[]) => void;
    const firstPromise = new Promise<UnifiedMessage[]>((resolve) => {
      resolveFirst = resolve;
    });

    mockListUnifiedMessages
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(async () => [assistantText('a-fresh', 'fresh content')]);

    const { rerender } = render(<RunChatView runId="run-stale" />);
    await waitFor(() => expect(mockListUnifiedMessages).toHaveBeenCalledTimes(1));

    act(() => {
      rerender(<RunChatView runId="run-fresh" />);
    });
    await waitFor(() => expect(mockListUnifiedMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('fresh content')).toBeInTheDocument());

    // Resolve the stale fetch — must NOT clobber fresh content.
    act(() => {
      resolveFirst([assistantText('a-stale', 'stale content')]);
    });

    await waitFor(() => {
      expect(screen.getByText('fresh content')).toBeInTheDocument();
      expect(screen.queryByText('stale content')).not.toBeInTheDocument();
    });
  });
});
