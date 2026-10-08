import { useState } from 'react';
import { ArrowLeft, Square } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { useNow } from '../../hooks/useNow';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { ARCHIVE_MESSAGE, canReconnect, hasPairingDetails, healthFor } from './AgentCard';
import { CapabilityChips } from './CapabilityChips';
import { HealthDot } from './HealthDot';
import { VendorAvatar } from './VendorAvatar';
import { failureCopyAndUnlock } from './agentsVocabulary';
import type { AgentViewT } from './types';

export function ThreadHeader({
  agent,
  onBack,
  onOpenPairing,
  onReconnect,
}: {
  agent: AgentViewT;
  onBack: () => void;
  onOpenPairing: (id: string) => void;
  onReconnect: (id: string) => void;
}): React.JSX.Element {
  const now = useNow(30_000);
  const control = usePersistentAgentsStore((s) => s.control);
  const archiveAgent = usePersistentAgentsStore((s) => s.archiveAgent);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const c = agent.connection;
  const health = c !== null ? healthFor(agent, c, now) : null;
  const canStop = c !== null && c.capabilities.descriptor.control.includes('interrupt');
  const stopLabel = c !== null && c.capabilities.observed.control !== undefined ? 'Stop' : 'Stop (not confirmed)';

  const stop = async (): Promise<void> => {
    setError(null);
    const res = await control(agent.id, 'interrupt');
    if (!res.ok) setError(`Couldn't stop it: ${failureCopyAndUnlock(res).copy}`);
  };

  const archive = async (): Promise<void> => {
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
    <div className="border-b border-border-primary bg-bg-secondary px-7 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton aria-label="All agents" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack} />
        <VendorAvatar vendor={agent.vendor} name={agent.displayName} size={28} />
        <h3 className="min-w-0 break-words text-base font-bold text-text-primary">{agent.displayName}</h3>
        <span className="font-mono text-[10px] text-text-tertiary">{`cf/${agent.handle}/`}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canStop && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Square className="h-3 w-3" />}
              data-testid="thread-stop"
              onClick={() => void stop()}
            >
              {stopLabel}
            </Button>
          )}
          {hasPairingDetails(agent) && (
            <Button variant="ghost" size="sm" data-testid="thread-pairing-details" onClick={() => onOpenPairing(agent.id)}>
              Pairing details
            </Button>
          )}
          {canReconnect(agent) && (
            <Button variant="ghost" size="sm" data-testid="thread-reconnect" onClick={() => onReconnect(agent.id)}>
              Reconnect…
            </Button>
          )}
          <Button variant="ghost" size="sm" data-testid="thread-archive" onClick={() => setConfirmArchive(true)}>
            Archive…
          </Button>
        </div>
      </div>
      <div data-testid="thread-connection-line" className="mt-1.5 flex items-start gap-2 text-[11px] text-text-secondary">
        <span className="mt-1">
          <HealthDot dot={health?.dot ?? 'neutral'} label={health?.copy ?? 'Not connected'} />
        </span>
        <span className="min-w-0 break-words">{health?.copy ?? 'Not connected'}</span>
      </div>
      {c !== null && (
        <div className="mt-2">
          <CapabilityChips snapshot={c.capabilities} transport={c.transport} vendor={agent.vendor} testId="thread-chips" />
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-1 text-[11px] text-status-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        isOpen={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => void archive()}
        title={`Archive ${agent.displayName}?`}
        message={ARCHIVE_MESSAGE}
        confirmText="Archive"
      />
    </div>
  );
}
