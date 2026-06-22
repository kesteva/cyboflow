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
 */
import {
  useInsightsStore,
  selectReadyBuckets,
  selectGreedyReadyRows,
} from '../../stores/insightsStore';
import { ReadyBucket } from './ReadyBucket';
import { READY_BUCKETS } from './findingsTagMeta';
import type { TriageFinding } from '../../stores/insightsStore';
import type { FindingTagBucket } from '../../../../shared/types/reviews';

/**
 * The project the section-level Select all / Deselect all forwards to. Cross-
 * project ready findings can span projects, so we forward each bucket-level action
 * with the right project; the global Select-all groups ids by project.
 */
function groupIdsByProject(rows: readonly TriageFinding[]): Map<number, string[]> {
  const byProject = new Map<number, string[]>();
  for (const row of rows) {
    const existing = byProject.get(row.project_id);
    if (existing) existing.push(row.id);
    else byProject.set(row.project_id, [row.id]);
  }
  return byProject;
}

/** ReadyToCompound — see the file header. */
export function ReadyToCompound(): React.JSX.Element {
  const triageFindings = useInsightsStore((s) => s.triageFindings);
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

  // The global Select all / Deselect all fans out per project (the cross-project
  // view mixes findings from several projects; each project's PQueue serializes).
  const handleSelectAll = (selected: boolean): void => {
    for (const projectId of groupIdsByProject(allReady).keys()) {
      void selectAllReady(projectId, selected);
    }
  };

  const handleToggleBucket = (bucket: FindingTagBucket, selected: boolean): void => {
    for (const projectId of groupIdsByProject(buckets[bucket]).keys()) {
      void selectBucket(projectId, bucket, selected);
    }
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
