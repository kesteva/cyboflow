/**
 * AgentThreadView tests (S1.2).
 *
 * UnifiedChatView and useUnifiedAgentThreadMessages are stubbed so this file
 * tests AgentThreadView's OWN wiring — mode/running passthrough, the
 * composer/chips → store.sendMessage plumbing, and the once-per-launch digest
 * gate — not UnifiedChatView's internals (covered by UnifiedChatView.test.tsx)
 * or the store's own subscription logic (covered by agentThreadStore.test.ts).
 *
 * The module-scoped `digestTriggeredThisLaunch` flag in AgentThreadView.tsx is
 * intentionally NOT React state (see its doc comment), so each test dynamically
 * re-imports the component after `vi.resetModules()` to get a fresh flag —
 * otherwise test order would leak the "already triggered" state across cases.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import type { AgentThread } from '../../../../shared/types/agentThread';

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

// -- agentThreadStore stub: a plain selector-applying function (not a real
//    subscribing Zustand store), driven by the mutable fixture vars below. --
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockTriggerDigest = vi.fn().mockResolvedValue(undefined);
let mockThread: AgentThread | null = null;
let mockSending = false;

interface FakeAgentThreadState {
  thread: AgentThread | null;
  sending: boolean;
  sendMessage: typeof mockSendMessage;
  triggerDigest: typeof mockTriggerDigest;
}

vi.mock('../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadState) => unknown) =>
    selector({
      thread: mockThread,
      sending: mockSending,
      sendMessage: mockSendMessage,
      triggerDigest: mockTriggerDigest,
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
  mockTriggerDigest.mockClear();
  mockThread = null;
  mockSending = false;
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

  it('leaves the S1.3 proposal-card slot as a comment placeholder — chips + composer are the only rendered bottomSlot content', async () => {
    mockThread = makeThread();
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

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

    fireEvent.click(screen.getByText('Where is everything?'));

    expect(mockSendMessage).toHaveBeenCalledWith('Where is everything?');
  });

  it('disables the composer before the thread has loaded', async () => {
    mockThread = null;
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    expect(screen.getByTestId('agent-composer-input')).toBeDisabled();
  });
});

describe('AgentThreadView — auto-digest (once per launch)', () => {
  it('does not trigger while the thread has not loaded', async () => {
    mockThread = null;
    const AgentThreadView = await loadAgentThreadView();
    render(<AgentThreadView />);

    await Promise.resolve();
    expect(mockTriggerDigest).not.toHaveBeenCalled();
  });

  it('triggers exactly once when the thread becomes available, and not again on remount', async () => {
    const AgentThreadView = await loadAgentThreadView();

    // First mount: thread still loading.
    mockThread = null;
    const { rerender, unmount } = render(<AgentThreadView />);
    await Promise.resolve();
    expect(mockTriggerDigest).not.toHaveBeenCalled();

    // The store's bootstrap resolves — thread becomes available.
    mockThread = makeThread();
    rerender(<AgentThreadView />);
    await waitFor(() => expect(mockTriggerDigest).toHaveBeenCalledTimes(1));

    // Unmount (rail toggles out of view) and remount (rail toggles back in,
    // shouldShowAgentRail) — the module-scoped flag must survive: no second
    // digest this launch. A genuinely fresh render() call (not `rerender`)
    // mirrors AgentRail's real unmount/mount cycle most directly.
    unmount();
    render(<AgentThreadView />);
    await Promise.resolve();
    expect(mockTriggerDigest).toHaveBeenCalledTimes(1);
  });
});
