import { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { PERMISSION_MODE_OPTIONS } from '../AgentPermissionModeSelector';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';

/**
 * PermissionModePill — interactive agent-permission selector for a quick SDK
 * session's composer, rendered next to the {@link ModelPill}.
 *
 * Persists via the `sessions:update-agent-permission-mode` IPC (→
 * sessions.agent_permission_mode), which `resolveSessionAgentPermissionMode`
 * re-reads on each SDK spawn — so the change takes effect on the NEXT turn with
 * no respawn. Mirrors the CommitModePill/ModelPill pattern (Dropdown + Pill +
 * onChange so the host mirrors it into the session store immediately).
 *
 * Single-sources its options from {@link PERMISSION_MODE_OPTIONS} (the same list
 * the launch-time AgentPermissionModeSelector uses), so labels never drift.
 */
const MODE_LABELS = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((o) => [o.id, o.label]),
) as Record<PermissionMode, string>;

interface PermissionModePillProps {
  sessionId: string;
  currentMode: PermissionMode;
  /** Invoked after the mode is persisted so the host updates its local state. */
  onModeChange: (mode: PermissionMode) => void;
}

export function PermissionModePill({
  sessionId,
  currentMode,
  onModeChange,
}: PermissionModePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const label = MODE_LABELS[currentMode] ?? currentMode;

  const handleSelect = async (mode: PermissionMode): Promise<void> => {
    setOpen(false);
    if (mode === currentMode) return;
    try {
      const res = await API.sessions.updateAgentPermissionMode(sessionId, mode);
      if (res.success) onModeChange(mode);
      else console.error('Failed to set permission mode:', res.error);
    } catch (err) {
      console.error('Failed to set permission mode:', err);
    }
  };

  const items: DropdownItem[] = PERMISSION_MODE_OPTIONS.map((o) => ({
    id: o.id,
    label: o.label,
    description: o.hint,
    icon: ShieldCheck,
    iconColor: 'text-text-secondary',
    onClick: () => void handleSelect(o.id),
    variant: 'default',
  }));

  const trigger = (
    <Pill
      variant="default"
      icon={<ShieldCheck className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title="Agent permission — applies on your next message"
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
      selectedId={currentMode}
      position="auto"
      onOpenChange={setOpen}
    />
  );
}
