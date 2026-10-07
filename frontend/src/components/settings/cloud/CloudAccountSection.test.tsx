import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { CloudChangedEvent, CloudDeviceSummary, CloudSignInFailureCode, CloudStatus } from '../../../../../shared/types/cloudAccountWire';
import { makeBridgeConnector, makeCloudStatus, makeStatus } from '../../agentsEnv/__tests__/fixtures';

let cloudStatus: CloudStatus;
let handlers: { onData: (e: CloudChangedEvent) => void } | null;
let statusQuery: ReturnType<typeof vi.fn>;
let signInMutate: ReturnType<typeof vi.fn>;
let cancelMutate: ReturnType<typeof vi.fn>;
let reopenMutate: ReturnType<typeof vi.fn>;
let signOutMutate: ReturnType<typeof vi.fn>;
let refreshMutate: ReturnType<typeof vi.fn>;
let unlockMutate: ReturnType<typeof vi.fn>;
let listDevicesQuery: ReturnType<typeof vi.fn>;
let openDevicesMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { get query() { return statusQuery; } },
        onCloudChanged: {
          subscribe: vi.fn().mockImplementation((_i: undefined, h: { onData: (e: CloudChangedEvent) => void }) => {
            handlers = h;
            return { unsubscribe: vi.fn() };
          }),
        },
        signIn: { get mutate() { return signInMutate; } },
        cancelSignIn: { get mutate() { return cancelMutate; } },
        reopenSignInPage: { get mutate() { return reopenMutate; } },
        signOut: { get mutate() { return signOutMutate; } },
        refreshAccount: { get mutate() { return refreshMutate; } },
        unlock: { get mutate() { return unlockMutate; } },
        listDevices: { get query() { return listDevicesQuery; } },
        openDevicesPage: { get mutate() { return openDevicesMutate; } },
      },
      persistentAgents: {},
    },
  },
}));

import { CloudAccountSection, bridgeChip } from './CloudAccountSection';
import { signInFailureCopy, cloudErrorCopy, platformLabel, formatExpiry } from './cloudCopy';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

const cloudInitial = useCloudAccountStore.getState();

beforeEach(() => {
  handlers = null;
  cloudStatus = makeCloudStatus('signed_in');
  statusQuery = vi.fn().mockImplementation(async () => cloudStatus);
  signInMutate = vi.fn().mockResolvedValue({ expiresAt: '2026-10-07T11:00:00.000Z' });
  cancelMutate = vi.fn().mockResolvedValue({ cancelled: true });
  reopenMutate = vi.fn().mockResolvedValue({ opened: true });
  signOutMutate = vi.fn().mockResolvedValue({ remoteRevoked: 'yes' });
  refreshMutate = vi.fn().mockImplementation(async () => cloudStatus);
  unlockMutate = vi.fn().mockImplementation(async () => cloudStatus);
  listDevicesQuery = vi.fn().mockResolvedValue({ ok: true, devices: [] });
  openDevicesMutate = vi.fn().mockResolvedValue({ opened: true });
  useCloudAccountStore.setState({ ...cloudInitial, status: null, devices: null, lastSignOut: null, actionError: null, pending: null });
  usePersistentAgentsStore.setState({ featureStatus: null, connectors: null });
});

async function show(testId: string): Promise<HTMLElement> {
  return screen.findByTestId(testId);
}

