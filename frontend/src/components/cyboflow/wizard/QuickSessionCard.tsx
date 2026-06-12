/**
 * QuickSessionCard — the featured "start a quick session" card shown above the
 * workflow list when the wizard was opened with `allowQuick`.
 *
 * Cream card with a terracotta border and a dark diagonal-hatch tab, a terminal
 * glyph, the title, and a one-line description of what a quick session is (no
 * structured workflow, no review steps). The CLI substrate (SDK vs Interactive
 * PTY) is chosen on the CONFIGURE step, so the card carries no substrate chip.
 * Selected → a stronger terracotta border.
 */

interface QuickSessionCardProps {
  selected: boolean;
  onSelect: () => void;
}

/** The dark diagonal-hatch tab fill (ink over a slightly lighter shade). */
const HATCH_TAB_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, #1a1815 0 7px, #3a3530 7px 14px)',
};

export function QuickSessionCard({
  selected,
  onSelect,
}: QuickSessionCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="quick-session-card"
      aria-pressed={selected}
      className={`flex w-full flex-col overflow-hidden border bg-bg-secondary text-left transition-colors ${
        selected ? 'border-2 border-interactive' : 'border border-interactive'
      }`}
    >
      {/* Dark diagonal-hatch tab */}
      <div className="h-2 w-full" style={HATCH_TAB_STYLE} aria-hidden="true" />

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">⌨</span>
          <span
            className="text-text-primary"
            style={{ fontSize: '14px', fontWeight: 700 }}
          >
            Start a quick session
          </span>
        </div>
        <p className="text-xs text-text-secondary">
          Open a Claude Code session and drive it yourself — no structured
          workflow, no review steps.
        </p>
      </div>
    </button>
  );
}
