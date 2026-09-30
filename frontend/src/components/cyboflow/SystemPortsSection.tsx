/**
 * SystemPortsSection — the read-only "Ports & sockets" section of the System
 * view (design IDEA-037). Kept as its own top-level section rather than folded
 * into owning worktree cards: it answers "what's bound on this machine".
 *
 * Sourced from `snapshot.ports` (the :4521 dev renderer, :9223 CDP and
 * `orch.sock` occupancy). The snapshot carries no explicit port→owner link, so
 * the owner is inferred best-effort by finding a process whose command line
 * names the port; a foreign match renders as a conflict. No destructive control
 * lives here. Every field is read defensively so a partial payload (missing
 * `ports`, or a missing member) renders an empty state instead of crashing.
 */
import type { ReactElement } from 'react';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import { KindTag } from './KindTag';

type PortsData = SystemSnapshotData['ports'];
type ProcessEntry = SystemSnapshotData['processes'][number];

export interface SystemPortsSectionProps {
  /** `snapshot.ports`; tolerated undefined/partial (an older or starting payload). */
  ports?: Partial<PortsData> | null;
  /** Used only to infer a port's owning process/worktree. */
  processes?: ProcessEntry[] | null;
}

interface PortRow {
  id: string;
  title: string;
  sub: string;
  bound: boolean;
  /** Set for TCP ports so an owner can be inferred; absent for orch.sock. */
  port?: number;
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
      port: devRenderer.port,
    });
  }
  if (cdp) {
    rows.push({
      id: 'port-9223',
      title: `:${cdp.port}`,
      sub: cdp.label,
      bound: cdp.inUse,
      port: cdp.port,
    });
  }
  if (orchSocket) {
    const bindings = Object.entries(orchSocket.runBindings ?? {}).filter(([, n]) => n > 0);
    const clients = orchSocket.connectionCount ?? 0;
    rows.push({
      id: 'orch-sock',
      title: 'orch.sock',
      sub: `${clients} client${clients === 1 ? '' : 's'} · ${bindings.length} run${bindings.length === 1 ? '' : 's'} bound`,
      bound: clients > 0,
      runBindings: bindings,
    });
  }
  return rows;
}

/** First process whose command line names `port` (`:4521`, `--port=4521`, `--port 4521`). */
function findOwner(port: number, processes: ProcessEntry[]): ProcessEntry | null {
  const pattern = new RegExp(`(?:[:=\\s])${port}(?:\\D|$)`);
  return processes.find((p) => pattern.test(p.command)) ?? null;
}

function OwnerCell({ owner }: { owner: ProcessEntry | null }): ReactElement {
  if (owner === null) {
    return <span className="text-text-tertiary">no owner identified</span>;
  }
  const pid = owner.bucket === 'foreign' ? owner.pidLabel : String(owner.pid);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <KindTag kind="process" />
      <span className="text-text-secondary">pid {pid}</span>
      {owner.worktreePath !== null && (
        <>
          <KindTag kind="worktree" />
          <span className="max-w-[260px] truncate text-text-secondary" title={owner.worktreePath}>
            {owner.worktreePath}
          </span>
        </>
      )}
    </span>
  );
}

export function SystemPortsSection({ ports, processes }: SystemPortsSectionProps): ReactElement {
  const rows = buildRows(ports);
  const procs = processes ?? [];

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
            const owner = row.port !== undefined && row.bound ? findOwner(row.port, procs) : null;
            const conflict = owner !== null && owner.bucket === 'foreign';
            const tone = conflict
              ? 'border-status-warning/40 bg-status-warning/10'
              : 'border-border-primary bg-card-bg';
            return (
              <li
                key={row.id}
                data-testid={`system-port-${row.id}`}
                data-bound={row.bound ? 'true' : 'false'}
                data-conflict={conflict ? 'true' : 'false'}
                className={`rounded-card border px-3.5 py-2.5 shadow-sm ${tone}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-text-primary">{row.title}</span>
                  <span className="text-[11px] text-text-tertiary">{row.sub}</span>
                  <span
                    className={`eyebrow ml-auto rounded-button border px-1.5 py-0.5 text-[10px] ${
                      row.bound
                        ? 'border-status-success/40 bg-status-success/10 text-status-success'
                        : 'border-border-primary text-text-tertiary'
                    }`}
                  >
                    {row.bound ? 'bound' : 'free'}
                  </span>
                </div>
                {row.port !== undefined && row.bound && (
                  <div className="mt-1.5 text-[11px]" data-testid={`system-port-${row.id}-owner`}>
                    {conflict && (
                      <span className="eyebrow mr-1.5 text-status-warning" data-testid={`system-port-${row.id}-conflict`}>
                        conflict — held by another instance
                      </span>
                    )}
                    <OwnerCell owner={owner} />
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
