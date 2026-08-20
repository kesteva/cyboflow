import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot, Code2, ExternalLink, RefreshCw, Boxes } from 'lucide-react';
import type { AgentProvider, AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import { AGENT_PROVIDERS, isAgentProviderEnabled } from '../../../../shared/types/agentRuntime';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
import { useOmpAvailability, type OmpAvailability } from '../../hooks/useOmpAvailability';
import { useConfigStore } from '../../stores/configStore';
import { API } from '../../utils/api';
import { Button } from '../ui/Button';
import { SettingsSection } from '../ui/SettingsSection';
import { Toggle } from '../ui/Toggle';
import { TrackerIntegrationSection } from './tracker/TrackerIntegrationSection';

type ProviderStatus = 'checking' | 'connected' | 'attention' | 'unavailable';

interface ProviderViewModel {
  status: ProviderStatus;
  label: string;
  detail: string;
  metadata?: string;
}

interface ProviderRowProps {
  name: string;
  description: string;
  icon: ReactNode;
  view: ProviderViewModel;
  action?: ReactNode;
  /** Provider-access toggle state + handler (see ProviderToggle). */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** Set when the toggle is locked, explaining why (last provider standing / save in flight). */
  toggleDisabledReason?: string;
  toggleTestId: string;
}

/**
 * The provider on/off switch. Turning a provider off removes its runtimes from
 * every launch picker and makes the launch seams reject it — this is the SAME
 * `AppConfig.agentProviderAccess` field the onboarding Connect step writes, so
 * the two surfaces are one setting, not two.
 */
function ProviderToggle({
  name,
  enabled,
  onToggle,
  disabledReason,
  testId,
}: {
  name: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabledReason?: string;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1" data-testid={testId}>
      <Toggle
        checked={enabled}
        onChange={onToggle}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? `${enabled ? 'Disable' : 'Enable'} ${name}`}
        aria-label={`Use ${name} in Cyboflow`}
      />
      <span className="text-[10px] font-semibold uppercase tracking-[.08em] text-text-tertiary">
        {enabled ? 'On' : 'Off'}
      </span>
    </div>
  );
}

const statusClasses: Record<ProviderStatus, { dot: string; text: string }> = {
  checking: { dot: 'bg-text-disabled', text: 'text-text-tertiary' },
  connected: { dot: 'bg-status-success', text: 'text-status-success' },
  attention: { dot: 'bg-interactive', text: 'text-interactive' },
  unavailable: { dot: 'bg-status-error', text: 'text-status-error' },
};

