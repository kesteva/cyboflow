import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plug } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
import { sameStringSet } from '../../../utils/sameStringSet';
import type { McpEntry } from '../../../../../shared/types/integrations';

/**
 * McpTogglePill — multi-select MCP-server selector for a quick SDK session's
 * composer, rendered next to the {@link PermissionModePill}.
 *
 * Polarity (the subtle bit): the runtime mental-model is "which servers are ON",
 * so every discovered server renders CHECKED by default. But the persisted
 * column (sessions.disabled_mcp_servers_json) is a DENY list — the COMPLEMENT —
 * so the empty default ([] disabled) is byte-identical to the prior all-on
 * behavior. Unchecking a server adds its name to the deny set; re-checking
 * removes it.
 *
 * Persists via the `sessions:update-session-mcps` IPC, which the SDK spawn
 * re-reads on each turn (claudeCodeManager.resolveSessionDisabledMcps) — so the
 * change takes effect on the NEXT turn with no respawn. Multi-select variant of
 * PermissionModePill: closeOnSelect={false}, toggles names in/out of the deny
 * array, and uses item.showDot for the per-row checked marker (selectedId only
 * marks one row, which is wrong for a multi-select).
 */
interface McpTogglePillProps {
  /**
   * The owning session id. When set (live session), a toggle persists to
   * sessions.disabled_mcp_servers_json immediately. When OMITTED (the launch
   * wizard — no session exists yet), the pill is purely controlled: a toggle just
   * calls onChange and the parent owns the value + persistence at creation.
   */
  sessionId?: string;
  /** The DENY set — MCP server names currently disabled. */
  disabled: string[];
  /** Invoked with the next deny set on each toggle (after persist when sessionId set). */
  onChange: (disabled: string[]) => void;
}

export function McpTogglePill({
  sessionId,
  disabled,
  onChange,
}: McpTogglePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  // Optimistic local mirror of the persisted deny set. The composer feeds
  // `disabled` from a FETCHED session copy (SessionProvider), NOT the zustand
  // store our `onChange` updates — so a toggle never changes the prop and the
  // label would stay stale until the session is re-fetched. Mirror locally for
  // instant feedback, and re-sync ONLY when the prop VALUE genuinely changes
  // (reload / session switch / async column arrival) — never on the fresh
  // `?? []` identity the composer creates each render, which would otherwise
  // clobber the optimistic state on every re-render.
  const [localDisabled, setLocalDisabled] = useState<string[]>(disabled);
  const lastProp = useRef<string[]>(disabled);
  useEffect(() => {
    if (!sameStringSet(lastProp.current, disabled)) {
      lastProp.current = disabled;
      setLocalDisabled(disabled);
    }
  }, [disabled]);

  // Read-only catalogue of MCP servers configured in the CLI (machine-global),
  // fetched once on mount; failures degrade to an empty list.
  const [servers, setServers] = useState<McpEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await trpc.cyboflow.mcps.list.query();
        if (!cancelled) setServers(list);
      } catch {
        if (!cancelled) setServers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Selectable server names: the catalogue deduped by name (a server can appear
  // at multiple scopes), minus the single-writer `cyboflow` server (never
  // disable-able — it carries the orchestrator socket), unioned with any
  // already-disabled name so a stale deny entry stays visible + re-enable-able.
  const options = useMemo(() => {
    const names = new Set<string>();
    for (const entry of servers) {
      if (entry.name === 'cyboflow' || entry.name.startsWith('cyboflow_')) continue;
      names.add(entry.name);
    }
    for (const name of localDisabled) names.add(name);
    return Array.from(names).sort();
  }, [servers, localDisabled]);

  const label = localDisabled.length === 0 ? 'MCP' : `MCP · ${localDisabled.length} off`;

  const handleToggle = async (name: string): Promise<void> => {
    // The CHECKED state shown is "enabled" = NOT in the deny set. Toggling a
    // checked server disables it (add to deny set); toggling an unchecked one
    // re-enables it (remove from deny set). Apply optimistically so the label +
    // row dot update on the click; revert if the persist fails.
    const checked = !localDisabled.includes(name);
    const next = checked ? [...localDisabled, name] : localDisabled.filter((x) => x !== name);
    const prev = localDisabled;
    setLocalDisabled(next);
    // Wizard (no sessionId yet): parent owns state + persists at session creation.
    if (!sessionId) {
      onChange(next);
      return;
    }
    try {
      const res = await API.sessions.updateSessionMcps(sessionId, next);
      if (res.success) onChange(next);
      else {
        setLocalDisabled(prev);
        console.error('Failed to set MCP selection:', res.error);
      }
    } catch (err) {
      setLocalDisabled(prev);
      console.error('Failed to set MCP selection:', err);
    }
  };

  const items: DropdownItem[] = options.map((name) => ({
    id: name,
    label: name,
    icon: Plug,
    iconColor: 'text-text-secondary',
    onClick: () => void handleToggle(name),
    variant: 'default',
    showDot: !localDisabled.includes(name),
    dotColor: 'bg-interactive',
  }));

  const trigger = (
    <Pill
      variant="default"
      icon={<Plug className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title="MCP servers — applies on your next message"
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
