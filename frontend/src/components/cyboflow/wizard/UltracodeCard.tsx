/**
 * UltracodeCard — the featured "Ultracode" card shown in the wizard's workflow
 * step, alongside the quick-session card.
 *
 * Ultracode is NOT a structured workflow (no phases/steps): selecting it opens
 * an interactive PTY Claude Code session launched with the ultracode setting, so
 * Claude defaults to authoring/running dynamic background workflows. If the agent
 * fans work out, the live dynamic-workflow visualization lights up the canvas.
 *
 * Visually mirrors {@link QuickSessionCard} (cream card, terracotta border, dark
 * diagonal-hatch tab) with a distinct glyph + an `/ultracode` slash chip so it
 * reads as a peer of the workflow cards.
 */

interface UltracodeCardProps {
  selected: boolean;
  onSelect: () => void;
}

/** The dark diagonal-hatch tab fill — matches QuickSessionCard. */
const HATCH_TAB_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, #1a1815 0 7px, #3a3530 7px 14px)',
};

export function UltracodeCard({
  selected,
  onSelect,
}: UltracodeCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="ultracode-card"
      aria-pressed={selected}
      className={`flex w-full flex-col overflow-hidden border bg-bg-secondary text-left transition-colors ${
        selected ? 'border-2 border-interactive' : 'border border-interactive'
      }`}
    >
      {/* Dark diagonal-hatch tab */}
      <div className="h-2 w-full" style={HATCH_TAB_STYLE} aria-hidden="true" />

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">✦</span>
          <span
            className="text-text-primary"
            style={{ fontSize: '14px', fontWeight: 700 }}
          >
            Ultracode
          </span>
          <span className="ml-auto font-mono text-xs text-interactive">/ultracode</span>
        </div>
        <p className="text-xs text-text-secondary">
          Open an interactive session in ultracode mode — Claude fans work out as
          parallel background agents, surfaced live as a dynamic workflow.
        </p>
      </div>
    </button>
  );
}
