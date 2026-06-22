/**
 * ReadyBucket — one bucket (Quick fix / Documentation update / Task candidate) in
 * the READY-to-compound section: a tri-state header checkbox + swatch + label +
 * `selected/total` count, over the bucket's visible {@link ReadyRow}s.
 *
 * The header checkbox is BESPOKE (role="checkbox" + aria-checked, square — ui/
 * Checkbox is rounded + label-bound) and TRI-STATE: checked when every row in the
 * bucket is selected, indeterminate (aria-checked="mixed") when only some are.
 * Toggling it selects/deselects the WHOLE bucket. The `total` (full count) comes
 * from the raw bucket, NOT the visible (budget-allocated) slice.
 */
import { cn } from '../../utils/cn';
import { ReadyRow } from './ReadyRow';
import type { TriageFinding } from '../../stores/insightsStore';
import type { FindingTagBucket } from '../../../../shared/types/reviews';
import { BUCKET_LABEL, BUCKET_SWATCH, BUCKET_TEXT_CLASS } from './findingsTagMeta';

interface ReadyBucketProps {
  bucket: FindingTagBucket;
  /** The rows to render (already budget-allocated by the parent). */
  visibleRows: readonly TriageFinding[];
  /** Selected count over the FULL bucket (not just the visible slice). */
  selectedCount: number;
  /** Total count over the FULL bucket (raw, budget-independent). */
  fullCount: number;
  /** Toggle every row in this bucket (selected = the next state). */
  onToggleBucket: (selected: boolean) => void;
  /** Toggle one row's selection. */
  onToggleRow: (finding: TriageFinding) => void;
}

/** ReadyBucket — see the file header. */
export function ReadyBucket({
  bucket,
  visibleRows,
  selectedCount,
  fullCount,
  onToggleBucket,
  onToggleRow,
}: ReadyBucketProps): React.JSX.Element {
  const allSelected = fullCount > 0 && selectedCount === fullCount;
  const indeterminate = selectedCount > 0 && selectedCount < fullCount;

  return (
    <div className="mt-2" data-testid={`ready-bucket-${bucket}`}>
      <div className="flex items-center gap-2 border-b border-border-tertiary py-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={indeterminate ? 'mixed' : allSelected}
          aria-label={`Select all ${BUCKET_LABEL[bucket]}`}
          onClick={() => onToggleBucket(!allSelected)}
          data-testid={`ready-bucket-checkbox-${bucket}`}
          className={cn(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
            allSelected || indeterminate ? 'border-interactive bg-interactive text-text-on-interactive' : 'border-border-primary',
          )}
        >
          {allSelected && (
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M2.5 6.5 5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {indeterminate && <span aria-hidden className="h-px w-2 bg-current" />}
        </button>
        <span
          aria-hidden
          className="shrink-0"
          style={{ width: 8, height: 8, background: BUCKET_SWATCH[bucket] }}
        />
        <span className={cn('text-xs font-semibold', BUCKET_TEXT_CLASS[bucket])}>
          {BUCKET_LABEL[bucket]}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-text-tertiary">
          {selectedCount}/{fullCount}
        </span>
      </div>

      {visibleRows.map((finding) => (
        <ReadyRow key={finding.id} finding={finding} onToggle={() => onToggleRow(finding)} />
      ))}
    </div>
  );
}
