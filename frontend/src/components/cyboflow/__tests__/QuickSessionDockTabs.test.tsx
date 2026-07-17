import '@testing-library/jest-dom';
import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../RunView', () => ({
  RunView: ({ runId }: { runId?: string | null }) => (
    <div data-testid="mock-run-view" data-run-id={runId ?? ''}>
      {runId === null ? 'No active run' : `Events for ${runId}`}
    </div>
  ),
}));

import { QuickSessionDockTabs } from '../QuickSessionDockTabs';

describe('QuickSessionDockTabs', () => {
  it('passes the quick session chatRunId to Data Stream and keeps chat mounted across switches', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();

    function LiveChatSurface() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div data-testid="live-chat-surface">Live chat / xterm</div>;
    }

    render(
      <QuickSessionDockTabs
        runId="quick-chat-run-1"
        chatContent={<LiveChatSurface />}
      />,
    );

    const chatPanel = screen.getByTestId('quick-session-dock-chat-panel');
    const streamPanel = screen.getByTestId('quick-session-dock-data-stream-panel');
    const chatSurface = screen.getByTestId('live-chat-surface');
    expect(chatPanel).toHaveStyle({ display: 'flex' });
    expect(streamPanel).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('mock-run-view')).toHaveAttribute('data-run-id', 'quick-chat-run-1');
    expect(mounted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));
    expect(chatPanel).toHaveStyle({ display: 'none' });
    expect(streamPanel).toHaveStyle({ display: 'block' });
    expect(screen.getByTestId('live-chat-surface')).toBe(chatSurface);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByTestId('live-chat-surface')).toBe(chatSurface);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('renders the null-run placeholder without crashing before chatRunId is minted', () => {
    render(
      <QuickSessionDockTabs
        runId={null}
        chatContent={<div>Chat content</div>}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));
    expect(screen.getByText('No active run')).toBeInTheDocument();
    expect(screen.getByTestId('mock-run-view')).toHaveAttribute('data-run-id', '');
  });
});
