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
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
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
// Ticker backfill (runs.contextUsage) — both facts unknown by default.
const mockContextUsage = vi.fn<() => Promise<{ usedTokens: number | null; contextWindow: number | null }>>(
  async () => ({ usedTokens: null, contextWindow: null }),
);
// Artifacts feed for the question-card "open in pane" wiring (#8 / #9).
import type { Artifact } from '../../../../../shared/types/artifacts';
const mockArtifactsList = vi.fn<() => Promise<Artifact[]>>(async () => []);

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listUnifiedMessages: {
          query: (...args: Parameters<typeof mockListUnifiedMessages>) => mockListUnifiedMessages(...args),
        },
        contextUsage: {
          query: (...args: Parameters<typeof mockContextUsage>) => mockContextUsage(...args),
        },
      },
      artifacts: {
        list: {
          query: (...args: Parameters<typeof mockArtifactsList>) => mockArtifactsList(...args),
        },
        onArtifactChanged: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
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

// The ChatTranscript stub invokes `renderToolCallExtra` with a fixed tool id so
// the inline AskUserQuestionCard injection (and its artifact wiring) is exercised
// without depending on the real transcript's projection internals.
vi.mock('../../chat/ChatTranscript', () => ({
  ChatTranscript: ({
    renderToolCallExtra,
  }: {
    renderToolCallExtra?: (toolCallId: string) => ReactNode;
  }) => (
    <div data-testid="chat-transcript">
      ChatTranscript
      {renderToolCallExtra?.('tool-use-card')}
    </div>
  ),
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

// Capture the model-fallback push callback RunChatView subscribes with, so a test
// can fire a notice and assert the toast. Only the `models` surface is used here.
const apiMock = vi.hoisted(() => {
  const state: { fallbackCb: ((notice: unknown) => void) | null } = { fallbackCb: null };
  return { state };
});
vi.mock('../../../utils/api', () => ({
  API: {
    models: {
      onModelFallback: (cb: (notice: unknown) => void) => {
        apiMock.state.fallbackCb = cb;
        return () => {
          apiMock.state.fallbackCb = null;
        };
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { RunChatView } from '../RunChatView';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import { useQuestionStore } from '../../../stores/questionStore';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
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
    useQuestionStore.setState({ queue: [], connectionStatus: 'idle', otherText: {} });
    useCenterPaneStore.setState({ bySession: {} });
  });
  apiMock.state.fallbackCb = null;
  mockListUnifiedMessages.mockClear();
  mockListUnifiedMessages.mockImplementation(async () => []);
  mockArtifactsList.mockClear();
  mockArtifactsList.mockImplementation(async () => []);
  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Artifact fixture
// ---------------------------------------------------------------------------

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: overrides.id ?? 'art-1',
    runId: overrides.runId ?? 'run-art',
    sessionId: overrides.sessionId ?? null,
    atype: overrides.atype ?? 'idea-spec',
    label: overrides.label ?? 'IDEA-001 Spec',
    stepOrigin: overrides.stepOrigin ?? null,
    mode: overrides.mode ?? 'template',
    committed: overrides.committed ?? false,
    sessionOnly: overrides.sessionOnly ?? false,
    isNew: overrides.isNew ?? false,
    payloadJson: overrides.payloadJson ?? null,
    sourceRef: overrides.sourceRef ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    committedAt: overrides.committedAt ?? null,
  };
}

/** Seed a pending question whose toolUseId matches the ChatTranscript stub's id. */
function seedQuestion(runId: string): void {
  act(() => {
    useQuestionStore.setState({
      queue: [
        {
          id: 'q-1',
          runId,
          workflowName: 'planner',
          toolUseId: 'tool-use-card',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          answeredAt: null,
          answerJson: null,
          questions: [
            {
              question: 'Approve?',
              header: 'Approve',
              multiSelect: false,
              options: [{ label: 'Yes', preview: '# Yes\nbody' }, { label: 'No' }],
            },
          ],
        },
      ],
      connectionStatus: 'connected',
      otherText: {},
    });
  });
}

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

// ---------------------------------------------------------------------------
// Tests — AskUserQuestionCard artifact wiring (#8 / #9)
// ---------------------------------------------------------------------------

describe('RunChatView — question-card artifact wiring', () => {
  it('passes onOpenArtifact when an artifact exists; "View in pane" opens a center-pane tab', async () => {
    mockArtifactsList.mockImplementation(async () => [makeArtifact({ id: 'art-1', atype: 'idea-spec', label: 'IDEA-001 Spec' })]);
    seedRun('run-art', 'sdk');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-art');
    });
    seedQuestion('run-art');

    render(<RunChatView runId="run-art" />);

    // The injected card surfaces the "open in pane" affordances (per-option +
    // below-prompt link) once the artifact list resolves.
    const belowLink = await screen.findByRole('button', { name: /View IDEA-001 Spec in pane/i });
    expect(screen.queryByText('Show preview')).not.toBeInTheDocument();

    // Clicking the below-prompt link opens an idea-spec center-pane tab keyed by
    // the run id (no parent session → key falls back to activeRunId).
    fireEvent.click(belowLink);
    await waitFor(() => {
      const session = useCenterPaneStore.getState().bySession['run-art'];
      expect(session?.tabs.some((t) => t.kind === 'artifact' && t.artifactId === 'art-1')).toBe(true);
    });
  });

  it('prefers the idea-spec artifact over a more-recent non-idea-spec one', async () => {
    mockArtifactsList.mockImplementation(async () => [
      makeArtifact({ id: 'art-spec', atype: 'idea-spec', label: 'Spec', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeArtifact({ id: 'art-shot', atype: 'screenshots', label: 'Shots', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    seedRun('run-art', 'sdk');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-art');
    });
    seedQuestion('run-art');

    render(<RunChatView runId="run-art" />);

    // The link copy carries the idea-spec label even though the screenshot is newer.
    const link = await screen.findByRole('button', { name: /View Spec in pane/i });
    fireEvent.click(link);
    await waitFor(() => {
      const session = useCenterPaneStore.getState().bySession['run-art'];
      expect(session?.tabs.some((t) => t.kind === 'artifact' && t.artifactId === 'art-spec')).toBe(true);
    });
  });

  it('falls back to inline preview when the run has no artifacts', async () => {
    mockArtifactsList.mockImplementation(async () => []);
    seedRun('run-art', 'sdk');
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-art');
    });
    seedQuestion('run-art');

    render(<RunChatView runId="run-art" />);

    // No artifact → card keeps the inline "Show preview" toggle, no "in pane" CTAs.
    expect(await screen.findByText('Show preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /in pane/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — mid-call model fallback toast
// ---------------------------------------------------------------------------

describe('RunChatView — model fallback toast', () => {
  it('raises a toast when THIS run falls back off a pulled model', async () => {
    seedRun('run-fb', 'sdk');
    render(<RunChatView runId="run-fb" />);
    await waitFor(() => expect(apiMock.state.fallbackCb).not.toBeNull());

    act(() => {
      apiMock.state.fallbackCb!({
        panelId: 'run-fb',
        sessionId: 'run-fb',
        unavailableAlias: 'fable',
        unavailableLabel: 'Fable 5',
        fallbackAlias: 'opus',
      });
    });

    expect(await screen.findByTestId('session-action-toast')).toHaveTextContent(
      'Fable 5 is unavailable — switched to Opus 4.8 for this run.',
    );
  });

  it('ignores a fallback notice addressed to a DIFFERENT run', async () => {
    seedRun('run-fb', 'sdk');
    render(<RunChatView runId="run-fb" />);
    await waitFor(() => expect(apiMock.state.fallbackCb).not.toBeNull());

    act(() => {
      apiMock.state.fallbackCb!({
        panelId: 'other-run',
        sessionId: 'other-run',
        unavailableAlias: 'fable',
        unavailableLabel: 'Fable 5',
        fallbackAlias: 'opus',
      });
    });

    expect(screen.queryByTestId('session-action-toast')).toBeNull();
  });
});
