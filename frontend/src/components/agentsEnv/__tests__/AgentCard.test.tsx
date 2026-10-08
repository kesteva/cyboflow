import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeAgent, makeConnection, makeStatus } from './fixtures';

let disconnectMutate: ReturnType<typeof vi.fn>;
let archiveMutate: ReturnType<typeof vi.fn>;
let listAgentsQuery: ReturnType<typeof vi.fn>;
let openDevicesMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      persistentAgents: {
        status: { query: vi.fn().mockResolvedValue({ devBuild: true, configEnabled: true, enabled: true, killed: false, running: true, bridgeDisabled: false }) },
        listAgents: { get query() { return listAgentsQuery; } },
        disconnect: { get mutate() { return disconnectMutate; } },
        archiveAgent: { get mutate() { return archiveMutate; } },
        onAgentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      cloud: {
        openDevicesPage: { get mutate() { return openDevicesMutate; } },
      },
    },
  },
}));

import { AgentCard } from '../AgentCard';
import { AgentsTab } from '../AgentsTab';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

const handlers = () => ({ onOpen: vi.fn(), onOpenPairing: vi.fn(), onReconnect: vi.fn() });

beforeEach(() => {
  disconnectMutate = vi.fn().mockResolvedValue({ ok: true, connectionId: 'conn-1', remoteRevoke: 'done', offerForgetCredentialId: null });
  archiveMutate = vi.fn().mockResolvedValue({ ok: true });
  listAgentsQuery = vi.fn().mockResolvedValue([]);
  openDevicesMutate = vi.fn().mockResolvedValue({ opened: true });
  useNavigationStore.setState({ agentsEnvOpen: true, agentsEnvAgentId: null });
});

function dotOf(): string | null {
  return screen.getAllByRole('img')[0].getAttribute('data-dot');
}

