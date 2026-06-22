/**
 * ModifyDrawer — the in-place re-tag / re-prioritize panel revealed below an
 * {@link UntriagedRow} when its Modify button is active (single-open invariant
 * owned by {@link FindingsSection}).
 *
 * Two labelled segmented-control rows:
 *   RE-TAG →   Quick fix / Documentation update / Task candidate
 *              (targets 'fix' / 'docs' / 'backlog' — the canonical re-bucketing).
 *   PRIORITY → P0 / P1 / P2.
 *
 * Both apply immediately (applied-not-consumed): clicking a segment fires the
 * matching callback, which the store applies optimistically + persists via the
 * reviewItems chokepoint. Re-tag/re-prioritize are untriaged-only (the backend
 * guards `staged_at IS NULL`); this drawer only ever opens for an untriaged row.
 *
 * Controls are BESPOKE square segmented buttons (NOT ui/Pill — rounded-full — and
 * NOT ui/Button, whose primary inverts to ink on hover). The slide-in is gated
 * behind prefers-reduced-motion via the motion-safe/motion-reduce variants.
 */
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { findingBucket, type FindingTagBucket } from '../../../../shared/types/reviews';
import type { FindingProposedTarget, FindingPriority } from '../../../../shared/types/reviews';
import { FINDING_PRIORITIES } from '../../../../shared/types/reviews';
import { BUCKET_LABEL, READY_BUCKETS } from './findingsTagMeta';

/**
 * The re-tag segments, in bucket render order — each maps a bucket back to the
 * canonical proposedTarget the chokepoint persists (quick→'fix', doc→'docs',
 * task→'backlog'). Keyed exhaustively so a new bucket breaks at compile time.
 */
const BUCKET_TO_TARGET: Record<FindingTagBucket, FindingProposedTarget> = {
  quick: 'fix',
  doc: 'docs',
  task: 'backlog',
};

const SEGMENT_BASE =
  'px-2 py-1 text-[10px] font-semibold uppercase tracking-wider border transition-colors duration-[120ms]';
const SEGMENT_IDLE =
  'bg-surface-primary text-text-secondary border-border-primary hover:border-border-emphasized';
const SEGMENT_ACTIVE = 'bg-interactive text-text-on-interactive border-interactive';

interface ModifyDrawerProps {
  /** The finding being modified — drives which segments read as active. */
  currentTarget: FindingProposedTarget | null;
  currentPriority: FindingPriority | null;
  onRetag: (target: FindingProposedTarget) => void;
  onReprioritize: (priority: FindingPriority) => void;
  /** Close the drawer (Done) — FindingsSection clears its openModifyId. */
  onClose: () => void;
}

/** A single bespoke square segmented-control button. */
function Segment({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(SEGMENT_BASE, active ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
    >
      {label}
    </button>
  );
}

/** ModifyDrawer — see the file header. Rendered only while open. */
export function ModifyDrawer({
  currentTarget,
  currentPriority,
  onRetag,
  onReprioritize,
  onClose,
}: ModifyDrawerProps): React.JSX.Element {
  // The active re-tag segment follows the canonical bucket the finding maps to so
  // an untagged finding highlights nothing fabricated (null folds to 'doc' for
  // display, but we compare on the explicit target so a null shows no active tag).
  const activeBucket: FindingTagBucket | null =
    currentTarget === null ? null : findingBucket(currentTarget);

  return (
    <div
      className="mt-2 border border-border-tertiary bg-bg-tertiary p-3 motion-safe:animate-[slideDown_120ms_ease-out]"
      data-testid="modify-drawer"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 eyebrow text-text-tertiary">Re-tag →</span>
        <div role="radiogroup" aria-label="Re-tag finding" className="flex gap-1.5">
          {READY_BUCKETS.map((bucket) => (
            <Segment
              key={bucket}
              active={activeBucket === bucket}
              label={BUCKET_LABEL[bucket]}
              onClick={() => onRetag(BUCKET_TO_TARGET[bucket])}
            />
          ))}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 eyebrow text-text-tertiary">Priority →</span>
        <div role="radiogroup" aria-label="Re-prioritize finding" className="flex gap-1.5">
          {FINDING_PRIORITIES.map((priority) => (
            <Segment
              key={priority}
              active={currentPriority === priority}
              label={priority}
              onClick={() => onReprioritize(priority)}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="ml-auto"
          data-testid="modify-drawer-done"
        >
          Done
        </Button>
      </div>
    </div>
  );
}
