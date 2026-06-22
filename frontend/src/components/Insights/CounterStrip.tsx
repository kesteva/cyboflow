/**
 * CounterStrip — the findings-scoped Pending / Resolved / Dismissed counter strip
 * that sits directly above the two triage sections.
 *
 * Findings-scoped (NOT whole-inbox): Pending comes from the store's
 * finding-scoped `pendingByKind.finding`, while Resolved/Dismissed are derived
 * client-side from the already-fetched `qualityFindings` — both via the store's
 * {@link selectFindingsCounters} selector. Placing the strip directly above the
 * sections that enumerate "what is pending" makes any inflation obvious, so the
 * whole-inbox `reviewSummary.pending/resolved/dismissed` would be wrong here. Live
 * via the store's `onReviewItemChanged` subscription (+ the optimistic dismiss
 * counter bump).
 */
import { useInsightsStore, selectFindingsCounters } from '../../stores/insightsStore';

/**
 * One labelled cell in the counter strip — a value-over-label stack. Kept tiny +
 * local; the strip is the only consumer.
 */
function CounterCell({
  value,
  label,
  accentClass = 'text-text-primary',
}: {
  value: number;
  label: string;
  accentClass?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col" data-testid={`findings-counter-${label}`}>
      <span className={`text-lg font-bold tabular-nums ${accentClass}`}>{value}</span>
      <span className="eyebrow text-text-tertiary">{label}</span>
    </div>
  );
}

/** The findings-scoped counter strip — see the file header. No props. */
export function CounterStrip(): React.JSX.Element {
  const qualityFindings = useInsightsStore((s) => s.qualityFindings);
  const reviewSummary = useInsightsStore((s) => s.reviewSummary);
  const { pending, resolved, dismissed } = selectFindingsCounters(qualityFindings, reviewSummary);

  return (
    <div className="mt-3 flex gap-7" data-testid="findings-counter-strip">
      <CounterCell value={pending} label="pending" accentClass="text-interactive" />
      <CounterCell value={resolved} label="resolved" accentClass="text-status-success" />
      <CounterCell value={dismissed} label="dismissed" />
    </div>
  );
}
