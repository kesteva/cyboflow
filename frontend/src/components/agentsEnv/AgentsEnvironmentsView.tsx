import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '../ui/Button';
import { trpc } from '../../trpc/client';
import { useNavigationStore, type AgentsEnvTab } from '../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { AgentsTab } from './AgentsTab';
import { ConnectAgentDialog } from './ConnectAgentDialog';
import { EnvironmentsPlaceholder } from './EnvironmentsPlaceholder';
import { PersistentAgentThreadView } from './PersistentAgentThreadView';

const TABS: ReadonlyArray<{ id: AgentsEnvTab; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'environments', label: 'Environments' },
];

/** Center pane: the Agents tab (cards or one agent's thread) and the Environments placeholder. */
export function AgentsEnvironmentsView(): React.JSX.Element {
  const tab = useNavigationStore((s) => s.agentsEnvTab);
  const agentId = useNavigationStore((s) => s.agentsEnvAgentId);
  const setTab = useNavigationStore((s) => s.setAgentsEnvTab);
  const selectAgent = useNavigationStore((s) => s.selectPersistentAgent);
  const agents = usePersistentAgentsStore((s) => s.agents);
  const agentsStatus = usePersistentAgentsStore((s) => s.agentsStatus);
  const [connectOpen, setConnectOpen] = useState(false);
  const [resumeAgentId, setResumeAgentId] = useState<string | null>(null);
  const [reconnectAgentId, setReconnectAgentId] = useState<string | null>(null);

  // Opening the pane is an implicit user action: ask main to decrypt the saved cloud sign-in (a no-op after
  // a failed decrypt, and when there is nothing to unlock).
  const unlockSent = useRef(false);
  useEffect(() => {
    if (unlockSent.current) return;
    unlockSent.current = true;
    try {
      void Promise.resolve(trpc.cyboflow.cloud.unlock.mutate({ explicitRetry: false })).catch(() => {});
    } catch {
      /* cloud procedures unavailable: nothing to unlock */
    }
  }, []);

  const selected = agentId !== null ? (agents.find((a) => a.id === agentId) ?? null) : null;
  const missing = agentId !== null && selected === null;
  // An open thread owns the whole pane: its own header carries the way back, so the pane chrome hides.
  const threadOpen = tab === 'agents' && agentId !== null && selected !== null;

  // An archived or deleted agent: drop the selection once the list is authoritative.
  useEffect(() => {
    if (missing && agentsStatus === 'ready') selectAgent(null);
  }, [missing, agentsStatus, selectAgent]);

  const closeDialog = (): void => {
    setConnectOpen(false);
    setResumeAgentId(null);
    setReconnectAgentId(null);
  };

  const onTabKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setTab(tab === 'agents' ? 'environments' : 'agents');
  };

  return (
    <div data-testid="agents-env-view" className="flex h-full w-full flex-col overflow-hidden bg-bg-primary">
      {!threadOpen && (
        <>
          <div className="flex items-center gap-3 border-b border-border-primary bg-bg-secondary px-7 py-4">
            <div className="min-w-0">
              <div className="eyebrow text-text-tertiary">Machines · persistent agents</div>
              <h2 className="text-base font-bold text-text-primary">Agents &amp; Environments</h2>
            </div>
            <div className="ml-auto">
              {tab === 'agents' && agentId === null && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  data-testid="agents-connect-button"
                  onClick={() => setConnectOpen(true)}
                >
                  Connect an agent
                </Button>
              )}
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Agents & Environments"
            onKeyDown={onTabKey}
            className="flex gap-5 border-b border-border-primary px-7"
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  data-testid={`agents-env-tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`py-2 font-mono text-[11px] transition-colors ${
                    active
                      ? 'border-b-2 border-interactive text-text-primary'
                      : 'border-b-2 border-transparent text-text-tertiary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {tab === 'environments' ? (
          <EnvironmentsPlaceholder />
        ) : agentId !== null && selected !== null ? (
          <PersistentAgentThreadView
            agentId={agentId}
            onBack={() => selectAgent(null)}
            onOpenPairing={setResumeAgentId}
            onReconnect={setReconnectAgentId}
          />
        ) : missing && agentsStatus !== 'ready' ? (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading agent" />
          </div>
        ) : (
          <AgentsTab
            onConnect={() => setConnectOpen(true)}
            onOpenPairing={setResumeAgentId}
            onReconnect={setReconnectAgentId}
          />
        )}
      </div>

      <ConnectAgentDialog
        isOpen={connectOpen || resumeAgentId !== null || reconnectAgentId !== null}
        resumeAgentId={resumeAgentId}
        reconnectAgentId={reconnectAgentId}
        onClose={closeDialog}
        onOpenThread={(id) => {
          closeDialog();
          selectAgent(id);
        }}
      />
    </div>
  );
}
