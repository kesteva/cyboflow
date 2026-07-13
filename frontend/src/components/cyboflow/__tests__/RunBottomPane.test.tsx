/**
 * RunBottomPane component tests (TASK-756, updated TASK-761 + worktree-terminal).
 *
 * Behaviors verified:
 *   1. An SDK run shows Chat + Terminal + Data Stream, but NO Agent tab (SDK has
 *      no agent PTY).
 *   2. An interactive run offers an Agent tab that mounts the live agent terminal.
 *   3. The primary Terminal tab is ALWAYS present (every substrate) and mounts the
 *      user shell (terminalId === runId).
 *   4. Chat is the default active tab; RunChatView is mounted on first render.
 *   5. Clicking Data Stream tab mounts RunView (raw event log) and hides the chat.
 *   6. Clicking Chat tab after switching away restores RunChatView.
 *   7. ＋terminal spawns an additional, closeable terminal with a distinct id.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — same pattern as RunView.test.tsx
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Mock the tRPC client so the real RunView (mounted on the Data Stream tab) can
// call cyboflow.runs.listRawEvents.query without a live backend. Returns [] so
// the raw-event backfill resolves to empty.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listRawEvents: {
          query: vi.fn(async () => []),
        },
        shellClose: {
          mutate: vi.fn(async () => ({ success: true })),
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock RunChatView so the Chat tab test does not require tRPC / stores
// ---------------------------------------------------------------------------

vi.mock('../RunChatView', () => ({
  RunChatView: () => <div data-testid="run-chat-view-mock">RunChatView</div>,
}));

// Mock InteractiveTerminalView so the Agent tab does not boot a real xterm/PTY
// subscription in jsdom.
vi.mock('../InteractiveTerminalView', () => ({
  InteractiveTerminalView: ({ runId }: { runId: string }) => (
    <div data-testid="interactive-terminal-mock">{runId}</div>
  ),
}));

// Mock RunShellTerminalView so the Terminal tabs do not boot a real xterm / shell
// trpc calls in jsdom. Exposes the terminalId so multi-terminal routing is testable.
vi.mock('../RunShellTerminalView', () => ({
  RunShellTerminalView: ({ runId, terminalId }: { runId: string; terminalId?: string }) => (
    <div data-testid="run-shell-terminal-mock" data-terminal-id={terminalId ?? runId}>
      {runId}
    </div>
  ),
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunBottomPane } from '../RunBottomPane';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';

/** Seed the active-runs store so RunBottomPane resolves a run's substrate. */
function seedRun(id: string, substrate: 'sdk' | 'interactive'): void {
  act(() => {
    useActiveRunsStore.setState({
      runsByProject: { 1: [{ id, substrate } as unknown as ActiveRunRow] },
    });
  });
}

