/**
 * SubstrateSelector — per-run CLI substrate choice (SDK | Interactive PTY) plus
 * the unconditional interactive v1 caveats (IDEA-013 / TASK-812). Presentational
 * (controlled value/onChange).
 *
 * Substrate is a WORKFLOW-RUN concept only — it is honored by RunExecutor /
 * SubstrateDispatchFacade when a run is launched via runs.start. It has NO effect
 * on quick sessions (their Claude panel always uses the SDK manager), so callers
 * render this ONLY for the workflow path.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * caveats text is single-sourced (no drift).
 */
import { type CliSubstrate } from '../../../../shared/types/substrate';

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

export function SubstrateSelector({
  value,
  onChange,
  id = 'substrate-select',
  label = 'CLI substrate',
  caveatsTestId = 'substrate-caveats',
}: SubstrateSelectorProps): React.JSX.Element {
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

      {value === 'interactive' && (
        <div
          data-testid={caveatsTestId}
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
      )}
    </div>
  );
}
