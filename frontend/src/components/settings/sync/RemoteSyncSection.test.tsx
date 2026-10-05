import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSyncStatus } from '../../../../../shared/types/remoteSync';
import { REMOTE_SYNC_STAGING_ORIGIN } from '../../../../../shared/types/remoteSync';
import { useConfigStore } from '../../../stores/configStore';

const { getStatus } = vi.hoisted(() => ({ getStatus: vi.fn<() => Promise<RemoteSyncStatus>>() }));
vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { remoteSync: { getStatus: { query: getStatus } } } },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { RemoteSyncSection } from './RemoteSyncSection';

function devStatus(overrides: Partial<Extract<RemoteSyncStatus, { available: true }>> = {}): RemoteSyncStatus {
  return {
    available: true,
    enabled: false,
    serverOrigin: REMOTE_SYNC_STAGING_ORIGIN,
    staging: true,
    signedIn: false,
    ...overrides,
  };
}

describe('RemoteSyncSection', () => {
  beforeEach(() => {
    getStatus.mockReset();
  });

  it('renders nothing in a release build', async () => {
    getStatus.mockResolvedValue({ available: false });
    const { container } = render(<RemoteSyncSection />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Sync across machines')).not.toBeInTheDocument();
  });

  it('renders nothing when the status call fails', async () => {
    getStatus.mockRejectedValue(new Error('no route'));
    const { container } = render(<RemoteSyncSection />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the section with a Staging badge in a dev build, flag off', async () => {
    getStatus.mockResolvedValue(devStatus());
    render(<RemoteSyncSection />);
    expect(await screen.findByText('Sync across machines')).toBeInTheDocument();
    expect(screen.getByTestId('remote-sync-staging-badge')).toHaveTextContent('Staging');
    expect(screen.queryByTestId('remote-sync-signed-out')).not.toBeInTheDocument();
  });

  it('shows the signed-out state once enabled', async () => {
    getStatus.mockResolvedValue(devStatus({ enabled: true }));
    render(<RemoteSyncSection />);
    expect(await screen.findByTestId('remote-sync-signed-out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('writes the flag through the config store and refreshes', async () => {
    const updateConfig = vi.fn().mockResolvedValue(true);
    useConfigStore.setState({ updateConfig });
    getStatus.mockResolvedValueOnce(devStatus()).mockResolvedValueOnce(devStatus({ enabled: true }));
    render(<RemoteSyncSection />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable sync across machines' }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ remoteSync: { enabled: true } }));
    expect(await screen.findByTestId('remote-sync-signed-out')).toBeInTheDocument();
  });
});
