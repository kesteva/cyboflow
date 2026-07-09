/**
 * AgentPermissionModeSelector — the 4-button agent-permission picker, mirroring
 * the global control in Settings.tsx. Presentational (controlled value/onChange);
 * the seed-from-global + touched-guard state lives in {@link useAgentPermissionMode}.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * options + button markup are single-sourced (no drift in labels/hints/styling).
 */
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { AgentProvider } from '../../../../shared/types/agentRuntime';

/**
 * The session agent-permission options. Selecting one writes the host session's
 * sessions.agent_permission_mode: directly for a quick session, and — when an
 * explicit mode is supplied at launch — permanently for a workflow run's host
 * session too (the launch still stamps workflow_runs.permission_mode_snapshot as a
 * launch-time audit value that may diverge). The session column is the sole
 * execution authority.
 */
type PermissionModeOption = Readonly<{ id: PermissionMode; label: string; hint: string }>;

export const PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Prompt for each edit' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Auto-allow edits, safe reads & git' },
  { id: 'auto', label: 'Auto', hint: 'Native Claude classifier' },
  { id: 'dontAsk', label: "Don't ask", hint: 'No prompts · skip permissions' },
];

const CODEX_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = PERMISSION_MODE_OPTIONS.map((option) =>
  option.id === 'auto'
    ? { ...option, hint: 'Codex decides when to ask' }
    : option,
);

function permissionModeOptionsForProvider(agentProvider: AgentProvider): ReadonlyArray<PermissionModeOption> {
  return agentProvider === 'codex' ? CODEX_PERMISSION_MODE_OPTIONS : PERMISSION_MODE_OPTIONS;
}

interface AgentPermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Provider whose runtime will execute the next launch/message. */
  agentProvider?: AgentProvider;
  /** Heading text above the buttons; pass null to omit the heading. */
  label?: string | null;
  /** Extra classes on the wrapper. */
  className?: string;
}

export function AgentPermissionModeSelector({
  value,
  onChange,
  agentProvider = 'claude',
  label = 'Session permission',
  className,
}: AgentPermissionModeSelectorProps): React.JSX.Element {
  const options = permissionModeOptionsForProvider(agentProvider);

  return (
    <div className={`flex flex-col gap-1.5${className ? ` ${className}` : ''}`}>
      {label !== null && <span className="text-xs font-medium text-text-secondary">{label}</span>}
      {options.map(({ id, label: optLabel, hint }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={value === id}
          aria-label={`Permission mode: ${optLabel}`}
          className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
            value === id
              ? 'border-interactive bg-interactive-surface'
              : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
          }`}
        >
          <span className="text-text-primary font-medium text-sm">{optLabel}</span>
          <span className="text-xs text-text-tertiary">{hint}</span>
        </button>
      ))}
      {agentProvider === 'codex' && (
        <p className="text-xs text-text-tertiary">
          Codex uses Codex-native sandbox prompts; Cyboflow review-queue permission prompts are Claude-only for now.
        </p>
      )}
    </div>
  );
}
