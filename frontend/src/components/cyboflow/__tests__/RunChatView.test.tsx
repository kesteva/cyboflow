/**
 * RunChatView component tests.
 *
 * RunChatView renders the run's conversation. As of IDEA-030 / TASK-815 it
 * branches on the run's CLI substrate (read from activeRunsStore the way
 * ChatInput does):
 *   - 'interactive' → the live PTY xterm (InteractiveTerminalView) REPLACES the
 *     structured transcript; the right PromptNavigation rail is dropped; the
 *     composer (ChatInput) and approvals strip (PendingApprovalsForRun) stay
 *     mounted. The listUnifiedMessages-fed ChatTranscript stays dormant (not in
 *     the DOM) so the conversation is not double-rendered.
 *   - 'sdk' / undefined → the existing ChatTranscript + PromptNavigation rail,
 *     byte-for-byte the prior behavior.
 *
 * Heavy children are mocked as testid stubs so the branch logic — not pixel
 * rendering — is under test. Data-flow behaviors verified alongside the branch:
 *   - On mount with runId set, calls listUnifiedMessages.query once with { runId }.
 *   - Re-queries with the new runId when runId changes.
 *   - Quick-session mode renders a placeholder and skips the query.
 *   - Empty mode renders "No active run".
 *   - A debounced live re-query fires after streamEvents change.
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
  subscribeToPtyBytes: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    subscribeToPtyBytes: vi.fn(() => vi.fn()),
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
      },
      events: {
        onStuckDetected: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        onApprovalCreated: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        onApprovalDecided: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        onRunStatusChanged: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock the heavy children as testid stubs — branch logic, not pixel rendering.
// ---------------------------------------------------------------------------

vi.mock('../InteractiveTerminalView', () => ({
  InteractiveTerminalView: ({ runId }: { runId: string }) => (
    <div data-testid="interactive-terminal-view">InteractiveTerminalView:{runId}</div>
  ),
}));

vi.mock('../../chat/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript">ChatTranscript</div>,
}));

vi.mock('../../panels/claude/PromptNavigation', () => ({
  PromptNavigation: () => <div data-testid="prompt-navigation">PromptNavigation</div>,
}));

vi.mock('../ChatInput', () => ({
  ChatInput: ({ runId }: { runId: string | null }) => (
    <div data-testid="chat-input">ChatInput:{String(runId)}</div>
  ),
}));

vi.mock('../../ReviewQueue/PendingApprovalsForRun', () => ({
  PendingApprovalsForRun: ({ runId }: { runId: string | null }) => (
    <div data-testid="pending-approvals-for-run">PendingApprovalsForRun:{String(runId)}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { RunChatView } from '../RunChatView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import type { CliSubstrate } from '../../../../../shared/types/substrate';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useActiveRunsStore.setState({ runsByProject: {} });
  });
  mockListUnifiedMessages.mockClear();
  mockListUnifiedMessages.mockImplementation(async () => []);
  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunRow(id: string, substrate: CliSubstrate | undefined): ActiveRunRow {
  return {
    id,
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
    permission_mode_snapshot: 'default',
    substrate,
    workflowName: 'planner',
  };
}

function seedRun(id: string, substrate: CliSubstrate | undefined): void {
  act(() => {
    useActiveRunsStore.setState({ runsByProject: { 7: [makeRunRow(id, substrate)] } });
  });
}

// ---------------------------------------------------------------------------
// Tests — substrate branch
// ---------------------------------------------------------------------------

describe('RunChatView — substrate branch', () => {
  it("interactive: renders InteractiveTerminalView, drops the rail + ChatTranscript, keeps composer + approvals", async () => {
    seedRun('run-int', 'interactive');

    render(<RunChatView runId="run-int" />);

    await waitFor(() => {
      expect(screen.getByTestId('interactive-terminal-view')).toBeInTheDocument();
    });
    // The structured transcript surface + rail are gone.
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-navigation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-chat-prompt-rail-toggle')).not.toBeInTheDocument();
    // Composer + approvals stay mounted.
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approvals-for-run')).toBeInTheDocument();
  });

  it("sdk: renders ChatTranscript + PromptNavigation rail, no InteractiveTerminalView", async () => {
    seedRun('run-sdk', 'sdk');

    render(<RunChatView runId="run-sdk" />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('run-chat-prompt-rail-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
    // Composer + approvals stay mounted here too.
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approvals-for-run')).toBeInTheDocument();
  });

  it("undefined substrate falls back to the sdk surface (ChatTranscript + rail)", async () => {
    seedRun('run-undef', undefined);

    render(<RunChatView runId="run-undef" />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
  });

  it("no matching run row falls back to the sdk surface (ChatTranscript + rail)", async () => {
    // runsByProject does not contain run-missing → run resolves null → sdk path.
    render(<RunChatView runId="run-missing" />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-terminal-view')).not.toBeInTheDocument();
  });

  it("interactive: does NOT render the structured ChatTranscript (no double-render)", async () => {
    mockListUnifiedMessages.mockImplementation(async () => [
      { id: 'a-1', role: 'assistant', timestamp: '2026-05-26T00:00:00Z', segments: [{ type: 'text', content: 'hi' }] },
    ]);
    seedRun('run-int2', 'interactive');

    render(<RunChatView runId="run-int2" />);

    await waitFor(() => {
      expect(screen.getByTestId('interactive-terminal-view')).toBeInTheDocument();
    });
    // Even with messages available, the ChatTranscript is not in the DOM.
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — data flow (substrate-agnostic; sdk surface)
// ---------------------------------------------------------------------------

describe('RunChatView — data flow', () => {
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

  it('renders quick-session placeholder when runId is null and selectedSessionId is set', () => {
    act(() => {
      useCyboflowStore.getState().setActiveQuickSession('qs-001');
    });

    render(<RunChatView runId={null} />);

    expect(screen.getByText('Quick session chat (history rendered by panel surface)')).toBeInTheDocument();
    expect(mockListUnifiedMessages).not.toHaveBeenCalled();
  });

  it('renders "No active run" when runId is null and selectedSessionId is also null', () => {
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

    act(() => {
      useCyboflowStore.getState().appendStreamEvent({
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
      });
    });

    // Debounced re-query should fire after the debounce window.
    await waitFor(() => {
      expect(mockListUnifiedMessages).toHaveBeenCalledTimes(2);
    }, { timeout: 2000 });
  });
});
