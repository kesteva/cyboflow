/**
 * FindingsSection — Insights mockup section 01.
 *
 * "01 FINDINGS — triage what the flows surfaced." Surfaces the pending
 * `kind='finding'` review items so they can be triaged in-place, alongside a
 * counter strip derived from the cross-project review summary (pending /
 * resolved / dismissed counts of the whole inbox).
 *
 * Card reuse: the pending findings render through the SAME {@link ReviewItemCard}
 * the review queue uses, so triage actions (Dismiss / Promote to task) route
 * through the existing review-item chokepoint. On a successful triage the card
 * fires `onResolved`, which refreshes the store so the finding leaves the list
 * and the counter strip re-derives.
 *
 * Empty state mirrors the review-queue copy: findings only appear here once a
 * Sprint agent reports one via `cyboflow_report_finding` during a run.
 *
 * Header CTA: a "Run compounding session" button starts the center-pane start
 * wizard ({@link useNavigationStore.goToWizard}) with `preselectWorkflowName:
 * 'compound'`, so the wizard preselects the built-in compound flow and
 * auto-advances to ③ Configure (dropping the user straight into a `/compound`
 * launch). When the Insights view is scoped to a single project (the store's
 * `projectFilter` is set), that project id is threaded as `lockProjectId` so the
 * wizard opens directly on the workflow step. The CTA is hidden until at least
 * one project exists, since the wizard's first step is project selection.
 */
import { useInsightsStore } from '../../stores/insightsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useProjectsCount } from '../../stores/landingStore';
import { ReviewItemCard } from '../ReviewQueue/ReviewItemCard';

/**
 * One labelled cell in the counter strip. Kept tiny + local — the strip is the
 * only consumer and the markup is a value-over-label stack.
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

export function FindingsSection(): React.JSX.Element {
  const reviewSummary = useInsightsStore((s) => s.reviewSummary);
  const pendingFindings = useInsightsStore((s) => s.pendingFindings);
  const refresh = useInsightsStore((s) => s.refresh);
  // Gate the "Run compounding session" CTA on having at least one project — the
  // wizard's first step is project selection, so it is pointless without one.
  const hasProjects = useProjectsCount() > 0;

  return (
    <div data-testid="findings-section">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border-primary pb-2">
        <span className="eyebrow text-text-tertiary">01 Findings</span>
        <span className="text-xs text-text-secondary">— triage what the flows surfaced</span>
        {hasProjects && (
          <button
            type="button"
            onClick={() => {
              const projectFilter = useInsightsStore.getState().projectFilter;
              useNavigationStore.getState().goToWizard({
                preselectWorkflowName: 'compound',
                ...(projectFilter !== null ? { lockProjectId: projectFilter } : {}),
              });
            }}
            data-testid="run-compounding-session"
            className="ml-auto bg-interactive px-3 py-1 font-mono text-xs uppercase tracking-wider text-text-on-interactive hover:bg-interactive-hover"
          >
            Run compounding session
          </button>
        )}
      </header>

      {/* Counter strip — whole-inbox triage state (pending / resolved / dismissed). */}
      <div className="mt-3 flex gap-7" data-testid="findings-counter-strip">
        <CounterCell value={reviewSummary?.pending ?? 0} label="pending" accentClass="text-interactive" />
        <CounterCell value={reviewSummary?.resolved ?? 0} label="resolved" accentClass="text-status-success" />
        <CounterCell value={reviewSummary?.dismissed ?? 0} label="dismissed" />
      </div>

      <div className="mt-4" role="list">
        {pendingFindings.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted" data-testid="findings-empty">
            No pending findings — agents report them via cyboflow_report_finding during runs.
          </p>
        ) : (
          pendingFindings.map((item) => (
            <ReviewItemCard key={item.id} item={item} onResolved={() => void refresh()} />
          ))
        )}
      </div>
    </div>
  );
}
