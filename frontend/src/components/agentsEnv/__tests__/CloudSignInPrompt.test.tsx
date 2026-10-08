import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { CloudChangedEvent, CloudStatus } from '../../../../../shared/types/cloudAccountWire';
import { makeCloudStatus } from './fixtures';

let calls: string[];
let statusQuery: ReturnType<typeof vi.fn>;
let subscribeMock: ReturnType<typeof vi.fn>;
let unsubscribeMock: ReturnType<typeof vi.fn>;
let signInMutate: ReturnType<typeof vi.fn>;
let cancelMutate: ReturnType<typeof vi.fn>;
let reopenMutate: ReturnType<typeof vi.fn>;
let unlockMutate: ReturnType<typeof vi.fn>;
let refreshMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { get query() { return statusQuery; } },
        onCloudChanged: { get subscribe() { return subscribeMock; } },
        signIn: { get mutate() { return signInMutate; } },
        cancelSignIn: { get mutate() { return cancelMutate; } },
        reopenSignInPage: { get mutate() { return reopenMutate; } },
        unlock: { get mutate() { return unlockMutate; } },
        refreshAccount: { get mutate() { return refreshMutate; } },
      },
    },
  },
}));

import { CloudSignInPrompt } from '../CloudSignInPrompt';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';

const initial = useCloudAccountStore.getState();

function seedStatus(s: CloudStatus | 'never'): void {
  statusQuery = vi.fn().mockImplementation(() => {
    calls.push('status');
    return s === 'never' ? new Promise(() => {}) : Promise.resolve(s);
  });
}