describe('AgentCard', () => {
  it('the health dot and copy follow deriveHealth', () => {
    const now = Date.now();
    const cases: Array<[string, Parameters<typeof makeConnection>[0], string]> = [
      ['green', { state: 'verified', lastSeenAt: new Date(now - 60_000).toISOString() }, 'Connected via cyboflow Bridge · last seen 1m ago'],
      ['amber', { state: 'verified', lastSeenAt: new Date(now - 2 * 3_600_000).toISOString() }, 'Connected via cyboflow Bridge · last seen 2h ago'],
      ['neutral', { state: 'stale', lastSeenAt: null }, 'Quiet · messages wait on the bridge'],
      ['hollow', { state: 'pending' }, 'Not yet verified · waiting for its first reply'],
      ['red', { state: 'revoked' }, 'Token revoked'],
    ];
    for (const [dot, conn, copy] of cases) {
      const { unmount } = render(<AgentCard agent={makeAgent({ connection: makeConnection(conn) })} {...handlers()} />);
      expect(dotOf()).toBe(dot);
      expect(screen.getByText(copy)).toBeInTheDocument();
      unmount();
    }
  });

  it('no connection reads Not connected with a neutral dot', () => {
    render(<AgentCard agent={makeAgent({ connection: null })} {...handlers()} />);
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(dotOf()).toBe('neutral');
  });

  it('the unread pill shows only above zero and caps at 99+', () => {
    const { rerender } = render(<AgentCard agent={makeAgent({ unreadCount: 0 })} {...handlers()} />);
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    rerender(<AgentCard agent={makeAgent({ unreadCount: 3 })} {...handlers()} />);
    expect(screen.getByLabelText('3 unread')).toHaveTextContent('3');
    rerender(<AgentCard agent={makeAgent({ unreadCount: 150 })} {...handlers()} />);
    expect(screen.getByLabelText('150 unread')).toHaveTextContent('99+');
  });

  it('Pairing details only for a pending Bridge connection or a pending Bridge switch', () => {
    const h = handlers();
    const { rerender } = render(<AgentCard agent={makeAgent({ connection: makeConnection({ state: 'pending' }) })} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pairing details' }));
    expect(h.onOpenPairing).toHaveBeenCalledWith('a1');
    rerender(<AgentCard agent={makeAgent()} {...h} />);
    expect(screen.queryByRole('button', { name: 'Pairing details' })).toBeNull();
    rerender(
      <AgentCard
        agent={makeAgent({
          connection: makeConnection({ state: 'revoked' }),
          pendingSwitch: { connectionId: 'c2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z', connection: makeConnection({ id: 'c2', state: 'pending' }) },
        })}
        {...h}
      />,
    );
    expect(screen.getByRole('button', { name: 'Pairing details' })).toBeInTheDocument();
  });

  it('Disconnect… asks first, then disconnects; a pending remote revoke is explained', async () => {
    disconnectMutate.mockResolvedValue({ ok: true, connectionId: 'conn-1', remoteRevoke: 'pending', offerForgetCredentialId: null });
    render(<AgentCard agent={makeAgent()} {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Disconnect My dot?')).toBeInTheDocument();
    expect(
      screen.getByText("cyboflow revokes this agent's Bridge connection. Its thread stays here; use Reconnect to pair it again."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledWith({ agentId: 'a1' }));
    expect(await screen.findByText('Revoking on the Bridge — cyboflow keeps retrying.')).toBeInTheDocument();
  });

  it('a failed disconnect shows an alert', async () => {
    disconnectMutate.mockResolvedValue({ ok: false, error: 'not_found', message: 'gone' });
    render(<AgentCard agent={makeAgent()} {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This agent or connection no longer exists.');
  });

  it('a cloud_locked disconnect failure asks main to unlock the cloud sign-in', async () => {
    const unlock = vi.fn().mockResolvedValue(null);
    useCloudAccountStore.setState({ unlock });
    disconnectMutate.mockResolvedValue({ ok: false, error: 'cloud_locked', message: 'locked' });
    render(<AgentCard agent={makeAgent()} {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith(false));
  });

  it('Open thread calls onOpen with the id', () => {
    const h = handlers();
    render(<AgentCard agent={makeAgent()} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(h.onOpen).toHaveBeenCalledWith('a1');
  });

  it('Reconnect… is shown for a revoked Bridge connection only', () => {
    const h = handlers();
    const { rerender } = render(<AgentCard agent={makeAgent({ connection: makeConnection({ state: 'revoked' }) })} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect…' }));
    expect(h.onReconnect).toHaveBeenCalledWith('a1');
    // Disconnect… is not offered for an already revoked connection.
    expect(screen.queryByRole('button', { name: 'Disconnect…' })).toBeNull();
    rerender(<AgentCard agent={makeAgent()} {...h} />);
    expect(screen.queryByRole('button', { name: 'Reconnect…' })).toBeNull();
    rerender(<AgentCard agent={makeAgent({ connection: null })} {...h} />);
    expect(screen.queryByRole('button', { name: 'Reconnect…' })).toBeNull();
  });

  it('Archive… asks, archives, and the card is gone after the refetch', async () => {
    const agent = makeAgent();
    listAgentsQuery.mockResolvedValue([agent]);
    usePersistentAgentsStore.setState({ agents: [agent], agentsStatus: 'ready', featureStatus: makeStatus() });
    const teardown = usePersistentAgentsStore.getState().init();
    try {
      render(<AgentsTab onConnect={vi.fn()} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('agent-card-a1')).toBeInTheDocument());
      listAgentsQuery.mockResolvedValue([]);
      fireEvent.click(screen.getByTestId('agent-archive'));
      expect(archiveMutate).not.toHaveBeenCalled();
      expect(screen.getByText('Archive My dot?')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
      await waitFor(() => expect(archiveMutate).toHaveBeenCalledWith({ agentId: 'a1' }));
      await waitFor(() => expect(screen.queryByTestId('agent-card-a1')).toBeNull());
    } finally {
      teardown();
    }
  });

  it('archiving the open agent clears the selection', async () => {
    useNavigationStore.setState({ agentsEnvAgentId: 'a1' });
    render(<AgentCard agent={makeAgent()} {...handlers()} />);
    fireEvent.click(screen.getByTestId('agent-archive'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(useNavigationStore.getState().agentsEnvAgentId).toBeNull());
  });

  it('a retired connection with failed revokes shows the warning; gave_up points to the Devices page', () => {
    const { rerender } = render(
      <AgentCard
        agent={makeAgent({
          retiredConnections: [{ connectionId: 'r1', connectorDisplayName: 'cyboflow Bridge', remoteRevoke: { state: 'pending', attempts: 3, lastError: null } }],
        })}
        {...handlers()}
      />,
    );
    expect(screen.getByTestId('agent-retired-revoke-warning')).toHaveTextContent(
      "cyboflow couldn't revoke this agent's old Bridge access (3 tries) · retrying",
    );
    expect(screen.queryByRole('button', { name: 'Manage devices…' })).toBeNull();
    rerender(
      <AgentCard
        agent={makeAgent({
          retiredConnections: [{ connectionId: 'r1', connectorDisplayName: 'cyboflow Bridge', remoteRevoke: { state: 'gave_up', attempts: 9, lastError: null } }],
        })}
        {...handlers()}
      />,
    );
    expect(screen.getByTestId('agent-retired-revoke-warning')).toHaveTextContent(
      "cyboflow couldn't revoke this agent's old Bridge access and stopped retrying. Revoke it from the Devices page.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage devices…' }));
    expect(openDevicesMutate).toHaveBeenCalledTimes(1);
  });

  it('an 80-character name renders in full with no clamp or truncate classes', () => {
    const name = 'N'.repeat(80);
    const { container } = render(
      <div style={{ width: '320px' }}>
        <AgentCard agent={makeAgent({ displayName: name })} {...handlers()} />
      </div>,
    );
    const el = screen.getByTitle(name);
    expect(el).toHaveTextContent(name);
    expect(el.className).not.toMatch(/line-clamp|truncate/);
    expect(el.className).toContain('break-words');
    expect(container.querySelector('[class*="line-clamp"]')).toBeNull();
  });
});
