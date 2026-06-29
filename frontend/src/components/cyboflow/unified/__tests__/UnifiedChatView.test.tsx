/**
 * UnifiedChatView tests — the shared chat surface rendered by BOTH the
 * workflow-run host (RunChatView) and the quick-session host (ClaudePanel).
 *
 * Covers the substrate branch (interactive body vs structured transcript + rail),
 * the host-injected slots (bottomSlot, renderToolCallExtra), the load-error
 * branch, and the prompt-rail collapse toggle. Heavy leaf children are mocked as
 * testid stubs so the branch/wiring logic — not pixel rendering — is under test.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode, RefObject } from 'react';
import type { UnifiedMessage } from '../../../../../../shared/types/unifiedMessage';

// The ChatTranscript stub echoes the message count, invokes renderToolCallExtra
// with a fixed id (inline-extra passthrough), and ATTACHES messagesEndRef so the
// host's auto-scroll effect can call scrollIntoView (scroll-on-switch coverage).
vi.mock('../../../chat/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    renderToolCallExtra,
    messagesEndRef,
  }: {
    messages: UnifiedMessage[];
    renderToolCallExtra?: (toolCallId: string) => ReactNode;
    messagesEndRef?: RefObject<HTMLDivElement | null>;
  }) => (
    <div data-testid="chat-transcript" data-count={messages.length}>
      ChatTranscript
      {renderToolCallExtra?.('tool-use-card')}
      <div ref={messagesEndRef} data-testid="messages-end" />
    </div>
  ),
}));

vi.mock('../../../panels/claude/PromptNavigation', () => ({
  PromptNavigation: ({ prompts }: { prompts?: { id: number }[] }) => (
    <div data-testid="prompt-navigation" data-markers={prompts?.length ?? 0}>
      PromptNavigation
    </div>
  ),
}));

import { UnifiedChatView } from '../UnifiedChatView';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userMsg(id: string, text: string): UnifiedMessage {
  return { id, role: 'user', timestamp: '2026-06-29T00:00:00Z', segments: [{ type: 'text', content: text }] };
}
function assistantMsg(id: string, text: string): UnifiedMessage {
  return { id, role: 'assistant', timestamp: '2026-06-29T00:00:01Z', segments: [{ type: 'text', content: text }] };
}

const baseProps = {
  name: 'Claude',
  folderLabel: 'feature-x',
  folderTitle: '/repo/wt/feature-x',
  branchName: 'feature/x',
  contextUsage: null,
} as const;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnifiedChatView — substrate branch', () => {
  it('sdk: renders ChatTranscript + PromptNavigation rail + rail toggle, no interactive body', () => {
    render(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="quick"
        messages={[userMsg('u1', 'hi'), assistantMsg('a1', 'hello')]}
        interactiveBody={<div data-testid="interactive-body">TERM</div>}
        bottomSlot={<div data-testid="bottom-slot">composer</div>}
      />,
    );

    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-count', '2');
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('run-chat-prompt-rail-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('bottom-slot')).toBeInTheDocument();
    expect(screen.getByTestId('chat-mode-identity')).toBeInTheDocument();
    expect(screen.getByTestId('chat-meta-strip')).toBeInTheDocument();
    // Even though an interactiveBody is supplied, the SDK transport ignores it.
    expect(screen.queryByTestId('interactive-body')).not.toBeInTheDocument();
  });

  it('interactive: renders the interactiveBody, drops transcript + rail + toggle, keeps bottomSlot', () => {
    render(
      <UnifiedChatView
        {...baseProps}
        name="Terminal"
        transport="interactive"
        mode="quick"
        messages={[userMsg('u1', 'hi')]}
        interactiveBody={<div data-testid="interactive-body">TERM</div>}
        bottomSlot={<div data-testid="bottom-slot">composer</div>}
      />,
    );

    expect(screen.getByTestId('interactive-body')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-navigation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-chat-prompt-rail-toggle')).not.toBeInTheDocument();
    // The bottom region (composer/approvals) stays mounted in interactive mode.
    expect(screen.getByTestId('bottom-slot')).toBeInTheDocument();
  });

  it('sdk + loadError: renders the inline error instead of the transcript', () => {
    render(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="flow"
        messages={[]}
        loadError="boom"
      />,
    );

    expect(screen.getByText(/Error loading history: boom/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
  });

  it('passes renderToolCallExtra through to ChatTranscript', () => {
    render(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="flow"
        messages={[userMsg('u1', 'hi')]}
        renderToolCallExtra={(id) => <div data-testid="extra">extra:{id}</div>}
      />,
    );
    expect(screen.getByTestId('extra')).toHaveTextContent('extra:tool-use-card');
  });

  it('derives prompt markers from user turns', () => {
    render(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="quick"
        messages={[userMsg('u1', 'first'), assistantMsg('a1', 'r'), userMsg('u2', 'second')]}
      />,
    );
    // Two user turns → two markers.
    expect(screen.getByTestId('prompt-navigation')).toHaveAttribute('data-markers', '2');
  });

  it('re-pins to the bottom on a host conversation switch (railId change), even with fewer messages', async () => {
    // Regression: the live quick path reuses one UnifiedChatView instance across
    // session switches. Without the railId reset, switching to a session with
    // FEWER messages leaves hasNewMessages=false (stale prevCount) → no scroll.
    const { rerender } = render(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="quick"
        railId="session-a"
        messages={[userMsg('u1', 'x'), assistantMsg('a1', 'y'), userMsg('u2', 'z')]}
      />,
    );
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
    (HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();

    // Switch to a shorter conversation: must still scroll to its latest message.
    rerender(
      <UnifiedChatView
        {...baseProps}
        transport="sdk"
        mode="quick"
        railId="session-b"
        messages={[userMsg('u3', 'only one')]}
      />,
    );
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('rail toggle collapses + restores the PromptNavigation rail', () => {
    render(
      <UnifiedChatView {...baseProps} transport="sdk" mode="quick" messages={[userMsg('u1', 'hi')]} />,
    );
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('run-chat-prompt-rail-toggle'));
    expect(screen.queryByTestId('prompt-navigation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('run-chat-prompt-rail-toggle'));
    expect(screen.getByTestId('prompt-navigation')).toBeInTheDocument();
  });
});