function ProviderRow({
  name,
  description,
  icon,
  view,
  action,
  enabled,
  onToggle,
  toggleDisabledReason,
  toggleTestId,
}: ProviderRowProps): React.JSX.Element {
  const tone = statusClasses[view.status];

  return (
    <div
      className={`grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)_auto] ${
        enabled ? '' : 'bg-surface-secondary/40'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center border border-border-primary bg-surface-secondary ${
            enabled ? 'text-interactive' : 'text-text-disabled'
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-text-primary">{name}</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-tertiary">{description}</p>
        </div>
      </div>

      <div className="flex min-w-0 items-start justify-between gap-3 sm:border-l sm:border-border-primary sm:pl-4">
        <div className="min-w-0">
          <div className={`flex items-center gap-2 text-xs font-semibold ${tone.text}`}>
            <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} />
            {view.label}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">{view.detail}</p>
          {view.metadata && (
            <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">{view.metadata}</p>
          )}
          {!enabled && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">
              Turned off — hidden from every runtime picker, and launches that ask for it are
              rejected.
            </p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>

      <div className="flex items-start sm:border-l sm:border-border-primary sm:pl-4">
        <ProviderToggle
          name={name}
          enabled={enabled}
          onToggle={onToggle}
          disabledReason={toggleDisabledReason}
          testId={toggleTestId}
        />
      </div>
    </div>
  );
}

function claudeView(
  detection: ProviderDetectionResult<'claude'> | null,
  error: string | null,
): ProviderViewModel {
  if (error) {
    return { status: 'unavailable', label: 'Check failed', detail: error };
  }
  if (!detection) {
    return { status: 'checking', label: 'Checking', detail: 'Looking for your Claude Code account.' };
  }
  if (detection.state === 'missing') {
    return {
      status: 'unavailable',
      label: 'Not available',
      detail: 'Claude Code was not found on this machine.',
    };
  }
  if (detection.state === 'loggedOut') {
    return {
      status: 'attention',
      label: 'Sign-in required',
      detail: 'Claude Code is installed, but no authenticated account was found.',
      metadata: detection.binary.version ?? undefined,
    };
  }

  const account = detection.credentials.account ?? 'Authenticated account';
  const runtime = detection.binary.found
    ? [detection.binary.version, detection.binary.path].filter(Boolean).join(' · ')
    : 'SDK ready · interactive CLI not detected';
  return {
    status: 'connected',
    label: 'Connected',
    detail: account,
    metadata: runtime,
  };
}

function codexView(
  detection: ProviderDetectionResult<'codex'> | null,
  error: string | null,
): ProviderViewModel {
  if (error) {
    return { status: 'unavailable', label: 'Check failed', detail: error };
  }
  if (!detection) {
    return { status: 'checking', label: 'Checking', detail: 'Verifying the bundled Codex runtime.' };
  }
  if (detection.state === 'loggedOut') {
    return {
      status: 'attention',
      label: 'Sign-in required',
      detail: 'The bundled Codex runtime is ready. Sign in with ChatGPT, then check again.',
      metadata: detection.runtime.version ?? undefined,
    };
  }
  if (detection.state === 'unavailable') {
    return {
      status: 'unavailable',
      label: 'Unable to verify',
      detail: detection.runtime.found
        ? 'The bundled runtime could not verify a ChatGPT account.'
        : 'The bundled Codex runtime is unavailable.',
      metadata: detection.runtime.version ?? undefined,
    };
  }

  const account = detection.account.email ?? 'ChatGPT account';
  const plan = detection.account.planType ? `ChatGPT ${detection.account.planType}` : 'ChatGPT authenticated';
  const runtime = detection.runtime.version ? `Codex ${detection.runtime.version}` : 'Bundled Codex runtime';
  return {
    status: 'connected',
    label: 'Connected',
    detail: account,
    metadata: `${plan} · ${runtime}`,
  };
}

/**
 * The OMP row's status.
 *
 * ARIA MODE CHANGES WHAT "DETECTED" MEANS. Off, OMP runs on THIS machine and
 * the local binary is the thing to find. On, Cyboflow supervises a REMOTE fleet
 * over the Prime bridge and never launches a local `omp` — so reporting the
 * local binary there answers a question nobody asked, and reports "Detected"
 * for an install that cannot actually launch anything. Under Aria mode the row
 * reports the FLEET instead, which is the resource the runtime needs.
 */
function ompView(
  detection: ProviderDetectionResult<'omp'> | null,
  error: string | null,
  omp: OmpAvailability,
): ProviderViewModel {
  if (omp.ariaMode) {
    return omp.launchable
      ? {
          status: 'connected',
          label: 'Fleet detected',
          detail: 'Supervising a remote OMP fleet over the Prime bridge.',
          metadata: 'Aria mode · the local omp binary is not used',
        }
      : {
          status: 'unavailable',
          label: 'Fleet not detected',
          detail:
            'Aria mode is on, but no OMP Prime bridge was found. Set OMP_BRIDGE_TOKEN_FILE and OMP_BRIDGE_SESSION_ID, then restart Cyboflow.',
          metadata: 'Aria mode · the local omp binary is not used',
        };
  }
  if (error) {
    return { status: 'unavailable', label: 'Check failed', detail: error };
  }
  if (!detection) {
    return { status: 'checking', label: 'Checking', detail: 'Looking for an omp binary on this machine.' };
  }
  if (detection.state === 'unavailable') {
    // A binaryPath with no usable version means the ladder found something but
    // its version probe failed — the most common cause is a build older than
    // OMP_MIN_SUPPORTED_VERSION, so name that explicitly rather than claiming
    // omp is simply missing.
    if (detection.binaryPath !== null) {
      return {
        status: 'unavailable',
        label: 'Unsupported version',
        detail: detection.version
          ? `Found omp ${detection.version}, but this version isn't supported.`
          : "Found an omp binary, but its version couldn't be verified.",
        metadata: detection.binaryPath,
      };
    }
    return {
      status: 'unavailable',
      label: 'Not available',
      detail: 'omp was not found on this machine.',
    };
  }
  return {
    status: 'connected',
    label: 'Detected',
    detail: detection.version ? `omp ${detection.version}` : 'omp binary found',
    metadata: detection.binaryPath ?? undefined,
  };
}

