/**
 * FindingsHeader — the "01 Findings — triage what the flows surfaced" eyebrow row
 * for the triage section. Pure chrome: NO CTA (the compounding launch lives in the
 * sticky {@link CompoundingTray} at the bottom of the section, not here).
 */

/** The findings-section eyebrow + tagline. No props, no actions. */
export function FindingsHeader(): React.JSX.Element {
  return (
    <header
      className="flex flex-wrap items-baseline gap-2 border-b border-border-primary pb-2"
      data-testid="findings-header"
    >
      <span className="eyebrow text-text-tertiary">01 Findings</span>
      <span className="text-xs text-text-secondary">— triage what the flows surfaced</span>
    </header>
  );
}
