/**
 * ClaudeSignInCard — the chat's recovery surface for an expired Claude login.
 *
 * Rendered by a chat host (ClaudePanel for quick sessions, RunChatView for
 * flow runs) at the end of the transcript when the last turn failed for want
 * of a usable Claude Code login (see utils/findClaudeLoginRequired). It replaces
 * the CLI's "Please run /login" advice — a slash command the SDK substrate
 * cannot run — with an in-app flow: the sign-in dialog drives the bundled
 * CLI's `claude auth login` over `cyboflow.claudeAuth`, the user approves in
 * the browser and pastes the code back, and the host gets `onSignedIn` so it
 * can put the failed prompt back in the composer.
 *
 * The dialog POLLS `loginState` while open: the login runner is a single
 * main-process state machine and a 700 ms cadence is plenty for a flow whose
 * slow step is a human in a browser. No event plumbing was worth adding.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, CheckCircle, Loader2, XCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { trpc } from '../../trpc/client';
import { IDLE_CLAUDE_LOGIN_STATE, type ClaudeLoginState } from '../../../../shared/types/claudeAuth';

const POLL_INTERVAL_MS = 700;

export interface ClaudeSignInCardProps {
  /**
   * Called once a sign-in attempt succeeds. The quick-session host uses it to
   * repopulate the composer with the prompt that failed.
   */
  onSignedIn?: () => void;
  /** Label for the post-sign-in action the host offers (e.g. "Send it again"). */
  retryLabel?: string;
  onRetry?: () => void;
}

