/**
 * AgentThreadView tests (S1.2).
 *
 * UnifiedChatView and useUnifiedAgentThreadMessages are stubbed so this file
 * tests AgentThreadView's OWN wiring — mode/running passthrough, and the
 * composer/chips → store.sendMessage plumbing — not UnifiedChatView's
 * internals (covered by UnifiedChatView.test.tsx) or the store's own
 * subscription logic (covered by agentThreadStore.test.ts).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import type { AgentThread, AgentProposal } from '../../../../shared/types/agentThread';

// -- UnifiedChatView stub: captures mode/running and renders bottomSlot verbatim. --
interface UnifiedChatViewStubProps {
  mode: string;
  running?: boolean;
  bottomSlot?: ReactNode;
}

vi.mock('../cyboflow/unified/UnifiedChatView', () => ({
  UnifiedChatView: ({ mode, running, bottomSlot }: UnifiedChatViewStubProps) => (
    <div data-testid="unified-chat-view-stub" data-mode={mode} data-running={String(running)}>
      {bottomSlot}
    </div>
  ),
}));

vi.mock('../cyboflow/unified/useUnifiedAgentThreadMessages', () => ({
  useUnifiedAgentThreadMessages: () => ({ messages: [], isLoading: false, loadError: null }),
}));

// -- ProposalCardList stub: this file tests AgentThreadView's OWN wiring (the
//    proposals selector -> prop passthrough), not ProposalCardList's rendering
//    (covered by ProposalCardList.test.tsx / ProposalCard.test.tsx). --
vi.mock('./ProposalCardList', () => ({
  ProposalCardList: ({ proposals }: { proposals: AgentProposal[] }) => (
    <div data-testid="proposal-card-list-stub" data-count={proposals.length} />
  ),
}));

// -- agentThreadStore stub: a plain selector-applying function (not a real
//    subscribing Zustand store), driven by the mutable fixture vars below. --
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
let mockThread: AgentThread | null = null;
let mockSending = false;
let mockProposals: AgentProposal[] = [];

interface FakeAgentThreadState {
  thread: AgentThread | null;
  sending: boolean;
  sendMessage: typeof mockSendMessage;
  proposals: AgentProposal[];
}

vi.mock('../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadState) => unknown) =>
    selector({
      thread: mockThread,
      sending: mockSending,
      sendMessage: mockSendMessage,
      proposals: mockProposals,
    }),
}));

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 'thread-1',
    scope: 'global',
    model: null,
    claudeSessionId: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

async function loadAgentThreadView(): Promise<ComponentType> {
  const mod = await import('./AgentThreadView');
  return mod.AgentThreadView;
}

beforeEach(() => {
  vi.resetModules();
  mockSendMessage.mockClear();
  mockThread = null;
  mockSending = false;
  mockProposals = [];
});

describe('AgentThreadView — UnifiedChatView wiring', () => {
  it('passes mode="agent" and running=sending through to UnifiedChatView', async () => {
    mockSending = true;
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    const stub = screen.getByTestId('unified-chat-view-stub');
    expect(stub).toHaveAttribute('data-mode', 'agent');
    expect(stub).toHaveAttribute('data-running', 'true');
  });

  it('renders ProposalCardList above the chips + composer, passing store.proposals through', async () => {
    mockThread = makeThread();
    mockProposals = [
      {
        id: 'p1',
        threadId: 'thread-1',
        kind: 'open-session',
        payload: { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
        preconditions: null,
        status: 'proposed',
        result: null,
        idempotencyKey: null,
        createdAt: '2026-07-17T00:00:00.000Z',
        decidedAt: null,
      },
    ];
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    const stub = screen.getByTestId('proposal-card-list-stub');
    expect(stub).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('agent-suggestion-chips')).toBeInTheDocument();
    expect(screen.getByTestId('agent-composer')).toBeInTheDocument();
  });
});

describe('AgentThreadView — composer + chips wiring', () => {
  it('composer Send calls store.sendMessage', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    fireEvent.change(screen.getByTestId('agent-composer-input'), {
      target: { value: 'hello agent' },
    });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(mockSendMessage).toHaveBeenCalledWith('hello agent');
  });

  it('a suggestion chip calls store.sendMessage with its canned prompt', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    fireEvent.click(screen.getByText('Status update'));

    expect(mockSendMessage).toHaveBeenCalledWith('Status update');
  });

  it('disables the composer before the thread has loaded', async () => {
    mockThread = null;
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.getByTestId('agent-composer-input')).toBeDisabled();
  });
});
