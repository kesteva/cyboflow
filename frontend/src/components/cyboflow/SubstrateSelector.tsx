/**
 * SubstrateSelector — per-run CLI substrate choice (SDK | Interactive PTY) plus
 * the unconditional interactive v1 caveats (IDEA-013 / TASK-812). Controlled
 * (value/onChange), but self-locks to the global PTY-only setting (see below).
 *
 * Substrate is honored on BOTH launch paths:
 *   - Workflow runs: threaded into runs.start as the `substrate` param, stamped
 *     onto workflow_runs.substrate and honored by RunExecutor /
 *     SubstrateDispatchFacade.
 *   - Quick sessions: threaded via useQuickSession.start →
 *     CreateSessionRequest.substrate → sessions.substrate (migration 027);
 *     'interactive' spawns a PTY-backed quick session (persistent claude REPL).
 *
 * Global PTY-only lock: when Settings → AI Integration → CLI runtime is set to
 * "Interactive PTY only" (config.interactivePtyOnly), the SDK is disabled and
 * every run is forced onto the interactive substrate. The authoritative pin is
 * the backend ConfigManager.getForcedSubstrate (consumed in
 * WorkflowRegistry.createRun, above the whole resolver ladder); this component
 * reads the same flag from the config store so the picker stays honest — it
 * renders a read-only locked state and syncs the controlled value to
 * 'interactive' so the launch payload matches what will be stamped. Reading the
 * flag HERE (the single shared picker) locks every consumer at once.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * caveats text + lock behavior are single-sourced (no drift).
 */
import { useEffect } from 'react';
import { type CliSubstrate } from '../../../../shared/types/substrate';
import { useForcedSubstrate } from '../../hooks/useForcedSubstrate';

/**
 * The v1 limits of the interactive PTY substrate, surfaced when 'interactive' is
 * picked. These are the UNCONDITIONAL caveats — the interactive PreToolUse
 * approval gating DID ship (TASK-810), so the "approval routing unavailable"
 * caveat is intentionally NOT listed.
 */
export const INTERACTIVE_CAVEATS: readonly string[] = [
  'AskUserQuestion is native-TUI-only — multiple-choice questions surface in the terminal, not the structured panel.',
  'Subagent gating is limited — only the main session reports step transitions; subagent tool calls are gated but not separately surfaced.',
  'Streaming is coarser — output arrives at turn-level granularity, not token-level deltas.',
];

interface SubstrateSelectorProps {
  value: CliSubstrate;
  onChange: (substrate: CliSubstrate) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
  /** data-testid for the caveats panel (per-surface to keep existing selectors stable). */
  caveatsTestId?: string;
}

function InteractiveCaveats({ testId }: { testId: string }): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="note"
      className="mt-1 rounded-input border border-status-warning bg-bg-secondary px-3 py-2 text-xs text-text-secondary"
    >
      <p className="mb-1 font-semibold text-text-primary">Interactive substrate — v1 limits</p>
      <ul className="list-disc space-y-1 pl-4">
        {INTERACTIVE_CAVEATS.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

export function SubstrateSelector({
  value,
  onChange,
  id = 'substrate-select',
  label = 'CLI substrate',
  caveatsTestId = 'substrate-caveats',
}: SubstrateSelectorProps): React.JSX.Element {
  // Global forced-substrate pin (see file header), mirroring the backend
  // precedence: demo → 'sdk', else interactivePtyOnly → 'interactive', else null.
  // Reactive read so a config fetch resolving AFTER mount still locks the picker.
  const forced = useForcedSubstrate();

  // Under the interactive lock, keep the controlled value consistent so the
  // launch payload matches the backend pin. Scoped to 'interactive' only: demo's
  // 'sdk' pin is left alone so demo's picker behaves as before (cosmetic — the
  // backend forces 'sdk' regardless). After value reaches 'interactive' the
  // guard stops re-firing (safe with an unstable onChange identity).
  useEffect(() => {
    if (forced === 'interactive' && value !== 'interactive') onChange('interactive');
  }, [forced, value, onChange]);

  // Only the user-facing interactive lock gets the read-only locked UI. Demo
  // mode also pins ('sdk'), but it is a throwaway showcase profile — leave the
  // normal select so demo never falsely renders "Interactive (PTY) — locked".
  if (forced === 'interactive') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-locked"
          aria-label="CLI substrate locked to interactive PTY"
          className="w-full rounded-input border border-border-primary bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          Interactive (PTY) — locked
        </div>
        <p className="text-xs text-text-tertiary">
          SDK is disabled globally (Settings → AI Integration → CLI runtime). Every run uses the
          interactive PTY substrate.
        </p>
        <InteractiveCaveats testId={caveatsTestId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value === 'interactive' ? 'interactive' : 'sdk')}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select CLI substrate"
      >
        <option value="sdk">SDK (default)</option>
        <option value="interactive">Interactive (PTY)</option>
      </select>

      {value === 'interactive' && <InteractiveCaveats testId={caveatsTestId} />}
    </div>
  );
}
