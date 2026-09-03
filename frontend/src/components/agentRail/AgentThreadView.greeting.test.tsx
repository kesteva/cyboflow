/**
 * AgentThreadView — the onboarding finale's one-shot greeting.
 *
 * Kept separate from AgentThreadView.test.tsx (which stubs UnifiedChatView
 * without inspecting `messages`) because this behaviour is about the transcript
 * array itself. Two properties are load-bearing:
 *   1. The greeting is prepended as a SYNTHETIC assistant message — no SDK
 *      turn, no agent_messages row — and only when one is parked.
 *   2. The parked value is read NON-destructively and cleared by a mount
 *      effect, so <React.StrictMode>'s double-invoked initializer cannot eat it
 *      before the first paint (Codex review, major #7).
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';

interface UnifiedChatViewStubProps {
  messages: UnifiedMessage[];
}

vi.mock('../cyboflow/unified/UnifiedChatView', () => ({
  UnifiedChatView: ({ messages }: UnifiedChatViewStubProps) => (
    <div
      data-testid="unified-chat-view-stub"
      data-ids={messages.map((m) => m.id).join(',')}
      data-roles={messages.map((m) => m.role).join(',')}
    >
      {messages.map((m) => (
        <p key={m.id}>{m.segments.map((s) => (s.type === 'text' ? s.content : '')).join('')}</p>
      ))}
    </div>
  ),
}));

vi.mock('../cyboflow/unified/useUnifiedAgentThreadMessages', () => ({
  useUnifiedAgentThreadMessages: () => ({ messages: [], isLoading: false, loadError: null }),
}));

vi.mock('./ProposalCardList', () => ({
  ProposalCardList: () => <div data-testid="proposal-card-list-stub" />,
}));

vi.mock('../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      thread: null,
      sending: false,
      sendMessage: vi.fn(),
      proposals: [],
    }),
}));

import { AgentThreadView } from './AgentThreadView';
import { GREETING_KEY, primeAssistantGreeting } from './onboardingGreeting';

const GREETING_TEXT = 'dogwalkr is set up. If you need more help, ask me questions at any time.';

beforeEach(() => {
  localStorage.clear();
});

describe('AgentThreadView — onboarding greeting', () => {
  it('prepends the primed greeting as a synthetic assistant message and consumes it', () => {
    primeAssistantGreeting('dogwalkr');

    const { unmount } = render(<AgentThreadView />);

    const stub = screen.getByTestId('unified-chat-view-stub');
    expect(stub).toHaveAttribute('data-ids', 'onboarding-greeting');
    expect(stub).toHaveAttribute('data-roles', 'assistant');
    expect(screen.getByText(GREETING_TEXT)).toBeInTheDocument();
    // Consumed on mount: the next rail mount must not repeat it.
    expect(localStorage.getItem(GREETING_KEY)).toBeNull();

    unmount();
    render(<AgentThreadView />);
    expect(screen.getByTestId('unified-chat-view-stub')).toHaveAttribute('data-ids', '');
  });

  it('survives StrictMode double-invoked initializers', () => {
    primeAssistantGreeting('dogwalkr');

    render(
      <StrictMode>
        <AgentThreadView />
      </StrictMode>,
    );

    expect(screen.getByText(GREETING_TEXT)).toBeInTheDocument();
  });

  it('renders nothing extra when no greeting is parked', () => {
    render(<AgentThreadView />);

    expect(screen.getByTestId('unified-chat-view-stub')).toHaveAttribute('data-ids', '');
  });
});
