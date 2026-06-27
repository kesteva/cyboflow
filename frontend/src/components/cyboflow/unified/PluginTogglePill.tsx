import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Puzzle } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
import type { PluginEntry } from '../../../../../shared/types/integrations';

/**
 * PluginTogglePill — multi-select plugin selector for a quick SDK session's
 * composer, rendered after the {@link McpTogglePill}.
 *
 * Unlike the MCP pill (a DENY list), the persisted column
 * (sessions.enabled_plugins_json) is an ALLOW list — the selection IS the stored
 * set. Plugins render UNCHECKED by default, so the empty default ([] enabled)
 * emits no enabledPlugins key and inherits the user's file settings
 * (byte-identical). Checking a plugin force-enables it for the session.
 *
 * Persists via the `sessions:update-session-plugins` IPC, which the SDK spawn
 * re-reads on each turn (claudeCodeManager.resolveSessionEnabledPlugins) — so
 * the change takes effect on the NEXT turn with no respawn. Multi-select variant
 * of PermissionModePill: closeOnSelect={false}, item.showDot for the per-row
 * checked marker.
 */
interface PluginTogglePillProps {
  sessionId: string;
  /** The persisted ALLOW set — plugin ids currently force-enabled for the session. */
  selected: string[];
  /** Invoked after the allow set is persisted so the host mirrors it into the store. */
  onChange: (selected: string[]) => void;
}

export function PluginTogglePill({
  sessionId,
  selected,
  onChange,
}: PluginTogglePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  // Read-only catalogue of installed plugins (machine-global), fetched once on
  // mount; failures degrade to an empty list.
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await trpc.cyboflow.plugins.list.query();
        if (!cancelled) setPlugins(list);
      } catch {
        if (!cancelled) setPlugins([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Selectable plugin ids: the catalogue (deduped by id) unioned with any
  // already-enabled id so a stale allow entry stays visible + un-checkable.
  // Keep a name lookup so the row shows the short name with the id as detail.
  const options = useMemo(() => {
    const byId = new Map<string, string>(); // id -> display name
    for (const p of plugins) if (!byId.has(p.id)) byId.set(p.id, p.name);
    for (const id of selected) if (!byId.has(id)) byId.set(id, id);
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [plugins, selected]);

  const label = selected.length === 0 ? 'Plugins' : `Plugins · ${selected.length}`;

  const handleToggle = async (id: string): Promise<void> => {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    try {
      const res = await API.sessions.updateSessionPlugins(sessionId, next);
      if (res.success) onChange(next);
      else console.error('Failed to set plugin selection:', res.error);
    } catch (err) {
      console.error('Failed to set plugin selection:', err);
    }
  };

  const items: DropdownItem[] = options.map(({ id, name }) => ({
    id,
    label: name,
    description: id,
    icon: Puzzle,
    iconColor: 'text-text-secondary',
    onClick: () => void handleToggle(id),
    variant: 'default',
    showDot: selected.includes(id),
    dotColor: 'bg-interactive',
  }));

  const trigger = (
    <Pill
      variant="default"
      icon={<Puzzle className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title="Plugins — applies on your next message"
    >
      {label}
      <ChevronDown
        className={cn('w-3 h-3 transition-transform text-text-secondary', open ? 'rotate-180' : '')}
      />
    </Pill>
  );

  return (
    <Dropdown
      trigger={trigger}
      items={items}
      position="auto"
      closeOnSelect={false}
      onOpenChange={setOpen}
    />
  );
}
