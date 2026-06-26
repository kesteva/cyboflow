/**
 * ChatInput component tests (TASK-762).
 *
 * Behaviors verified:
 *   1. Quick session: textarea enabled; submitting calls API.sessions.sendInput
 *      with (selectedSessionId, text); textarea cleared after success; failed
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
      // idle-chat nudge (Piece C) + live-input relay (TASK-817) — both ride runs.*.
      runs: {
        nudge: { mutate: vi.fn(async () => ({ delivered: true })) },
        reopen: { mutate: vi.fn(async () => ({ delivered: true })) },
        relayInput: { mutate: vi.fn(async () => ({ success: true })) },
        relayResize: { mutate: vi.fn(async () => ({ success: true })) },
        // "Always allow messaging a running flow" — Send QUEUES while an SDK run
        // executes; the backend delivers the text at the next turn boundary.
        queueInput: { mutate: vi.fn(async () => ({ queued: true })) },
        // ISSUE #2 — runtime agent-permission change for an active SDK run.
        setPermissionMode: { mutate: vi.fn(async () => ({ updated: true })) },
      },
      // On-demand monitor (monitor-unify) — ChatInput probes isActive for an SDK
      // run and routes Send to monitor.send. Default inactive so the existing
      // workflow-idle/paused tests keep their disabled behavior; the
      // monitor-composer describe overrides isActive → active per-test.
      monitor: {
        isActive: { query: vi.fn(async () => ({ active: false })) },
        send: { mutate: vi.fn(async () => ({ delivered: true })) },
        stepResults: { query: vi.fn(async () => []) },
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
  vi.mocked(trpc.cyboflow.runs.relayInput.mutate).mockClear();
  vi.mocked(trpc.cyboflow.runs.relayInput.mutate).mockResolvedValue({ success: true });
  vi.mocked(trpc.cyboflow.runs.queueInput.mutate).mockClear();
  vi.mocked(trpc.cyboflow.runs.queueInput.mutate).mockResolvedValue({ queued: true });

  // On-demand monitor: default inactive so the existing SDK tests keep their
  // workflow-idle/paused (disabled) behavior; the monitor-composer describe
  // overrides isActive → active.
  vi.mocked(trpc.cyboflow.monitor.isActive.query).mockClear();
  vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: false });
  vi.mocked(trpc.cyboflow.monitor.send.mutate).mockClear();
  vi.mocked(trpc.cyboflow.monitor.send.mutate).mockResolvedValue({ delivered: true });

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
  it('renders nothing when neither runId nor selectedSessionId is set', () => {
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

  it('sends on ⌘↵ (Cmd+Enter)', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'cmd enter send' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith('qs-001', 'cmd enter send');
    });
  });

  it('does NOT send on plain Enter (newline) or Shift+Enter', async () => {
    render(<ChatInput runId={null} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'no send' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    // Give microtasks a tick — sendInput must NOT have been called
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSendInput).not.toHaveBeenCalled();
  });
});

describe('ChatInput — workflow run, no question', () => {
  it('workflow run, no question, not awaiting_review: textarea disabled, hint rendered', () => {
    // run-001 is NOT in activeRunsStore → activeRun is null → not nudgeable →
    // the idle input stays disabled (this is the non-awaiting_review idle case).
    render(<ChatInput runId="run-001" />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // The unified composer renders the disabled hint inline (no Tooltip wrapper).
    expect(
      screen.getByText('Input enabled when the agent asks a question or the run is awaiting your review'),
    ).toBeInTheDocument();
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

describe('ChatInput — workflow-idle nudge (awaiting_review)', () => {
  const RUN_ID = 'run-idle-001';
  const PROJECT_ID = 9;

  function makeAwaitingRow(): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-1',
      project_id: PROJECT_ID,
      status: 'awaiting_review',
      worktree_path: '/Users/me/worktrees/idea-x',
      branch_name: 'planner/idea-x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'planner',
    };
  }

  beforeEach(() => {
    vi.mocked(trpc.cyboflow.runs.nudge.mutate).mockClear();
    vi.mocked(trpc.cyboflow.runs.nudge.mutate).mockResolvedValue({ delivered: true });
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makeAwaitingRow()] } });
    });
  });

  it('enables the input when the run rests in awaiting_review', () => {
    render(<ChatInput runId={RUN_ID} />);
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('sends a nudge via trpc.cyboflow.runs.nudge and clears the textarea on delivery', async () => {
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'also handle the empty case' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'also handle the empty case',
      });
    });
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('surfaces the noOp reason and keeps the text when the nudge is ignored', async () => {
    vi.mocked(trpc.cyboflow.runs.nudge.mutate).mockResolvedValue({ noOp: true, reason: 'blocked' });

    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'try anyway' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      // 'blocked' surfaces as a human-readable hint (not the raw reason code).
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Resolve the blocking review item(s) for this run first.',
      );
    });
    // Text retained so the user can retry once the gate clears.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('try anyway');
  });

  it('ENABLES the input (queue, not nudge) for a RUNNING idle SDK run', async () => {
    // "Always allow messaging a running flow": a running SDK run no longer falls
    // into a disabled composer — it is enabled and Send QUEUES the message (it is
    // NOT the nudge path, which only re-drives a rested awaiting_review run).
    act(() => {
      useActiveRunsStore.setState({
        runsByProject: { [PROJECT_ID]: [{ ...makeAwaitingRow(), status: 'running' }] },
      });
    });
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'queue me mid-run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.queueInput.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'queue me mid-run',
      });
    });
    // The nudge path must NOT fire for a still-running run.
    expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).not.toHaveBeenCalled();
  });
});

describe('ChatInput — workflow-idle reopen (failed)', () => {
  const RUN_ID = 'run-idle-001';
  const PROJECT_ID = 9;

  function makeFailedRow(): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-1',
      project_id: PROJECT_ID,
      status: 'failed',
      substrate: 'sdk',
      worktree_path: '/Users/me/worktrees/idea-x',
      branch_name: 'ship/idea-x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'ship',
    };
  }

  beforeEach(() => {
    vi.mocked(trpc.cyboflow.runs.reopen.mutate).mockClear();
    vi.mocked(trpc.cyboflow.runs.reopen.mutate).mockResolvedValue({ delivered: true });
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makeFailedRow()] } });
    });
  });

  it('enables the input for a failed sdk run (reopen escape hatch)', () => {
    render(<ChatInput runId={RUN_ID} />);
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('sends a reopen via trpc.cyboflow.runs.reopen and clears the textarea on delivery', async () => {
    render(<ChatInput runId={RUN_ID} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'pick it back up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.reopen.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'pick it back up',
      });
    });
    expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('a failed INTERACTIVE run offers no reopen composer (hidden behind ⌃G; no --resume)', () => {
    act(() => {
      useActiveRunsStore.setState({
        runsByProject: { [PROJECT_ID]: [{ ...makeFailedRow(), substrate: 'interactive' }] },
      });
    });
    render(<ChatInput runId={RUN_ID} />);
    // Interactive composers are hidden (relay behind ⌃G) — there is no reopen
    // textbox to type into, and reopen is never invoked.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(vi.mocked(trpc.cyboflow.runs.reopen.mutate)).not.toHaveBeenCalled();
  });
});

describe('ChatInput — workflow-interactive composer (TASK-817)', () => {
  const RUN_ID = 'run-interactive-001';

  function makeInteractiveRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-int',
      project_id: 5,
      status: 'running',
      substrate: 'interactive',
      worktree_path: '/Users/me/worktrees/int',
      branch_name: 'feature/int',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'sprint',
      ...overrides,
    };
  }

  it('an interactive running run reveals (⌃G) an ENABLED composer with the relay placeholder', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { 5: [makeInteractiveRow()] } });
    });

    render(<ChatInput runId={RUN_ID} />);

    // PTY composer is hidden behind ⌃G by default (type into the terminal above);
    // reveal it to reach the relay textarea.
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByTestId('unified-composer-reveal'));

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.placeholder).toBe('Message the running session — relayed safely…');
  });

  it("Send relays the body, then a SEPARATE '\\r' (Enter) — claude 2.1 paste+submit", async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { 5: [makeInteractiveRow()] } });
    });

    render(<ChatInput runId={RUN_ID} />);

    fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'run the tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // First: the body alone (lands as a bracketed paste in claude's composer).
    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.relayInput.mutate)).toHaveBeenNthCalledWith(1, {
        runId: RUN_ID,
        text: 'run the tests',
      });
    });

    // Then: '\r' as its own keystroke (Enter) — a '\r' appended to the body would
    // be swallowed by bracketed-paste and never submit.
    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.relayInput.mutate)).toHaveBeenNthCalledWith(2, {
        runId: RUN_ID,
        text: '\r',
      });
    });

    // Textarea cleared after both relays complete.
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('a non-interactive (sdk) RUNNING run gets an ENABLED queue composer (NOT the relay path)', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({
        // sdk + running → "always allow messaging a running flow": the composer is
        // ENABLED and Send QUEUES (it is NOT the interactive live-PTY relay path).
        runsByProject: { 5: [makeInteractiveRow({ substrate: 'sdk', status: 'running' })] },
      });
    });

    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'queue this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.queueInput.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'queue this',
      });
    });
    // The live-PTY relay mutation must NOT be reachable for an SDK run.
    expect(vi.mocked(trpc.cyboflow.runs.relayInput.mutate)).not.toHaveBeenCalled();
  });

  it('an interactive run that is NOT running falls back to the disabled workflow-idle composer', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({
        // 'stuck' is non-running AND non-nudgeable (not awaiting_review), so the
        // merged idle composer stays disabled (awaiting_review is now nudgeable).
        runsByProject: { 5: [makeInteractiveRow({ status: 'stuck' })] },
      });
    });

    render(<ChatInput runId={RUN_ID} />);
    // Reveal the ⌃G-hidden composer; the revealed input is disabled (idle).
    fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});

describe('ChatInput — workflow-monitor composer (monitor-unify)', () => {
  const RUN_ID = 'run-monitor-001';
  const PROJECT_ID = 13;

  function makeSdkRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-mon',
      project_id: PROJECT_ID,
      status: 'running',
      substrate: 'sdk',
      worktree_path: '/Users/me/worktrees/mon',
      branch_name: 'planner/mon',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'planner',
      ...overrides,
    };
  }

  const activate = (overrides: Partial<ActiveRunRow> = {}) => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makeSdkRow(overrides)] } });
    });
  };

  it('probes monitor.isActive with the runId for an SDK run', async () => {
    activate();
    render(<ChatInput runId={RUN_ID} />);

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.isActive.query)).toHaveBeenCalledWith({ runId: RUN_ID });
    });
  });

  it('ENABLES the composer with the monitor placeholder once isActive resolves active', async () => {
    vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: true });
    activate();
    render(<ChatInput runId={RUN_ID} />);

    // SDK input is always visible; the probe flips the mode to workflow-monitor,
    // enabling the (already-rendered) composer — re-query inside waitFor.
    await waitFor(() => {
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toBe(
      'Ask the monitor about this run…',
    );
  });

  it('Send calls monitor.send.mutate and clears the textarea on delivery (no optimistic insert)', async () => {
    vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: true });
    activate();
    render(<ChatInput runId={RUN_ID} />);

    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'what failed in step 3?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.send.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'what failed in step 3?',
      });
    });
    // The user's turn + reply arrive via the unified stream — the composer only
    // clears on confirmed delivery; it does not insert the turn locally.
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
    // The nudge path must NOT be reached for a monitored run.
    expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).not.toHaveBeenCalled();
  });

  it('surfaces an error and keeps the text when the monitor is no longer active', async () => {
    vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: true });
    vi.mocked(trpc.cyboflow.monitor.send.mutate).mockResolvedValue({ delivered: false });
    activate();
    render(<ChatInput runId={RUN_ID} />);

    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'still there?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('The monitor is no longer active for this run.');
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('still there?');
  });

  it('does NOT take the monitor composer when isActive resolves inactive (falls back to the running-queue path)', async () => {
    vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: false });
    activate(); // status 'running'
    render(<ChatInput runId={RUN_ID} />);

    // Probe still fires for the SDK run.
    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.isActive.query)).toHaveBeenCalledWith({ runId: RUN_ID });
    });
    // No monitor → "always allow messaging a running flow" takes over: the composer
    // is ENABLED with the queue placeholder (not the disabled idle composer it used
    // to render before that feature).
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.placeholder).toBe('Queue a message for the agent — sent on its next turn…');
    // The monitor send path is NOT reached when the monitor is inactive.
    expect(vi.mocked(trpc.cyboflow.monitor.send.mutate)).not.toHaveBeenCalled();
  });

  it('re-probes monitor.isActive when the run status changes (catches a late registration)', async () => {
    // The monitor registers only once the controller starts walking. The probe
    // re-fires on the status change and switches the composer to the MONITOR path
    // once the monitor is up. (With "always allow messaging a running flow", a
    // running/starting SDK run is enabled either way — via the queue path before
    // the monitor registers, and via the monitor path after — so this test now
    // asserts the placeholder swap rather than a disabled→enabled flip.)
    vi.mocked(trpc.cyboflow.monitor.isActive.query)
      .mockResolvedValueOnce({ active: false })
      .mockResolvedValue({ active: true });
    activate({ status: 'starting' });
    render(<ChatInput runId={RUN_ID} />);

    // First probe (status 'starting') saw no monitor → the composer falls back to
    // the running-queue path (enabled, queue placeholder).
    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.isActive.query)).toHaveBeenCalledWith({ runId: RUN_ID });
    });
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toBe(
        'Queue a message for the agent — sent on its next turn…',
      );
    });
    const callsAfterMount = vi.mocked(trpc.cyboflow.monitor.isActive.query).mock.calls.length;

    // Run advances to 'running' → the status dep changes → re-probe → active → the
    // composer switches to the monitor path (monitor placeholder).
    activate({ status: 'running' });
    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.isActive.query).mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toBe(
        'Ask the monitor about this run…',
      );
    });
  });

  it('does NOT probe the monitor for an interactive run (the live-PTY relay path is untouched)', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({
        runsByProject: { [PROJECT_ID]: [makeSdkRow({ substrate: 'interactive', status: 'running' })] },
      });
    });
    render(<ChatInput runId={RUN_ID} />);

    // The interactive relay composer is hidden behind ⌃G; reveal it to reach the
    // textarea. The monitor must never be probed for an interactive run.
    fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Message the running session — relayed safely…');
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(trpc.cyboflow.monitor.isActive.query)).not.toHaveBeenCalled();
  });
});

describe('ChatInput — SDK running queue ("always allow messaging a running flow")', () => {
  const RUN_ID = 'run-sdk-running-001';
  const PROJECT_ID = 17;

  function makeRunningSdkRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-run',
      project_id: PROJECT_ID,
      status: 'running',
      substrate: 'sdk',
      worktree_path: '/Users/me/worktrees/run-x',
      branch_name: 'planner/run-x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'planner',
      ...overrides,
    };
  }

  const activate = (overrides: Partial<ActiveRunRow> = {}) => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makeRunningSdkRow(overrides)] } });
    });
  };

  it('ENABLES the composer with the queue placeholder + a "Queue" button while a running SDK run has no monitor', async () => {
    activate();
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.placeholder).toBe('Queue a message for the agent — sent on its next turn…');
    // The primary action communicates queue semantics (not "Send").
    expect(screen.getByRole('button', { name: 'Queue' })).toBeInTheDocument();
    // The disabled idle hint must NOT be shown.
    expect(
      screen.queryByText('Input enabled when the agent asks a question or the run is awaiting your review'),
    ).not.toBeInTheDocument();
  });

  it('Send calls runs.queueInput and clears the textarea on a confirmed queue', async () => {
    activate();
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'also rename the helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.queueInput.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        text: 'also rename the helper',
      });
    });
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
    // Neither nudge nor relay is reached for a still-running SDK run.
    expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).not.toHaveBeenCalled();
    expect(vi.mocked(trpc.cyboflow.runs.relayInput.mutate)).not.toHaveBeenCalled();
  });

  it('also enables the queue composer for a STARTING SDK run', () => {
    activate({ status: 'starting' });
    render(<ChatInput runId={RUN_ID} />);
    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Queue' })).toBeInTheDocument();
  });

  it('surfaces the noOp reason and keeps the text when queueInput is rejected', async () => {
    vi.mocked(trpc.cyboflow.runs.queueInput.mutate).mockResolvedValue({ noOp: true, reason: 'terminal' });
    activate();
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'too late?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('This run has ended and cannot receive messages.');
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('too late?');
  });

  it('an ACTIVE monitor still wins (queries the monitor, not the queue path)', async () => {
    // monitor-unify precedence: when an SDK run has an active monitor, Send routes
    // to monitor.send — the queue path must NOT fire.
    vi.mocked(trpc.cyboflow.monitor.isActive.query).mockResolvedValue({ active: true });
    activate();
    render(<ChatInput runId={RUN_ID} />);

    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    // The monitor placeholder (not the queue placeholder) is shown.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toBe(
      'Ask the monitor about this run…',
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'what is step 2 doing?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.monitor.send.mutate)).toHaveBeenCalled();
    });
    expect(vi.mocked(trpc.cyboflow.runs.queueInput.mutate)).not.toHaveBeenCalled();
  });
});

describe('ChatInput — workflow paused (Phase 4b)', () => {
  const RUN_ID = 'run-paused-001';
  const PROJECT_ID = 11;

  function makePausedRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-1',
      project_id: PROJECT_ID,
      status: 'paused',
      substrate: 'sdk',
      worktree_path: '/Users/me/worktrees/paused-x',
      branch_name: 'planner/paused-x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'planner',
      ...overrides,
    };
  }

  beforeEach(() => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makePausedRow()] } });
    });
  });

  it('disables the composer with the "Run paused — Resume to continue" placeholder', () => {
    render(<ChatInput runId={RUN_ID} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(textarea.placeholder).toBe('Run paused — Resume to continue');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows a distinct paused hint (not the awaiting-review hint)', () => {
    render(<ChatInput runId={RUN_ID} />);

    // The paused run is SDK, so the composer is visible (disabled) with the
    // paused hint rendered inline.
    expect(
      screen.getByText('Run paused — Resume to continue the conversation'),
    ).toBeInTheDocument();
    // The generic idle hint must NOT be shown for a paused run.
    expect(
      screen.queryByText('Input enabled when the agent asks a question or the run is awaiting your review'),
    ).not.toBeInTheDocument();
  });

  it('does NOT relay or nudge while paused', async () => {
    render(<ChatInput runId={RUN_ID} />);

    // Disabled textarea — typing + Enter must be a no-op (no transport call).
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'try to send' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(trpc.cyboflow.runs.nudge.mutate)).not.toHaveBeenCalled();
    expect(vi.mocked(trpc.cyboflow.runs.relayInput.mutate)).not.toHaveBeenCalled();
  });
});

// NOTE: the folder/branch status-bar moved out of ChatInput into the shared
// <ChatMetaStrip> (rendered by RunChatView). Its chip rendering is covered by
// ChatMetaStrip's own test; ChatInput no longer renders chips.

describe('ChatInput — run permission pill (ISSUE #2)', () => {
  const RUN_ID = 'run-perm-001';
  const PROJECT_ID = 21;

  function makeSdkRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
    return {
      id: RUN_ID,
      workflow_id: 'wf-perm',
      project_id: PROJECT_ID,
      status: 'awaiting_review',
      substrate: 'sdk',
      worktree_path: '/Users/me/worktrees/perm-x',
      branch_name: 'planner/perm-x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      stuck_reason: null,
      permission_mode_snapshot: 'default',
      workflowName: 'planner',
      ...overrides,
    };
  }

  const activate = (overrides: Partial<ActiveRunRow> = {}) => {
    act(() => {
      useCyboflowStore.getState().setActiveRun(RUN_ID);
      useActiveRunsStore.setState({ runsByProject: { [PROJECT_ID]: [makeSdkRow(overrides)] } });
    });
  };

  beforeEach(() => {
    vi.mocked(trpc.cyboflow.runs.setPermissionMode.mutate).mockClear();
    vi.mocked(trpc.cyboflow.runs.setPermissionMode.mutate).mockResolvedValue({ updated: true });
  });

  it('renders the permission pill for a non-terminal SDK run, seeded with the current mode', () => {
    activate({ permission_mode_snapshot: 'auto' });
    render(<ChatInput runId={RUN_ID} />);
    // 'auto' → 'Auto' label.
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('selecting a mode calls runs.setPermissionMode with { runId, permissionMode }', async () => {
    activate({ permission_mode_snapshot: 'default' });
    render(<ChatInput runId={RUN_ID} />);

    fireEvent.click(screen.getByText('Ask before edits')); // open the dropdown
    fireEvent.click(await screen.findByText('Auto'));

    await waitFor(() => {
      expect(vi.mocked(trpc.cyboflow.runs.setPermissionMode.mutate)).toHaveBeenCalledWith({
        runId: RUN_ID,
        permissionMode: 'auto',
      });
    });
  });

  it('does NOT render the pill for a terminal (failed) run', () => {
    activate({ status: 'failed' });
    render(<ChatInput runId={RUN_ID} />);
    expect(screen.queryByText('Ask before edits')).toBeNull();
  });

  it('does NOT render the pill for an interactive run', () => {
    activate({ substrate: 'interactive', status: 'running' });
    render(<ChatInput runId={RUN_ID} />);
    expect(screen.queryByText('Ask before edits')).toBeNull();
    expect(vi.mocked(trpc.cyboflow.runs.setPermissionMode.mutate)).not.toHaveBeenCalled();
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