describe('CloudAccountSection: visibility', () => {
  it('renders nothing for an unavailable status', async () => {
    cloudStatus = { available: false };
    const { container } = render(<CloudAccountSection />);
    await waitFor(() => expect(statusQuery).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is loading', () => {
    statusQuery = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { container } = render(<CloudAccountSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CloudAccountSection: states', () => {
  it('signed_out: copy, the default device name, and Sign in with GitHub (called once)', async () => {
    cloudStatus = makeCloudStatus('signed_out');
    render(<CloudAccountSection />);
    const state = await show('cloud-state-signed_out');
    expect(state).toHaveTextContent('Not signed in.');
    expect(state).toHaveTextContent('This computer will appear as my-mac.');
    fireEvent.click(screen.getByTestId('cloud-signin-button'));
    await waitFor(() => expect(signInMutate).toHaveBeenCalledTimes(1));
  });

  it('signing_in (waiting): Finish signing in, an expiry, Cancel, and Open the browser again', async () => {
    cloudStatus = makeCloudStatus('signing_in', {
      signIn: { phase: 'waiting_for_browser', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString() },
    });
    render(<CloudAccountSection />);
    const state = await show('cloud-state-signing_in');
    expect(state).toHaveTextContent('Finish signing in in your browser.');
    expect(state).toHaveTextContent('The link expires in 10 minutes.');
    fireEvent.click(screen.getByTestId('cloud-cancel-signin'));
    await waitFor(() => expect(cancelMutate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('cloud-reopen-browser'));
    await waitFor(() => expect(reopenMutate).toHaveBeenCalledTimes(1));
  });

  it('Open the browser again reports a browser that would not open', async () => {
    reopenMutate = vi.fn().mockResolvedValue({ opened: false });
    cloudStatus = makeCloudStatus('signing_in', {
      signIn: { phase: 'waiting_for_browser', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    render(<CloudAccountSection />);
    fireEvent.click(await screen.findByTestId('cloud-reopen-browser'));
    expect(await screen.findByText("cyboflow couldn't open your browser.")).toBeInTheDocument();
  });

  it('signing_in (registering): the Cancel button is disabled', async () => {
    cloudStatus = makeCloudStatus('signing_in', { signIn: { phase: 'registering', startedAt: new Date().toISOString() } });
    render(<CloudAccountSection />);
    const state = await show('cloud-state-signing_in');
    expect(state).toHaveTextContent('Registering this computer…');
    expect(screen.getByTestId('cloud-cancel-signin')).toBeDisabled();
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it('locked: shows who is signed in, Unlocking…, and Unlock retries explicitly', async () => {
    cloudStatus = makeCloudStatus('locked');
    render(<CloudAccountSection />);
    const state = await show('cloud-state-locked');
    expect(state).toHaveTextContent('Signed in as @octo');
    expect(state).toHaveTextContent('Unlocking your saved sign-in…');
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: false }));
    fireEvent.click(screen.getByTestId('cloud-unlock'));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
  });

  it('signed_in with an unfetched account: Checking your account…, no Bridge chip and no Last checked', async () => {
    cloudStatus = makeCloudStatus('signed_in', { lastOkAt: null });
    render(<CloudAccountSection />);
    const state = await show('cloud-state-signed_in');
    expect(state).toHaveTextContent('Checking your account…');
    expect(screen.queryByTestId('cloud-bridge-chip')).toBeNull();
    expect(state).not.toHaveTextContent('Last checked');
    await waitFor(() => expect(screen.getByTestId('cloud-check-again')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cloud-check-again'));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: true }));
  });

  it('signed_in: login, device line, Bridge chip, Last checked, and the action buttons', async () => {
    render(<CloudAccountSection />);
    const state = await show('cloud-state-signed_in');
    await waitFor(() => expect(screen.getByTestId('cloud-bridge-chip')).toBeInTheDocument());
    expect(state).toHaveTextContent('Signed in as @octo');
    expect(state).toHaveTextContent('This computer: my-mac · ref code ABC');
    expect(state).toHaveTextContent('Last checked');
    expect(screen.getByRole('button', { name: 'Devices' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cloud-manage-devices'));
    await waitFor(() => expect(openDevicesMutate).toHaveBeenCalledTimes(1));
  });

  it('needs_update: copy and Check again', async () => {
    cloudStatus = makeCloudStatus('needs_update');
    render(<CloudAccountSection />);
    const state = await show('cloud-state-needs_update');
    expect(state).toHaveTextContent('Update cyboflow to keep using cyboflow cloud.');
    fireEvent.click(screen.getByTestId('cloud-check-again'));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: true }));
  });

  it('revoked: Sign in again and Remove', async () => {
    cloudStatus = makeCloudStatus('revoked');
    render(<CloudAccountSection />);
    const state = await show('cloud-state-revoked');
    expect(state).toHaveTextContent('This computer was signed out of cyboflow cloud.');
    fireEvent.click(screen.getByTestId('cloud-remove'));
    await waitFor(() => expect(signOutMutate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(signInMutate).toHaveBeenCalledTimes(1));
  });

  it('undecryptable: Try again is offered before Sign in again, and retries with an explicit unlock', async () => {
    cloudStatus = makeCloudStatus('undecryptable');
    render(<CloudAccountSection />);
    const state = await show('cloud-state-undecryptable');
    expect(state).toHaveTextContent("This computer's saved sign-in can't be read.");
    const buttons = Array.from(state.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.indexOf('Try again')).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf('Try again')).toBeLessThan(buttons.indexOf('Sign in again'));
    fireEvent.click(screen.getByTestId('cloud-retry-unlock'));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
  });

  it('secrets_unavailable: Try again unlocks explicitly and does not start with a forced refresh', async () => {
    cloudStatus = makeCloudStatus('secrets_unavailable');
    render(<CloudAccountSection />);
    await show('cloud-state-secrets_unavailable');
    refreshMutate.mockClear();
    fireEvent.click(screen.getByTestId('cloud-retry-unlock'));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
    expect(refreshMutate).not.toHaveBeenCalledWith({ force: true });
  });

  it('no Copy sign-in link button exists in any state', async () => {
    for (const display of ['signed_out', 'signing_in', 'locked', 'signed_in', 'needs_update', 'revoked', 'undecryptable', 'secrets_unavailable'] as const) {
      cloudStatus = makeCloudStatus(display, {
        signIn: display === 'signing_in' ? { phase: 'waiting_for_browser', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } : undefined,
      });
      useCloudAccountStore.setState({ ...cloudInitial, status: null });
      const { unmount } = render(<CloudAccountSection />);
      await screen.findByTestId(`cloud-state-${display}`);
      expect(screen.queryByText(/copy sign-in link/i)).toBeNull();
      unmount();
    }
  });
});

describe('CloudAccountSection: sign out', () => {
  it('requires the inline confirm: nothing is sent before it, exactly one call after', async () => {
    render(<CloudAccountSection />);
    await show('cloud-state-signed_in');
    fireEvent.click(await screen.findByTestId('cloud-signout-button'));
    expect(screen.getByTestId('cloud-signout-confirm')).toHaveTextContent(
      'Sign out this computer? Bridge connections stop receiving messages until you sign in again.',
    );
    expect(signOutMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cloud-signout-confirm-yes'));
    await waitFor(() => expect(signOutMutate).toHaveBeenCalledTimes(1));
  });

  it('Keep signed in dismisses the confirm without signing out', async () => {
    render(<CloudAccountSection />);
    fireEvent.click(await screen.findByTestId('cloud-signout-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep signed in' }));
    expect(screen.queryByTestId('cloud-signout-confirm')).toBeNull();
    expect(signOutMutate).not.toHaveBeenCalled();
  });

  async function signOutWith(remoteRevoked: 'yes' | 'no' | 'skipped' | 'not_needed'): Promise<void> {
    signOutMutate = vi.fn().mockResolvedValue({ remoteRevoked });
    render(<CloudAccountSection />);
    fireEvent.click(await screen.findByTestId('cloud-signout-button'));
    fireEvent.click(screen.getByTestId('cloud-signout-confirm-yes'));
    await waitFor(() => expect(signOutMutate).toHaveBeenCalled());
    cloudStatus = makeCloudStatus('signed_out');
    act(() => handlers?.onData({ kind: 'signedOut', status: cloudStatus }));
    await show('cloud-state-signed_out');
  }

  it('a remote revoke that failed shows the notice with Manage devices…', async () => {
    await signOutWith('no');
    expect(screen.getByTestId('cloud-signout-remote-notice')).toHaveTextContent(
      "This computer's registration may still be active on your account. Revoke it on the Devices page.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage devices…' }));
    await waitFor(() => expect(openDevicesMutate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('cloud-signout-remote-notice')).toBeNull();
  });

  it('a skipped remote revoke shows the notice too', async () => {
    await signOutWith('skipped');
    expect(screen.getByTestId('cloud-signout-remote-notice')).toBeInTheDocument();
  });

  it.each(['yes', 'not_needed'] as const)('a %s result shows no notice', async (r) => {
    await signOutWith(r);
    expect(screen.queryByTestId('cloud-signout-remote-notice')).toBeNull();
  });
});

describe('CloudAccountSection: Bridge chip', () => {
  function seedBridge(availability: Parameters<typeof makeBridgeConnector>[0]): void {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus(), connectors: [makeBridgeConnector(availability)] });
  }

  async function chipText(): Promise<string> {
    const chip = await screen.findByTestId('cloud-bridge-chip');
    return chip.textContent ?? '';
  }

  it('is "Bridge: enabled" when no running status is available', async () => {
    render(<CloudAccountSection />);
    expect(await chipText()).toBe('Bridge: enabled');
  });

  it.each([
    ['ok', 'Bridge: connected'],
    ['disabled', 'Bridge: off on this computer'],
    ['needs_update', 'Bridge: needs update'],
    ['not_entitled', 'Bridge: not enabled for this account'],
    ['unavailable', 'Bridge: unreachable · retrying'],
    ['locked', 'Bridge: paused'],
  ] as const)('with the connector %s the chip reads %s', async (state, label) => {
    seedBridge({ availability: { state, message: null, retryAt: null } });
    render(<CloudAccountSection />);
    expect(await chipText()).toBe(label);
  });

  it('an account without the entitlement reads not enabled, with the beta help line', async () => {
    cloudStatus = makeCloudStatus('signed_in', { bridgeEntitled: false });
    seedBridge({});
    render(<CloudAccountSection />);
    expect(await chipText()).toBe('Bridge: not enabled for this account');
    expect(screen.getByText('Bridge access is granted per account during the beta.')).toBeInTheDocument();
  });

  it('bridgeChip is a pure first-match table', () => {
    const status = makeCloudStatus('signed_in');
    if (!status.available || status.account === null) throw new Error('fixture');
    expect(bridgeChip({ ...status.account, bridgeEntitled: false }, true, makeBridgeConnector()).tone).toBe('warning');
    expect(bridgeChip(status.account, false, makeBridgeConnector()).label).toBe('Bridge: enabled');
    expect(bridgeChip(status.account, true, undefined).label).toBe('Bridge: enabled');
  });
});

describe('CloudAccountSection: badges, devices, errors', () => {
  it('shows the Staging badge only for a staging origin', async () => {
    const { unmount } = render(<CloudAccountSection />);
    await show('cloud-state-signed_in');
    expect(screen.queryByTestId('cloud-staging-badge')).toBeNull();
    unmount();
    cloudStatus = { ...(makeCloudStatus('signed_in') as Extract<CloudStatus, { available: true }>), staging: true };
    useCloudAccountStore.setState({ ...cloudInitial, status: null });
    render(<CloudAccountSection />);
    expect(await screen.findByTestId('cloud-staging-badge')).toHaveTextContent('Staging');
  });

  it('warns when the signed-in origin differs from the configured one', async () => {
    cloudStatus = { ...(makeCloudStatus('signed_in') as Extract<CloudStatus, { available: true }>), originMismatch: true, configuredOrigin: 'https://other.example' };
    render(<CloudAccountSection />);
    expect(await screen.findByTestId('cloud-origin-mismatch')).toHaveTextContent(
      'Signed in to https://cloud.example. This build is set to https://other.example; sign out and sign in again to switch.',
    );
  });

  it('device rows are keyed without an id, mark This computer and hide revoked devices until expanded', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const devices: CloudDeviceSummary[] = [
      { code: 'ABC', name: 'my-mac', platform: 'darwin', appVersion: '0.5.1', createdAt: '2026-10-01T10:00:00.000Z', lastSeenAt: '2026-10-07T09:00:00.000Z', revokedAt: null, current: true },
      { code: 'DEF', name: 'my-mac', platform: 'win32', appVersion: null, createdAt: '2026-10-02T10:00:00.000Z', lastSeenAt: null, revokedAt: null, current: false },
      { code: 'GHI', name: 'old', platform: null, appVersion: null, createdAt: '2026-09-01T10:00:00.000Z', lastSeenAt: null, revokedAt: '2026-09-02T10:00:00.000Z', current: false },
    ];
    listDevicesQuery = vi.fn().mockResolvedValue({ ok: true, devices });
    render(<CloudAccountSection />);
    fireEvent.click(await screen.findByTestId('cloud-devices-toggle'));
    const list = await screen.findByTestId('cloud-devices');
    await waitFor(() => expect(list).toHaveTextContent('This computer'));
    expect(list).toHaveTextContent('macOS');
    expect(list).toHaveTextContent('Windows');
    expect(list).not.toHaveTextContent('old');
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 signed-out device' }));
    expect(list).toHaveTextContent('old');
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/unique "key"/);
    errors.mockRestore();
  });

  it('a device list error shows fixed copy', async () => {
    listDevicesQuery = vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', code: 'x', httpStatus: 0, at: '2026-10-07T10:00:00.000Z', retryNotBefore: null } });
    render(<CloudAccountSection />);
    fireEvent.click(await screen.findByTestId('cloud-devices-toggle'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach cyboflow cloud. Check your connection and try again.");
  });

  it('shows the sign-in failure copy, including a cancellation', async () => {
    cloudStatus = makeCloudStatus('signed_out', { lastSignInFailure: { code: 'cancelled', httpStatus: null, at: '2026-10-07T10:00:00.000Z' } });
    render(<CloudAccountSection />);
    expect(await screen.findByTestId('cloud-signin-failure')).toHaveTextContent('Sign-in was cancelled.');
  });
});

describe('cloudCopy', () => {
  const codes: CloudSignInFailureCode[] = [
    'cancelled', 'timed_out', 'browser_open_failed', 'loopback_failed', 'invalid_callback', 'browser_error',
    'invalid_code', 'bad_request', 'ref_code_taken', 'upgrade_required', 'rate_limited', 'service_unavailable',
    'network', 'bad_response', 'secrets_unavailable', 'not_available', 'unexpected',
  ];

  it.each(codes)('signInFailureCopy(%s) is non-empty fixed text', (code) => {
    expect(signInFailureCopy(code).length).toBeGreaterThan(10);
  });

  it('the browser-open copy tells the user to check the default browser', () => {
    expect(signInFailureCopy('browser_open_failed')).toBe(
      "cyboflow couldn't open your browser. Check that a default browser is set, then try again.",
    );
  });

  it('cloudErrorCopy covers every kind, and platformLabel never returns an empty string', () => {
    for (const kind of ['network', 'auth', 'revoked', 'not_entitled', 'upgrade_required', 'retryable', 'terminal'] as const) {
      expect(cloudErrorCopy({ kind, code: 'x', httpStatus: 0, at: '', retryNotBefore: null }).length).toBeGreaterThan(10);
    }
    expect(platformLabel(null)).toBe('Unknown platform');
    expect(platformLabel('freebsd')).toBe('freebsd');
  });

  it('formatExpiry reads a future deadline and never "just now"', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(formatExpiry('2026-10-07T12:09:00Z', now)).toBe('in 9 minutes');
    expect(formatExpiry('2026-10-07T12:00:30Z', now)).toBe('in less than a minute');
    expect(formatExpiry('2026-10-07T11:00:00Z', now)).toBe('soon');
    expect(formatExpiry('garbage', now)).toBe('soon');
  });
});
