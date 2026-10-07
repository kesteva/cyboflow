import { useNow } from '../../hooks/useNow';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { Chip } from '../landing/QueuePrimitives';
import { healthFor } from './AgentCard';
import { HealthDot } from './HealthDot';
import { VendorAvatar } from './VendorAvatar';
import { kindChipLabel } from './agentsVocabulary';

/**
 * "Persistent agents" section at the top of the sidebar's scroll area. Reads only the store (never calls
 * tRPC), and is absent unless the feature is running and at least one agent exists.
 */
export function PersistentAgentsRailSection(): React.JSX.Element | null {
  const running = usePersistentAgentsStore((s) => s.featureStatus?.running === true);
  const agents = usePersistentAgentsStore((s) => s.agents);
  const agentsEnvOpen = useNavigationStore((s) => s.agentsEnvOpen);
  const selectedId = useNavigationStore((s) => s.agentsEnvAgentId);
  const openAgentsEnv = useNavigationStore((s) => s.openAgentsEnv);
  const now = useNow(60_000);

  if (!running || agents.length === 0) return null;

  return (
    <section data-testid="rail-persistent-agents" aria-label="Persistent agents" className="pb-1">
      <div className="flex items-center justify-between overflow-hidden px-4 py-2 text-sm uppercase">
        <span className="truncate text-text-tertiary">Persistent agents</span>
      </div>
      <ul>
        {agents.map((a) => {
          const selected = agentsEnvOpen && selectedId === a.id;
          const health = a.connection !== null ? healthFor(a, a.connection, now) : null;
          return (
            <li key={a.id}>
              <button
                type="button"
                data-testid={`rail-agent-row-${a.id}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => openAgentsEnv({ agentId: a.id })}
                className={`mx-2 flex w-[calc(100%-1rem)] items-start gap-2 px-2 py-1.5 text-left transition-colors ${
                  selected ? 'bg-surface-secondary' : 'hover:bg-surface-hover'
                }`}
              >
                <VendorAvatar vendor={a.vendor} name={a.displayName} />
                <span className="min-w-0 flex-1">
                  <span
                    title={a.displayName}
                    className="block break-words text-[12px] font-bold leading-tight text-text-primary"
                  >
                    {a.displayName}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Chip>{kindChipLabel(a.vendor, a.connection?.kind ?? 'bridge')}</Chip>
                    <HealthDot dot={health?.dot ?? 'neutral'} label={health?.copy ?? 'Not connected'} />
                    {a.unreadCount > 0 && (
                      <span
                        data-testid={`rail-agent-unread-${a.id}`}
                        aria-label={`${a.unreadCount} unread`}
                        className="shrink-0 rounded-full bg-interactive px-1.5 text-[10px] font-bold leading-4 text-text-on-interactive"
                      >
                        {a.unreadCount > 99 ? '99+' : a.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
