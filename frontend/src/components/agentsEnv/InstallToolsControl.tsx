import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { useHostsStore } from '../../stores/hostsStore';
import type { HostView, ToolchainProgressEvent } from '../../../../shared/types/hosts';

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}`;

/** "Hashing…" / "Uploading 120 of 550 MB" / "Verifying…". Pure. */
export function toolchainPhaseText(ev: ToolchainProgressEvent | undefined): string {
  if (ev === undefined || ev.phase === 'hashing') return 'Hashing…';
  if (ev.phase === 'uploading') {
    return ev.bytesTotal > 0 ? `Uploading ${mb(ev.bytesSent)} of ${mb(ev.bytesTotal)} MB` : 'Uploading…';
  }
  return 'Verifying…';
}

/** True when the card should offer the install: a complete check of the machine that is not yet ready. SSH only. */
export function needsToolchainInstall(host: HostView): boolean {
  if (host.kind !== 'ssh' || host.preflight === null) return false;
  if (!host.preflight.reachable || !host.preflight.probeComplete) return false;
  const hash = host.preflight.results.find((r) => r.id === 'sdk-binary-hash');
  return hash?.status !== 'pass' || !host.remoteReady;
}

export function InstallToolsControl({ host }: { host: HostView }): React.JSX.Element | null {
  const live = useHostsStore((s) => s.toolchainLive[host.id]);
  const watchToolchain = useHostsStore((s) => s.watchToolchain);
  const installToolchain = useHostsStore((s) => s.installToolchain);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => (host.kind === 'ssh' ? watchToolchain(host.id) : undefined), [host.id, host.kind, watchToolchain]);

  if (host.kind !== 'ssh') return null;
  const installing = pending || host.installRunning || live !== undefined;
  if (!installing && !needsToolchainInstall(host)) return null;

  const install = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const res = await installToolchain(host.id);
    setPending(false);
    if (!res.ok) setFailure(res.message);
  };

  const pct = live && live.phase === 'uploading' && live.bytesTotal > 0
    ? Math.min(100, Math.round((live.bytesSent / live.bytesTotal) * 100))
    : null;

  return (
    <div data-testid={`install-tools-${host.id}`} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid={`install-tools-button-${host.id}`}
          disabled={installing}
          icon={installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          onClick={() => void install()}
        >
          Install cyboflow tools (about 550 MB)
        </Button>
      </div>
      <div className="text-[10px] text-text-tertiary">
        Copies the Claude and Codex agents and the cyboflow bridge to this Mac&apos;s folder{' '}
        {host.remoteRoot ?? `~/cf-remote/${host.id}`}. Needed for sessions and workflows.
      </div>
      {installing && (
        <div data-testid={`install-tools-progress-${host.id}`} className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            className="h-1.5 w-full bg-bg-primary border border-border-primary"
          >
            <div
              data-testid={`install-tools-bar-${host.id}`}
              className={`h-full bg-status-success ${pct === null ? 'w-1/4 animate-pulse' : ''}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <div data-testid={`install-tools-phase-${host.id}`} className="text-[10px] text-text-secondary">
            {toolchainPhaseText(live)}
          </div>
        </div>
      )}
      {failure !== null && (
        <div role="alert" data-testid={`install-tools-failure-${host.id}`} className="text-[11px] text-status-error">
          {failure}
        </div>
      )}
    </div>
  );
}
