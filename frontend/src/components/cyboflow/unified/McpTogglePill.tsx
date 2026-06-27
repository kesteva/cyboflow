import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Plug } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
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
  sessionId: string;
  /** The persisted DENY set — MCP server names currently disabled for the session. */
  disabled: string[];
  /** Invoked after the deny set is persisted so the host mirrors it into the store. */
  onChange: (disabled: string[]) => void;
}

export function McpTogglePill({
  sessionId,
  disabled,
  onChange,
}: McpTogglePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);

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
    for (const name of disabled) names.add(name);
    return Array.from(names).sort();
  }, [servers, disabled]);

  const label = disabled.length === 0 ? 'MCP' : `MCP · ${disabled.length} off`;

  const handleToggle = async (name: string): Promise<void> => {
    // The CHECKED state shown is "enabled" = NOT in the deny set. Toggling a
    // checked server disables it (add to deny set); toggling an unchecked one
    // re-enables it (remove from deny set).
    const checked = !disabled.includes(name);
    const next = checked ? [...disabled, name] : disabled.filter((x) => x !== name);
    try {
      const res = await API.sessions.updateSessionMcps(sessionId, next);
      if (res.success) onChange(next);
      else console.error('Failed to set MCP selection:', res.error);
    } catch (err) {
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
    showDot: !disabled.includes(name),
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
