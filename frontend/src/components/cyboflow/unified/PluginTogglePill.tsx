import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Puzzle } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
import { sameStringSet } from '../../../utils/sameStringSet';
import type { PluginEntry } from '../../../../../shared/types/integrations';

/**
 * PluginTogglePill — multi-select plugin selector for a quick SDK session's
 * composer, rendered after the {@link McpTogglePill}.
 *
 * The runtime mental-model matches the MCP pill: every plugin renders CHECKED
 * when it is ON for the session. The wizard SEEDS `selected` from the user's
 * current enabled set (PluginEntry.enabled), so the control reflects reality —
 * enabled plugins show on, disabled ones off — and unchecking one turns it off
 * for this session (a deterministic exclusive override at the flag tier). The
 * persisted column (sessions.enabled_plugins_json) is that resulting ON set.
 *
 * Persists via the `sessions:update-session-plugins` IPC, which the SDK spawn
 * re-reads on each turn (claudeCodeManager.resolveSessionEnabledPlugins) — so
 * the change takes effect on the NEXT turn with no respawn. Multi-select variant
 * of PermissionModePill: closeOnSelect={false}, item.showDot for the per-row
 * checked marker.
 */
interface PluginTogglePillProps {
  /**
   * The owning session id. When set (live session), a toggle persists to
   * sessions.enabled_plugins_json immediately. When OMITTED (the launch wizard —
   * no session exists yet), the pill is purely controlled: a toggle just calls
   * onChange and the parent owns the value + persistence at creation.
   */
  sessionId?: string;
  /** The ALLOW set — plugin ids currently force-enabled. */
  selected: string[];
  /** Invoked with the next allow set on each toggle (after persist when sessionId set). */
  onChange: (selected: string[]) => void;
}

export function PluginTogglePill({
  sessionId,
  selected,
  onChange,
}: PluginTogglePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  // Optimistic local mirror of the persisted allow set. The composer feeds
  // `selected` from a FETCHED session copy (SessionProvider), NOT the zustand
  // store our `onChange` updates — so a toggle never changes the prop and the
  // label would stay stale until the session is re-fetched. Mirror locally for
  // instant feedback, and re-sync ONLY when the prop VALUE genuinely changes
  // (reload / session switch / async column arrival) — never on the fresh
  // `?? []` identity the composer creates each render.
  const [localSelected, setLocalSelected] = useState<string[]>(selected);
  const lastProp = useRef<string[]>(selected);
  useEffect(() => {
    if (!sameStringSet(lastProp.current, selected)) {
      lastProp.current = selected;
      setLocalSelected(selected);
    }
  }, [selected]);

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
    for (const id of localSelected) if (!byId.has(id)) byId.set(id, id);
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [plugins, localSelected]);

  // Mirror the MCP pill: show how many of the listed plugins are OFF (unchecked),
  // so the trigger reflects the session's disabled count rather than a raw select
  // count. `options` is the full visible set (installed ∪ any stale selection).
  const offCount = options.filter((o) => !localSelected.includes(o.id)).length;
  const label = offCount === 0 ? 'Plugins' : `Plugins · ${offCount} off`;

  const handleToggle = async (id: string): Promise<void> => {
    // Apply optimistically so the label + row dot update on the click; revert if
    // the persist fails.
    const next = localSelected.includes(id)
      ? localSelected.filter((x) => x !== id)
      : [...localSelected, id];
    const prev = localSelected;
    setLocalSelected(next);
    // Wizard (no sessionId yet): parent owns state + persists at session creation.
    if (!sessionId) {
      onChange(next);
      return;
    }
    try {
      const res = await API.sessions.updateSessionPlugins(sessionId, next);
      if (res.success) onChange(next);
      else {
        setLocalSelected(prev);
        console.error('Failed to set plugin selection:', res.error);
      }
    } catch (err) {
      setLocalSelected(prev);
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
    showDot: localSelected.includes(id),
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
