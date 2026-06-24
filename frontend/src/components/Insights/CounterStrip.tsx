/**
 * CounterStrip — the findings-scoped Pending / Resolved / Dismissed counter strip
 * that sits directly above the two triage sections.
 *
 * Findings-scoped (NOT whole-inbox): Pending is `triageFindings.length` — the total
 * pending findings the store fetched (the merge-gated, orphan-hidden set), matching
 * the UNFILTERED untriaged list the strip sits above — while Resolved/Dismissed are
 * derived client-side from the already-fetched `qualityFindings`, both via the
 * store's {@link selectFindingsCounters} selector. It is NOT narrowed by the
 * selection-locked project (that lock only filters the READY-to-compound section);
 * and the whole-inbox `reviewSummary.pendingByKind.finding` would over-count (it
 * includes orphaned/unmerged findings the list hides). Live via the store's
 * `onReviewItemChanged` subscription (+ the optimistic dismiss removal, which drops
 * the row from `triageFindings` and so decrements Pending).
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
  const triageFindings = useInsightsStore((s) => s.triageFindings);
  const qualityFindings = useInsightsStore((s) => s.qualityFindings);
  const { pending, resolved, dismissed } = selectFindingsCounters(triageFindings, qualityFindings);

  return (
    <div className="mt-3 flex gap-7" data-testid="findings-counter-strip">
      <CounterCell value={pending} label="pending" accentClass="text-interactive" />
      <CounterCell value={resolved} label="resolved" accentClass="text-status-success" />
      <CounterCell value={dismissed} label="dismissed" />
    </div>
  );
}
