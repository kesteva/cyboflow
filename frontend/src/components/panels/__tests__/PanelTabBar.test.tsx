import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../../shared/types/panels';
import type { Session } from '../../../types/session';
import { SessionProvider } from '../../../contexts/SessionContext';
import { PanelTabBar } from '../PanelTabBar';

function panel(id: string, title: string): ToolPanel {
  return {
    id,
    sessionId: 'session-1',
    type: 'claude',
    title,
    state: { isActive: id === 'panel-1', customState: {} },
    metadata: {
      createdAt: '2026-07-13T00:00:00.000Z',
      lastActiveAt: '2026-07-13T00:00:00.000Z',
      position: 0,
    },
  };
}

function sessionWithRuntime(agentRuntime: 'claude-sdk' | 'codex-sdk' | 'codex-pty'): Session {
  return {
    id: 'session-1',
    worktreePath: '/wt/session-1',
    projectId: 1,
    agentRuntime,
  } as unknown as Session;
}

describe('PanelTabBar chat labels', () => {
  it('renders legacy provider-generated titles as provider-neutral Chat tabs', () => {
    const panels = [
      panel('panel-1', 'Claude 1'),
      panel('panel-2', 'Codex'),
    ];

    render(
      <PanelTabBar
        panels={panels}
        activePanel={panels[0]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Chat 1')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.queryByText('Claude 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
  });

  it('preserves a user-supplied chat panel title', () => {
    const customPanel = panel('panel-1', 'Planning notes');

    render(
      <PanelTabBar
        panels={[customPanel]}
        activePanel={customPanel}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Planning notes')).toBeInTheDocument();
  });
});

describe('PanelTabBar add chat action', () => {
  it('renders Add chat next to Add terminal as a substrate picker and invokes the chat callback with no override for "Inherit session"', () => {
    const onAddTerminal = vi.fn();
    const onAddChat = vi.fn();

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddTerminal={onAddTerminal}
        onAddChat={onAddChat}
      />,
    );

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add terminal panel', 'Add chat panel']);

    // Clicking the trigger opens the picker rather than creating a chat directly.
    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    expect(onAddChat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Inherit session'));

    expect(onAddChat).toHaveBeenCalledTimes(1);
    expect(onAddChat).toHaveBeenCalledWith(undefined);
    expect(onAddTerminal).not.toHaveBeenCalled();
  });

  it('invokes the chat callback with the chosen substrate override', () => {
    const onAddChat = vi.fn();

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddChat={onAddChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    fireEvent.click(screen.getByText('CLI (interactive)'));

    expect(onAddChat).toHaveBeenCalledTimes(1);
    expect(onAddChat).toHaveBeenCalledWith('interactive');
  });

  it('logs rejected async add-chat callbacks instead of leaking an unhandled rejection', async () => {
    const error = new Error('create chat failed');
    const onAddChat = vi.fn().mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddChat={onAddChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    fireEvent.click(screen.getByText('Inherit session'));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[PanelTabBar] Failed to add chat:', error);
    });

    errorSpy.mockRestore();
  });

  /**
   * The picker chooses a substrate, not a provider — "SDK" in a Codex session
   * launches the CODEX SDK, because the provider is session-wide. The copy used
   * to say "Claude SDK" unconditionally, which named the wrong agent for every
   * Codex session.
   */
  it.each([
    { runtime: 'codex-sdk' as const, expected: 'Codex SDK', wrong: 'Claude SDK' },
    { runtime: 'claude-sdk' as const, expected: 'Claude SDK', wrong: 'Codex SDK' },
  ])('names the session provider in the SDK option ($runtime)', ({ runtime, expected, wrong }) => {
    const onAddChat = vi.fn();

    render(
      <SessionProvider session={sessionWithRuntime(runtime)}>
        <PanelTabBar panels={[]} onPanelSelect={vi.fn()} onPanelClose={vi.fn()} onAddChat={onAddChat} />
      </SessionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(wrong)).not.toBeInTheDocument();

    // The provider is display-only: the callback still carries just the substrate.
    fireEvent.click(screen.getByText(expected));
    expect(onAddChat).toHaveBeenCalledWith('sdk');
  });

  /**
   * Both axes resolve independently in main (services/panelLane.ts), so an
   * override stays inside the session's provider: the PTY option in a Codex
   * session is the CODEX terminal, and both options are live in every session
   * type — including codex-pty, where they used to be ignored outright.
   */
  it.each([
    { runtime: 'codex-sdk' as const, provider: 'Codex' },
    { runtime: 'codex-pty' as const, provider: 'Codex' },
    { runtime: 'claude-sdk' as const, provider: 'Claude' },
  ])('names the session provider in the PTY option ($runtime)', ({ runtime, provider }) => {
    const onAddChat = vi.fn();

    render(
      <SessionProvider session={sessionWithRuntime(runtime)}>
        <PanelTabBar panels={[]} onPanelSelect={vi.fn()} onPanelClose={vi.fn()} onAddChat={onAddChat} />
      </SessionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    expect(screen.getByText(`Run this chat with the interactive ${provider} terminal`)).toBeInTheDocument();

    // Live in every session type — the override actually routes now.
    fireEvent.click(screen.getByText('CLI (interactive)'));
    expect(onAddChat).toHaveBeenCalledWith('interactive');
  });
});
