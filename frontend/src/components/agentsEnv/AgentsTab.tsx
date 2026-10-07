import { Bot, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { EmptyWell, ProminentButton } from '../landing/QueuePrimitives';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { AgentCard } from './AgentCard';

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
    <div className="grid h-full content-start gap-3 overflow-y-auto p-7 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
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
  );
}