function setActiveRun(id: string): void {
  act(() => {
    useCyboflowStore.getState().setActiveRun(id);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useActiveRunsStore.setState({ runsByProject: {} });
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw and tests can focus on rendering behaviour.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunBottomPane', () => {
  it('an SDK run shows Chat + Terminal + Data Stream, but no Agent tab', () => {
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data Stream' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Agent' })).not.toBeInTheDocument();
  });

  it('an interactive run offers an Agent tab that mounts the live agent terminal', () => {
    seedRun('run-pty', 'interactive');
    setActiveRun('run-pty');
    render(<RunBottomPane />);

    const agentTab = screen.getByRole('tab', { name: 'Agent' });
    expect(agentTab).toBeInTheDocument();

    fireEvent.click(agentTab);
    expect(screen.getByTestId('interactive-terminal-mock')).toHaveTextContent('run-pty');
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();
  });

  it('the primary Terminal tab is always present and mounts the user shell (SDK run)', () => {
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane />);

    const shellTab = screen.getByRole('tab', { name: 'Terminal' });
    expect(shellTab).toBeInTheDocument();

    fireEvent.click(shellTab);
    const mock = screen.getByTestId('run-shell-terminal-mock');
    expect(mock).toHaveTextContent('run-xyz');
    // The primary terminal's id is the run id.
    expect(mock).toHaveAttribute('data-terminal-id', 'run-xyz');
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();
  });

  it('an interactive run shows both Agent and Terminal tabs', () => {
    seedRun('run-pty', 'interactive');
    setActiveRun('run-pty');
    render(<RunBottomPane />);
    expect(screen.getByRole('tab', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  });

  it('＋terminal adds a closeable second terminal (distinct id), then close removes it', () => {
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane />);

    // Only the primary terminal initially.
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal 2' })).not.toBeInTheDocument();

    // Add → "Terminal 2" appears, is focused, and mounts a shell with a distinct id.
    fireEvent.click(screen.getByTestId('run-bottom-pane-add-terminal'));
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument();
    expect(screen.getByTestId('run-shell-terminal-mock')).toHaveAttribute(
      'data-terminal-id',
      'run-xyz::t1',
    );

    // Close it → the tab is gone and the pane falls back to Chat.
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    expect(screen.queryByRole('tab', { name: 'Terminal 2' })).not.toBeInTheDocument();
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();
  });

  it('restores a run’s added terminals after switching away and back (per-run persistence)', () => {
    // Two active runs so the substrate resolves for both.
    act(() => {
      useActiveRunsStore.setState({
        runsByProject: {
          1: [
            { id: 'run-a', substrate: 'sdk' },
            { id: 'run-b', substrate: 'sdk' },
          ] as unknown as ActiveRunRow[],
        },
      });
    });
    setActiveRun('run-a');
    render(<RunBottomPane />);

    // Add a terminal to run-a.
    fireEvent.click(screen.getByTestId('run-bottom-pane-add-terminal'));
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument();

    // Switch to run-b → run-a's added terminal is NOT carried over.
    setActiveRun('run-b');
    expect(screen.queryByRole('tab', { name: 'Terminal 2' })).not.toBeInTheDocument();

    // Switch back to run-a → Terminal 2 (and its live shell) is restored.
    setActiveRun('run-a');
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument();
  });

  it('defaults to Chat tab and mounts RunChatView', () => {
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane />);
    // RunChatView (mocked) is mounted on first render; RunView is not.
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  it('clicking Data Stream tab mounts RunView and hides the chat', () => {
    setActiveRun('run-xyz');
    render(<RunBottomPane />);

    // Default: RunChatView is visible
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();

    // Click Data Stream tab
    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));

    // RunView renders the runId text
    expect(screen.getByText('run-xyz')).toBeInTheDocument();
    // Chat content gone
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();
  });

  it('clicking Chat tab after switching away restores RunChatView', () => {
    setActiveRun('run-xyz');
    render(<RunBottomPane />);

    // Switch to Data Stream (RunView visible, chat gone)
    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));
    expect(screen.getByText('run-xyz')).toBeInTheDocument();
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();

    // Switch back to Chat
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // onChatTabActiveChange wiring (TASK-047): the pane reports whether the Chat
  // tab is the active bottom-dock tab up to RunCenterPane, which combines it
  // with the dock-open state to tell RunPendingInputStrip whether the chat
  // transcript is the visible surface for a live question (so the strip can
  // stand down its duplicate live-question card).
  // -------------------------------------------------------------------------

  it('reports Chat-tab active (true) on mount — Chat is the default tab', () => {
    const onChatTabActiveChange = vi.fn();
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane onChatTabActiveChange={onChatTabActiveChange} />);
    expect(onChatTabActiveChange).toHaveBeenLastCalledWith(true);
  });

  it('reports false when switching to a non-chat tab (Data Stream) and true again on return to Chat', () => {
    const onChatTabActiveChange = vi.fn();
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane onChatTabActiveChange={onChatTabActiveChange} />);

    // Leaving Chat → the chat transcript is no longer the visible surface.
    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));
    expect(onChatTabActiveChange).toHaveBeenLastCalledWith(false);

    // Returning to Chat → the transcript is visible again.
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(onChatTabActiveChange).toHaveBeenLastCalledWith(true);
  });

  it('reports false when the Terminal tab is active (only Chat counts as the chat surface)', () => {
    const onChatTabActiveChange = vi.fn();
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    render(<RunBottomPane onChatTabActiveChange={onChatTabActiveChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(onChatTabActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('works stand-alone when onChatTabActiveChange is omitted (optional prop)', () => {
    seedRun('run-xyz', 'sdk');
    setActiveRun('run-xyz');
    // No callback threaded — must not throw and still renders the Chat tab.
    expect(() => render(<RunBottomPane />)).not.toThrow();
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
  });
});
