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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

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

vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (sessionId: string, input: string) => mockSendInput(sessionId, input),
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

vi.mock('../RichOutputWithSidebar', () => ({
  RichOutputWithSidebar: () => <div data-testid="sdk-rich-output">RichOutputWithSidebar</div>,
}));

vi.mock('../../ai/MessagesView', () => ({
  MessagesView: () => <div data-testid="messages-view">MessagesView</div>,
}));

vi.mock('../SessionStats', () => ({
  SessionStats: () => <div data-testid="session-stats">SessionStats</div>,
}));

vi.mock('../ClaudeInputWithImages', () => ({
  ClaudeInputWithImages: () => <div data-testid="claude-input">ClaudeInputWithImages</div>,
}));

vi.mock('../ClaudeSettingsPanel', () => ({
  ClaudeSettingsPanel: () => <div data-testid="claude-settings-panel">ClaudeSettingsPanel</div>,
}));

vi.mock('../../ai/transformers/ClaudeMessageTransformer', () => ({
  ClaudeMessageTransformer: class ClaudeMessageTransformer {},
}));

vi.mock('../../../ResizablePanel', () => ({
  ResizablePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../ReviewQueue/PendingApprovalsForRun', () => ({
  PendingApprovalsForRun: ({ runId }: { runId: string | null }) => (
    <div data-testid="pending-approvals-for-run">PendingApprovalsForRun:{String(runId)}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ClaudePanel } from '../ClaudePanel';
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
});

// ---------------------------------------------------------------------------
// Tests — substrate render swap
// ---------------------------------------------------------------------------

// The interactive composer is hidden by default; summon it via the Ctrl+G hint bar.
function openInteractiveComposer(): void {
  fireEvent.click(screen.getByTestId('interactive-composer-hint'));
}

describe('ClaudePanel — interactive-PTY render swap', () => {
  it("substrate 'interactive' + runId: renders the unguarded InteractiveTerminalView, hides the composer behind a Ctrl+G hint, drops the SDK surface AND ClaudeInputWithImages, keeps approvals", () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));

    const terminal = screen.getByTestId('interactive-terminal-view');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveTextContent('InteractiveTerminalView:run-q1');
    // Quick sessions are user-driven: the first-interaction guardrail is off.
    expect(terminal).toHaveTextContent('guard=false');
    expect(screen.getByTestId('claude-panel-interactive-terminal')).toBeInTheDocument();
    // The SDK structured surface stays dormant (not in the DOM).
    expect(screen.queryByTestId('sdk-rich-output')).not.toBeInTheDocument();
    // ClaudeInputWithImages must NOT mount — its handlers hit the panel-scoped
    // panels:send-input / panels:continue (no substrate guard → competing SDK
    // conversation).
    expect(screen.queryByTestId('claude-input')).not.toBeInTheDocument();
    // The composer is hidden by default (type into the terminal); a hint bar
    // advertises Ctrl+G. The composer mounts only once summoned.
    expect(screen.queryByTestId('interactive-session-composer')).not.toBeInTheDocument();
    expect(screen.getByTestId('interactive-composer-hint')).toBeInTheDocument();
    openInteractiveComposer();
    expect(screen.getByTestId('interactive-session-composer')).toBeInTheDocument();
    // Approvals stay mounted exactly as before.
    expect(screen.getByTestId('pending-approvals-for-run')).toHaveTextContent('run-q1');
  });

  it('Ctrl+G toggles the composer open and closed', () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
    expect(screen.queryByTestId('interactive-session-composer')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(screen.getByTestId('interactive-session-composer')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    expect(screen.queryByTestId('interactive-session-composer')).not.toBeInTheDocument();
  });

  it('substrate undefined: renders the SDK surface, no InteractiveTerminalView, ClaudeInputWithImages composer', () => {
    renderWithProvider(makeSession({ runId: 'run-q1' }));

    expect(screen.getByTestId('sdk-rich-output')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('claude-input')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-session-composer')).not.toBeInTheDocument();
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
});

// ---------------------------------------------------------------------------
// Tests — InteractiveSessionComposer (the session-scoped composer)
// ---------------------------------------------------------------------------

describe('ClaudePanel — InteractiveSessionComposer', () => {
  it('submits via API.sessions.sendInput with (sessionId, text) and clears on success', async () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
    openInteractiveComposer();

    const textarea = screen.getByPlaceholderText('Message the live session…');
    fireEvent.change(textarea, { target: { value: 'run the tests' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledTimes(1);
    });
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'run the tests');
    // Cleared on success.
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('Enter submits; Shift+Enter does not (newline stays local)', async () => {
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
    openInteractiveComposer();

    const textarea = screen.getByPlaceholderText('Message the live session…');
    fireEvent.change(textarea, { target: { value: 'first line' } });

    // Shift+Enter must NOT send.
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(mockSendInput).not.toHaveBeenCalled();

    // Bare Enter sends.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith('s1', 'first line');
    });
  });

  it('surfaces a failed send inline and keeps the draft text', async () => {
    mockSendInput.mockResolvedValue({ success: false, error: 'PTY relay failed' });
    renderWithProvider(makeSession({ substrate: 'interactive', runId: 'run-q1' }));
    openInteractiveComposer();

    const textarea = screen.getByPlaceholderText('Message the live session…');
    fireEvent.change(textarea, { target: { value: 'doomed message' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('PTY relay failed');
    });
    // The draft is NOT cleared on failure.
    expect(textarea).toHaveValue('doomed message');
  });
});
