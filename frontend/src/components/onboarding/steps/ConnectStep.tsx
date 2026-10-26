import { useState } from 'react';
import type { ProviderDetectionResult } from '../../../../../shared/types/onboarding';
import { ClaudeSignInFlow } from '../../session/ClaudeSignInCard';

interface ConnectStepProps {
  claudeDetection: ProviderDetectionResult<'claude'> | null;
  claudeConnected: boolean;
  codexDetection: ProviderDetectionResult<'codex'> | null;
  codexConnected: boolean;
  /**
   * OMP is OPTIONAL: unlike Claude/Codex, its row never gates Continue (see
   * onboardingStore.isNextGateBlocked) and its toggle defaults off. Null while
   * the probe hasn't run yet, same convention as the other two.
   */
  ompDetection: ProviderDetectionResult<'omp'> | null;
  ompConnected: boolean;
  checking: boolean;
  onToggleClaude: () => void;
  onToggleCodex: () => void;
  onToggleOmp: () => void;
  onRecheck: () => void;
  onLocate: () => void;
  onInstall: () => void;
  /**
   * A Claude sign-in finished inside the step (the in-app `claude auth login`
   * flow). The gate re-probes and switches the Claude toggle on.
   */
  onClaudeSignedIn: () => void;
}

interface ProviderRowProps {
  name: string;
  mark: string;
  detail: string;
  ready: boolean;
  connected: boolean;
  onToggle: () => void;
}

function GhostButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-border-primary bg-transparent px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[.1em] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
    >
      {label}
    </button>
  );
}