export function ClaudeSignInCard({ onSignedIn, retryLabel, onRetry }: ClaudeSignInCardProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  const handleSignedIn = useCallback(
    (state: ClaudeLoginState) => {
      const label = state.account?.email
        ? `${state.account.email}${state.account.subscriptionType ? ` · ${state.account.subscriptionType}` : ''}`
        : 'your Claude account';
      setSignedInAs(label);
      onSignedIn?.();
    },
    [onSignedIn],
  );

  return (
    <div
      data-testid="claude-sign-in-card"
      className="mt-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-status-warning/20 p-2 text-status-warning">
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="flex-1 space-y-2">
          {signedInAs === null ? (
            <>
              <div className="font-semibold text-text-primary">Claude sign-in required</div>
              <p className="text-sm text-text-secondary">
                Your Claude Code login has expired, so this session can&apos;t reach Claude. Sign in again to
                continue — the conversation is kept.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="claude-sign-in-open">
                  Sign in to Claude
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 font-semibold text-status-success">
                <CheckCircle className="h-4 w-4" />
                Signed in as {signedInAs}
              </div>
              <p className="text-sm text-text-secondary">
                {onRetry
                  ? 'Your last message is back in the composer — send it when ready.'
                  : 'Send your next message to continue.'}
              </p>
              {onRetry && (
                <div className="pt-1">
                  <Button size="sm" variant="secondary" onClick={onRetry} data-testid="claude-sign-in-retry">
                    {retryLabel ?? 'Send it again'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <ClaudeSignInDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSignedIn={handleSignedIn}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface ClaudeSignInDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSignedIn: (state: ClaudeLoginState) => void;
}

function isLivePhase(state: ClaudeLoginState): boolean {
  return state.phase === 'starting' || state.phase === 'awaiting-code' || state.phase === 'verifying';
}

export function ClaudeSignInDialog({ isOpen, onClose, onSignedIn }: ClaudeSignInDialogProps): React.JSX.Element {
  const [state, setState] = useState<ClaudeLoginState>(IDLE_CLAUDE_LOGIN_STATE);
  const [code, setCode] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  // Fire onSignedIn exactly once per open, however many polls report 'succeeded'.
  const signedInReportedRef = useRef(false);

  const start = useCallback(async () => {
    setSubmitError(null);
    setCode('');
    signedInReportedRef.current = false;
    try {
      setState(await trpc.cyboflow.claudeAuth.startLogin.mutate());
    } catch (error) {
      setState({
        ...IDLE_CLAUDE_LOGIN_STATE,
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  // Start an attempt when the dialog opens; cancel a live one when it closes.
  useEffect(() => {
    if (!isOpen) return;
    void start();
    return () => {
      void trpc.cyboflow.claudeAuth.cancelLogin.mutate().catch(() => undefined);
      setState(IDLE_CLAUDE_LOGIN_STATE);
    };
  }, [isOpen, start]);

  // Poll while live.
  useEffect(() => {
    if (!isOpen || !isLivePhase(state)) return;
    const timer = setInterval(() => {
      trpc.cyboflow.claudeAuth.loginState
        .query()
        .then(setState)
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isOpen, state]);

  useEffect(() => {
    if (state.phase === 'succeeded' && !signedInReportedRef.current) {
      signedInReportedRef.current = true;
      onSignedIn(state);
    }
  }, [state, onSignedIn]);

  useEffect(() => {
    if (state.phase === 'awaiting-code') codeInputRef.current?.focus();
  }, [state.phase]);

  const submit = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed.length === 0) return;
    setSubmitError(null);
    try {
      setState(await trpc.cyboflow.claudeAuth.submitLoginCode.mutate({ code: trimmed }));
      setCode('');
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  }, [code]);

  const openBrowser = useCallback(() => {
    if (state.authUrl && window.electronAPI) void window.electronAPI.openExternal(state.authUrl);
  }, [state.authUrl]);

  // Closing after success must NOT cancel anything — the attempt is finished;
  // the effect cleanup's cancelLogin is a no-op on a settled state.
  const close = onClose;

  return (
    <Modal isOpen={isOpen} onClose={close} size="md" closeOnOverlayClick={false}>
      <div className="space-y-4 p-6" data-testid="claude-sign-in-dialog">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-interactive" />
          <h2 className="text-lg font-semibold text-text-primary">Sign in to Claude</h2>
        </div>

        {(state.phase === 'idle' || state.phase === 'starting') && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening the sign-in page in your browser…
          </div>
        )}

        {state.phase === 'awaiting-code' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              A browser tab has opened to sign in to Claude. Approve Claude Code there, then copy the code it
              shows and paste it below.
            </p>
            <button
              type="button"
              onClick={openBrowser}
              disabled={!state.authUrl}
              className="inline-flex items-center gap-1 text-xs text-interactive hover:underline disabled:opacity-50"
              data-testid="claude-sign-in-open-browser"
            >
              <ExternalLink className="h-3 w-3" />
              Browser didn&apos;t open? Open it again
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="flex gap-2"
            >
              <input
                ref={codeInputRef}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Paste the authorization code"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 rounded border border-border-primary bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-interactive focus:outline-none"
                data-testid="claude-sign-in-code"
              />
              <Button type="submit" size="sm" disabled={code.trim().length === 0} data-testid="claude-sign-in-submit">
                Continue
              </Button>
            </form>
            {submitError && <p className="text-xs text-status-error">{submitError}</p>}
          </div>
        )}

        {state.phase === 'verifying' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            Verifying the code…
          </div>
        )}

        {state.phase === 'succeeded' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-status-success">
              <CheckCircle className="h-4 w-4" />
              {state.account?.email ? `Signed in as ${state.account.email}` : 'Signed in'}
              {state.account?.subscriptionType ? (
                <span className="text-xs font-normal text-text-tertiary">· {state.account.subscriptionType}</span>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={close} data-testid="claude-sign-in-done">
                Done
              </Button>
            </div>
          </div>
        )}

        {state.phase === 'failed' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-status-error">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{state.error ?? 'The sign-in did not complete.'}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void start()} data-testid="claude-sign-in-retry-login">
                Try again
              </Button>
            </div>
          </div>
        )}

        {isLivePhase(state) && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
