/**
 * SystemPortsSection — the read-only "Ports & sockets" section of the System
 * view (design IDEA-037). Kept as its own top-level section rather than folded
 * into owning worktree cards: it answers "what's bound on this machine".
 *
 * Sourced from `snapshot.ports`: the watched TCP ports (configured in place via
 * the section's gear — AppConfig.systemWatchedPorts; cyboflow's own dev ports
 * are added in a dev build) and `orch.sock` occupancy. The snapshot carries no authoritative port→owner
 * mapping and no listening flag for `orch.sock`, so neither is asserted: a bound
 * TCP port shows its owner as unidentified, and `orch.sock` shows its client
 * count without claiming bound/free (a listening socket can have zero clients).
 * The only control is that gear: no destructive action lives here. Every field is read defensively so a
 * partial payload (missing `ports`, or a missing member) renders an empty state
 * instead of crashing.
 */
import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Settings as GearIcon } from 'lucide-react';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import { API } from '../../utils/api';
import { useConfigStore } from '../../stores/configStore';
import {
  parseSystemWatchedPortsText,
  resolveSystemWatchedPorts,
  SYSTEM_WATCHED_PORTS_MAX,
} from '../../../../shared/types/systemWatchedPorts';

type PortsData = SystemSnapshotData['ports'];

export interface SystemPortsSectionProps {
  /** `snapshot.ports`; tolerated undefined/partial (an older or starting payload). */
  ports?: Partial<PortsData> | null;
  /** Called after the watched-port list is saved, so the view can re-probe right away. */
  onWatchedPortsSaved?: () => void;
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
  const { tcp, orchSocket } = ports;
  for (const probe of Array.isArray(tcp) ? tcp : []) {
    rows.push({
      id: `port-${probe.port}`,
      title: `:${probe.port}`,
      sub: probe.label,
      bound: probe.inUse,
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

const SMALL_BUTTON_CLASS =
  'rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

/** Inline editor for the watched-port list; loads the stored list fresh when opened. */
function WatchedPortsEditor({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }): ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the stored list on open (absent ⇒ the defaults).
  useEffect(() => {
    let cancelled = false;
    const show = (stored: unknown): void => {
      if (!cancelled) setText(resolveSystemWatchedPorts(stored).join(', '));
    };
    API.config
      .get()
      .then((response) => show(response.success ? response.data?.systemWatchedPorts : undefined))
      .catch(() => show(undefined));
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (): Promise<void> => {
    if (text === null || saving) return;
    const parsed = parseSystemWatchedPortsText(text);
    if (parsed.invalid.length > 0) {
      setError(`Not a port (1-65535): ${parsed.invalid.join(', ')}`);
      return;
    }
    if (parsed.ports.length > SYSTEM_WATCHED_PORTS_MAX) {
      setError(`At most ${SYSTEM_WATCHED_PORTS_MAX} ports`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await API.config.update({ systemWatchedPorts: parsed.ports });
      if (!response.success) {
        setError(response.error ?? 'Failed to save watched ports');
        return;
      }
      void useConfigStore.getState().fetchConfig();
      onSaved?.();
      onClose();
    } catch {
      setError('Failed to save watched ports');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div data-testid="system-ports-editor" className="mb-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          data-testid="system-ports-editor-input"
          aria-label="Watched ports"
          autoFocus
          disabled={text === null || saving}
          value={text ?? ''}
          placeholder="e.g. 3000, 5000, 8080"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          className="w-80 max-w-full rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-primary focus:border-border-emphasized focus:outline-none"
        />
        <button
          type="button"
          data-testid="system-ports-editor-save"
          disabled={text === null || saving}
          onClick={() => void save()}
          className={SMALL_BUTTON_CLASS}
        >
          Save
        </button>
        <button type="button" data-testid="system-ports-editor-cancel" onClick={onClose} className={SMALL_BUTTON_CLASS}>
          Cancel
        </button>
      </div>
      {error !== null ? (
        <div data-testid="system-ports-editor-error" role="alert" className="text-[11px] text-status-error">
          {error}
        </div>
      ) : (
        <div className="text-[11px] text-text-tertiary">Separate ports with commas or spaces. Leave empty to watch none.</div>
      )}
    </div>
  );
}

export function SystemPortsSection({ ports, onWatchedPortsSaved }: SystemPortsSectionProps): ReactElement {
  const rows = buildRows(ports);
  const [editing, setEditing] = useState(false);

  return (
    <section data-testid="system-ports" aria-label="Ports and sockets" className="border-b border-border-primary px-7 py-4">
      <div className="mb-2.5 flex items-center gap-1.5">
        <div className="eyebrow text-text-tertiary">Ports &amp; sockets</div>
        <button
          type="button"
          data-testid="system-ports-configure"
          aria-label="Configure watched ports"
          aria-expanded={editing}
          title="Configure watched ports"
          onClick={() => setEditing((v) => !v)}
          className={`rounded-button p-0.5 transition-colors hover:text-text-primary ${
            editing ? 'text-text-primary' : 'text-text-tertiary'
          }`}
        >
          <GearIcon className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {editing && <WatchedPortsEditor onClose={() => setEditing(false)} onSaved={onWatchedPortsSaved} />}
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
