import { useState } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
import { effortLevelsForProvider, type ReasoningEffort } from '../../../../../shared/types/reasoningEffort';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';

/**
 * EffortPill — interactive reasoning-effort selector for a quick session's
 * composer (IDEA-029), mirroring ModelPill.
 *
 * Persists the choice via `claude-panels:set-effort` (panel settings), which
 * takes effect on the NEXT turn — each quick-session turn re-spawns the CLI
 * process and reads the persisted effort — so no respawn is needed here.
 *
 * Only mounted for non-running quick sessions (see QuickSessionComposer,
 * same gating as ModelPill) — a running turn's effort choice is already
 * baked into the in-flight spawn and a mid-turn change would be discarded.
 */
const DEFAULT_ID = '__default__';

interface EffortPillProps {
  panelId: string;
  /** Provider owning the panel settings; controls the visible effort scale. */
  agentProvider?: AgentProvider;
  /** Current persisted effort selection; null means "provider default". */
  currentEffort: ReasoningEffort | null;
  /** Invoked after the effort is persisted so the host updates its local state. */
  onEffortChange: (effort: ReasoningEffort | null) => void;
}

export function EffortPill({
  panelId,
  agentProvider = 'claude',
  currentEffort,
  onEffortChange,
}: EffortPillProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = currentEffort ?? DEFAULT_ID;
  const levels = effortLevelsForProvider(agentProvider);
  const label = currentEffort ? capitalize(currentEffort) : 'Default';

  const handleSelect = async (effort: ReasoningEffort | null): Promise<void> => {
    setOpen(false);
    if ((effort ?? DEFAULT_ID) === active) return;
    try {
      const res = await API.claudePanels.setEffort(panelId, effort);
      if (res.success) onEffortChange(effort);
      else console.error('Failed to set reasoning effort:', res.error);
    } catch (err) {
      console.error('Failed to set reasoning effort:', err);
    }
  };

  const items: DropdownItem[] = [
    {
      id: DEFAULT_ID,
      label: 'Default',
      description: `Let ${agentProvider === 'codex' ? 'Codex' : 'Claude'} pick the effort`,
      icon: Gauge,
      iconColor: 'text-text-secondary',
      onClick: () => void handleSelect(null),
      variant: 'default',
    },
    ...levels.map((level) => ({
      id: level,
      label: capitalize(level),
      icon: Gauge,
      iconColor: 'text-text-secondary',
      onClick: () => void handleSelect(level),
      variant: 'default' as const,
    })),
  ];

  const trigger = (
    <Pill
      variant="default"
      icon={<Gauge className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title="Reasoning effort — applies on your next message"
    >
      {label}
      <ChevronDown
        className={cn('w-3 h-3 transition-transform text-text-secondary', open ? 'rotate-180' : '')}
      />
    </Pill>
  );

  return (
    <Dropdown trigger={trigger} items={items} selectedId={active} position="auto" onOpenChange={setOpen} />
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
