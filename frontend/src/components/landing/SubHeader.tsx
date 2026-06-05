/**
 * SubHeader — the fixed landing sub-header below the app chrome.
 *
 * Two modes, driven by the derived home state:
 *   - `reviews` — something is waiting on the user (highest-priority surface).
 *   - `none`    — nothing needs review; shows the working/idle split instead.
 *
 * Counts are passed in (derived by the composing LandingHome from the
 * aggregated review/run stores) so this leaf stays pure and presentational.
 */

export interface SubHeaderProps {
  /** Which header to render — the review queue or the all-clear summary. */
  mode: 'reviews' | 'none';
  /** Items waiting on the user (decision + human_task). */
  waitingCount: number;
  /** Subset of waiting items that block a sprint. */
  blockingCount: number;
  /** Runs currently making progress. */
  workingCount: number;
  /** Runs that are idle (no active/blocked run). */
  idleCount: number;
  /** True when work is in flight and nothing is idle. */
  allActive: boolean;
}

/** SubHeader is a fixed presentational band — see {@link SubHeaderProps}. */
export function SubHeader({
  mode,
  waitingCount,
  blockingCount,
  workingCount,
  idleCount,
  allActive,
}: SubHeaderProps) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-border-primary bg-bg-primary px-7 py-4 font-mono">
      {mode === 'reviews' ? (
        <>
          <div className="min-w-0">
            <div className="eyebrow mb-1 text-text-tertiary">Human review queue</div>
            <h2 className="text-[21px] font-bold leading-tight tracking-tight text-text-primary">
              <span className="tabular-nums text-interactive">{waitingCount}</span> waiting on you
            </h2>
          </div>
          <div className="shrink-0 text-right text-xs text-text-secondary">
            <span className="tabular-nums">{blockingCount}</span> blocking a sprint · grouped by type
          </div>
        </>
      ) : (
        <>
          <div className="min-w-0">
            <div className="eyebrow mb-1 text-text-tertiary">Nothing to review</div>
            <h2 className="text-[21px] font-bold leading-tight tracking-tight text-text-primary">
              {allActive ? 'All clear — for now' : 'Nothing needs your review'}
            </h2>
          </div>
          <div className="shrink-0 text-right text-xs text-text-secondary">
            <span className="tabular-nums">{workingCount}</span> working ·{' '}
            <span className="tabular-nums">{idleCount}</span> idle
          </div>
        </>
      )}
    </div>
  );
}
