import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { cmaDescriptor, makeAgent, makeConnection } from './fixtures';

let controlMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      persistentAgents: {
        control: { get mutate() { return controlMutate; } },
        listAgents: { query: vi.fn().mockResolvedValue([]) },
      },
      cloud: { openDevicesPage: { mutate: vi.fn() } },
    },
  },
}));

import { ThreadHeader } from '../ThreadHeader';

const props = () => ({ onBack: vi.fn(), onOpenPairing: vi.fn(), onReconnect: vi.fn() });

beforeEach(() => {
  controlMutate = vi.fn().mockResolvedValue({ ok: true });
});

describe('ThreadHeader', () => {
  it('the connection line shows the derived health copy', () => {
    const lastSeenAt = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<ThreadHeader agent={makeAgent({ connection: makeConnection({ lastSeenAt }) })} {...props()} />);
    expect(screen.getByTestId('thread-connection-line')).toHaveTextContent('Connected via cyboflow Bridge · last seen 5m ago');
  });

  it('no connection reads Not connected', () => {
    render(<ThreadHeader agent={makeAgent({ connection: null })} {...props()} />);
    expect(screen.getByTestId('thread-connection-line')).toHaveTextContent('Not connected');
  });

  it('every chip is present for a bridge connection and none truncates', () => {
    render(<ThreadHeader agent={makeAgent()} {...props()} />);
    const chips = screen.getByTestId('thread-chips');
    expect(chips.children.length).toBe(8);
    for (const el of Array.from(chips.children)) expect(el.className).not.toContain('truncate');
  });

  it('Stop is hidden when the descriptor declares no control', () => {
    render(<ThreadHeader agent={makeAgent()} {...props()} />);
    expect(screen.queryByTestId('thread-stop')).toBeNull();
  });

  it('Stop reads (not confirmed) until observed, then plain Stop; click interrupts', async () => {
    const agent = makeAgent({
      connection: makeConnection({ capabilities: { descriptor: cmaDescriptor, descriptorVersion: 1, observed: {} } }),
    });
    const { rerender } = render(<ThreadHeader agent={agent} {...props()} />);
    expect(screen.getByTestId('thread-stop')).toHaveTextContent('Stop (not confirmed)');
    fireEvent.click(screen.getByTestId('thread-stop'));
    await waitFor(() => expect(controlMutate).toHaveBeenCalledWith({ agentId: 'a1', verb: 'interrupt' }));
    rerender(
      <ThreadHeader
        agent={makeAgent({
          connection: makeConnection({
            capabilities: { descriptor: cmaDescriptor, descriptorVersion: 1, observed: { control: '2026-10-07T10:00:00.000Z' } },
          }),
        })}
        {...props()}
      />,
    );
    expect(screen.getByTestId('thread-stop')).toHaveTextContent(/^Stop$/);
  });

  it('a failed stop shows why', async () => {
    controlMutate.mockResolvedValue({ ok: false, error: 'control_not_supported', message: 'x' });
    const agent = makeAgent({
      connection: makeConnection({ capabilities: { descriptor: cmaDescriptor, descriptorVersion: 1, observed: {} } }),
    });
    render(<ThreadHeader agent={agent} {...props()} />);
    fireEvent.click(screen.getByTestId('thread-stop'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't stop it: This agent can't be stopped from cyboflow.");
  });

  it('Pairing details only for a pending bridge connection', () => {
    const p = props();
    const { rerender } = render(<ThreadHeader agent={makeAgent({ connection: makeConnection({ state: 'pending' }) })} {...p} />);
    fireEvent.click(screen.getByTestId('thread-pairing-details'));
    expect(p.onOpenPairing).toHaveBeenCalledWith('a1');
    rerender(<ThreadHeader agent={makeAgent()} {...p} />);
    expect(screen.queryByTestId('thread-pairing-details')).toBeNull();
  });

  it('Reconnect… for a revoked Bridge connection; archiving lives on the card, not the thread', () => {
    const p = props();
    render(<ThreadHeader agent={makeAgent({ connection: makeConnection({ state: 'revoked' }) })} {...p} />);
    fireEvent.click(screen.getByTestId('thread-reconnect'));
    expect(p.onReconnect).toHaveBeenCalledWith('a1');
    expect(screen.queryByText(/Archive/)).toBeNull();
  });

  it('the back button reads All agents', () => {
    const p = props();
    render(<ThreadHeader agent={makeAgent()} {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(p.onBack).toHaveBeenCalledTimes(1);
  });
});
