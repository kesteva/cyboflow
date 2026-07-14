import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot, Code2, ExternalLink, RefreshCw } from 'lucide-react';
import type {
  ClaudeDetectionResult,
  CodexDetectionResult,
} from '../../../../shared/types/onboarding';
import { API } from '../../utils/api';
import { Button } from '../ui/Button';
import { SettingsSection } from '../ui/SettingsSection';

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
}

const statusClasses: Record<ProviderStatus, { dot: string; text: string }> = {
  checking: { dot: 'bg-text-disabled', text: 'text-text-tertiary' },
  connected: { dot: 'bg-status-success', text: 'text-status-success' },
  attention: { dot: 'bg-interactive', text: 'text-interactive' },
  unavailable: { dot: 'bg-status-error', text: 'text-status-error' },
};

function ProviderRow({ name, description, icon, view, action }: ProviderRowProps): React.JSX.Element {
  const tone = statusClasses[view.status];

  return (
    <div className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center border border-border-primary bg-surface-secondary text-interactive">
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
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </div>
  );
}

function claudeView(
  detection: ClaudeDetectionResult | null,
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
  detection: CodexDetectionResult | null,
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

function responseError(provider: string, error?: string): string {
  return error?.trim() || `Cyboflow could not check ${provider}.`;
}

export function IntegrationsSettings(): React.JSX.Element {
  const [claudeDetection, setClaudeDetection] = useState<ClaudeDetectionResult | null>(null);
  const [codexDetection, setCodexDetection] = useState<CodexDetectionResult | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const requestId = useRef(0);

  const checkProviders = useCallback(async (): Promise<void> => {
    const currentRequest = ++requestId.current;
    setChecking(true);
    setClaudeError(null);
    setCodexError(null);

    const [claudeResult, codexResult] = await Promise.allSettled([
      API.claude.detect(),
      API.codex.detect(),
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

  const claude = claudeView(claudeDetection, claudeError);
  const codex = codexView(codexDetection, codexError);

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
          />
        </div>
      </SettingsSection>

      <div className="flex items-center justify-between gap-4 border-t border-border-primary pt-4">
        <p className="text-xs leading-relaxed text-text-tertiary">
          Provider access follows the accounts already signed in on this machine.
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
