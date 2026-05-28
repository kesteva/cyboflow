/**
 * ChatInput component tests (TASK-762).
 *
 * Behaviors verified:
 *   1. Quick session: textarea enabled; submitting calls API.sessions.sendInput
 *      with (activeQuickSessionId, text); textarea cleared after success; failed
 *      IPC response surfaces an error indicator without clearing the textarea.
 *   2. Workflow-run, no active question: textarea disabled; Send button disabled;
 *      Tooltip with the exact string "Input enabled only when the agent asks a
 *      question" is rendered.
 *   3. Workflow-run, active question: textarea enabled; submitting forwards text to
 *      questionStore.setOtherText(questionId, text) and clears the textarea;
 *      trpc.cyboflow.questions.answer.mutate is NOT called from ChatInput.
 *   4. Mode-gating: store state changes drive re-renders into the correct mode.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — prevents real IPC subscription attempts from the store.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock tRPC client — provides stubs for all subscriptions and queries used by
// stores that get initialised inside the test.  answer.mutate is the key one:
// we assert it is never called from ChatInput.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
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
// Mock API.sessions.sendInput — the quick-session transport.
// ---------------------------------------------------------------------------

const mockSendInput = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (sessionId: string, input: string) => mockSendInput(sessionId, input),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks (vi.mock hoisting safety)
// ---------------------------------------------------------------------------

import { ChatInput } from '../ChatInput';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useQuestionStore } from '../../../stores/questionStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import { trpc } from '../../../trpc/client';
import type { Question } from '../../../../../shared/types/questions';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useQuestionStore.getState().replaceAll([]);
    useActiveRunsStore.setState({ runsByProject: {} });
  });

  mockSendInput.mockClear();
  vi.mocked(trpc.cyboflow.questions.answer.mutate).mockClear();

  // Default: sendInput succeeds
  mockSendInput.mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuestion(id: string, runId: string): Question {
  return {
    id,
    runId,
    workflowName: 'test-wf',
    toolUseId: `tool-${id}`,
    questions: [
      {
        question: 'Choose an option',
        header: 'Choice',
        multiSelect: false,
        options: [
          { label: 'A' },
          { label: 'B' },
        ],
      },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    answeredAt: null,
    answerJson: null,
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('ChatInput — none mode', () => {
  it('renders nothing when neither runId nor activeQuickSessionId is set', () => {
    const { container } = render(<ChatInput runId={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ChatInput — quick session mode', () => {
  beforeEach(() => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('qs-001');
    });
  });

  it('renders an enabled textarea and Send button', () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).not.toBeDisabled();

    // Send button is disabled when textarea is empty
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('quick session: sends input via API.sessions.sendInput', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello world' } });

    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).not.toBeDisabled();

    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith('qs-001', 'hello world');
    });
  });

  it('clears textarea after successful send', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('surfaces error and keeps text on IPC failure', async () => {
    mockSendInput.mockResolvedValue({ success: false, error: 'session not found' });

    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'retry me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('session not found');
    });

    // Text is retained so the user can retry
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('retry me');
  });

  it('sends on Enter (without Shift)', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'enter send' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith('qs-001', 'enter send');
    });
  });

  it('does NOT send on Shift+Enter', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'shift enter' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    // Give microtasks a tick — sendInput must NOT have been called
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSendInput).not.toHaveBeenCalled();
  });
});

describe('ChatInput — workflow run, no question', () => {
  it('workflow run, no question: textarea disabled, tooltip rendered', () => {
    render(<ChatInput runId="run-001" />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Tooltip's `content` prop holds the exact literal string — trigger hover to
    // make it visible in jsdom (the Tooltip component conditionally renders its
    // content div on mouseEnter).
    const tooltipWrapper = textarea.closest('.relative.inline-block');
    expect(tooltipWrapper).not.toBeNull();
    fireEvent.mouseEnter(tooltipWrapper!);

    expect(screen.getByText('Input enabled only when the agent asks a question')).toBeInTheDocument();
  });
});

describe('ChatInput — workflow run, active question', () => {
  const RUN_ID = 'run-wf-001';
  const Q_ID = 'q-abc';

  beforeEach(() => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useQuestionStore.getState().addQuestion(makeQuestion(Q_ID, RUN_ID));
    });
  });

  it('workflow run, active question: forwards text to questionStore', async () => {
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).not.toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'my other answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const otherText = useQuestionStore.getState().otherText;
      expect(otherText[Q_ID]).toBe('my other answer');
    });

    // Textarea is cleared after forwarding
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('workflow run, active question: does NOT call trpc.cyboflow.questions.answer.mutate', async () => {
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'must not mutate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      // Confirm the store setter was called (so we know the branch ran)
      const otherText = useQuestionStore.getState().otherText;
      expect(otherText[Q_ID]).toBe('must not mutate');
    });

    // The key assertion: tRPC answer.mutate must NOT have been called
    expect(vi.mocked(trpc.cyboflow.questions.answer.mutate)).not.toHaveBeenCalled();
  });
});

describe('ChatInput — run status bar', () => {
  function makeRunRow(overrides: Partial<ActiveRunRow>): ActiveRunRow {
    return {
      id: 'run-001',
      workflow_id: 'wf-1',
      project_id: 7,
      status: 'running',
      worktree_path: '/Users/me/worktrees/feature-x',
      branch_name: 'feature/x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      workflowName: 'planner',
      ...overrides,
    };
  }

  it('renders folder basename + branch from the active run', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-001');
      useActiveRunsStore.setState({ runsByProject: { 7: [makeRunRow({})] } });
    });

    render(<ChatInput runId="run-001" />);

    const bar = screen.getByTestId('run-chat-status-bar');
    expect(bar).toHaveTextContent('feature-x');
    expect(bar).toHaveTextContent('feature/x');
  });

  it('hides the status bar when worktree and branch are null', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-001');
      useActiveRunsStore.setState({
        runsByProject: { 7: [makeRunRow({ worktree_path: null, branch_name: null })] },
      });
    });

    render(<ChatInput runId="run-001" />);
    expect(screen.queryByTestId('run-chat-status-bar')).toBeNull();
  });

  it('hides the status bar when the active run is not in the store', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-missing');
    });

    render(<ChatInput runId="run-missing" />);
    expect(screen.queryByTestId('run-chat-status-bar')).toBeNull();
  });
});

describe('ChatInput — mode-gating re-renders', () => {
  it('switches from workflow-idle to workflow-question when a question is added', async () => {
    const { rerender } = render(<ChatInput runId="run-mode-001" />);

    // Initially idle — textarea disabled
    expect(screen.getByRole('textbox')).toBeDisabled();

    // Add a pending question for this run
    act(() => {
      useQuestionStore.getState().addQuestion(makeQuestion('q-new', 'run-mode-001'));
    });
    rerender(<ChatInput runId="run-mode-001" />);

    // Now enabled
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('switches from quick to none when activeQuickSession is cleared', () => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('qs-gone');
    });

    const { rerender } = render(<ChatInput runId={null} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    act(() => {
      useCyboflowStore.getState().clearActiveQuickSession();
    });
    rerender(<ChatInput runId={null} />);

    // Rendered nothing
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
