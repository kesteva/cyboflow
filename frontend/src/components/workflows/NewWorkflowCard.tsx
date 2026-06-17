/**
 * NewWorkflowCard — the dashed "+ New workflow" entry-point card that trails the
 * Workflows grid. Mirrors the design reference's `.GB-new` block (dashed border,
 * centered circular plus glyph, label + helper line), re-created with repo
 * semantic tokens and square corners.
 *
 * The click handler is wired in P4 / the editor integration; for now the caller
 * passes a thin `onClick` (TODO no-op) so render never crashes.
 */
export interface NewWorkflowCardProps {
  /** Invoked when the card is activated. Wired to the create flow in P4. */
  onClick?: () => void;
}

/** NewWorkflowCard — see the file header. */
export function NewWorkflowCard({ onClick }: NewWorkflowCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="new-workflow-card"
      className="flex min-h-[218px] flex-col items-center justify-center gap-2.5 border border-dashed border-text-tertiary bg-transparent p-5 text-center text-text-secondary transition-colors hover:border-text-primary hover:bg-surface-primary hover:text-text-primary"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-current text-2xl leading-none">
        +
      </span>
      <span className="text-xs font-bold tracking-[0.02em]">New workflow</span>
      <span className="max-w-[200px] text-[10.5px] leading-relaxed text-text-tertiary">
        Start from a template or an empty blueprint canvas.
      </span>
    </button>
  );
}
