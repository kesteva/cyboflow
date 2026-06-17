/**
 * RunBottomPane component tests (TASK-756, updated TASK-761).
 *
 * Behaviors verified:
 *   1. An SDK run shows only Chat + Data Stream (no Terminal tab — SDK has no PTY).
 *   2. An interactive run offers a Terminal tab that mounts the live terminal.
 *   3. Chat is the default active tab; RunChatView is mounted on first render.
 *   4. Clicking Data Stream tab mounts RunView (raw event log) and hides the chat.
 *   5. Clicking Chat tab after switching away restores RunChatView.
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

// Mock the tRPC client so the real RunView (mounted on the Data Stream tab)
// can call cyboflow.runs.listRawEvents.query without a live backend. Mirrors
// RunView.test.tsx; returns [] so the raw-event backfill resolves to empty.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listRawEvents: {
          query: vi.fn(async () => []),
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock tRPC client — the Data Stream tab mounts RunView, whose effect calls
// trpc.cyboflow.runs.listRawEvents.query(...) on mount. Without this mock the
// procedure is undefined and the awaited .query() rejects as an unhandled
// rejection (Vitest then exits 1 even though all assertions pass). Mirror the
// canonical mock in RunView.test.tsx; return [] so the backfill is a no-op.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listRawEvents: {
          query: vi.fn(async () => []),
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

// Mock InteractiveTerminalView so the interactive Terminal tab does not boot a
// real xterm/PTY subscription in jsdom.
vi.mock('../InteractiveTerminalView', () => ({
  InteractiveTerminalView: ({ runId }: { runId: string }) => (
    <div data-testid="interactive-terminal-mock">{runId}</div>
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
  it('an SDK run shows only Chat + Data Stream (no Terminal tab — SDK has no PTY)', () => {
    seedRun('run-xyz', 'sdk');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data Stream' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
  });

  it('an interactive run offers a Terminal tab that mounts the live terminal', () => {
    seedRun('run-pty', 'interactive');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-pty');
    });
    render(<RunBottomPane />);

    const terminalTab = screen.getByRole('tab', { name: 'Terminal' });
    expect(terminalTab).toBeInTheDocument();

    fireEvent.click(terminalTab);
    expect(screen.getByTestId('interactive-terminal-mock')).toHaveTextContent('run-pty');
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();
  });

  it('defaults to Chat tab and mounts RunChatView', () => {
    seedRun('run-xyz', 'sdk');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);
    // RunChatView (mocked) is mounted on first render; RunView is not.
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  it('clicking Data Stream tab mounts RunView and hides the chat', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
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
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
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
});
