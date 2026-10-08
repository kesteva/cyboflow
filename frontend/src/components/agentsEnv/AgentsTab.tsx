import { useEffect } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { EmptyWell, ProminentButton } from '../landing/QueuePrimitives';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { useCloudAccountStore } from '../../stores/cloudAccountStore';
import { AgentCard } from './AgentCard';
import { CloudSignInPrompt } from './CloudSignInPrompt';

export function AgentsTab({
  onConnect,
  onOpenPairing,
  onReconnect,
}: {
  onConnect: () => void;
  onOpenPairing: (agentId: string) => void;
  onReconnect: (agentId: string) => void;
}): React.JSX.Element {
  const agents = usePersistentAgentsStore((s) => s.agents);
  const agentsStatus = usePersistentAgentsStore((s) => s.agentsStatus);
  const agentsError = usePersistentAgentsStore((s) => s.agentsError);
  const refreshAgents = usePersistentAgentsStore((s) => s.refreshAgents);
  const selectPersistentAgent = useNavigationStore((s) => s.selectPersistentAgent);
  const cloud = useCloudAccountStore((s) => s.status);
  const anyLocked = agents.some((a) => a.connection?.availability.state === 'locked');
  // One remedy for the whole list (every Bridge card shares the one sign-in), and only when the user has
  // to act: a transient 'locked' (unlock in flight) is already described on each card.
  const needsCloudAction =
    anyLocked &&
    cloud?.available === true &&
    (cloud.display === 'secrets_unavailable' || cloud.display === 'undecryptable');

  // Keep a live cloud status while some connection waits on the sign-in.
  useEffect(() => (anyLocked ? useCloudAccountStore.getState().init() : undefined), [anyLocked]);

  if (agents.length === 0) {
    if (agentsStatus === 'loading') {
      return (
        <div className="flex items-center gap-2 p-7 text-[12px] text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading agents…
        </div>
      );
    }
    if (agentsStatus === 'error') {
      return (
        <div role="alert" className="flex flex-col items-start gap-2 p-7 text-[12px] text-status-error">
          <span>{agentsError ?? 'Could not load agents.'}</span>
          <Button variant="secondary" size="sm" onClick={() => void refreshAgents()}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <div className="p-7">
        <EmptyWell
          testId="agents-empty"
          icon={<Bot className="h-5 w-5 text-text-tertiary" />}
          title="No persistent agents yet"
          body="Connect an agent that lives with another vendor — like an OpenAI dot or Meta's Muse — and message it from here. Replies come back to this thread."
          action={
            <ProminentButton data-testid="agents-empty-connect" onClick={onConnect}>
              Connect an agent
            </ProminentButton>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {needsCloudAction && (
        <div data-testid="agents-cloud-remedy" className="border-b border-border-primary bg-bg-secondary px-7 py-3">
          <CloudSignInPrompt />
        </div>
      )}
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-7 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            onOpen={(id) => selectPersistentAgent(id)}
            onOpenPairing={onOpenPairing}
            onReconnect={onReconnect}
          />
        ))}
      </div>
    </div>
  );
}
