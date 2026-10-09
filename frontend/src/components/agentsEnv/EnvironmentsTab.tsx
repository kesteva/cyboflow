import { useState } from 'react';
import { Loader2, Server } from 'lucide-react';
import { Button } from '../ui/Button';
import { EmptyWell } from '../landing/QueuePrimitives';
import { EnvironmentCard } from './EnvironmentCard';
import { AddEnvironmentDialog } from './AddEnvironmentDialog';
import { HostTerminalModal } from './HostTerminalModal';
import { useHostsStore } from '../../stores/hostsStore';
import type { HostView } from '../../../../shared/types/hosts';

export function EnvironmentsTab(): React.JSX.Element {
  const featureStatus = useHostsStore((s) => s.featureStatus);
  const hosts = useHostsStore((s) => s.hosts);
  const hostsStatus = useHostsStore((s) => s.hostsStatus);
  const hostsError = useHostsStore((s) => s.hostsError);
  const refreshHosts = useHostsStore((s) => s.refreshHosts);
  const [editing, setEditing] = useState<HostView | null>(null);
  const [terminalHost, setTerminalHost] = useState<HostView | null>(null);

  if (featureStatus === null) {
    return (
      <div className="flex items-center gap-2 p-7 text-[12px] text-text-tertiary" data-testid="environments-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading environments…
      </div>
    );
  }

  if (!featureStatus.running) {
    return (
      <div className="p-7">
        <EmptyWell
          testId="environments-off"
          icon={<Server className="h-5 w-5 text-text-tertiary" />}
          title="Environments are off"
          body="Turn on Environments in Settings → Feature controls."
        />
      </div>
    );
  }

  const killed = featureStatus.killed;
  // This Mac first, then SSH machines in the order the backend lists them.
  const ordered = [...hosts.filter((h) => h.kind === 'local'), ...hosts.filter((h) => h.kind !== 'local')];

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="environments-tab">
      {killed && (
        <div
          role="status"
          data-testid="environments-killed"
          className="border-b border-border-primary bg-bg-secondary px-7 py-2 text-[11px] text-status-warning"
        >
          Remote environments are turned off on this computer (CYBOFLOW_DISABLE_REMOTE_HOSTS).
        </div>
      )}
      {hostsStatus === 'error' && hosts.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-7 text-[12px] text-status-error" data-testid="environments-error">
          {hostsError ?? 'Could not load environments.'}
          <Button variant="secondary" size="sm" data-testid="environments-retry" onClick={() => void refreshHosts()}>
            Retry
          </Button>
        </div>
      ) : hostsStatus !== 'ready' ? (
        <div className="flex items-center gap-2 p-7 text-[12px] text-text-tertiary" data-testid="environments-loading">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading environments…
        </div>
      ) : (
        <div
          data-testid="environments-grid"
          className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-7 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]"
        >
          {ordered.map((h) => (
            <EnvironmentCard
              key={h.id}
              host={h}
              terminalsAvailable={!killed}
              onEdit={setEditing}
              onOpenTerminal={setTerminalHost}
            />
          ))}
        </div>
      )}

      <AddEnvironmentDialog isOpen={editing !== null} host={editing} onClose={() => setEditing(null)} />
      <HostTerminalModal
        host={terminalHost}
        isOpen={terminalHost !== null}
        onClose={() => setTerminalHost(null)}
      />
    </div>
  );
}
