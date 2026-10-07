import { Button } from '../ui/Button';
import { parseTimestamp } from '../../utils/timestampUtils';
import { useNow } from '../../hooks/useNow';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { RetiredRevokeWarnings } from './AgentCard';
import { CloudSignInPrompt } from './CloudSignInPrompt';
import { formatClock } from './agentsEnvFormat';
import { vendorAppName } from './agentsVocabulary';
import type { AgentViewT } from './types';

export type ThreadBannerKind =
  | 'not_connected'
  | 'revoked'
  | 'auth_failed'
  | 'cloud_signed_out'
  | 'cloud_locked'
  | 'other_account'
  | 'bridge_disabled'
  | 'connector_blocked'
  | 'pending'
  | 'stale'
  | 'rate_limited';
export type ThreadBannerAction = 'sign_in' | 'pairing' | 'reconnect' | null;
export interface ThreadBanner {
  kind: ThreadBannerKind;
  tone: 'neutral' | 'warning' | 'error';
  copy: string;
  action: ThreadBannerAction;
}

const BRIDGE_OFF_COPY = 'The Bridge is turned off on this computer; messages are not being collected.';

/** Pure; first match in table order; null for a healthy connection. */
export function selectThreadBanner(args: {
  agent: AgentViewT;
  bridgeDisabled: boolean;
  now: number;
}): ThreadBanner | null {
  const { agent, bridgeDisabled, now } = args;
  const c = agent.connection;
  if (c === null) return { kind: 'not_connected', tone: 'neutral', copy: 'Not connected.', action: null };
  const a = c.availability;
  const isBridge = c.kind === 'bridge';

  if (c.state === 'revoked') {
    return {
      kind: 'revoked',
      tone: 'error',
      copy: "Token revoked. This agent can't receive messages.",
      action: isBridge ? 'reconnect' : null,
    };
  }
  if (c.state === 'auth_failed') {
    return { kind: 'auth_failed', tone: 'error', copy: 'API key rejected · reconnect.', action: null };
  }
  if (a.state === 'signed_out' || a.state === 'device_revoked') {
    return {
      kind: 'cloud_signed_out',
      tone: 'warning',
      copy: "This computer isn't signed in to cyboflow cloud, so Bridge messages aren't being collected.",
      action: 'sign_in',
    };
  }
  if (a.state === 'locked') {
    return {
      kind: 'cloud_locked',
      tone: 'neutral',
      copy: a.message ?? 'Waiting for the cyboflow cloud sign-in to unlock.',
      action: 'sign_in',
    };
  }
  if (a.state === 'other_account') {
    return {
      kind: 'other_account',
      tone: 'warning',
      copy: a.message ?? 'This connection was created under a different cyboflow cloud account.',
      action: null,
    };
  }
  if (a.state === 'disabled' || (isBridge && bridgeDisabled)) {
    return { kind: 'bridge_disabled', tone: 'warning', copy: a.message ?? BRIDGE_OFF_COPY, action: null };
  }
  if (a.state === 'needs_update' || a.state === 'not_entitled' || a.state === 'unavailable') {
    return {
      kind: 'connector_blocked',
      tone: 'warning',
      copy: a.message ?? 'This connection is unavailable right now.',
      action: null,
    };
  }
  if (c.state === 'pending') {
    return {
      kind: 'pending',
      tone: 'neutral',
      copy: 'Not yet verified · waiting for its first reply. Messages wait on the Bridge until it checks in.',
      action: isBridge ? 'pairing' : null,
    };
  }
  if (c.state === 'stale') {
    const since = c.lastSeenAt !== null ? formatClock(c.lastSeenAt, new Date(now)) : '';
    const quiet = since !== '' ? `Quiet since ${since}` : 'Quiet';
    return {
      kind: 'stale',
      tone: 'warning',
      copy: `${quiet} · messages wait on the bridge. Open ${vendorAppName(agent.vendor)} and ask it to check its cyboflow messages.`,
      action: null,
    };
  }
  if (c.rateLimitedUntil !== null && parseTimestamp(c.rateLimitedUntil).getTime() > now) {
    return { kind: 'rate_limited', tone: 'warning', copy: 'Rate limited by the vendor · retrying.', action: null };
  }
  return null;
}

const TONE_CLASS: Record<ThreadBanner['tone'], string> = {
  neutral: 'border-border-primary bg-surface-secondary text-text-secondary',
  warning: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  error: 'border-status-error/40 bg-status-error/10 text-status-error',
};

export function ThreadBanner({
  agent,
  onOpenPairing,
  onReconnect,
}: {
  agent: AgentViewT;
  onOpenPairing: (agentId: string) => void;
  onReconnect: (agentId: string) => void;
}): React.JSX.Element | null {
  const now = useNow(30_000);
  const bridgeDisabled = usePersistentAgentsStore((s) => s.featureStatus?.bridgeDisabled === true);
  const banner = selectThreadBanner({ agent, bridgeDisabled, now });
  const switching = agent.pendingSwitch?.connection.kind === 'bridge';
  const retired = agent.retiredConnections;
  if (banner === null && !switching && retired.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {banner !== null && (
        <div
          role="status"
          data-testid="thread-banner"
          data-kind={banner.kind}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-7 py-2 text-[12px] ${TONE_CLASS[banner.tone]}`}
        >
          <span className="min-w-0 break-words">{banner.copy}</span>
          {banner.action === 'sign_in' && <CloudSignInPrompt compact />}
          {banner.action === 'pairing' && (
            <Button variant="ghost" size="sm" onClick={() => onOpenPairing(agent.id)}>
              Pairing details
            </Button>
          )}
          {banner.action === 'reconnect' && (
            <Button variant="ghost" size="sm" data-testid="thread-banner-reconnect" onClick={() => onReconnect(agent.id)}>
              Reconnect…
            </Button>
          )}
        </div>
      )}
      {switching && (
        <div
          role="status"
          data-testid="thread-banner-switching"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-7 py-2 text-[12px] ${TONE_CLASS.neutral}`}
        >
          <span>Reconnecting · waiting for the new connection to verify.</span>
          <Button variant="ghost" size="sm" onClick={() => onOpenPairing(agent.id)}>
            Pairing details
          </Button>
        </div>
      )}
      {retired.length > 0 && (
        <div className="px-7 py-1">
          <RetiredRevokeWarnings retired={retired} />
        </div>
      )}
    </div>
  );
}
