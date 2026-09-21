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
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import type { StreamEvent } from '../../utils/cyboflowApi';

// -- UnifiedChatView stub: captures mode/running/liveTail and renders bottomSlot
//    verbatim (liveTail alongside it, so tests can assert on its presence/absence
//    the same way a real ChatTranscript would gate its animated fallback). --
interface UnifiedChatViewStubProps {
  mode: string;
  running?: boolean;
  liveTail?: ReactNode;
  bottomSlot?: ReactNode;
}

vi.mock('../cyboflow/unified/UnifiedChatView', () => ({
  UnifiedChatView: ({ mode, running, liveTail, bottomSlot }: UnifiedChatViewStubProps) => (
    <div data-testid="unified-chat-view-stub" data-mode={mode} data-running={String(running)}>
      <div data-testid="live-tail-slot">{liveTail}</div>
      {bottomSlot}
    </div>
  ),
}));

let mockMessages: UnifiedMessage[] = [];
vi.mock('../cyboflow/unified/useUnifiedAgentThreadMessages', () => ({
  useUnifiedAgentThreadMessages: () => ({ messages: mockMessages, isLoading: false, loadError: null }),
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
let mockLiveEvents: StreamEvent[] = [];

interface FakeAgentThreadState {
  thread: AgentThread | null;
  sending: boolean;
  sendMessage: typeof mockSendMessage;
  proposals: AgentProposal[];
  liveEvents: StreamEvent[];
}

vi.mock('../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadState) => unknown) =>
    selector({
      thread: mockThread,
      sending: mockSending,
      sendMessage: mockSendMessage,
      proposals: mockProposals,
      liveEvents: mockLiveEvents,
    }),
}));

/** A synthetic `stream_event` envelope matching the wrapper shape AgentThreadService
 *  publishes and agentThreadStore captures into `liveEvents`. */
function makeStreamEventEnvelope(event: Record<string, unknown>): StreamEvent {
  return {
    type: 'stream_event',
    payload: { type: 'stream_event', event },
    timestamp: '2026-09-21T00:00:00.000Z',
  } as StreamEvent;
}

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 'thread-1',
    scope: 'global',
    model: null,
    claudeSessionId: null,
    sessionRuntime: null,
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
  mockMessages = [];
  mockLiveEvents = [];
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

    expect(mockSendMessage).toHaveBeenCalledWith('hello agent', undefined);
  });

  it('forwards the composer image attachments into the store opts', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    // Drive the real AgentComposer's attach path (it is not stubbed here) so
    // this proves the whole composer → view → store hop, not just the callback.
    const file = new File([Uint8Array.from([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('agent-composer-file-input'), { target: { files: [file] } });
    await screen.findByTestId('agent-composer-attachments');
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(mockSendMessage).toHaveBeenCalledWith('', {
      images: [expect.objectContaining({ name: 'shot.png', mediaType: 'image/png' })],
    });
  });

  it('a suggestion chip calls store.sendMessage with its canned prompt', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    fireEvent.click(screen.getByText('Status update'));

    expect(mockSendMessage).toHaveBeenCalledWith('Status update', undefined);
  });

  it('disables the composer before the thread has loaded', async () => {
    mockThread = null;
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.getByTestId('agent-composer-input')).toBeDisabled();
  });
});

describe('AgentThreadView — live tail (claude-sdk stream_event wiring, assistant rail parity)', () => {
  it('renders progressive LiveTail content when liveEvents carries visible text', async () => {
    mockThread = makeThread();
    mockLiveEvents = [
      makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      makeStreamEventEnvelope({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi there' } }),
    ];
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.getByTestId('live-tail')).toBeInTheDocument();
    expect(screen.getByTestId('live-tail')).toHaveTextContent('Hi there');
  });

  it('renders no LiveTail node (keeps the animated fallback) when liveEvents is empty (e.g. codex-sdk runtime)', async () => {
    mockThread = makeThread();
    mockLiveEvents = [];
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.queryByTestId('live-tail')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-tail-slot')).toBeEmptyDOMElement();
  });

  it('gates on VISIBLE content — an opened-but-empty block does not render a bare header', async () => {
    mockThread = makeThread();
    // content_block_start only: the block is open but carries no text yet.
    mockLiveEvents = [
      makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    ];
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.queryByTestId('live-tail')).not.toBeInTheDocument();
  });
});

describe('AgentThreadView — model badge', () => {
  function msg(role: UnifiedMessage['role'], model?: string): UnifiedMessage {
    return {
      id: `m-${role}-${model ?? 'none'}`,
      role,
      timestamp: '2026-07-17T00:00:00.000Z',
      segments: [{ type: 'text', content: 'hi' }],
      ...(model !== undefined ? { metadata: { model } } : {}),
    } as UnifiedMessage;
  }

  it('shows "default" before any assistant turn has run and no per-thread override is set', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);
    expect(screen.getByTestId('agent-model-badge')).toHaveTextContent('model · default');
  });

  it('shows the model stamped on the LAST assistant turn, ignoring user turns after it', async () => {
    mockThread = makeThread({ model: 'opus' });
    mockMessages = [msg('assistant', 'claude-opus-5'), msg('assistant', 'claude-sonnet-5'), msg('user')];
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);
    expect(screen.getByTestId('agent-model-badge')).toHaveTextContent('model · claude-sonnet-5');
  });
});
