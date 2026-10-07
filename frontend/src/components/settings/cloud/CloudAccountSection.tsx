/**
 * Settings → Integrations: the shared "cyboflow cloud" sign-in for this computer.
 *
 * Renders nothing unless cloud is available (dev build with Agents & Environments enabled). The sign-in URL
 * never reaches the renderer; "Open the browser again" asks main to re-open it. Every recovery copy here has a
 * working action (Sign in again, Try again, Check again, Unlock, Open the browser again, Manage devices…).
 */
import { useEffect, useState } from 'react';
import { Cloud, Loader2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { Chip } from '../../landing/QueuePrimitives';
import { formatDistanceToNow } from '../../../utils/timestampUtils';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';
import type { CloudStatusT, ConnectorViewT } from '../../agentsEnv/types';
import { cloudErrorCopy, formatExpiry, platformLabel, signInFailureCopy } from './cloudCopy';

type Available = Extract<CloudStatusT, { available: true }>;

interface BridgeChipSpec {
  tone: 'success' | 'warning' | 'neutral';
  label: string;
  help?: string;
}

/** The Bridge chip on the signed-in services row (first match wins). */
export function bridgeChip(
  account: NonNullable<Available['account']>,
  running: boolean,
  bridge: ConnectorViewT | undefined,
): BridgeChipSpec {
  if (!account.bridgeEntitled) {
    return {
      tone: 'warning',
      label: 'Bridge: not enabled for this account',
      help: 'Bridge access is granted per account during the beta.',
    };
  }
  if (!running || bridge === undefined) return { tone: 'success', label: 'Bridge: enabled' };
  switch (bridge.availability.state) {
    case 'ok':
      return { tone: 'success', label: 'Bridge: connected' };
    case 'disabled':
      return { tone: 'neutral', label: 'Bridge: off on this computer' };
    case 'needs_update':
      return { tone: 'warning', label: 'Bridge: needs update' };
    case 'not_entitled':
      return { tone: 'warning', label: 'Bridge: not enabled for this account' };
    case 'unavailable':
      return { tone: 'warning', label: 'Bridge: unreachable · retrying' };
    default:
      return { tone: 'neutral', label: 'Bridge: paused' };
  }
}

export function CloudAccountSection(): React.JSX.Element | null {
  useEffect(() => useCloudAccountStore.getState().init(), []);

  const status = useCloudAccountStore((s) => s.status);
  const devices = useCloudAccountStore((s) => s.devices);
  const devicesError = useCloudAccountStore((s) => s.devicesError);
  const devicesLoading = useCloudAccountStore((s) => s.devicesLoading);
  const pending = useCloudAccountStore((s) => s.pending);
  const actionError = useCloudAccountStore((s) => s.actionError);
  const lastSignOut = useCloudAccountStore((s) => s.lastSignOut);
  const signIn = useCloudAccountStore((s) => s.signIn);
  const cancelSignIn = useCloudAccountStore((s) => s.cancelSignIn);
  const reopenSignInPage = useCloudAccountStore((s) => s.reopenSignInPage);
  const signOut = useCloudAccountStore((s) => s.signOut);
  const clearSignOutNotice = useCloudAccountStore((s) => s.clearSignOutNotice);
  const refresh = useCloudAccountStore((s) => s.refresh);
  const retryUnlock = useCloudAccountStore((s) => s.retryUnlock);
  const loadDevices = useCloudAccountStore((s) => s.loadDevices);
  const openDevicesPage = useCloudAccountStore((s) => s.openDevicesPage);

  const running = usePersistentAgentsStore((s) => s.featureStatus?.running === true);
  const connectors = usePersistentAgentsStore((s) => s.connectors);
  const loadConnectors = usePersistentAgentsStore((s) => s.loadConnectors);

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [browserNotice, setBrowserNotice] = useState(false);

  // The Bridge chip reads the Bridge connector's live availability: load it, and reload on every cloud change.
  useEffect(() => {
    if (running) void loadConnectors();
  }, [running, status, loadConnectors]);

  if (status === null || !status.available) return null;

  const account = status.account;
  const display = status.display;
  const login = account?.displayLogin ?? null;
  const signedInAs = login !== null ? `Signed in as @${login}` : 'Signed in';
  const failure = status.lastSignInFailure;
  const bridge = connectors?.find((c) => c.definition.id === 'bridge');

  const signInButton = (label: string): React.JSX.Element => (
    <Button
      variant="primary"
      size="sm"
      data-testid="cloud-signin-button"
      loading={pending === 'signIn'}
      onClick={() => void signIn()}
    >
      {label}
    </Button>
  );
  const signOutButton = (): React.JSX.Element => (
    <Button
      variant="secondary"
      size="sm"
      data-testid="cloud-signout-button"
      disabled={pending === 'signOut'}
      onClick={() => setConfirmSignOut(true)}
    >
      Sign out
    </Button>
  );
  const tryAgainButton = (): React.JSX.Element => (
    <Button
      variant="secondary"
      size="sm"
      data-testid="cloud-retry-unlock"
      loading={pending === 'unlock'}
      onClick={() => void retryUnlock()}
    >
      Try again
    </Button>
  );
  const manageDevices = (): React.JSX.Element => (
    <Button variant="ghost" size="sm" data-testid="cloud-manage-devices" onClick={() => void openDevicesPage()}>
      Manage devices…
    </Button>
  );

  const failureLine =
    failure !== null && (display === 'signed_out' || display === 'revoked' || display === 'undecryptable') ? (
      <p role="alert" data-testid="cloud-signin-failure" className="text-[11px] text-status-error">
        {signInFailureCopy(failure.code)}
      </p>
    ) : null;

  let body: React.ReactNode;
  switch (display) {
    case 'signed_out': {
      const notice = lastSignOut !== null && (lastSignOut.remoteRevoked === 'no' || lastSignOut.remoteRevoked === 'skipped');
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">Not signed in.</p>
          <p className="text-[11px] text-text-tertiary">
            Signing in opens your browser to sign in with GitHub and registers this computer as a device on your
            account.
          </p>
          <p className="text-[11px] text-text-tertiary">
            This computer will appear as <strong className="text-text-secondary">{status.defaultDeviceName}</strong>.
          </p>
          {notice && (
            <div
              role="status"
              data-testid="cloud-signout-remote-notice"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-status-warning"
            >
              <span>
                This computer&apos;s registration may still be active on your account. Revoke it on the Devices
                page.
              </span>
              {manageDevices()}
              <Button variant="ghost" size="sm" onClick={clearSignOutNotice}>
                Dismiss
              </Button>
            </div>
          )}
          {failureLine}
          <div>{signInButton('Sign in with GitHub')}</div>
        </>
      );
      break;
    }
    case 'signing_in': {
      const phase = status.signIn;
      body =
        phase.phase === 'waiting_for_browser' ? (
          <>
            <p className="flex items-center gap-2 text-[12px] font-bold text-text-primary">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Finish signing in in your browser.
            </p>
            <p className="text-[11px] text-text-tertiary">{`The link expires ${formatExpiry(phase.expiresAt)}.`}</p>
            {browserNotice && (
              <p role="status" className="text-[11px] text-text-tertiary">
                cyboflow couldn&apos;t open your browser.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="cloud-cancel-signin"
                loading={pending === 'cancel'}
                onClick={() => void cancelSignIn()}
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="cloud-reopen-browser"
                onClick={() => {
                  setBrowserNotice(false);
                  void reopenSignInPage().then((opened) => setBrowserNotice(!opened));
                }}
              >
                Open the browser again
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-[12px] font-bold text-text-primary">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Registering this computer…
            </p>
            <div>
              <Button variant="secondary" size="sm" data-testid="cloud-cancel-signin" disabled title="Almost done">
                Cancel
              </Button>
            </div>
          </>
        );
      break;
    }
    case 'locked':
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">{signedInAs}</p>
          <p className="text-[11px] text-text-tertiary">Unlocking your saved sign-in…</p>
          <div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="cloud-unlock"
              loading={pending === 'unlock'}
              onClick={() => void retryUnlock()}
            >
              Unlock
            </Button>
          </div>
        </>
      );
      break;
    case 'signed_in': {
      const deviceLine =
        account !== null ? (
          <p className="text-[11px] text-text-tertiary">
            This computer: <strong className="text-text-secondary">{account.deviceName}</strong> · ref code{' '}
            <strong className="text-text-secondary">{account.deviceCode}</strong>
          </p>
        ) : null;
      if (account === null || account.lastOkAt === null) {
        body = (
          <>
            <p className="text-[12px] font-bold text-text-primary">{signedInAs}</p>
            {deviceLine}
            <p className="text-[11px] text-text-tertiary">Checking your account…</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="cloud-check-again"
                loading={pending === 'refresh'}
                onClick={() => void refresh(true)}
              >
                Check again
              </Button>
              {signOutButton()}
            </div>
          </>
        );
      } else {
        const chip = bridgeChip(account, running, bridge);
        const visible = (devices ?? []).filter((d) => showRevoked || d.revokedAt === null);
        const hidden = (devices ?? []).filter((d) => d.revokedAt !== null).length;
        body = (
          <>
            <p className="text-[12px] font-bold text-text-primary">{signedInAs}</p>
            {deviceLine}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-tertiary">Services</span>
              <span data-testid="cloud-bridge-chip">
                <Chip tone={chip.tone} noTruncate>
                  {chip.label}
                </Chip>
              </span>
            </div>
            {chip.help !== undefined && <p className="text-[11px] text-text-tertiary">{chip.help}</p>}
            <p className="text-[11px] text-text-tertiary">{`Last checked ${formatDistanceToNow(account.lastOkAt)}`}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="cloud-devices-toggle"
                onClick={() => {
                  const next = !showDevices;
                  setShowDevices(next);
                  if (next) void loadDevices();
                }}
              >
                Devices
              </Button>
              {manageDevices()}
              {signOutButton()}
            </div>
            {showDevices && (
              <div data-testid="cloud-devices" className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {devicesLoading && devices === null && <span>Loading devices…</span>}
                {devicesError !== null && <span role="alert" className="text-status-error">{cloudErrorCopy(devicesError)}</span>}
                {visible.map((d) => (
                  <div key={`${d.code}:${d.createdAt}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-bold text-text-primary">{d.name}</span>
                    <span>{d.code}</span>
                    <span>{platformLabel(d.platform)}</span>
                    {d.appVersion !== null && <span>{d.appVersion}</span>}
                    {d.lastSeenAt !== null && <span>{`active ${formatDistanceToNow(d.lastSeenAt)}`}</span>}
                    {d.current && <Chip tone="success">This computer</Chip>}
                  </div>
                ))}
                {hidden > 0 && !showRevoked && (
                  <Button variant="ghost" size="sm" onClick={() => setShowRevoked(true)}>
                    {`Show ${hidden} signed-out device${hidden === 1 ? '' : 's'}`}
                  </Button>
                )}
              </div>
            )}
          </>
        );
      }
      break;
    }
    case 'needs_update':
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">Update cyboflow to keep using cyboflow cloud.</p>
          <p className="text-[11px] text-text-tertiary">
            The cloud service needs a newer version of this app. Your connections resume after you update.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="cloud-check-again"
              loading={pending === 'refresh'}
              onClick={() => void refresh(true)}
            >
              Check again
            </Button>
            {signOutButton()}
          </div>
        </>
      );
      break;
    case 'revoked':
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">This computer was signed out of cyboflow cloud.</p>
          <p className="text-[11px] text-text-tertiary">
            It was signed out from another device or the Devices page, or after 90 days without use. Local data is
            kept.
          </p>
          {account !== null && (
            <p className="text-[11px] text-text-tertiary">
              {account.deviceName} · ref code {account.deviceCode}
            </p>
          )}
          {failureLine}
          <div className="flex flex-wrap items-center gap-2">
            {signInButton('Sign in again')}
            <Button
              variant="secondary"
              size="sm"
              data-testid="cloud-remove"
              disabled={pending === 'signOut'}
              onClick={() => void signOut()}
            >
              Remove
            </Button>
          </div>
        </>
      );
      break;
    case 'undecryptable':
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">This computer&apos;s saved sign-in can&apos;t be read.</p>
          <p className="text-[11px] text-text-tertiary">
            It was saved on another machine or by another user account, for example before restoring a backup. Sign
            in again to register this computer. The old registration stays on your account until you revoke it on
            the Devices page.
          </p>
          {failureLine}
          <div className="flex flex-wrap items-center gap-2">
            {tryAgainButton()}
            {signInButton('Sign in again')}
            <Button
              variant="secondary"
              size="sm"
              data-testid="cloud-remove"
              disabled={pending === 'signOut'}
              onClick={() => void signOut()}
            >
              Remove
            </Button>
            {manageDevices()}
          </div>
        </>
      );
      break;
    case 'secrets_unavailable':
      body = (
        <>
          <p className="text-[12px] font-bold text-text-primary">Secure storage isn&apos;t available.</p>
          <p className="text-[11px] text-text-tertiary">
            cyboflow keeps the cloud credential in your OS keychain, which can&apos;t be reached right now.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {tryAgainButton()}
            {signOutButton()}
          </div>
        </>
      );
      break;
  }

  return (
    <div data-testid="cloud-account-section">
      <SettingsSection
        title="cyboflow cloud"
        description="Signs this computer in to cyboflow's cloud services. The Bridge uses it to reach agents that have no API."
        icon={<Cloud className="h-4 w-4" />}
        className="ml-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Chip>Dev build</Chip>
          {status.staging && (
            <span data-testid="cloud-staging-badge">
              <Chip tone="warning" title={status.configuredOrigin}>
                Staging
              </Chip>
            </span>
          )}
        </div>
        {status.originMismatch && account !== null && (
          <p data-testid="cloud-origin-mismatch" role="status" className="text-[11px] text-status-warning">
            {`Signed in to ${account.origin}. This build is set to ${status.configuredOrigin}; sign out and sign in again to switch.`}
          </p>
        )}
        <div
          data-testid={`cloud-state-${display}`}
          className="flex flex-col gap-1.5 rounded-lg border border-border-primary bg-surface-primary px-4 py-3"
        >
          {body}
          {status.lastError !== null && (status.lastError.kind === 'network' || status.lastError.kind === 'retryable') && (
            <p className="text-[11px] text-text-tertiary">Couldn&apos;t reach cyboflow cloud. Retrying is safe.</p>
          )}
          {actionError !== null && (
            <p role="alert" className="text-[11px] text-status-error">
              {actionError}
            </p>
          )}
          {confirmSignOut && (
            <div
              data-testid="cloud-signout-confirm"
              className="mt-1 flex flex-col gap-2 border border-border-primary bg-surface-secondary px-3 py-2"
            >
              <p className="text-[11px] text-text-secondary">
                Sign out this computer? Bridge connections stop receiving messages until you sign in again.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  data-testid="cloud-signout-confirm-yes"
                  onClick={() => {
                    setConfirmSignOut(false);
                    void signOut();
                  }}
                >
                  Sign out
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmSignOut(false)}>
                  Keep signed in
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
