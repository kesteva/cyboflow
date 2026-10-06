/**
 * ClaudePanel component tests — the interactive-PTY render swap.
 *
 * For PTY-backed quick sessions, ClaudePanel branches on the session's default
 * runtime / CLI substrate (mirroring RunChatView's swap for workflow runs):
 *   - substrate 'interactive' + non-null runId → the live PTY xterm
 *     (InteractiveTerminalView, keyed by the sentinel __quick__ run id, with
 *     guardFirstInteraction={false}) REPLACES the SDK structured surface;
 *     ClaudeInputWithImages is REPLACED by the dedicated
 *     InteractiveSessionComposer (session-scoped API.sessions.sendInput →
 *     sessions:input, relayed into the live PTY server-side — never the
 *     panel-scoped panels:send-input / panels:continue, which would spawn a
 *     competing SDK conversation); the approvals strip stays mounted.
 *   - substrate undefined / 'sdk' → the SDK structured surface, unchanged.
 *   - substrate 'interactive' + null runId → fall through to the SDK surface
 *     (null-safe, never crash).
 *
 * The session resolves from the SessionProvider context first, falling back to
 * the sessionStore copy keyed by the panel's sessionId. Heavy children are
 * mocked as testid stubs so the branch logic — not pixel rendering — is under
 * test (same treatment as RunChatView.test.tsx).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Hoisted mutable holder — the useClaudePanel mock reads activeSession from it
// at call time so each test can swap the session without re-mocking.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const holder: { activeSession: unknown; messages: unknown[] } = {
    activeSession: undefined,
    messages: [],
  };
  return { holder };
});

/** Mutable return value of the mocked useInteractiveTerminalHealth (reset per test). */
const { terminalHealth, mockTerminalHealthRetry, mockTerminalHealthArgs } = vi.hoisted(() => {
  const retry = vi.fn();
  return {
    terminalHealth: {
      stalled: false,
      worktreeMissing: false,
      retrying: false,
      error: null as string | null,
      retry,
    },
    mockTerminalHealthRetry: retry,
    mockTerminalHealthArgs: vi.fn(),
  };
});

vi.mock('../../../../hooks/useClaudePanel', () => ({
  useClaudePanel: () => ({
    activeSession: mocks.holder.activeSession,
    input: '',
    setInput: vi.fn(),
    textareaRef: { current: null },
    handleSendInput: vi.fn(),
    handleContinueConversation: vi.fn(),
    gitCommands: null,
    handleStopSession: vi.fn(),
  }),
}));

vi.mock('../../../../stores/configStore', () => ({
  // devMode off — debug tabs are out of scope for the swap branch under test.
  useConfigStore: <T,>(selector: (state: { config: { devMode: boolean } | null }) => T): T =>
    selector({ config: null }),
}));

// ---------------------------------------------------------------------------
// Mock API.sessions.sendInput — the interactive composer's session-scoped
// transport (same treatment as ChatInput.test.tsx).
// ---------------------------------------------------------------------------

const mockSendInput = vi.fn();
// Default: REPL is live → not resumable → no open-time resume prompt. Tests that
// exercise the prompt override mockGetResumeState per-case.
const mockGetResumeState = vi.fn((_sessionId?: string) =>
  Promise.resolve({
    success: true,
    data: { replRunning: true, claudeSessionId: null as string | null, worktreeExists: false },
  }),
);
const mockResumeInteractive = vi.fn((_sessionId?: string) => Promise.resolve({ success: true }));

vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (sessionId: string, input: string) => mockSendInput(sessionId, input),
      getInteractiveResumeState: (sessionId: string) => mockGetResumeState(sessionId),
      resumeInteractive: (sessionId: string) => mockResumeInteractive(sessionId),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock the heavy children as testid stubs — branch logic, not pixel rendering.
// ---------------------------------------------------------------------------

vi.mock('../../../cyboflow/InteractiveTerminalView', () => ({
  InteractiveTerminalView: ({
    runId,
    guardFirstInteraction,
  }: {
    runId: string;
    guardFirstInteraction?: boolean;
  }) => (
    <div data-testid="interactive-terminal-view">
      InteractiveTerminalView:{runId}:guard={String(guardFirstInteraction)}
    </div>
  ),
}));

