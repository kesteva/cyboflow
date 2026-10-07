import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentMessageBubble } from '../AgentMessageBubble';
import { makeMessage } from './fixtures';
import { formatClock } from '../agentsEnvFormat';

const NOW = Date.parse('2026-10-07T12:00:00Z');

function renderBubble(over: Parameters<typeof makeMessage>[0], state: 'verified' | 'revoked' | null = 'verified'): ReturnType<typeof render> {
  return render(<AgentMessageBubble message={makeMessage(over)} agentName="My dot" connectionState={state} now={NOW} />);
}

describe('AgentMessageBubble', () => {
  it('an outbound message shows its receipt; an inbound one has none', () => {
    renderBubble({ id: 'o1', direction: 'out', author: 'user', sendState: 'on_bridge' });
    expect(screen.getByTestId('receipt-o1')).toHaveTextContent('On the bridge');
  });

  it('inbound messages carry no receipt', () => {
    renderBubble({ id: 'i1', direction: 'in' });
    expect(screen.queryByTestId('receipt-i1')).toBeNull();
  });

  it('Picked up shows the clock time', () => {
    const pickedUpAt = '2026-10-07T11:30:00.000Z';
    renderBubble({ id: 'o2', direction: 'out', author: 'user', sendState: 'on_bridge', pickedUpAt });
    expect(screen.getByTestId('receipt-o2')).toHaveTextContent(`Picked up ${formatClock(pickedUpAt, new Date(NOW))}`);
  });

  it('an accepted brief reads Accepted and a declined one Declined', () => {
    const { unmount } = renderBubble({ id: 'b1', direction: 'out', author: 'user', kind: 'brief', sendState: 'on_bridge', remoteAck: 'acked' });
    expect(screen.getByTestId('receipt-b1')).toHaveTextContent('Accepted');
    expect(screen.getByText('Brief')).toBeInTheDocument();
    unmount();
    renderBubble({ id: 'b2', direction: 'out', author: 'user', kind: 'brief', sendState: 'on_bridge', remoteAck: 'declined' });
    expect(screen.getByTestId('receipt-b2')).toHaveTextContent('Declined');
  });

  it('a queued message to a revoked connection says it is waiting', () => {
    renderBubble({ id: 'q', direction: 'out', author: 'user', sendState: 'queued' }, 'revoked');
    expect(screen.getByTestId('receipt-q')).toHaveTextContent('Waiting · agent disconnected');
  });

  it('an inbound body is shown as exact literal text, never as markup', () => {
    const body = '<script>alert(1)</script> **bold** [x](https://evil)';
    const { container } = renderBubble({ id: 'x', body });
    expect(screen.getByText(body)).toBeInTheDocument();
    const bubble = screen.getByTestId('message-x');
    expect(bubble.querySelector('script')).toBeNull();
    expect(bubble.querySelector('strong')).toBeNull();
    expect(bubble.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  describe('links', () => {
    const openExternal = vi.fn();
    beforeEach(() => {
      openExternal.mockReset();
      (window as unknown as { electronAPI: { openExternal: typeof openExternal } }).electronAPI = { openExternal };
    });
    afterEach(() => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    it('shows the domain and a truncated URL; clicking opens only through openExternal', () => {
      const url = `https://github.com/org/repo/pull/${'1'.repeat(120)}`;
      renderBubble({ links: [{ url, domain: 'github.com' }] });
      expect(screen.getByText('github.com')).toBeInTheDocument();
      const shown = screen.getByText(/^https:\/\/github\.com\/org\/repo\/pull\/1+…$/);
      expect(shown.textContent?.length).toBe(78);
      fireEvent.click(screen.getByText('github.com'));
      expect(openExternal).toHaveBeenCalledWith(url);
    });

    it('a javascript: link renders inert and a click does nothing', () => {
      renderBubble({ links: [{ url: 'javascript:alert(1)', domain: 'x' }] });
      expect(screen.getByText('unsupported link')).toBeInTheDocument();
      fireEvent.click(screen.getByText('unsupported link'));
      expect(openExternal).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /javascript/ })).toBeNull();
    });

    it('shows a punycode domain for a lookalike host', () => {
      renderBubble({ links: [{ url: 'https://xn--pple-43d.com/login', domain: 'xn--pple-43d.com' }] });
      expect(screen.getByText('xn--pple-43d.com')).toBeInTheDocument();
    });
  });

  it('a system note renders its body verbatim as plain text', () => {
    const body = 'A message from this agent expired on the cyboflow Bridge before this computer collected it.';
    renderBubble({ id: 's', direction: 'local', author: 'local', kind: 'system', body });
    expect(screen.getByTestId('message-s')).toHaveTextContent(body);
  });

  it('a system note with markup in it stays text', () => {
    renderBubble({ id: 's2', direction: 'in', author: 'relay', kind: 'system', body: '<b>paired</b>' });
    expect(screen.getByTestId('message-s2').querySelector('b')).toBeNull();
    expect(screen.getByText('<b>paired</b>')).toBeInTheDocument();
  });

  it('a body over 2000 characters is collapsed and expands on demand', () => {
    const body = 'a'.repeat(2500);
    renderBubble({ body });
    expect(screen.queryByText(body)).toBeNull();
    fireEvent.click(screen.getByText('Show all (2500 characters)'));
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it('labels a delivery report and lists its pull request link with the domain', () => {
    renderBubble({
      kind: 'delivery_report',
      body: 'Opened a PR',
      delivery: { prUrl: 'https://github.com/o/r/pull/9', prDomain: 'github.com', summary: null, briefId: null },
    });
    expect(screen.getByText('My dot reported a pull request')).toBeInTheDocument();
    expect(screen.getByText('github.com')).toBeInTheDocument();
  });
});
