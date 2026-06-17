/**
 * NewAgentCard — the dashed "+ New agent" entry-point card that trails the
 * Agents grid. The agent variant of {@link NewWorkflowCard}; a touch shorter
 * (no fixed min-height) to sit in the denser 4-up agent grid, matching the
 * design reference's `.GB-new` agent variant.
 *
 * The click handler is wired in the editor integration; for now the caller
 * passes a thin `onClick` (TODO no-op) so render never crashes.
 */
export interface NewAgentCardProps {
  /** Invoked when the card is activated. Wired to the agent editor in P4. */
  onClick?: () => void;
}

/** NewAgentCard — see the file header. */
export function NewAgentCard({ onClick }: NewAgentCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="new-agent-card"
      className="flex flex-col items-center justify-center gap-2.5 border border-dashed border-text-tertiary bg-transparent p-5 text-center text-text-secondary transition-colors hover:border-text-primary hover:bg-surface-primary hover:text-text-primary"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full border-[1.5px] border-current text-xl leading-none">
        +
      </span>
      <span className="text-xs font-bold tracking-[0.02em]">New agent</span>
      <span className="max-w-[200px] text-[10.5px] leading-relaxed text-text-tertiary">
        Define a role, tools and instructions.
      </span>
    </button>
  );
}
