import type { ClaudeDetectionResult } from '../../../../../shared/types/onboarding';

/**
 * Step 1 — Connect Claude Code (the one gated step). Three variants driven by
 * the main-side detection probe (`detected` | `loggedOut` | `missing`), plus a
 * loading row while the probe is in flight. Only the `detected` variant exposes
 * the consent toggle; the footer Continue stays disabled until state==='detected'
 * AND the toggle is on (enforced by isNextGateBlocked in the store).
 *
 * Deviation from the prototype: the connected line drops the "Max plan" tier
 * claim — main/ cannot introspect billing (shared/types/onboarding.ts).
 */
interface ConnectStepProps {
  detection: ClaudeDetectionResult | null;
  connected: boolean;
  checking: boolean;
  onToggleConnect: () => void;
  onRecheck: () => void;
  onLocate: () => void;
  onInstall: () => void;
}

const REQUIRED_LINE = "Agents can't run until Claude Code is connected — this is the one required step.";

/** Small uppercase ghost button ("↻ Check again", "Locate binary…"). */
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

export function ConnectStep({
  detection,
  connected,
  checking,
  onToggleConnect,
  onRecheck,
  onLocate,
  onInstall,
}: ConnectStepProps): React.JSX.Element {
  const state = detection?.state ?? null;

  return (
    <div className="px-6 pb-2 pt-5">
      {state === null || checking ? (
        <>
          <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
            Checking this machine for your Claude Code login…
          </div>
          <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
            <span className="h-[7px] w-[7px] flex-shrink-0 animate-cfpulse rounded-full bg-interactive" />
            <span className="text-[11px] text-text-secondary">Detecting Claude Code…</span>
          </div>
        </>
      ) : state === 'detected' ? (
        <>
          <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
            Cyboflow uses your existing authenticated Claude account and your existing billing mode. If you don't have
            Claude Code installed you will need to install it.
          </div>
          <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
            <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center border-[1.4px] border-border-emphasized bg-bg-primary text-[15px] font-bold text-interactive">
              ▸
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-bold text-text-primary">Claude Code</span>
              <span className="mt-px block text-[10px] text-text-tertiary">
                {detection?.binary.found
                  ? `Detected${detection.binary.version ? ` · ${detection.binary.version}` : ''}`
                  : 'SDK bundled'}
              </span>
            </span>
            {/* 44×24 consent toggle — off = line token, on = terracotta. */}
            <button
              type="button"
              role="switch"
              aria-checked={connected}
              aria-label="Use this Claude Code install for every session"
              onClick={onToggleConnect}
              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                connected ? 'bg-interactive' : 'bg-border-primary'
              }`}
            >
              <span
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-[left]"
                style={{ left: connected ? 22 : 2 }}
              />
            </button>
          </div>
          {connected ? (
            <>
              <div className="mt-[13px] flex items-center gap-2">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-status-success text-[9px] text-white">
                  ✓
                </span>
                <span className="text-[11px] text-text-primary">
                  <b>Connected</b> · logged in
                  {detection?.credentials.account ? ` · ${detection.credentials.account}` : ''}
                </span>
              </div>
              <div className="mt-[11px] text-[10px] leading-[1.5] text-text-tertiary">
                Change how much agents may do on their own anytime in Settings → Agent permission mode.
              </div>
            </>
          ) : (
            <div className="mt-[13px] text-[10.5px] leading-[1.55] text-text-secondary">
              Not connected. Cyboflow will use this install for every session it runs — toggle on to continue.
            </div>
          )}
        </>
      ) : state === 'loggedOut' ? (
        <>
          <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
            Claude Code is installed, but you're not logged in yet.
          </div>
          <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
            <span
              className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center border-[1.4px] bg-surface-primary text-[15px] font-bold"
              style={{ borderColor: 'var(--human-border)', color: 'var(--human-border)' }}
            >
              ▸
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-bold text-text-primary">Claude Code</span>
              <span className="mt-px block text-[10px]" style={{ color: 'var(--human-border)' }}>
                Installed · not logged in
              </span>
            </span>
            <GhostButton label="↻ Check again" onClick={onRecheck} />
          </div>
          <div className="mt-3 border border-border-primary bg-[var(--paper-3)] px-[15px] py-[13px]">
            <div className="text-[11px] leading-[1.55] text-text-primary">
              Run <code className="border border-border-primary bg-bg-primary px-1.5 py-px text-[10px]">claude</code> in a
              terminal and log in, then check again.
            </div>
          </div>
          <div className="mt-3 text-[10px] leading-[1.5] text-text-tertiary">{REQUIRED_LINE}</div>
        </>
      ) : (
        // state === 'missing'
        <>
          <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
            Cyboflow drives your own Claude Code install — we couldn't find one on this machine yet.
          </div>
          <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
            <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center border-[1.4px] border-border-primary bg-[var(--paper-3)] text-[15px] font-bold text-text-disabled">
              ▸
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-bold text-text-primary">Claude Code</span>
              <span className="mt-px block text-[10px] text-interactive">Not found on this machine</span>
            </span>
            <GhostButton label="↻ Check again" onClick={onRecheck} />
          </div>
          <div className="mt-3 border border-border-primary bg-[var(--paper-3)] px-[15px] py-[13px]">
            <div className="mb-[11px] text-[11px] leading-[1.55] text-text-primary">
              Install Claude Code and log in, then check again. Cyboflow picks it up automatically.
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onInstall}
                className="border border-border-emphasized bg-[var(--ink)] px-[13px] py-2 text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive"
              >
                Install Claude Code →
              </button>
              <GhostButton label="Locate binary…" onClick={onLocate} />
              <span className="text-[9.5px] tracking-[.02em] text-text-tertiary">macOS 13+ · claude.ai/code</span>
            </div>
          </div>
          <div className="mt-3 text-[10px] leading-[1.5] text-text-tertiary">{REQUIRED_LINE}</div>
        </>
      )}
    </div>
  );
}
