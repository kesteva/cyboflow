/**
 * RunBottomPane component tests (TASK-756, updated TASK-761).
 *
 * Behaviors verified:
 *   1. Renders three tab buttons with labels Chat, Terminal, Data Stream.
 *   2. Chat is the default active tab; RunChatView is mounted on first render.
 *   3. Clicking Terminal tab shows the "Terminal — coming soon" placeholder and hides the chat.
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

// ---------------------------------------------------------------------------
// Mock RunChatView so the Chat tab test does not require tRPC / stores
// ---------------------------------------------------------------------------

vi.mock('../RunChatView', () => ({
  RunChatView: () => <div data-testid="run-chat-view-mock">RunChatView</div>,
}));

// ---------------------------------------------------------------------------
// Mock tRPC client — the Data Stream tab mounts the real RunView, whose
// backfill effect calls trpc.cyboflow.runs.listRawEvents.query(...). Stub it to
// resolve [] (mirrors RunView.test.tsx) so the effect does not throw on an
// undefined trpc client (which surfaced as an Unhandled Rejection that failed
// the run even though every assertion passed).
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listRawEvents: {
          query: async () => [],
        },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunBottomPane } from '../RunBottomPane';
import { useCyboflowStore } from '../../../stores/cyboflowStore';

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

describe('RunBottomPane', () => {
  it('renders three tabs with labels Chat, Terminal, Data Stream', () => {
    render(<RunBottomPane />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data Stream' })).toBeInTheDocument();
  });

  it('defaults to Chat tab and mounts RunChatView', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);
    // RunChatView (mocked) is mounted on first render; RunView is not.
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  it('clicking Terminal tab shows "Terminal — coming soon" and hides the chat', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);

    // Default: RunChatView is visible
    expect(screen.getByTestId('run-chat-view-mock')).toBeInTheDocument();

    // Click Terminal tab
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));

    // Terminal placeholder visible
    expect(screen.getByText('Terminal — coming soon')).toBeInTheDocument();
    // Chat content gone
    expect(screen.queryByTestId('run-chat-view-mock')).not.toBeInTheDocument();
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
