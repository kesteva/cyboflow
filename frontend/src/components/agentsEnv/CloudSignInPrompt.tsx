import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { useCloudAccountStore } from '../../stores/cloudAccountStore';
import { signInFailureCopy } from '../settings/cloud/cloudCopy';

/**
 * Inline "sign in to cyboflow cloud" prompt, embedded by the Connect dialog and the thread banner.
 *
 * Self-sufficient: it takes a ref on the cloud store (subscribe, then seed) while mounted, so every embedding
 * has a live status even when no other cloud consumer is on screen. The sign-in URL never reaches the
 * renderer: "Open the browser again" asks main to re-open it.
 */
export function CloudSignInPrompt({
  purpose = 'bridge',
  compact = false,
}: {
  purpose?: 'bridge';
  compact?: boolean;
}): React.JSX.Element {
  useEffect(() => useCloudAccountStore.getState().init(), []);

  const status = useCloudAccountStore((s) => s.status);
  const pending = useCloudAccountStore((s) => s.pending);
  const actionError = useCloudAccountStore((s) => s.actionError);
  const signIn = useCloudAccountStore((s) => s.signIn);
  const cancelSignIn = useCloudAccountStore((s) => s.cancelSignIn);
  const reopen = useCloudAccountStore((s) => s.reopenSignInPage);
  const retryUnlock = useCloudAccountStore((s) => s.retryUnlock);
  const refresh = useCloudAccountStore((s) => s.refresh);

  const spacing = compact ? 'inline-flex flex-wrap items-center gap-x-2 gap-y-1' : 'flex flex-col items-start gap-2';
  const text = compact ? 'text-[12px]' : 'text-[12px] text-text-secondary';
  const wrap = (children: React.ReactNode): React.JSX.Element => (
    <div data-testid="cloud-signin-prompt" data-purpose={purpose} className={spacing}>
      {children}
    </div>
  );

  if (status === null) return wrap(<p className={text}>Checking your cyboflow cloud account…</p>);
  if (!status.available) return wrap(<p className={text}>cyboflow cloud isn&apos;t available in this build.</p>);

  const failure = status.lastSignInFailure;
  const failureLine =
    failure !== null && failure.code !== 'cancelled' ? (
      <p role="alert" className="text-[11px] text-status-error">
        {signInFailureCopy(failure.code)}
      </p>
    ) : null;
  const errorLine =
    actionError !== null ? (
      <p role="alert" className="text-[11px] text-status-error">
        {actionError}
      </p>
    ) : null;

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

  switch (status.display) {
    case 'signing_in': {
      const registering = status.signIn.phase === 'registering';
      return wrap(
        <>
          <p className={`${text} flex items-center gap-2`}>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {registering ? 'Registering this computer…' : 'Finish signing in in your browser…'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="cloud-prompt-cancel"
              disabled={registering}
              onClick={() => void cancelSignIn()}
            >
              Cancel
            </Button>
            {!registering && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="cloud-prompt-reopen"
                onClick={() => void reopen()}
              >
                Open the browser again
              </Button>
            )}
          </div>
          {errorLine}
        </>,
      );
    }
    case 'signed_out':
      return wrap(
        <>
          <p className={text}>
            The Bridge runs through cyboflow cloud. Sign in with GitHub to connect agents that have no API.
          </p>
          {signInButton('Sign in with GitHub')}
          {failureLine}
          {errorLine}
        </>,
      );
    case 'revoked':
      return wrap(
        <>
          <p className={text}>This computer was signed out of cyboflow cloud. Sign in again to connect agents.</p>
          {signInButton('Sign in again')}
          {failureLine}
          {errorLine}
        </>,
      );
    case 'undecryptable':
      return wrap(
        <>
          <p className={text}>
            cyboflow can&apos;t read its saved sign-in on this computer (for example after restoring a backup).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="cloud-prompt-retry-unlock"
              loading={pending === 'unlock'}
              onClick={() => void retryUnlock()}
            >
              Try again
            </Button>
            {signInButton('Sign in again')}
          </div>
          {failureLine}
          {errorLine}
        </>,
      );
    case 'locked':
      return wrap(<p className={text}>Unlocking your saved sign-in…</p>);
    case 'secrets_unavailable':
      return wrap(
        <>
          <p className={text}>Your OS keychain isn&apos;t available right now.</p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="cloud-prompt-retry-unlock"
            loading={pending === 'unlock'}
            onClick={() => void retryUnlock()}
          >
            Try again
          </Button>
          {errorLine}
        </>,
      );
    case 'needs_update':
      return wrap(<p className={text}>Update cyboflow to use the Bridge.</p>);
    case 'signed_in': {
      const account = status.account;
      if (account === null || account.lastOkAt === null) {
        return wrap(
          <>
            <p className={`${text} text-text-tertiary`}>Checking your account…</p>
            <Button
              variant="ghost"
              size="sm"
              data-testid="cloud-prompt-check-again"
              loading={pending === 'refresh'}
              onClick={() => void refresh(true)}
            >
              Check again
            </Button>
            {errorLine}
          </>,
        );
      }
      if (!account.bridgeEntitled) {
        const who = account.displayLogin !== null ? `@${account.displayLogin}` : 'your account';
        // The operator grants access out of band: let the user re-check without waiting out the refresh gap.
        return wrap(
          <>
            <p className={text}>
              {`The cyboflow Bridge is in private beta and isn't enabled for ${who} yet.`}
            </p>
            <Button
              variant="ghost"
              size="sm"
              data-testid="cloud-prompt-check-again"
              loading={pending === 'refresh'}
              onClick={() => void refresh(true)}
            >
              Check again
            </Button>
            {errorLine}
          </>,
        );
      }
      return wrap(<p className={`${text} text-status-success`}>Signed in to cyboflow cloud.</p>);
    }
    default:
      return wrap(<p className={text}>Checking your cyboflow cloud account…</p>);
  }
}