// Dead-terminal detector — its own liveness/threshold logic is covered in
// useInteractiveTerminalHealth.test.ts; here it is a controllable stub so the
// panel's RENDER contract for the stalled state can be asserted directly.
vi.mock('../../../../hooks/useInteractiveTerminalHealth', () => ({
  useInteractiveTerminalHealth: (sessionId: string | null, panelId: string, enabled: boolean) => {
    mockTerminalHealthArgs(sessionId, panelId, enabled);
    return terminalHealth;
  },
}));

vi.mock('../../../cyboflow/ResumeSessionPrompt', () => ({
  ResumeSessionPrompt: ({
    isOpen,
    onResume,
    onStartFresh,
  }: {
    isOpen: boolean;
    onResume: () => void;
    onStartFresh: () => void;
  }) =>
    isOpen ? (
      <div data-testid="resume-session-prompt">
        <button data-testid="resume-btn" onClick={onResume}>
          Resume previous session
        </button>
        <button data-testid="fresh-btn" onClick={onStartFresh}>
          Start fresh
        </button>
      </div>
    ) : null,
}));

// The SDK transcript surface is now the shared UnifiedChatView. Stub it so the
// substrate-swap branch is under test (not the transcript internals): the stub
// echoes its transport and renders the host-supplied interactiveBody (the live
// terminal + resume overlay) and bottomSlot (approvals + composer + toast).
vi.mock('../../../cyboflow/unified/UnifiedChatView', () => ({
  UnifiedChatView: ({
    name,
    transport,
    running,
    isWaitingForResponse,
    interactiveBody,
    bottomSlot,
    renderToolCallExtra,
  }: {
    name: string;
    transport: string;
    running?: boolean;
    isWaitingForResponse?: boolean;
    interactiveBody?: ReactNode;
    bottomSlot?: ReactNode;
    renderToolCallExtra?: (toolCallId: string) => ReactNode;
  }) => (
    <div
      data-testid="unified-chat-view"
      data-name={name}
      data-transport={transport}
      data-running={String(running)}
      data-waiting={String(isWaitingForResponse)}
    >
      {/* Echo the inline extra for a fixed anchor id so tests can assert the
          anchored AskUserQuestionCard injection without the real transcript. */}
      <div data-testid="tool-call-extra-slot">{renderToolCallExtra?.('tool-1')}</div>
      {interactiveBody}
      {bottomSlot}
    </div>
  ),
}));

// The panel-scoped message source is exercised in useUnifiedPanelMessages tests;
// here it is stubbed so ClaudePanel's branch logic does not hit the panels API.
// Reads the hoisted holder so question-anchoring tests can supply a transcript.
vi.mock('../../../cyboflow/unified/useUnifiedPanelMessages', () => ({
  useUnifiedPanelMessages: () => ({
    messages: mocks.holder.messages,
    isLoading: false,
    loadError: null,
  }),
}));

// The question card's internals (radio groups, trpc submit) are covered in
// AskUserQuestionCard.test — stub it so these tests assert only the wiring.
vi.mock('../../../AskUserQuestion/AskUserQuestionCard', () => ({
  AskUserQuestionCard: ({ item }: { item: { id: string } }) => (
    <div data-testid="ask-user-question-card" data-question-id={item.id}>
      AskUserQuestionCard:{item.id}
    </div>
  ),
}));

// The composer is now the shared QuickSessionComposer; its send behavior lives
// in QuickSessionComposer.test / UnifiedComposer.test. Here we only assert the
// substrate-swap branch logic mounts it with the right `interactive`/`ptyOpen`.
vi.mock('../../../cyboflow/unified/QuickSessionComposer', () => ({
  QuickSessionComposer: ({
    interactive,
    ptyOpen,
    activeSession,
    activeQuestion,
    working,
  }: {
    interactive: boolean;
    ptyOpen?: boolean;
    activeSession?: { id?: string; effort?: string };
    activeQuestion?: { id: string } | null;
    working?: boolean;
  }) => (
    <div
      data-testid="quick-session-composer"
      data-interactive={String(interactive)}
      data-pty-open={String(ptyOpen)}
      data-session-id={activeSession?.id ?? ''}
      data-effort={activeSession?.effort ?? ''}
      data-active-question={activeQuestion?.id ?? ''}
      data-working={String(working)}
    >
      QuickSessionComposer
    </div>
  ),
}));