beforeEach(() => {
  calls = [];
  unsubscribeMock = vi.fn();
  subscribeMock = vi.fn().mockImplementation((_i: undefined, _h: { onData: (e: CloudChangedEvent) => void }) => {
    calls.push('subscribe');
    return { unsubscribe: unsubscribeMock };
  });
  signInMutate = vi.fn().mockResolvedValue({ expiresAt: '2026-10-07T11:00:00.000Z' });
  cancelMutate = vi.fn().mockResolvedValue({ cancelled: true });
  reopenMutate = vi.fn().mockResolvedValue({ opened: true });
  unlockMutate = vi.fn().mockResolvedValue(makeCloudStatus('signed_in'));
  refreshMutate = vi.fn().mockResolvedValue(makeCloudStatus('signed_in'));
  seedStatus(makeCloudStatus('signed_out'));
  useCloudAccountStore.setState({ ...initial, status: null, actionError: null, pending: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CloudSignInPrompt', () => {
  it('mounting with no prior init subscribes, then seeds cloud.status and shows Sign in with GitHub', async () => {
    render(<CloudSignInPrompt />);
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(calls.slice(0, 2)).toEqual(['subscribe', 'status']);
  });

  it('unmount tears the subscription down', async () => {
    const { unmount } = render(<CloudSignInPrompt />);
    await screen.findByRole('button', { name: 'Sign in with GitHub' });
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('shows the checking line while the status is unknown', () => {
    seedStatus('never');
    render(<CloudSignInPrompt />);
    expect(screen.getByText('Checking your cyboflow cloud account…')).toBeInTheDocument();
  });

  it('says so when cloud is not available in this build', async () => {
    seedStatus({ available: false });
    render(<CloudSignInPrompt />);
    expect(await screen.findByText("cyboflow cloud isn't available in this build.")).toBeInTheDocument();
  });

  it('signed out: the explanation and the sign-in button, which calls signIn once', async () => {
    render(<CloudSignInPrompt />);
    const btn = await screen.findByTestId('cloud-signin-button');
    expect(
      screen.getByText('The Bridge runs through cyboflow cloud. Sign in with GitHub to connect agents that have no API.'),
    ).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(signInMutate).toHaveBeenCalledTimes(1));
  });

  it('signing in: Finish signing in, Cancel, and Open the browser again calls reopenSignInPage', async () => {
    seedStatus(
      makeCloudStatus('signing_in', {
        signIn: { phase: 'waiting_for_browser', startedAt: '2026-10-07T10:00:00.000Z', expiresAt: '2026-10-07T10:10:00.000Z' },
      }),
    );
    render(<CloudSignInPrompt />);
    expect(await screen.findByText('Finish signing in in your browser…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelMutate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open the browser again' }));
    await waitFor(() => expect(reopenMutate).toHaveBeenCalledTimes(1));
  });

  it('revoked: the signed-out copy and Sign in again', async () => {
    seedStatus(makeCloudStatus('revoked'));
    render(<CloudSignInPrompt />);
    expect(
      await screen.findByText('This computer was signed out of cyboflow cloud. Sign in again to connect agents.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('undecryptable: Try again and Sign in again; Try again unlocks with an explicit retry', async () => {
    seedStatus(makeCloudStatus('undecryptable'));
    render(<CloudSignInPrompt />);
    expect(await screen.findByText(/can't read its saved sign-in on this computer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
  });

  it('locked: the unlocking line (the store unlocks implicitly, with no explicit retry)', async () => {
    seedStatus(makeCloudStatus('locked'));
    render(<CloudSignInPrompt />);
    expect(await screen.findByText('Unlocking your saved sign-in…')).toBeInTheDocument();
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: false }));
    expect(unlockMutate).not.toHaveBeenCalledWith({ explicitRetry: true });
  });

  it('secrets_unavailable: Try again unlocks with an explicit retry and then refreshes the account', async () => {
    seedStatus(makeCloudStatus('secrets_unavailable'));
    render(<CloudSignInPrompt />);
    expect(await screen.findByText("Your OS keychain isn't available right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cloud-prompt-retry-unlock'));
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: true }));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: false }));
    expect(unlockMutate.mock.invocationCallOrder[0]).toBeLessThan(refreshMutate.mock.invocationCallOrder[0]);
  });

  it('needs_update: the update line', async () => {
    seedStatus(makeCloudStatus('needs_update'));
    render(<CloudSignInPrompt />);
    expect(await screen.findByText('Update cyboflow to use the Bridge.')).toBeInTheDocument();
  });

  it('signed in with an unfetched account: Checking your account…, Check again, and no beta copy', async () => {
    refreshMutate = vi.fn().mockResolvedValue(makeCloudStatus('signed_in', { lastOkAt: null, bridgeEntitled: false }));
    seedStatus(makeCloudStatus('signed_in', { lastOkAt: null, bridgeEntitled: false }));
    render(<CloudSignInPrompt />);
    expect(await screen.findByText('Checking your account…')).toBeInTheDocument();
    expect(screen.queryByText(/private beta/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('cloud-prompt-check-again')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cloud-prompt-check-again'));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: true }));
  });

  it('signed in without the Bridge entitlement: the beta copy names the account', async () => {
    seedStatus(makeCloudStatus('signed_in', { bridgeEntitled: false, displayLogin: 'octo' }));
    render(<CloudSignInPrompt />);
    expect(
      await screen.findByText("The cyboflow Bridge is in private beta and isn't enabled for @octo yet."),
    ).toBeInTheDocument();
  });

  it('Check again on the beta copy force-refreshes, and a granted entitlement clears it', async () => {
    const notEntitled = makeCloudStatus('signed_in', { bridgeEntitled: false, displayLogin: 'octo' });
    seedStatus(notEntitled);
    refreshMutate = vi.fn().mockResolvedValue(notEntitled);
    render(<CloudSignInPrompt />);
    await screen.findByText(/private beta/);
    await waitFor(() => expect(screen.getByTestId('cloud-prompt-check-again')).not.toBeDisabled());
    refreshMutate.mockClear();
    refreshMutate.mockResolvedValue(makeCloudStatus('signed_in', { bridgeEntitled: true, displayLogin: 'octo' }));
    fireEvent.click(screen.getByTestId('cloud-prompt-check-again'));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: true }));
    expect(await screen.findByText('Signed in to cyboflow cloud.')).toBeInTheDocument();
    expect(screen.queryByText(/private beta/)).toBeNull();
  });

  it('shows the failure line for a failed sign-in but hides it for a cancellation', async () => {
    seedStatus(
      makeCloudStatus('signed_out', { lastSignInFailure: { code: 'timed_out', httpStatus: null, at: '2026-10-07T10:00:00.000Z' } }),
    );
    const { unmount } = render(<CloudSignInPrompt />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in timed out.');
    unmount();
    useCloudAccountStore.setState({ status: null });
    seedStatus(
      makeCloudStatus('signed_out', { lastSignInFailure: { code: 'cancelled', httpStatus: null, at: '2026-10-07T10:00:00.000Z' } }),
    );
    render(<CloudSignInPrompt />);
    await screen.findByTestId('cloud-signin-button');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
