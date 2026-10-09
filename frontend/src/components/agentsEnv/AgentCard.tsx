import { useState } from 'react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { Chip } from '../landing/QueuePrimitives';
import { deriveHealth } from '../../../../shared/types/persistentAgents';
import { useNow } from '../../hooks/useNow';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { useCloudAccountStore } from '../../stores/cloudAccountStore';
import { CapabilityChips } from './CapabilityChips';
import { HealthDot } from './HealthDot';
import { VendorAvatar } from './VendorAvatar';
import { failureCopyAndUnlock, kindChipLabel } from './agentsVocabulary';
import type { AgentViewT, ConnectionViewT, RetiredConnectionViewT } from './types';

/** Health for a connection row (card, rail, thread header). */
export function healthFor(
  agent: Pick<AgentViewT, 'vendor'>,
  c: ConnectionViewT,
  now: number,
): ReturnType<typeof deriveHealth> {
  return deriveHealth(
    {
      kind: c.kind,
      vendor: agent.vendor,
      state: c.state,
      lastSeenAt: c.lastSeenAt,
      verifiedAt: c.verifiedAt,
      remoteStatus: c.remoteStatus,
      availability: c.availability,
      credentialState: c.credential?.state ?? null,
      rateLimitedUntil: c.rateLimitedUntil,
    },
    new Date(now),
  );
}

/** One warning per retired connection whose remote revoke keeps failing. */
export function RetiredRevokeWarnings({
  retired,
}: {
  retired: readonly RetiredConnectionViewT[];
}): React.JSX.Element | null {
  const openDevicesPage = useCloudAccountStore((s) => s.openDevicesPage);
  if (retired.length === 0) return null;
  return (
    <>
      {retired.map((r) => (
        <div
          key={r.connectionId}
          role="status"
          data-testid="agent-retired-revoke-warning"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-status-warning"
        >
          {r.remoteRevoke.state === 'pending' ? (
            <span>
              {`cyboflow couldn't revoke this agent's old Bridge access (${r.remoteRevoke.attempts} tries) · retrying`}
            </span>
          ) : (
            <>
              <span>
                cyboflow couldn&apos;t revoke this agent&apos;s old Bridge access and stopped retrying. Revoke it
                from the Devices page.
              </span>
              <Button variant="ghost" size="sm" onClick={() => void openDevicesPage()}>
                Manage devices…
              </Button>
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** Whether Reconnect… applies: a revoked Bridge connection with no swap in flight. */
export function canReconnect(agent: AgentViewT): boolean {
  const c = agent.connection;
  return c !== null && c.kind === 'bridge' && c.state === 'revoked' && agent.pendingSwitch === null;
}

export function hasPairingDetails(agent: AgentViewT): boolean {
  const c = agent.connection;
  return (
    (c !== null && c.kind === 'bridge' && c.state === 'pending') ||
    agent.pendingSwitch?.connection.kind === 'bridge'
  );
}

export const DISCONNECT_MESSAGE =
  "cyboflow revokes this agent's Bridge connection. Its thread stays here; use Reconnect to pair it again.";
const ARCHIVE_MESSAGE =
  'It leaves your agents list and the rail, and is disconnected first if it is still connected. Its thread is kept.';

export function AgentCard({
  agent,
  onOpen,
  onOpenPairing,
  onReconnect,
}: {
  agent: AgentViewT;
  onOpen: (id: string) => void;
  onOpenPairing: (id: string) => void;
  onReconnect: (id: string) => void;
}): React.JSX.Element {
  const now = useNow(30_000);
  const disconnect = usePersistentAgentsStore((s) => s.disconnect);
  const archiveAgent = usePersistentAgentsStore((s) => s.archiveAgent);
  const [confirm, setConfirm] = useState<'disconnect' | 'archive' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const c = agent.connection;
  const health = c !== null ? healthFor(agent, c, now) : null;

  const doDisconnect = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const res = await disconnect(agent.id);
    if (!res.ok) {
      setError(failureCopyAndUnlock(res).copy);
    } else if (res.remoteRevoke === 'pending') {
      setNotice('Revoking on the Bridge — cyboflow keeps retrying.');
    }
  };

  const doArchive = async (): Promise<void> => {
    setError(null);
    const res = await archiveAgent(agent.id);
    if (!res.ok) {
      setError(failureCopyAndUnlock(res).copy);
      return;
    }
    if (useNavigationStore.getState().agentsEnvAgentId === agent.id) {
      useNavigationStore.getState().selectPersistentAgent(null);
    }
  };

  return (
    <div
      data-testid={`agent-card-${agent.id}`}
      className="flex flex-col gap-2 border border-border-primary bg-surface-primary px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <VendorAvatar vendor={agent.vendor} name={agent.displayName} />
        <span
          title={agent.displayName}
          className="min-w-0 flex-1 break-words text-[12px] font-bold text-text-primary"
        >
          {agent.displayName}
        </span>
        {agent.unreadCount > 0 && (
          <span
            aria-label={`${agent.unreadCount} unread`}
            className="shrink-0 rounded-full bg-interactive px-1.5 text-[10px] font-bold leading-4 text-text-on-interactive"
          >
            {agent.unreadCount > 99 ? '99+' : agent.unreadCount}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{kindChipLabel(agent.vendor, c?.kind ?? 'bridge')}</Chip>
        <span className="font-mono text-[10px] text-text-tertiary">{`cf/${agent.handle}/`}</span>
      </div>

      <div className="flex items-start gap-2">
        <span className="mt-1">
          <HealthDot dot={health?.dot ?? 'neutral'} label={health?.copy ?? 'Not connected'} />
        </span>
        <span className="min-w-0 break-words text-[11px] text-text-secondary">
          {health?.copy ?? 'Not connected'}
        </span>
      </div>

      <RetiredRevokeWarnings retired={agent.retiredConnections} />

      {c !== null && c.availability.state !== 'locked' && (
        <CapabilityChips snapshot={c.capabilities} transport={c.transport} vendor={agent.vendor} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" data-testid="agent-open-thread" onClick={() => onOpen(agent.id)}>
          Open thread
        </Button>
        {hasPairingDetails(agent) && (
          <Button size="sm" variant="ghost" data-testid="agent-pairing-details" onClick={() => onOpenPairing(agent.id)}>
            Pairing details
          </Button>
        )}
        {canReconnect(agent) && (
          <Button size="sm" variant="ghost" data-testid="agent-reconnect" onClick={() => onReconnect(agent.id)}>
            Reconnect…
          </Button>
        )}
        {c !== null && c.state !== 'revoked' && (
          <Button size="sm" variant="ghost" data-testid="agent-disconnect" onClick={() => setConfirm('disconnect')}>
            Disconnect…
          </Button>
        )}
        <Button size="sm" variant="ghost" data-testid="agent-archive" onClick={() => setConfirm('archive')}>
          Archive…
        </Button>
      </div>

      {notice !== null && (
        <p role="status" className="text-[11px] text-text-secondary">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-[11px] text-status-error">
          {error}
        </p>
      )}

      <ConfirmDialog
        isOpen={confirm === 'disconnect'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void doDisconnect()}
        title={`Disconnect ${agent.displayName}?`}
        message={DISCONNECT_MESSAGE}
        confirmText="Disconnect"
      />
      <ConfirmDialog
        isOpen={confirm === 'archive'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void doArchive()}
        title={`Archive ${agent.displayName}?`}
        message={ARCHIVE_MESSAGE}
        confirmText="Archive"
      />
    </div>
  );
}