vi.mock('../../../ReviewQueue/PendingApprovalsForRun', () => ({
  PendingApprovalsForRun: ({ runId }: { runId: string | null }) => (
    <div data-testid="pending-approvals-for-run">PendingApprovalsForRun:{String(runId)}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ClaudePanel, __resetDeclinedResumeForTests } from '../ClaudePanel';
import { SessionProvider } from '../../../../contexts/SessionContext';
import { useSessionStore } from '../../../../stores/sessionStore';
import { usePendingSendStore } from '../../../../stores/pendingSendStore';
import { useQuestionStore } from '../../../../stores/questionStore';
import type { Session } from '../../../../types/session';
import type { ToolPanel } from '../../../../../../shared/types/panels';
import type { Question } from '../../../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PANEL: ToolPanel = {
  id: 'panel-1',
  sessionId: 's1',
  type: 'claude',
  title: 'Claude',
  state: { isActive: true },
  metadata: {
    createdAt: '2026-06-12T00:00:00.000Z',
    lastActiveAt: '2026-06-12T00:00:00.000Z',
    position: 0,
  },
};

function makeSession(overrides: Partial<Session> = {}): Session {
  const merged: Session = {
    id: 's1',
    name: 'quick-1',
    worktreePath: '/repo/.cyboflow/worktrees/quick-1',
    prompt: '',
    status: 'running',
    createdAt: '2026-06-12T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
  // Permission-mode redesign §6: the chat surface (PendingApprovalsForRun +
  // InteractiveTerminalView) gates on chatRunId (the persistent __quick__ sentinel),
  // not runId (the latest flow run). For a quick session they coincide — mirror
  // runId → chatRunId unless an override sets chatRunId explicitly, so the existing
  // swap-driving cases keep exercising the interactive/approval surfaces.
  if (merged.chatRunId === undefined) merged.chatRunId = merged.runId ?? null;
  return merged;
}

/** Render inside the SessionProvider, the way CyboflowRoot wraps the quick pane. */
function renderWithProvider(session: Session, panelOverrides: Partial<ToolPanel> = {}) {
  mocks.holder.activeSession = session;
  const panel = { ...PANEL, ...panelOverrides };
  return render(
    <SessionProvider session={session} projectName="tester-mctest">
      <ClaudePanel panel={panel} isActive />
    </SessionProvider>,
  );
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    runId: 'run-q1',
    workflowName: 'quick',
    toolUseId: 'tool-1',
    questions: [
      {
        question: 'Which branch?',
        header: 'Branch',
        multiSelect: false,
        options: [{ label: 'main' }, { label: 'dev' }],
      },
    ],
    status: 'pending',
    createdAt: '2026-07-23T00:00:00.000Z',
    answeredAt: null,
    answerJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.holder.activeSession = undefined;
  mocks.holder.messages = [];
  Object.assign(terminalHealth, {
    stalled: false,
    worktreeMissing: false,
    retrying: false,
    error: null,
  });
  mockTerminalHealthRetry.mockReset();
  mockTerminalHealthArgs.mockReset();
  useSessionStore.setState({ sessions: [], activeSessionId: null, activeMainRepoSession: null });
  usePendingSendStore.setState({ byHost: {} });
  useQuestionStore.setState({ queue: [], otherText: {} });
  mockSendInput.mockReset();
  // Default: sendInput succeeds.
  mockSendInput.mockResolvedValue({ success: true });
  mockGetResumeState.mockReset();
  mockGetResumeState.mockResolvedValue({
    success: true,
    data: { replRunning: true, claudeSessionId: null, worktreeExists: false },
  });
  mockResumeInteractive.mockReset();
  mockResumeInteractive.mockResolvedValue({ success: true });
  __resetDeclinedResumeForTests();
});

// ---------------------------------------------------------------------------
// Tests — substrate render swap
// ---------------------------------------------------------------------------

describe('ClaudePanel — interactive-PTY render swap', () => {
  it("substrate 'interactive' + runId: renders the unguarded InteractiveTerminalView (keyed by the panel's OWN id, not the session's shared chat_run_id — see interactiveRunId), drops the SDK surface, mounts the interactive composer, keeps approvals", () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    const terminal = screen.getByTestId('interactive-terminal-view');
    // Keyed by panel.id (PANEL.id === 'panel-1'), not chatRunId ('run-q1') — a
    // second concurrent interactive chat panel in the same session would share
    // 'run-q1' but must NOT share this terminal's channel/cache (TASK-103
    // Add-chat duplication fix). approvalRunId (below) is unaffected — the
    // approval gate deliberately stays session-scoped.
    expect(terminal).toHaveTextContent('InteractiveTerminalView:panel-1');
    // Quick sessions are user-driven: the first-interaction guardrail is off.
    expect(terminal).toHaveTextContent('guard=false');
    expect(screen.getByTestId('claude-panel-interactive-terminal')).toBeInTheDocument();
    // The shared chat surface renders in interactive mode (its body is the live
    // terminal, not the structured transcript).
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
    // The unified composer mounts in interactive mode (⌃G handling lives inside
    // it; it is hidden by default — ptyOpen starts false).
    const composer = screen.getByTestId('quick-session-composer');
    expect(composer).toHaveAttribute('data-interactive', 'true');
    expect(composer).toHaveAttribute('data-pty-open', 'false');
    // Approvals stay mounted exactly as before.
    expect(screen.getByTestId('pending-approvals-for-run')).toHaveTextContent('run-q1');
  });

  it('a stalled terminal shows the retry card, and Retry restarts the REPL', () => {
    terminalHealth.stalled = true;
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    const notice = screen.getByTestId('terminal-stalled-notice');
    expect(notice).toHaveTextContent('Terminal not running');
    // The terminal itself stays mounted BEHIND the card — a REPL can die after
    // painting, and blanking the scrollback would destroy the context that
    // explains why.
    expect(screen.getByTestId('interactive-terminal-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('terminal-stalled-retry'));
    expect(mockTerminalHealthRetry).toHaveBeenCalledOnce();
  });

  it('offers no retry when the worktree is gone — a restart could only fail', () => {
    terminalHealth.stalled = true;
    terminalHealth.worktreeMissing = true;
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    expect(screen.getByTestId('terminal-stalled-notice')).toHaveTextContent('no longer on disk');
    expect(screen.queryByTestId('terminal-stalled-retry')).not.toBeInTheDocument();
  });

  it('surfaces a refused restart and disables the button while one is in flight', () => {
    terminalHealth.stalled = true;
    terminalHealth.retrying = true;
    terminalHealth.error = 'Claude is turned off in Settings';
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    expect(screen.getByTestId('terminal-stalled-notice')).toHaveTextContent(
      'Claude is turned off in Settings',
    );
    expect(screen.getByTestId('terminal-stalled-retry')).toBeDisabled();
  });

  it('never shows the retry card while a resume is on offer — resume beats restart', () => {
    terminalHealth.stalled = true;
    // Resumable: REPL down but the prior conversation survives on disk. Restart
    // would throw that history away, so ResumeSessionPrompt owns this surface.
    mockGetResumeState.mockResolvedValue({
      success: true,
      data: { replRunning: false, claudeSessionId: 'uuid-1', worktreeExists: true },
    });
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    return waitFor(() => {
      expect(screen.getByTestId('resume-session-prompt')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-stalled-notice')).not.toBeInTheDocument();
    });
  });

  it('does not enable the dead-terminal probe for a Codex PTY panel (wrong manager would read every healthy terminal as dead)', () => {
    renderWithProvider(
      makeSession({ substrate: 'interactive', runId: 'run-q1', agentRuntime: 'codex-pty' }),
    );
    expect(mockTerminalHealthArgs).toHaveBeenCalledWith('s1', 'panel-1', false);
  });

  // isOmpPtySession twin of the Codex PTY case above, now that OmpPtyManager
  // exists (docs/proposals/omp-provider-integration.md §5.2) — the health
  // probe knows nothing about OMP panels either.
  it('does not enable the dead-terminal probe for an OMP PTY panel (wrong manager would read every healthy terminal as dead)', () => {
    renderWithProvider(
      makeSession({ substrate: 'interactive', runId: 'run-q1', agentRuntime: 'omp-pty' }),
    );
    expect(mockTerminalHealthArgs).toHaveBeenCalledWith('s1', 'panel-1', false);
  });

  it('Ctrl+G toggles the composer ptyOpen flag', () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
    const get = () => screen.getByTestId('quick-session-composer');
    expect(get()).toHaveAttribute('data-pty-open', 'false');

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(get()).toHaveAttribute('data-pty-open', 'true');

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(get()).toHaveAttribute('data-pty-open', 'false');
  });

  it("agentRuntime codex-pty renders the terminal keyed by the panel's OWN id (not the shared chat_run_id — so two codex chats don't share one stream) and skips Claude resume probing", () => {
    renderWithProvider(
      makeSession({
        substrate: 'interactive',
        agentProvider: 'codex',
        agentRuntime: 'codex-pty',
        runId: 'run-codex',
      }),
    );

    // Keyed by panel.id ('panel-1'), NOT chatRunId ('run-codex'). A second codex
    // chat panel of the same session resolves the SAME chat_run_id sentinel, so
    // keying by it collapsed both onto one `cyboflow:pty:<runId>` stream.
    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent(
      'InteractiveTerminalView:panel-1',
    );
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'true');
    expect(mockGetResumeState).not.toHaveBeenCalled();
  });

  it('labels a Codex SDK quick session as Codex', () => {
    renderWithProvider(makeSession({
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      runId: 'run-codex-sdk',
    }));

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-name', 'Codex');
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'sdk');
  });

  // Registry-driven (AGENT_PROVIDER_LABELS via paneProvider !== 'claude'), same
  // mechanism as the Codex case above — no OMP-specific arm was needed.
  it('labels an OMP SDK quick session as OMP', () => {
    renderWithProvider(makeSession({
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      runId: 'run-omp-sdk',
    }));

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-name', 'OMP');
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'sdk');
  });

  it("agentRuntime omp-pty renders the terminal keyed by the panel's OWN id and names the panel OMP (not 'Terminal')", () => {
    renderWithProvider(
      makeSession({
        substrate: 'interactive',
        agentProvider: 'omp',
        agentRuntime: 'omp-pty',
        runId: 'run-omp',
      }),
    );

    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent(
      'InteractiveTerminalView:panel-1',
    );
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-name', 'OMP');
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'true');
    expect(mockGetResumeState).not.toHaveBeenCalled();
  });

  it('shows a Codex SDK session as working as soon as its optimistic send exists', () => {
    usePendingSendStore.setState({
      byHost: {
        'panel-1': [{
          id: 'pending-1',
          text: 'hello',
          createdAt: Date.now(),
          status: 'sending',
        }],
      },
    });

    renderWithProvider(makeSession({
      status: 'stopped',
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      runId: 'run-codex-sdk',
    }));

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-running', 'true');
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-waiting', 'true');
  });

  // omp-sdk emits no stream deltas either (v1 — §5.1's "dropped in v1" call),
  // so it needs the SAME optimistic-send preference the Codex case proves.
  it('shows an OMP SDK session as working as soon as its optimistic send exists', () => {
    usePendingSendStore.setState({
      byHost: {
        'panel-1': [{
          id: 'pending-1',
          text: 'hello',
          createdAt: Date.now(),
          status: 'sending',
        }],
      },
    });

    renderWithProvider(makeSession({
      status: 'stopped',
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      runId: 'run-omp-sdk',
    }));

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-running', 'true');
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-waiting', 'true');
  });

  it('substrate undefined: renders the SDK surface + the SDK (non-interactive) composer', () => {
    renderWithProvider(makeSession({ runId: 'run-q1' }));

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'sdk');
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'false');
  });

  it("substrate 'interactive' + null chatRunId: still renders the terminal, keyed by panel.id (no dependency on the gate sentinel having minted yet)", () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: null }));

    // interactiveRunId no longer derives from chatRunId (a session-level,
    // mint-on-read sentinel that can lag a frontend re-fetch) — it's panel.id,
    // synchronously available from the panel prop, so a null chatRunId no
    // longer blocks the terminal from rendering.
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent('InteractiveTerminalView:panel-1');
  });

  it("TASK-104 per-panel override: an SDK session's panel with substrate 'interactive' renders the terminal, not the SDK surface", () => {
    // A session-level substrate of 'sdk' with a PANEL-level override to
    // 'interactive' — the "Add chat" picker's PTY option on an otherwise-SDK
    // session. Reading only substrateSession.substrate (pre-fix) left this
    // panel on the SDK transport, which then waits forever for SDK stream
    // events that never arrive since the backend actually spawned a PTY —
    // the reported "stuck generating" symptom.
    renderWithProvider(makeSession({ substrate: 'sdk', runId: 'run-q1' }), { substrate: 'interactive' });

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent('InteractiveTerminalView:panel-1');
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'true');
  });

  it("TASK-104 per-panel override: an interactive session's panel with substrate 'sdk' renders the SDK surface, not the terminal", () => {
    // The inverse override — an SDK chat panel added inside an otherwise-PTY
    // session.
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }), { substrate: 'sdk' });

    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'sdk');
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'false');
  });

  it('no SessionProvider: resolves the session from the store by the panel sessionId and still swaps', () => {
    const session = makeSession({ substrate: 'interactive', runId: 'run-q2' });
    mocks.holder.activeSession = session;
    useSessionStore.setState({ sessions: [session] });

    render(<ClaudePanel panel={PANEL} isActive />);

    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent(
      'InteractiveTerminalView:panel-1',
    );
    expect(screen.getByTestId('unified-chat-view')).toHaveAttribute('data-transport', 'interactive');
  });

  it('feeds the composer the PANE session, not a diverging global activeSession (live-smoke regression)', () => {
    // The global store activeSession points at a STALE, different session (no
    // effort); the SessionProvider holds the pane's real session (panel.sessionId
    // 's1', ultracode). ClaudePanel must bind the composer to the pane session so
    // the read-only effort pill + the interactive send target are correct — the
    // exact divergence caught in the dev smoke (composer was reading bab62c6f
    // while the pane rendered the ultracode session 24e899ab).
    const pane = makeSession({ id: 's1', substrate: 'interactive', runId: 'run-q1', effort: 'ultracode' });
    const staleGlobal = makeSession({ id: 'stale-global' });
    mocks.holder.activeSession = staleGlobal;
    useSessionStore.setState({ sessions: [pane], activeSessionId: 'stale-global', activeMainRepoSession: null });

    render(
      <SessionProvider session={pane} projectName="tester-mctest">
        <ClaudePanel panel={PANEL} isActive />
      </SessionProvider>,
    );

    const composer = screen.getByTestId('quick-session-composer');
    expect(composer).toHaveAttribute('data-session-id', 's1');
    expect(composer).toHaveAttribute('data-effort', 'ultracode');
    expect(composer).toHaveAttribute('data-interactive', 'true');
  });

  it('`working` follows the LIVE store status, not the frozen SessionContext snapshot (codex Stop regression)', () => {
    // CyboflowRoot's SessionProvider passes an `effectiveSession` resolved ONCE —
    // its status never updates. Observed live: ctx said 'initializing' while the
    // store (and the DB) said 'running', which froze composerWorking=false and
    // hid Stop/Interrupt for the whole turn. Claude masked it via the live-tail
    // isGenerating flag; codex-sdk emits no stream deltas, so Stop never showed.
    const frozenCtx = makeSession({ id: 's1', status: 'initializing', agentRuntime: 'codex-sdk' });
    const live = makeSession({ id: 's1', status: 'running', agentRuntime: 'codex-sdk' });
    mocks.holder.activeSession = live;
    useSessionStore.setState({ sessions: [live], activeSessionId: 's1', activeMainRepoSession: null });

    render(
      <SessionProvider session={frozenCtx} projectName="tester-mctest">
        <ClaudePanel panel={PANEL} isActive />
      </SessionProvider>,
    );

    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-working', 'true');
  });

  it('reads a main-repo session from activeMainRepoSession so `working` tracks its live status', () => {
    // sessionStore.updateSession early-returns for the ACTIVE MAIN-REPO session,
    // writing only to activeMainRepoSession and leaving any `sessions` copy stale.
    // Rendered WITHOUT a SessionProvider (production has none), so the panel falls
    // back to the store — it must prefer activeMainRepoSession or `working` (and
    // with it the Stop button) freezes for a main-repo quick session.
    const stale = makeSession({ id: 's1', status: 'ready' });
    const live = makeSession({ id: 's1', status: 'running' });
    mocks.holder.activeSession = live;
    useSessionStore.setState({
      sessions: [stale],
      activeSessionId: 's1',
      activeMainRepoSession: live,
    });

    render(<ClaudePanel panel={PANEL} isActive />);

    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-working', 'true');
  });

  it('`working` is false for a non-running session (Stop stays hidden)', () => {
    const idle = makeSession({ id: 's1', status: 'waiting' });
    mocks.holder.activeSession = idle;
    useSessionStore.setState({ sessions: [idle], activeSessionId: 's1', activeMainRepoSession: null });

    render(<ClaudePanel panel={PANEL} isActive />);

    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-working', 'false');
  });

  // -------------------------------------------------------------------------
  // Pending AskUserQuestion gates (quick-session inline question cards)
  // -------------------------------------------------------------------------
  describe('pending AskUserQuestion gates', () => {
    it('renders an UNANCHORED pending question above the composer when the transcript has no tool anchor', () => {
      useQuestionStore.setState({ queue: [makeQuestion({ toolUseId: 'tool-unseen' })] });
      renderWithProvider(makeSession({ runId: 'run-q1' }));

      const block = screen.getByTestId('quick-session-unanchored-questions');
      expect(block).toBeInTheDocument();
      expect(screen.getByTestId('ask-user-question-card')).toHaveAttribute(
        'data-question-id',
        'q-1',
      );
      // The composer flips into answer mode for the same gate.
      expect(screen.getByTestId('quick-session-composer')).toHaveAttribute(
        'data-active-question',
        'q-1',
      );
    });

    it('renders an ANCHORED pending question inline at its tool_use position (not in the bottom block)', () => {
      // The transcript carries the tool_call anchor 'tool-1' (the id the
      // UnifiedChatView stub echoes through renderToolCallExtra).
      mocks.holder.messages = [
        {
          id: 'm1',
          role: 'assistant',
          segments: [{ type: 'tool_call', tool: { id: 'tool-1', name: 'AskUserQuestion' } }],
        },
      ];
      useQuestionStore.setState({ queue: [makeQuestion({ toolUseId: 'tool-1' })] });
      renderWithProvider(makeSession({ runId: 'run-q1' }));

      // Inline card injected at the anchor…
      const extraSlot = screen.getByTestId('tool-call-extra-slot');
      expect(extraSlot).toHaveTextContent('AskUserQuestionCard:q-1');
      // …and NOT duplicated in the unanchored bottom block.
      expect(screen.queryByTestId('quick-session-unanchored-questions')).not.toBeInTheDocument();
    });

    it("ignores questions belonging to a different run (another session's gate)", () => {
      useQuestionStore.setState({ queue: [makeQuestion({ runId: 'other-run' })] });
      renderWithProvider(makeSession({ runId: 'run-q1' }));

      expect(screen.queryByTestId('ask-user-question-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-session-unanchored-questions')).not.toBeInTheDocument();
      expect(screen.getByTestId('quick-session-composer')).toHaveAttribute(
        'data-active-question',
        '',
      );
    });

    it('keys questions on chatRunId (the __quick__ sentinel), not the latest flow runId', () => {
      useQuestionStore.setState({
        queue: [makeQuestion({ runId: 'sentinel-run', toolUseId: 'tool-unseen' })],
      });
      renderWithProvider(
        makeSession({ runId: 'flow-run', chatRunId: 'sentinel-run' }),
      );

      expect(screen.getByTestId('ask-user-question-card')).toHaveAttribute(
        'data-question-id',
        'q-1',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Open-time resume recovery (lost interactive REPL)
  // -------------------------------------------------------------------------
  describe('open-time resume recovery', () => {
    const resumable = {
      success: true,
      data: { replRunning: false, claudeSessionId: 'uuid-abc', worktreeExists: true },
    };

    it('shows the resume prompt when the REPL is lost but resumable', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

      expect(await screen.findByTestId('resume-session-prompt')).toBeInTheDocument();
      expect(mockGetResumeState).toHaveBeenCalledWith('s1');
    });

    it('does NOT show the prompt when the REPL is still running', async () => {
      // beforeEach default already resolves replRunning:true.
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
      // Let the probe settle, then assert no prompt.
      await waitFor(() => expect(mockGetResumeState).toHaveBeenCalled());
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
    });

    it('does NOT probe for an SDK session', async () => {
      renderWithProvider(makeSession({ substrate: undefined, runId: null }));
      // No interactive runId → no probe, no prompt.
      expect(mockGetResumeState).not.toHaveBeenCalled();
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
    });

    it('Resume eagerly re-spawns the REPL and shows the resuming hint', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

      fireEvent.click(await screen.findByTestId('resume-btn'));

      // resumeInteractive now spawns `--resume <uuid>` server-side (eager, no turn).
      await waitFor(() => expect(mockResumeInteractive).toHaveBeenCalledWith('s1'));
      expect(screen.getByTestId('resume-restored-hint')).toBeInTheDocument();
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
    });

    it('Start fresh dismisses the prompt without any backend call', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

      fireEvent.click(await screen.findByTestId('fresh-btn'));

      // Decline spawns nothing and calls no resume IPC — the next message simply
      // opens a fresh REPL via the sessions:input dead-REPL path.
      expect(mockResumeInteractive).not.toHaveBeenCalled();
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
      expect(screen.queryByTestId('resume-restored-hint')).not.toBeInTheDocument();
    });

    it('does NOT re-pop the resume prompt after Resume once the restored-context hint auto-clears', async () => {
      // Regression: the probe never re-runs for a quick session (its sentinel runId
      // is constant), so canOfferResume stays stale-true after the REPL comes back.
      // Without dismissing on Resume, the prompt re-pops the moment the 12s hint
      // auto-clears (resumeArmed → false). Fix B dismisses the prompt on Resume.
      mockGetResumeState.mockResolvedValue(resumable);
      vi.useFakeTimers();
      try {
        renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
        // Flush the async resume-state probe so the prompt mounts.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(screen.getByTestId('resume-session-prompt')).toBeInTheDocument();

        // Choose Resume → restored-context hint shows, prompt hides.
        await act(async () => {
          fireEvent.click(screen.getByTestId('resume-btn'));
          await Promise.resolve();
        });
        expect(screen.getByTestId('resume-restored-hint')).toBeInTheDocument();
        expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();

        // Advance past the 12s hint auto-clear.
        await act(async () => {
          vi.advanceTimersByTime(12_001);
        });

        // Hint is gone AND the prompt must stay dismissed (no re-pop).
        expect(screen.queryByTestId('resume-restored-hint')).not.toBeInTheDocument();
        expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-offer resume after Start fresh, even on remount', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      const { unmount } = renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
      fireEvent.click(await screen.findByTestId('fresh-btn'));
      await waitFor(() =>
        expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument(),
      );
      unmount();
      mockGetResumeState.mockClear();

      // Re-open the same session: the declined memory short-circuits the probe.
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
      expect(mockGetResumeState).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Slash-command autocomplete source
// ---------------------------------------------------------------------------

describe('ClaudePanel — slash commands for the composer autocomplete', () => {
  it("stores the newest system/init's slash_commands under slashCommands_<sessionId>", () => {
    localStorage.removeItem('slashCommands_s1');
    mocks.holder.messages = [
      {
        id: 'init-1',
        role: 'system',
        timestamp: '2026-06-12T00:00:00.000Z',
        segments: [],
        metadata: { systemSubtype: 'init', sessionInfo: { slash_commands: ['old'] } },
      },
      {
        id: 'init-2',
        role: 'system',
        timestamp: '2026-06-12T00:01:00.000Z',
        segments: [],
        metadata: { systemSubtype: 'init', sessionInfo: { slash_commands: ['review', 'compact'] } },
      },
    ];
    renderWithProvider(makeSession({ id: 's1' }));

    expect(JSON.parse(localStorage.getItem('slashCommands_s1') ?? 'null')).toEqual(['review', 'compact']);
  });

  it('writes nothing when the transcript carries no init event', () => {
    localStorage.removeItem('slashCommands_s1');
    renderWithProvider(makeSession({ id: 's1' }));

    expect(localStorage.getItem('slashCommands_s1')).toBeNull();
  });
});
