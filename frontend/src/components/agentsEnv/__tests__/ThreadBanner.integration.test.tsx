import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { CloudStatus } from '../../../../../shared/types/cloudAccountWire';
import { makeAgent, makeCloudStatus, makeConnection } from './fixtures';

let statusQuery: ReturnType<typeof vi.fn>;
let unlockMutate: ReturnType<typeof vi.fn>;
let refreshMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { get query() { return statusQuery; } },
        onCloudChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        unlock: { get mutate() { return unlockMutate; } },
        refreshAccount: { get mutate() { return refreshMutate; } },
        signIn: { mutate: vi.fn() },
        cancelSignIn: { mutate: vi.fn() },
        reopenSignInPage: { mutate: vi.fn() },
      },
      persistentAgents: {},
    },
  },
}));

import { ThreadBanner } from '../ThreadBanner';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';

const initial = useCloudAccountStore.getState();

function seed(s: CloudStatus): void {
  statusQuery = vi.fn().mockResolvedValue(s);
}

beforeEach(() => {
  unlockMutate = vi.fn().mockResolvedValue(makeCloudStatus('signed_in'));
  refreshMutate = vi.fn().mockResolvedValue(makeCloudStatus('signed_in'));
  seed(makeCloudStatus('signed_out'));
  useCloudAccountStore.setState({ ...initial, status: null, actionError: null, pending: null });
});

describe('ThreadBanner with the inline cloud prompt', () => {
  it('a signed_out availability shows the inline Sign in with GitHub prompt', async () => {
    const agent = makeAgent({
      connection: makeConnection({ availability: { state: 'signed_out', message: null, retryAt: null } }),
    });
    render(<ThreadBanner agent={agent} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
  });

  it('a locked availability with a keychain-unavailable cloud: Try again unlocks with an explicit retry', async () => {
    seed(makeCloudStatus('secrets_unavailable'));
    const agent = makeAgent({
      connection: makeConnection({ availability: { state: 'locked', message: 'Waiting for the sign-in.', retryAt: null } }),
    });
    render(<ThreadBanner agent={agent} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
    expect(screen.getByText('Waiting for the sign-in.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
  });

  it('renders nothing for a healthy agent', () => {
    const { container } = render(<ThreadBanner agent={makeAgent()} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a revoked Bridge connection offers Reconnect…', async () => {
    const onReconnect = vi.fn();
    const agent = makeAgent({ connection: makeConnection({ state: 'revoked' }) });
    render(<ThreadBanner agent={agent} onOpenPairing={vi.fn()} onReconnect={onReconnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect…' }));
    expect(onReconnect).toHaveBeenCalledWith('a1');
  });

  it('a pending switch adds the reconnecting line, and a failing remote revoke adds its warning', () => {
    const pending = makeConnection({ id: 'conn-2', state: 'pending' });
    const agent = makeAgent({
      pendingSwitch: { connectionId: 'conn-2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z', connection: pending },
      retiredConnections: [
        { connectionId: 'old', connectorDisplayName: 'cyboflow Bridge', remoteRevoke: { state: 'pending', attempts: 3, lastError: null } },
      ],
    });
    render(<ThreadBanner agent={agent} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
    expect(screen.getByText('Reconnecting · waiting for the new connection to verify.')).toBeInTheDocument();
    expect(screen.getByTestId('agent-retired-revoke-warning')).toHaveTextContent('(3 tries) · retrying');
  });
});
