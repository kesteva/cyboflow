import { useEffect, useRef, useState } from 'react';
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
 * The pill is persist-source-agnostic: the host passes a {@link persist} fn, but
 * both hosts now target the SAME chokepoint — sessions.agent_permission_mode. A
 * quick SDK session (QuickSessionComposer) and a running SDK workflow run
 * (ChatInput, resolving the host session from activeRun.session_id) both persist
 * via `sessions:update-agent-permission-mode` IPC. In BOTH cases the new mode
 * takes effect on the NEXT turn (the SDK re-reads the stored mode on each spawn).
 * Mirrors the CommitModePill/ModelPill pattern (Dropdown + Pill + onChange so the
 * host mirrors it into its local state immediately).
 *
 * Single-sources its options from {@link PERMISSION_MODE_OPTIONS} (the same list
 * the launch-time AgentPermissionModeSelector uses), so labels never drift.
 *
 * Optimistic local mirror (same pattern as McpTogglePill/PluginTogglePill): the
 * quick composer feeds `currentMode` from a FETCHED session copy (the
 * SessionProvider's `effectiveSession`, resolved once by usePanelSurface), NOT
 * the zustand store our `onModeChange` updates — and usePanelSurface re-syncs the
 * store→session only for the MAIN-repo session, never the quick session. So a
 * controlled-only pill would persist the change yet keep showing the stale mode
 * until a refetch. We mirror the selection locally for instant feedback and
 * re-sync ONLY when the prop VALUE genuinely changes (reload / session switch).
 */
const MODE_LABELS = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((o) => [o.id, o.label]),
) as Record<PermissionMode, string>;

interface PermissionModePillProps {
  currentMode: PermissionMode;
  /**
   * Persist the chosen mode to its backing store (the host session's
   * sessions.agent_permission_mode for both composers). Returns `{ success }` so
   * the pill can mirror optimistically only on a confirmed write. A thrown error
   * is caught + logged by handleSelect.
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

  // Optimistic local mirror of the persisted mode (see component doc). Re-sync
  // only when the prop VALUE genuinely changes, so an external update (reload /
  // session switch) wins but our own optimistic write is never clobbered by a
  // re-render that hands back the same stale prop.
  const [localMode, setLocalMode] = useState<PermissionMode>(currentMode);
  const lastProp = useRef<PermissionMode>(currentMode);
  useEffect(() => {
    if (lastProp.current !== currentMode) {
      lastProp.current = currentMode;
      setLocalMode(currentMode);
    }
  }, [currentMode]);

  const label = MODE_LABELS[localMode] ?? localMode;

  const handleSelect = async (mode: PermissionMode): Promise<void> => {
    setOpen(false);
    // Guard against the DISPLAYED value, not the (possibly stale) prop — else
    // re-selecting the value the prop is stuck on would no-op the persist.
    if (mode === localMode) return;
    const prev = localMode;
    setLocalMode(mode); // optimistic
    try {
      const res = await persist(mode);
      if (res.success) {
        onModeChange(mode);
        onApplied?.(mode, appliedMessage ?? `Permission mode set to ${MODE_LABELS[mode] ?? mode}`);
      } else {
        setLocalMode(prev);
        console.error('Failed to set permission mode:', res.error);
      }
    } catch (err) {
      setLocalMode(prev);
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
      selectedId={localMode}
      position="auto"
      onOpenChange={setOpen}
    />
  );
}
