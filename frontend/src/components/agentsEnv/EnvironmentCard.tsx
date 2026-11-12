import { useEffect, useState } from 'react';
import { Loader2, Pencil, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Chip } from '../landing/QueuePrimitives';
import { HealthDot } from './HealthDot';
import { PreflightChecklist } from './PreflightChecklist';
import { TierControl } from './TierControl';
import { useHostsStore } from '../../stores/hostsStore';
import { formatDistanceToNow } from '../../utils/timestampUtils';
import type { HealthDot as HealthDotKind } from '../../../../shared/types/persistentAgents';
import type { CapabilityTier, HostView, LifecycleState, PreflightRuntimes } from '../../../../shared/types/hosts';

const TIER_LABEL: Record<CapabilityTier, string> = {
  cli: 'CLI sessions',
  full: 'Sessions + workflows',
};

export function lifecycleDot(state: LifecycleState | null): { dot: HealthDotKind; label: string } {
  switch (state) {
    case 'online':
      return { dot: 'green', label: 'Online' };
    case 'asleep':
      return { dot: 'amber', label: 'Asleep' };
    case 'starting':
      return { dot: 'amber', label: 'Starting' };
    case 'unreachable':
      return { dot: 'amber', label: 'Unreachable' };
    case 'stopped':
      return { dot: 'neutral', label: 'Stopped' };
    default:
      return { dot: 'hollow', label: 'Not checked yet' };
  }
}

export function tierLine(host: HostView): string {
  if (host.tierSource === 'fixed' && host.effectiveTier !== null) {
    return `Fixed: ${TIER_LABEL[host.effectiveTier]}`;
  }
  if (host.detectedTier === null) return 'Not checked yet';
  const base = `Detected: ${TIER_LABEL[host.detectedTier]}`;
  return host.userCapTier === 'cli' && host.detectedTier !== 'cli' ? `${base} · limited to CLI sessions` : base;
}

export function runtimesLine(r: PreflightRuntimes): string {
  const parts: string[] = [];
  if (r.claudeCli) parts.push('Claude CLI');
  if (r.codexCli) parts.push('Codex CLI');
  if (!r.codexCli) parts.push('no Codex');
  if (!r.claudeCli) parts.push('no Claude CLI');
  return parts.join(' · ');
}

export function EnvironmentCard({
  host,
  onEdit,
  onOpenTerminal,
  terminalsAvailable = true,
}: {
  host: HostView;
  onEdit: (host: HostView) => void;
  onOpenTerminal: (host: HostView) => void;
  /** False when the kill switch is set: the terminal button stays visible but disabled. */
  terminalsAvailable?: boolean;
}): React.JSX.Element {
  const live = useHostsStore((s) => s.preflightLive[host.id]);
  const watchPreflight = useHostsStore((s) => s.watchPreflight);
  const runPreflight = useHostsStore((s) => s.runPreflight);
  const setUserCap = useHostsStore((s) => s.setUserCap);
  const archive = useHostsStore((s) => s.archive);
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => (host.kind === 'ssh' ? watchPreflight(host.id) : undefined), [host.id, host.kind, watchPreflight]);

  const running = host.preflightRunning || pending;
  const isSsh = host.kind === 'ssh';
  const activeWork = host.runningSessions + host.runningRuns;
  const { dot, label: dotLabel } = lifecycleDot(host.lifecycleState);
  const results = running && live && live.length > 0 ? live : (host.preflight?.results ?? []);
  const stale = host.lifecycleState === 'unreachable' || host.lifecycleState === 'asleep';
  const lastSeen = host.lastSeenAt !== null ? formatDistanceToNow(host.lastSeenAt) : null;

  const check = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const res = await runPreflight(host.id);
    setPending(false);
    if (!res.ok) setFailure(res.message);
  };

  const changeCap = async (cap: 'cli' | null): Promise<void> => {
    setFailure(null);
    const res = await setUserCap(host.id, cap);
    if (!res.ok) setFailure(res.message);
  };

  const remove = async (): Promise<void> => {
    setConfirmRemove(false);
    setFailure(null);
    const res = await archive(host.id);
    if (!res.ok) setFailure(res.message);
  };

  return (
    <div
      data-testid={`environment-card-${host.id}`}
      className="flex flex-col gap-2.5 border border-border-primary bg-surface-primary p-4"
    >
      <div className="flex items-center gap-2">
        <span data-testid={`environment-dot-${host.id}`}>
          <HealthDot dot={dot} label={dotLabel} />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-bold text-text-primary">{host.label}</h3>
        <Chip>{isSsh ? 'SSH' : 'This Mac'}</Chip>
      </div>

      {isSsh && host.sshTarget !== null && (
        <div className="truncate font-mono text-[11px] text-text-tertiary" title={host.sshTarget}>
          {host.sshTarget}
        </div>
      )}

      <div className="flex flex-col gap-0.5 text-[11px]">
        <div data-testid={`environment-tier-${host.id}`} className="text-text-secondary">
          {tierLine(host)}
        </div>
        <div data-testid={`environment-lifecycle-${host.id}`} className="text-text-tertiary">
          {dotLabel}
          {stale && lastSeen !== null ? ` · Last seen ${lastSeen}` : ''}
        </div>
        {host.preflight !== null && (
          <div data-testid={`environment-runtimes-${host.id}`} className="text-text-tertiary">
            {runtimesLine(host.preflight.runtimes)}
          </div>
        )}
      </div>

      {host.lifecycleState === 'unreachable' && host.preflightAt !== null && (
        <div data-testid={`environment-stale-${host.id}`} className="text-[11px] text-status-warning">
          Showing the last successful check from {formatDistanceToNow(host.preflightAt)}.
        </div>
      )}
      {host.lastAttempt !== null && !host.lastAttempt.reachable && (
        <div data-testid={`environment-attempt-${host.id}`} className="text-[11px] text-text-tertiary">
          {host.lastAttempt.summary}
        </div>
      )}

      <TierControl host={host} onChange={(cap) => void changeCap(cap)} />

      <PreflightChecklist hostId={host.id} results={results} running={running} />

      {failure !== null && (
        <div role="alert" data-testid={`environment-failure-${host.id}`} className="text-[11px] text-status-error">
          {failure}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid={`environment-check-${host.id}`}
          disabled={running}
          icon={
            running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />
          }
          onClick={() => void check()}
        >
          Check again
        </Button>
        {isSsh && (
          <>
            <Button
              size="sm"
              variant="secondary"
              data-testid={`environment-terminal-${host.id}`}
              disabled={!terminalsAvailable}
              title={terminalsAvailable ? undefined : 'Remote environments are turned off on this computer'}
              icon={<Terminal className="h-3 w-3" />}
              onClick={() => onOpenTerminal(host)}
            >
              Open terminal
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`environment-edit-${host.id}`}
              icon={<Pencil className="h-3 w-3" />}
              onClick={() => onEdit(host)}
            >
              Edit
            </Button>
            {confirmRemove ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid={`environment-remove-confirm-${host.id}`}
                  onClick={() => void remove()}
                >
                  Remove it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`environment-remove-cancel-${host.id}`}
                  onClick={() => setConfirmRemove(false)}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                data-testid={`environment-remove-${host.id}`}
                disabled={activeWork > 0}
                title={activeWork > 0 ? 'Finish or stop the work running here first' : undefined}
                icon={<Trash2 className="h-3 w-3" />}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
