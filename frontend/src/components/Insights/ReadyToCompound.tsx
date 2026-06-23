/**
 * ReadyToCompound — the READY-to-compound section: the approved findings, bucketed
 * (Quick fix / Documentation update / Task candidate), with a global Select all /
 * Deselect all, a greedy 5-row budget across buckets in fixed order, and ONE
 * section-level "Show N more" / "Collapse" toggle (no per-bucket toggle).
 *
 * The greedy allocation decides which rows render; a bucket whose rows were all
 * starved by the budget is hidden entirely, while PRESENT buckets still show their
 * FULL header counts (taken from the raw buckets, not the allocation). The
 * section-toggle is labelled with the exact hidden count.
 *
 * Selection is SINGLE-PROJECT: the rendered set is {@link useVisibleTriageFindings}
 * (narrowed to the selection's project once anything is selected), and Select all /
 * per-bucket selection target one project — the locked one, or the top finding's
 * project on the first cross-project pick — so the compound selection never spans
 * projects.
 */
import {
  useInsightsStore,
  useVisibleTriageFindings,
  selectReadyBuckets,
  selectGreedyReadyRows,
  selectLockProjectId,
} from '../../stores/insightsStore';
import { ReadyBucket } from './ReadyBucket';
import { READY_BUCKETS } from './findingsTagMeta';
import type { FindingTagBucket } from '../../../../shared/types/reviews';

/** ReadyToCompound — see the file header. */
export function ReadyToCompound(): React.JSX.Element {
  const triageFindings = useVisibleTriageFindings();
  const showAll = useInsightsStore((s) => s.readyShowAll);
  const toggleShowAll = useInsightsStore((s) => s.toggleReadyShowAll);
  const selectAllReady = useInsightsStore((s) => s.selectAllReady);
  const selectBucket = useInsightsStore((s) => s.selectBucket);
  const toggleFindingSelected = useInsightsStore((s) => s.toggleFindingSelected);

  const buckets = selectReadyBuckets(triageFindings);
  const allocation = selectGreedyReadyRows(buckets, showAll);

  const allReady = READY_BUCKETS.flatMap((bucket) => buckets[bucket]);
  const totalReady = allReady.length;
  const totalSelected = allReady.filter((f) => f.selected).length;
  const allSelected = totalReady > 0 && totalSelected === totalReady;

  // Bulk selection (Select all / per-bucket) must stay single-project: a compound
  // run is single-project, and selecting any finding narrows the surface to its
  // project. The target is the already-locked project (something selected) or — on
  // the first bulk pick from the cross-project view — the project of the top ready
  // finding (resp. the bucket's top finding). Once it fires, the surface filters to
  // that project and every later bulk action stays within it.
  const lockedProjectId = selectLockProjectId(triageFindings);

  const handleSelectAll = (selected: boolean): void => {
    const target = lockedProjectId ?? allReady[0]?.project_id ?? null;
    if (target === null) return;
    void selectAllReady(target, selected);
  };

  const handleToggleBucket = (bucket: FindingTagBucket, selected: boolean): void => {
    const target = lockedProjectId ?? buckets[bucket][0]?.project_id ?? null;
    if (target === null) return;
    void selectBucket(target, bucket, selected);
  };

  return (
    <div className="mt-6" data-testid="ready-to-compound">
      <div className="flex items-center gap-2">
        <div className="eyebrow text-text-tertiary">Ready to compound</div>
        {totalReady > 0 && (
          <button
            type="button"
            onClick={() => handleSelectAll(!allSelected)}
            data-testid="ready-select-all"
            className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-interactive transition-colors duration-[120ms] hover:text-interactive-active"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </div>

      {totalReady === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted" data-testid="ready-empty">
          Approve a finding to stage it for the next compounding session.
        </p>
      ) : (
        <>
          {READY_BUCKETS.filter((bucket) => allocation.visibleByBucket[bucket] !== undefined).map(
            (bucket) => (
              <ReadyBucket
                key={bucket}
                bucket={bucket}
                visibleRows={allocation.visibleByBucket[bucket] ?? []}
                selectedCount={buckets[bucket].filter((f) => f.selected).length}
                fullCount={buckets[bucket].length}
                onToggleBucket={(selected) => handleToggleBucket(bucket, selected)}
                onToggleRow={(finding) =>
                  void toggleFindingSelected(finding.project_id, finding.id)
                }
              />
            ),
          )}

          {(allocation.anyHidden || showAll) && (
            <button
              type="button"
              onClick={toggleShowAll}
              data-testid="ready-toggle"
              className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-interactive transition-colors duration-[120ms] hover:text-interactive-active"
            >
              {showAll ? 'Collapse' : `Show ${allocation.hiddenCount} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
