/**
 * SystemPortsSection — the read-only "Ports & sockets" section of the System
 * view (design IDEA-037). Kept as its own top-level section rather than folded
 * into owning worktree cards: it answers "what's bound on this machine".
 *
 * Sourced from `snapshot.ports` (the :4521 dev renderer, :9223 CDP and
 * `orch.sock` occupancy). The snapshot carries no authoritative port→owner
 * mapping and no listening flag for `orch.sock`, so neither is asserted: a bound
 * TCP port shows its owner as unidentified, and `orch.sock` shows its client
 * count without claiming bound/free (a listening socket can have zero clients).
 * No destructive control lives here. Every field is read defensively so a
 * partial payload (missing `ports`, or a missing member) renders an empty state
 * instead of crashing.
 */
import type { ReactElement } from 'react';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';

type PortsData = SystemSnapshotData['ports'];

export interface SystemPortsSectionProps {
  /** `snapshot.ports`; tolerated undefined/partial (an older or starting payload). */
  ports?: Partial<PortsData> | null;
}

interface PortRow {
  id: string;
  title: string;
  sub: string;
  /** `null` = the snapshot does not report occupancy (orch.sock). */
  bound: boolean | null;
  /** True for TCP ports probed by the snapshot; absent for orch.sock. */
  tcp?: boolean;
  runBindings?: Array<[string, number]>;
}

function buildRows(ports: Partial<PortsData> | null | undefined): PortRow[] {
  const rows: PortRow[] = [];
  if (ports === null || ports === undefined) return rows;
  const { devRenderer, cdp, orchSocket } = ports;
  if (devRenderer) {
    rows.push({
      id: 'port-4521',
      title: `:${devRenderer.port}`,
      sub: devRenderer.label,
      bound: devRenderer.inUse,
      tcp: true,
    });
  }
  if (cdp) {
    rows.push({
      id: 'port-9223',
      title: `:${cdp.port}`,
      sub: cdp.label,
      bound: cdp.inUse,
      tcp: true,
    });
  }
  if (orchSocket) {
    const bindings = Object.entries(orchSocket.runBindings ?? {}).filter(([, n]) => n > 0);
    const clients = orchSocket.connectionCount ?? 0;
    rows.push({
      id: 'orch-sock',
      title: 'orch.sock',
      sub: `${clients} client${clients === 1 ? '' : 's'} · ${bindings.length} run${bindings.length === 1 ? '' : 's'} bound`,
      bound: null,
      runBindings: bindings,
    });
  }
  return rows;
}

export function SystemPortsSection({ ports }: SystemPortsSectionProps): ReactElement {
  const rows = buildRows(ports);

  return (
    <section data-testid="system-ports" aria-label="Ports and sockets" className="border-b border-border-primary px-7 py-4">
      <div className="eyebrow mb-2.5 text-text-tertiary">Ports &amp; sockets</div>
      {rows.length === 0 ? (
        <div data-testid="system-ports-empty" className="text-sm text-text-tertiary">
          No ports or sockets reported.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            return (
              <li
                key={row.id}
                data-testid={`system-port-${row.id}`}
                data-bound={row.bound === null ? 'unknown' : row.bound ? 'true' : 'false'}
                className="rounded-card border border-border-primary bg-card-bg px-3.5 py-2.5 shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-text-primary">{row.title}</span>
                  <span className="text-[11px] text-text-tertiary">{row.sub}</span>
                  {row.bound !== null && (
                    <span
                      className={`eyebrow ml-auto rounded-button border px-1.5 py-0.5 text-[10px] ${
                        row.bound
                          ? 'border-status-success/40 bg-status-success/10 text-status-success'
                          : 'border-border-primary text-text-tertiary'
                      }`}
                    >
                      {row.bound ? 'bound' : 'free'}
                    </span>
                  )}
                </div>
                {row.tcp === true && row.bound === true && (
                  <div className="mt-1.5 text-[11px] text-text-tertiary" data-testid={`system-port-${row.id}-owner`}>
                    owner not identified
                  </div>
                )}
                {row.bound === null && (
                  <div className="mt-1.5 text-[11px] text-text-tertiary" data-testid={`system-port-${row.id}-state`}>
                    listening state not reported
                  </div>
                )}
                {row.runBindings !== undefined && row.runBindings.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-text-secondary">
                    {row.runBindings.map(([runId, n]) => (
                      <li key={runId} className="rounded-button border border-border-primary px-1.5 py-0.5">
                        {runId} ×{n}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
