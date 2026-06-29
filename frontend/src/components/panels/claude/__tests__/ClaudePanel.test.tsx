/**
 * ClaudePanel component tests — the interactive-PTY render swap.
 *
 * For PTY-backed quick sessions, ClaudePanel branches on the session's CLI
 * substrate (mirroring RunChatView's swap for workflow runs):
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

// ---------------------------------------------------------------------------
// Hoisted mutable holder — the useClaudePanel mock reads activeSession from it
// at call time so each test can swap the session without re-mocking.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const holder: { activeSession: unknown } = { activeSession: undefined };
  return { holder };
});

vi.mock('../../../../hooks/useClaudePanel', () => ({
  useClaudePanel: () => ({
    activeSession: mocks.holder.activeSession,
    input: '',
    setInput: vi.fn(),
    textareaRef: { current: null },
    handleTerminalCommand: vi.fn(),
    handleSendInput: vi.fn(),
    handleContinueConversation: vi.fn(),
    ultrathink: false,
    setUltrathink: vi.fn(),
    gitCommands: null,
    handleCompactContext: vi.fn(),
    hasConversationHistory: false,
    contextCompacted: false,
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
const mockCancelInteractiveResume = vi.fn((_sessionId?: string) => Promise.resolve({ success: true }));

vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (sessionId: string, input: string) => mockSendInput(sessionId, input),
      getInteractiveResumeState: (sessionId: string) => mockGetResumeState(sessionId),
      resumeInteractive: (sessionId: string) => mockResumeInteractive(sessionId),
      cancelInteractiveResume: (sessionId: string) => mockCancelInteractiveResume(sessionId),
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

vi.mock('../RichOutputWithSidebar', () => ({
  RichOutputWithSidebar: () => <div data-testid="sdk-rich-output">RichOutputWithSidebar</div>,
}));

vi.mock('../../ai/MessagesView', () => ({
  MessagesView: () => <div data-testid="messages-view">MessagesView</div>,
}));

vi.mock('../SessionStats', () => ({
  SessionStats: () => <div data-testid="session-stats">SessionStats</div>,
}));

// The composer is now the shared QuickSessionComposer; its send behavior lives
// in QuickSessionComposer.test / UnifiedComposer.test. Here we only assert the
// substrate-swap branch logic mounts it with the right `interactive`/`ptyOpen`.
vi.mock('../../../cyboflow/unified/QuickSessionComposer', () => ({
  QuickSessionComposer: ({
    interactive,
    ptyOpen,
    activeSession,
  }: {
    interactive: boolean;
    ptyOpen?: boolean;
    activeSession?: { id?: string; effort?: string };
  }) => (
    <div
      data-testid="quick-session-composer"
      data-interactive={String(interactive)}
      data-pty-open={String(ptyOpen)}
      data-session-id={activeSession?.id ?? ''}
      data-effort={activeSession?.effort ?? ''}
    >
      QuickSessionComposer
    </div>
  ),
}));

vi.mock('../ClaudeSettingsPanel', () => ({
  ClaudeSettingsPanel: () => <div data-testid="claude-settings-panel">ClaudeSettingsPanel</div>,
}));

vi.mock('../../ai/transformers/ClaudeMessageTransformer', () => ({
  ClaudeMessageTransformer: class ClaudeMessageTransformer {},
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
import type { Session } from '../../../../types/session';
import type { ToolPanel } from '../../../../../../shared/types/panels';

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
  return {
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
}

/** Render inside the SessionProvider, the way CyboflowRoot wraps the quick pane. */
function renderWithProvider(session: Session) {
  mocks.holder.activeSession = session;
  return render(
    <SessionProvider session={session} projectName="tester-mctest">
      <ClaudePanel panel={PANEL} isActive />
    </SessionProvider>,
  );
}

beforeEach(() => {
  mocks.holder.activeSession = undefined;
  useSessionStore.setState({ sessions: [], activeSessionId: null, activeMainRepoSession: null });
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
  mockCancelInteractiveResume.mockReset();
  mockCancelInteractiveResume.mockResolvedValue({ success: true });
  __resetDeclinedResumeForTests();
});

// ---------------------------------------------------------------------------
// Tests — substrate render swap
// ---------------------------------------------------------------------------

describe('ClaudePanel — interactive-PTY render swap', () => {
  it("substrate 'interactive' + runId: renders the unguarded InteractiveTerminalView, drops the SDK surface, mounts the interactive composer, keeps approvals", () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    const terminal = screen.getByTestId('interactive-terminal-view');
    expect(terminal).toHaveTextContent('InteractiveTerminalView:run-q1');
    // Quick sessions are user-driven: the first-interaction guardrail is off.
    expect(terminal).toHaveTextContent('guard=false');
    expect(screen.getByTestId('claude-panel-interactive-terminal')).toBeInTheDocument();
    // The SDK structured surface stays dormant (not in the DOM).
    expect(screen.queryByTestId('sdk-rich-output')).not.toBeInTheDocument();
    // The unified composer mounts in interactive mode (⌃G handling lives inside
    // it; it is hidden by default — ptyOpen starts false).
    const composer = screen.getByTestId('quick-session-composer');
    expect(composer).toHaveAttribute('data-interactive', 'true');
    expect(composer).toHaveAttribute('data-pty-open', 'false');
    // Approvals stay mounted exactly as before.
    expect(screen.getByTestId('pending-approvals-for-run')).toHaveTextContent('run-q1');
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

  it('substrate undefined: renders the SDK surface + the SDK (non-interactive) composer', () => {
    renderWithProvider(makeSession({ runId: 'run-q1' }));

    expect(screen.getByTestId('sdk-rich-output')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-session-composer')).toHaveAttribute('data-interactive', 'false');
  });

  it("substrate 'interactive' + null runId: falls through to the SDK surface (no crash)", () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: null }));

    expect(screen.getByTestId('sdk-rich-output')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
  });

  it('no SessionProvider: resolves the session from the store by the panel sessionId and still swaps', () => {
    const session = makeSession({ substrate: 'interactive', runId: 'run-q2' });
    mocks.holder.activeSession = session;
    useSessionStore.setState({ sessions: [session] });

    render(<ClaudePanel panel={PANEL} isActive />);

    expect(screen.getByTestId('interactive-terminal-view')).toHaveTextContent(
      'InteractiveTerminalView:run-q2',
    );
    expect(screen.queryByTestId('sdk-rich-output')).not.toBeInTheDocument();
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

    it('Resume arms the deferred resume and shows the restored-context hint', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

      fireEvent.click(await screen.findByTestId('resume-btn'));

      await waitFor(() => expect(mockResumeInteractive).toHaveBeenCalledWith('s1'));
      expect(screen.getByTestId('resume-restored-hint')).toBeInTheDocument();
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
    });

    it('Start fresh dismisses and disarms any prior resume intent', async () => {
      mockGetResumeState.mockResolvedValue(resumable);
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

      fireEvent.click(await screen.findByTestId('fresh-btn'));

      expect(mockResumeInteractive).not.toHaveBeenCalled();
      // Authoritative decline: the backend resume intent is cleared.
      await waitFor(() => expect(mockCancelInteractiveResume).toHaveBeenCalledWith('s1'));
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
      await waitFor(() => expect(mockCancelInteractiveResume).toHaveBeenCalled());
      unmount();
      mockGetResumeState.mockClear();

      // Re-open the same session: the declined memory short-circuits the probe.
      renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
      expect(screen.queryByTestId('resume-session-prompt')).not.toBeInTheDocument();
      expect(mockGetResumeState).not.toHaveBeenCalled();
    });
  });
});
