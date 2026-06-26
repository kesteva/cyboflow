import { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { PERMISSION_MODE_OPTIONS } from '../AgentPermissionModeSelector';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';

/**
 * PermissionModePill — interactive agent-permission selector for a composer,
 * rendered next to the {@link ModelPill}.
 *
 * The pill is persist-source-agnostic: the host passes a {@link persist} fn so
 * the SAME component serves both a quick SDK session (QuickSessionComposer →
 * `sessions:update-agent-permission-mode` IPC → sessions.agent_permission_mode)
 * and a running SDK workflow run (ChatInput → cyboflow.runs.setPermissionMode →
 * workflow_runs.permission_mode_snapshot — ISSUE #2). In BOTH cases the new mode
 * takes effect on the NEXT turn (the SDK re-reads the stored mode on each spawn).
 * Mirrors the CommitModePill/ModelPill pattern (Dropdown + Pill + onChange so the
 * host mirrors it into its local state immediately).
 *
 * Single-sources its options from {@link PERMISSION_MODE_OPTIONS} (the same list
 * the launch-time AgentPermissionModeSelector uses), so labels never drift.
 */
const MODE_LABELS = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((o) => [o.id, o.label]),
) as Record<PermissionMode, string>;

interface PermissionModePillProps {
  currentMode: PermissionMode;
  /**
   * Persist the chosen mode to its backing store (session row or run snapshot).
   * Returns `{ success }` so the pill can mirror optimistically only on a
   * confirmed write. A thrown error is caught + logged by handleSelect.
   */
  persist: (mode: PermissionMode) => Promise<{ success: boolean; error?: string }>;
  /** Invoked after the mode is persisted so the host updates its local state. */
  onModeChange: (mode: PermissionMode) => void;
  /**
   * Optional post-persist hook so the host can surface a confirmation (e.g. a
   * toast). Receives the applied mode plus a host-supplied confirmation message;
   * only fired on a confirmed write, after {@link onModeChange}.
   */
  onApplied?: (mode: PermissionMode, message: string) => void;
  /**
   * Host-supplied confirmation copy, used only when {@link onApplied} is set.
   * Lets the host phrase substrate-aware timing ("applies on your next message"
   * for SDK vs "applies when the terminal restarts" for an interactive PTY).
   */
  appliedMessage?: string;
  /**
   * Override the trigger tooltip. Defaults to the SDK next-message phrasing; the
   * interactive host passes restart-scoped copy so the title is honest per
   * substrate.
   */
  title?: string;
}

export function PermissionModePill({
  currentMode,
  persist,
  onModeChange,
  onApplied,
  appliedMessage,
  title = 'Agent permission — applies on your next message',
}: PermissionModePillProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const label = MODE_LABELS[currentMode] ?? currentMode;

  const handleSelect = async (mode: PermissionMode): Promise<void> => {
    setOpen(false);
    if (mode === currentMode) return;
    try {
      const res = await persist(mode);
      if (res.success) {
        onModeChange(mode);
        onApplied?.(mode, appliedMessage ?? `Permission mode set to ${MODE_LABELS[mode] ?? mode}`);
      } else {
        console.error('Failed to set permission mode:', res.error);
      }
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
      title={title}
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