function ProviderRow({
  name,
  mark,
  detail,
  ready,
  connected,
  onToggle,
}: ProviderRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3">
      <span
        className={`flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center border-[1.4px] bg-bg-primary text-[14px] font-bold ${
          ready ? 'border-border-emphasized text-interactive' : 'border-border-primary text-text-disabled'
        }`}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold text-text-primary">{name}</span>
        <span className={`mt-px block truncate text-[10px] ${ready ? 'text-text-tertiary' : 'text-interactive'}`}>
          {detail}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={connected}
        aria-label={`Use ${name} in Cyboflow`}
        disabled={!ready}
        onClick={onToggle}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
          connected ? 'bg-interactive' : 'bg-border-primary'
        } ${ready ? '' : 'cursor-not-allowed opacity-50'}`}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-[left]"
          style={{ left: connected ? 22 : 2 }}
        />
      </button>
    </div>
  );
}

function claudeDetail(detection: ProviderDetectionResult<'claude'>): string {
  if (detection.state === 'loggedOut') return 'Installed · sign in required';
  // 'missing' = no login AND no external CLI. The SDK runtime is bundled, so a
  // sign-in is all that is missing — not an install.
  if (detection.state === 'missing') return 'Sign in required';
  const version = detection.binary.version ? ` · ${detection.binary.version}` : '';
  const account = detection.credentials.account ? ` · ${detection.credentials.account}` : '';
  return `${detection.binary.found ? 'Detected' : 'SDK ready'}${version}${account}`;
}

function codexDetail(detection: ProviderDetectionResult<'codex'>): string {
  if (detection.state === 'loggedOut') return 'Bundled runtime · ChatGPT sign-in required';
  if (detection.state === 'unavailable') return 'Bundled runtime could not be verified';
  const plan = detection.account.planType ? ` · ${detection.account.planType}` : '';
  const email = detection.account.email ? ` · ${detection.account.email}` : '';
  return `ChatGPT connected${plan}${email}`;
}

/** OMP has no login for Cyboflow to observe — its evidence is a binary + version. */
function ompDetail(detection: ProviderDetectionResult<'omp'>): string {
  if (detection.state === 'unavailable') {
    return detection.binaryPath
      ? 'Found, but this version of omp is unsupported'
      : 'Not found on this machine — optional';
  }
  const version = detection.version ? ` · ${detection.version}` : '';
  return `Detected${version}`;
}

/** Step 1: enable at least one detected provider; enabling both is supported. */
export function ConnectStep({
  claudeDetection,
  claudeConnected,
  codexDetection,
  codexConnected,
  ompDetection,
  ompConnected,
  checking,
  onToggleClaude,
  onToggleCodex,
  onToggleOmp,
  onRecheck,
  onLocate,
  onInstall,
  onClaudeSignedIn,
}: ConnectStepProps): React.JSX.Element {
  const [claudeSigningIn, setClaudeSigningIn] = useState(false);
  const loading =
    checking || claudeDetection === null || codexDetection === null || ompDetection === null;
  const claudeReady = claudeDetection?.state === 'detected';
  const codexReady = codexDetection?.state === 'detected';
  const ompReady = ompDetection?.state === 'detected';
  const hasConnectedProvider =
    (claudeReady && claudeConnected) || (codexReady && codexConnected);

  return (
    <div className="px-6 pb-3 pt-5">
      <div className="mb-3 text-[12px] leading-[1.6] text-text-primary">
        Connect one or both agent accounts. Each provider uses its existing login and billing.
      </div>

      {loading ? (
        <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
          <span className="h-[7px] w-[7px] flex-shrink-0 animate-cfpulse rounded-full bg-interactive" />
          <span className="text-[11px] text-text-secondary">Checking Claude Code, Codex, and OMP…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ProviderRow
            name="Claude Code"
            mark="▸"
            detail={claudeDetail(claudeDetection)}
            ready={claudeReady}
            connected={claudeReady && claudeConnected}
            onToggle={onToggleClaude}
          />
          <ProviderRow
            name="Codex"
            mark="C"
            detail={codexDetail(codexDetection)}
            ready={codexReady}
            connected={codexReady && codexConnected}
            onToggle={onToggleCodex}
          />
          {/* OMP — optional, off by default. Its row never gates Continue (see
              onboardingStore.isNextGateBlocked), so it is presented the same way
              as the other two but never appears in the "must fix" panel below. */}
          <ProviderRow
            name="OMP"
            mark="◇"
            detail={ompDetail(ompDetection)}
            ready={ompReady}
            connected={ompReady && ompConnected}
            onToggle={onToggleOmp}
          />
          {/* OMP's own hint, independent of the claude/codex "must fix" panel
              below — an undetected OMP never blocks Continue, so it gets its
              own low-key note rather than joining the mandatory-fix copy. */}
          {ompDetection.state === 'unavailable' && (
            <div className="border border-border-primary bg-[var(--paper-3)] px-3.5 py-2.5 text-[10px] leading-[1.55] text-text-secondary">
              <div>
                OMP is optional. Install via{' '}
                <code className="border border-border-primary bg-bg-primary px-1">
                  curl -fsSL https://omp.sh/install | sh
                </code>{' '}
                or{' '}
                <code className="border border-border-primary bg-bg-primary px-1">
                  brew install can1357/tap/omp
                </code>
                , then run <code className="border border-border-primary bg-bg-primary px-1">omp</code>{' '}
                in a terminal and{' '}
                <code className="border border-border-primary bg-bg-primary px-1">/login &lt;provider&gt;</code>.
              </div>
              <div className="mt-2">
                <GhostButton label="↻ Check again" onClick={onRecheck} />
              </div>
            </div>
          )}

          {(claudeDetection.state !== 'detected' || codexDetection.state !== 'detected') && (
            <div className="border border-border-primary bg-[var(--paper-3)] px-3.5 py-2.5 text-[10px] leading-[1.55] text-text-secondary">
              {claudeDetection.state !== 'detected' && (
                <div data-testid="onboarding-claude-sign-in">
                  {claudeSigningIn ? (
                    <div className="border border-border-primary bg-bg-primary p-3 text-text-primary">
                      {/* Unmount the flow BEFORE the gate re-probes: the probe's
                          loading state replaces this panel, and a remount would
                          start a second `claude auth login`. */}
                      <ClaudeSignInFlow
                        onSignedIn={() => {
                          setClaudeSigningIn(false);
                          onClaudeSignedIn();
                        }}
                        onClose={() => setClaudeSigningIn(false)}
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        Claude: sign in with your Claude account. Cyboflow ships its own Claude Code runtime, so
                        there is nothing to install.
                      </div>
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setClaudeSigningIn(true)}
                          data-testid="onboarding-claude-sign-in-start"
                          className="border border-interactive bg-interactive px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[.1em] text-white transition-opacity hover:opacity-90"
                        >
                          Sign in to Claude
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {codexDetection.state === 'loggedOut' && (
                <div className={claudeDetection.state !== 'detected' ? 'mt-2' : undefined}>
                  Codex: run <code className="border border-border-primary bg-bg-primary px-1">codex login</code> with ChatGPT auth.
                </div>
              )}
              {codexDetection.state === 'unavailable' && (
                <div className={claudeDetection.state !== 'detected' ? 'mt-2' : undefined}>
                  Codex could not start its bundled runtime. You can continue with Claude.
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <GhostButton label="↻ Check again" onClick={onRecheck} />
                {claudeDetection.state === 'missing' && (
                  <>
                    <GhostButton label="Install Claude CLI" onClick={onInstall} />
                    <GhostButton label="Locate binary…" onClick={onLocate} />
                  </>
                )}
              </div>
            </div>
          )}

          <div className={`mt-1 text-[10px] leading-[1.5] ${hasConnectedProvider ? 'text-status-success' : 'text-text-tertiary'}`}>
            {hasConnectedProvider
              ? 'Ready · choose the runtime and model for each session or workflow.'
              : 'Enable at least one detected provider to continue.'}
          </div>
        </div>
      )}
    </div>
  );
}