function responseError(provider: string, error?: string): string {
  return error?.trim() || `Cyboflow could not check ${provider}.`;
}

export function IntegrationsSettings(): React.JSX.Element {
  const [claudeDetection, setClaudeDetection] = useState<ProviderDetectionResult<'claude'> | null>(null);
  const [codexDetection, setCodexDetection] = useState<ProviderDetectionResult<'codex'> | null>(null);
  const [ompDetection, setOmpDetection] = useState<ProviderDetectionResult<'omp'> | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [ompError, setOmpError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const requestId = useRef(0);

  const checkProviders = useCallback(async (): Promise<void> => {
    const currentRequest = ++requestId.current;
    setChecking(true);
    setClaudeError(null);
    setCodexError(null);
    setOmpError(null);

    const [claudeResult, codexResult, ompResult] = await Promise.allSettled([
      API.providers.detect('claude'),
      API.providers.detect('codex'),
      API.providers.detect('omp'),
    ]);
    if (currentRequest !== requestId.current) return;

    if (claudeResult.status === 'fulfilled' && claudeResult.value.success && claudeResult.value.data) {
      setClaudeDetection(claudeResult.value.data);
    } else {
      const message = claudeResult.status === 'rejected'
        ? claudeResult.reason instanceof Error ? claudeResult.reason.message : undefined
        : claudeResult.value.error;
      setClaudeError(responseError('Claude Code', message));
    }

    if (codexResult.status === 'fulfilled' && codexResult.value.success && codexResult.value.data) {
      setCodexDetection(codexResult.value.data);
    } else {
      const message = codexResult.status === 'rejected'
        ? codexResult.reason instanceof Error ? codexResult.reason.message : undefined
        : codexResult.value.error;
      setCodexError(responseError('Codex', message));
    }

    if (ompResult.status === 'fulfilled' && ompResult.value.success && ompResult.value.data) {
      setOmpDetection(ompResult.value.data);
    } else {
      const message = ompResult.status === 'rejected'
        ? ompResult.reason instanceof Error ? ompResult.reason.message : undefined
        : ompResult.value.error;
      setOmpError(responseError('OMP', message));
    }

    setChecking(false);
  }, []);

  useEffect(() => {
    void checkProviders();
    return () => {
      requestId.current += 1;
    };
  }, [checkProviders]);

  const installClaude = (): void => {
    void window.electronAPI?.openExternal('https://claude.ai/code');
  };

  // OMP is not bundled in v1 (docs/proposals/omp-provider-integration.md §3.3) —
  // the app can only point at the project's own install docs, the same posture
  // as Claude's "Install" action.
  const installOmp = (): void => {
    void window.electronAPI?.openExternal('https://omp.sh');
  };

  const claude = claudeView(claudeDetection, claudeError);
  const codex = codexView(codexDetection, codexError);
  const ompAvailability = useOmpAvailability();
  const omp = ompView(ompDetection, ompError, ompAvailability);

  // Provider access — the toggles below write AppConfig.agentProviderAccess,
  // the same field the onboarding Connect step writes, so the two surfaces are
  // one setting. Detection status is orthogonal: a provider can be signed in
  // and switched off, or switched on and not yet signed in.
  const providerAccess = useAgentProviderAccess();
  const claudeEnabled = isAgentProviderEnabled(providerAccess, 'claude');
  const codexEnabled = isAgentProviderEnabled(providerAccess, 'codex');
  // OMP is the first provider introduced after these toggles existed, so an
  // absent key floors to DISABLED (AGENT_PROVIDER_REGISTRY.omp.defaultEnabled),
  // unlike claude/codex — isAgentProviderEnabled already applies that per-
  // provider default, so this reads correctly with no special-casing here.
  const ompEnabled = isAgentProviderEnabled(providerAccess, 'omp');
  const enabledByProvider: Record<AgentProvider, boolean> = {
    claude: claudeEnabled,
    codex: codexEnabled,
    omp: ompEnabled,
  };
  const [savingProvider, setSavingProvider] = useState<AgentProvider | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setProviderEnabled = useCallback(
    async (provider: AgentProvider, enabled: boolean): Promise<void> => {
      setSavingProvider(provider);
      setSaveError(null);
      // Full access object, never a partial patch — a sibling member must not
      // be dropped by an update that only meant to change one provider.
      const next: AgentProviderAccess = {
        claude: provider === 'claude' ? enabled : claudeEnabled,
        codex: provider === 'codex' ? enabled : codexEnabled,
        omp: provider === 'omp' ? enabled : ompEnabled,
      };
      const ok = await useConfigStore.getState().updateConfig({ agentProviderAccess: next });
      if (!ok) {
        setSaveError(
          useConfigStore.getState().error || 'Could not save the provider setting.',
        );
      }
      setSavingProvider(null);
    },
    [claudeEnabled, codexEnabled, ompEnabled],
  );

  // Guard rail mirroring onboarding's "enable at least one detected provider":
  // the last provider standing cannot be switched off, or nothing could launch.
  const lastEnabledReason = 'At least one provider must stay enabled.';
  const toggleReason = (provider: AgentProvider, enabled: boolean): string | undefined => {
    if (savingProvider !== null) return 'Saving…';
    const otherEnabled = AGENT_PROVIDERS.some((p) => p !== provider && enabledByProvider[p]);
    if (enabled && !otherEnabled) return lastEnabledReason;
    return undefined;
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Agent providers"
        description="Accounts Cyboflow can use for quick sessions and workflow runs."
        icon={<Bot className="h-4 w-4" />}
        className="ml-0"
      >
        <div className="overflow-hidden rounded-lg border border-border-primary bg-surface-primary divide-y divide-border-primary">
          <ProviderRow
            name="Claude Code"
            description="Anthropic agent runtime for SDK and interactive terminal sessions."
            icon={<Bot className="h-4 w-4" />}
            view={claude}
            enabled={claudeEnabled}
            onToggle={(next) => void setProviderEnabled('claude', next)}
            toggleDisabledReason={toggleReason('claude', claudeEnabled)}
            toggleTestId="provider-toggle-claude"
            action={claudeDetection?.state === 'missing' ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={installClaude}
              >
                Install
              </Button>
            ) : undefined}
          />
          <ProviderRow
            name="Codex"
            description="OpenAI agent runtime using the Codex app server and your ChatGPT account."
            icon={<Code2 className="h-4 w-4" />}
            view={codex}
            enabled={codexEnabled}
            onToggle={(next) => void setProviderEnabled('codex', next)}
            toggleDisabledReason={toggleReason('codex', codexEnabled)}
            toggleTestId="provider-toggle-codex"
          />
          <ProviderRow
            name="OMP"
            description="Multi-provider agent harness (60+ model providers) using its own accounts and credentials — Cyboflow only detects the binary, never your OMP logins."
            icon={<Boxes className="h-4 w-4" />}
            view={omp}
            enabled={ompEnabled}
            onToggle={(next) => void setProviderEnabled('omp', next)}
            toggleDisabledReason={toggleReason('omp', ompEnabled)}
            toggleTestId="provider-toggle-omp"
            action={!ompAvailability.ariaMode && ompDetection?.state === 'unavailable' && ompDetection.binaryPath === null ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={installOmp}
              >
                Install
              </Button>
            ) : undefined}
          />
        </div>

        {saveError && (
          <p className="mt-3 text-xs leading-relaxed text-status-error" role="alert">
            {saveError}
          </p>
        )}
        {!claudeEnabled && (
          <p className="mt-3 text-xs leading-relaxed text-text-tertiary">
            Claude is off: design sessions and visual verification, which always run on Claude,
            are unavailable until you turn it back on.
          </p>
        )}
        {!ompEnabled && (
          <p className="mt-3 text-xs leading-relaxed text-text-tertiary">
            OMP is off by default — turn it on here once you've installed it and signed in
            (run <code className="border border-border-primary bg-bg-primary px-1">omp</code> in a
            terminal and <code className="border border-border-primary bg-bg-primary px-1">/login &lt;provider&gt;</code>).
          </p>
        )}
      </SettingsSection>

      <TrackerIntegrationSection />

      <div className="flex items-center justify-between gap-4 border-t border-border-primary pt-4">
        <p className="text-xs leading-relaxed text-text-tertiary">
          A provider must be both switched on here and signed in on this machine before Cyboflow
          can use it.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />}
          onClick={() => void checkProviders()}
          disabled={checking}
        >
          Check again
        </Button>
      </div>
    </div>
  );
}
