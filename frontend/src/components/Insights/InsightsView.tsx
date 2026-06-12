/**
 * InsightsView — the "Insights" center-pane surface (mockup sections 01–03).
 *
 * A single scrollable column that aggregates post-sprint debrief signals across
 * three sections, each driven by the cross-project {@link useInsightsStore}:
 *
 *   01 FINDINGS    — triage what the flows surfaced ({@link FindingsSection}).
 *   02 STATISTICS  — how each workflow is performing ({@link StatsSection}).
 *   03 CODE QUALITY — flagged / caught / found-after-merge ({@link CodeQualitySection}).
 *
 * Ownership split (matches BacklogPane / ReviewQueueView): this component owns
 * the layout shell + the section-index chips (which scroll-to their section) +
 * the one-shot `init()` on mount + the loading/error chrome. Each section reads
 * its own slice of the store directly, so InsightsView passes no data props.
 *
 * Init is idempotent (the store's first call fetches + subscribes); a remount
 * reuses the live subscription. The error banner is NON-FATAL — when the store
 * carries an `error` we keep rendering the (stale) sections beneath a warning
 * strip rather than blanking the surface.
 *
 * Design hex → EXISTING semantic tokens (styles/tokens/colors.css): the eyebrow
 * + numbered section chips use the shared `.eyebrow` utility (uppercase, wide
 * tracking, 10px) over the paper canvas, mirroring BacklogPane's header idiom.
 */
import { useEffect, useRef } from 'react';
import { useInsightsStore } from '../../stores/insightsStore';
import { FindingsSection } from './FindingsSection';
import { StatsSection } from './StatsSection';
import { CodeQualitySection } from './CodeQualitySection';

// ---------------------------------------------------------------------------
// Section index — the three numbered chips in the header. `anchor` matches the
// id stamped on each <section> so a chip click scrolls it into view.
// ---------------------------------------------------------------------------

interface SectionIndexEntry {
  /** Two-digit ordinal shown in the chip (mockup '01 FINDINGS'). */
  ordinal: string;
  label: string;
  /** The DOM id of the section the chip scrolls to. */
  anchor: string;
}

const SECTION_INDEX: readonly SectionIndexEntry[] = [
  { ordinal: '01', label: 'Findings', anchor: 'insights-findings' },
  { ordinal: '02', label: 'Statistics', anchor: 'insights-statistics' },
  { ordinal: '03', label: 'Code quality', anchor: 'insights-code-quality' },
];

/**
 * The numbered chip row. Each chip scrolls its target section into view via the
 * shared scroll container ref (so we scroll the column, not the document).
 */
function SectionIndex({
  onScrollTo,
}: {
  onScrollTo: (anchor: string) => void;
}): React.JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="insights-section-index">
      {SECTION_INDEX.map((entry) => (
        <button
          key={entry.anchor}
          type="button"
          onClick={() => onScrollTo(entry.anchor)}
          data-testid={`insights-index-${entry.anchor}`}
          className="inline-flex items-center gap-1.5 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
        >
          <span className="text-text-tertiary">{entry.ordinal}</span>
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** First-load skeleton — three placeholder blocks under the header. */
function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="insights-loading">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-28 w-full animate-pulse rounded-card border border-border-primary bg-bg-secondary"
        />
      ))}
    </div>
  );
}

/** InsightsView — see the file header. Named export, no props. */
export function InsightsView(): React.JSX.Element {
  const initialized = useInsightsStore((s) => s.initialized);
  const loading = useInsightsStore((s) => s.loading);
  const error = useInsightsStore((s) => s.error);

  // One-shot init on mount. The store's init is idempotent (first call fetches +
  // subscribes); a remount reuses the live subscription, so we do not unsubscribe.
  useEffect(() => {
    void useInsightsStore.getState().init();
  }, []);

  // Scroll the column (not the document) to a section. The container ref is the
  // scrollable column so chip clicks stay inside the pane.
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScrollTo = (anchor: string): void => {
    const container = scrollRef.current;
    if (container === null) return;
    const target = container.querySelector(`#${CSS.escape(anchor)}`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  // First load only: show the skeleton until the store has initialized. A
  // background refresh (loading && initialized) keeps the stale content.
  const showSkeleton = loading && !initialized;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary" data-testid="insights-view">
      <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div className="eyebrow text-text-tertiary">Continuous improvement · post-sprint debrief</div>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Insights</h2>
        <SectionIndex onScrollTo={handleScrollTo} />
      </div>

      {error !== null && (
        <div
          className="flex-shrink-0 border-b border-border-primary bg-status-warning/10 px-7 py-1.5 text-xs text-status-warning"
          role="alert"
          data-testid="insights-error"
        >
          Could not refresh insights ({error}). Showing the last loaded data.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-7 py-4 font-mono">
        <div className="mx-auto w-full max-w-[920px] space-y-10">
          {showSkeleton ? (
            <LoadingSkeleton />
          ) : (
            <>
              <section id="insights-findings">
                <FindingsSection />
              </section>
              <section id="insights-statistics">
                <StatsSection />
              </section>
              <section id="insights-code-quality">
                <CodeQualitySection />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
