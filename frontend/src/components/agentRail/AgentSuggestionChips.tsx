/**
 * AgentSuggestionChips — the static Stage-1 suggestion set (S1.2 — see
 * docs/proposals/GLOBAL-AGENT-PLAN.md §3 S1.2). Each chip sends its own label
 * verbatim as a canned prompt through the composer's send path; there is no
 * separate "prompt text" — what's on the chip IS the message.
 */
export interface AgentSuggestionChipsProps {
  /** Send a canned prompt (same path as the composer's Send). */
  onSend: (text: string) => void;
  /** Disabled while a turn is in flight, matching the composer. */
  disabled: boolean;
}

/** Fixed Stage-1 set. Widen only via a future stage (see plan §5 open questions). */
const SUGGESTION_CHIPS: readonly string[] = [
  'Status update',
  'Triage the backlog',
  'Modify a workflow',
];

export function AgentSuggestionChips({ onSend, disabled }: AgentSuggestionChipsProps): React.ReactElement {
  return (
    <div data-testid="agent-suggestion-chips" className="flex flex-wrap justify-center gap-1.5">
      {SUGGESTION_CHIPS.map((chip, idx) => (
        <button
          key={chip}
          type="button"
          disabled={disabled}
          onClick={() => onSend(chip)}
          data-testid={`agent-suggestion-chip-${idx}`}
          className="border border-border-primary bg-surface-secondary px-2 py-1 text-[10px] text-text-secondary transition-colors hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {chip}
        </button>
      ))}
    </div>
  );
}
