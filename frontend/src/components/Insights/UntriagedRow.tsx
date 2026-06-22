/**
 * UntriagedRow — one untriaged finding in the triage list: a severity dot,
 * priority badge, title + meta line, and the Approve / Modify / Dismiss actions,
 * with the {@link ModifyDrawer} revealed below when this row's Modify is active.
 *
 * Action styling (per the design + paper-theme caveats):
 *   Approve — BESPOKE rust button (`--terracotta` → `--terracotta-deep` on hover,
 *             120ms). The ui/Button `primary` is NOT used: on the paper theme its
 *             hover resolves to ink (#1a1815), inverting rust→dark, at 150ms.
 *   Modify  — ui/Button variant="secondary" size="sm" (outline).
 *   Dismiss — ui/Button variant="ghost" size="sm".
 *
 * The priority badge renders the explicit UNSET '—' for a null priority (never a
 * fabricated "P2"); the severity dot + tag dot/label + meta come from the pure
 * findingsTagMeta helpers.
 */
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { ModifyDrawer } from './ModifyDrawer';
import type { TriageFinding } from '../../stores/insightsStore';
import { findingBucket } from '../../../../shared/types/reviews';
import type { FindingProposedTarget, FindingPriority } from '../../../../shared/types/reviews';
import {
  BUCKET_LABEL,
  BUCKET_SWATCH,
  BUCKET_TEXT_CLASS,
  SEVERITY_DOT,
  composeUntriagedMeta,
  priorityBadge,
} from './findingsTagMeta';

interface UntriagedRowProps {
  finding: TriageFinding;
  /** Whether THIS row's modify drawer is open (single-open invariant). */
  modifyOpen: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  /** Toggle the modify drawer for this row (null closes; the row id opens). */
  onToggleModify: () => void;
  onRetag: (target: FindingProposedTarget) => void;
  onReprioritize: (priority: FindingPriority) => void;
  onCloseModify: () => void;
}

/** Lift the finding's proposedTarget from its payload (null when absent). */
function findingTarget(f: TriageFinding): FindingProposedTarget | null {
  const payload = f.payload;
  if (payload && payload.kind === 'finding' && payload.proposedTarget !== undefined) {
    return payload.proposedTarget;
  }
  return null;
}

/** UntriagedRow — see the file header. */
export function UntriagedRow({
  finding,
  modifyOpen,
  onApprove,
  onDismiss,
  onToggleModify,
  onRetag,
  onReprioritize,
  onCloseModify,
}: UntriagedRowProps): React.JSX.Element {
  const badge = priorityBadge(finding.priority);
  const target = findingTarget(finding);
  const bucket = findingBucket(target);
  // The severity dot color (default to info when severity is null on a finding).
  const severityColor = SEVERITY_DOT[finding.severity ?? 'info'];

  return (
    <div
      className="border-b border-border-primary px-1 py-3 transition-colors duration-[120ms] hover:bg-surface-hover"
      data-testid="untriaged-row"
      data-finding-id={finding.id}
      role="listitem"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="shrink-0 rounded-full"
          style={{ width: 7, height: 7, background: severityColor }}
        />
        <span
          className={cn(
            'shrink-0 rounded-badge border px-1.5 py-px text-[10px] font-bold tabular-nums',
            badge.class,
          )}
          data-testid="priority-badge"
        >
          {badge.label}
        </span>
        <span className="truncate text-sm font-semibold text-text-primary" title={finding.title}>
          {finding.title}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onApprove}
            data-testid="untriaged-approve"
            className="bg-[var(--terracotta)] px-button-x-sm py-button-y-sm text-sm font-medium text-text-on-interactive transition-colors duration-[120ms] hover:bg-[var(--terracotta-deep)]"
          >
            Approve
          </button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleModify}
            aria-expanded={modifyOpen}
            data-testid="untriaged-modify"
          >
            Modify
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss} data-testid="untriaged-dismiss">
            Dismiss
          </Button>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-tertiary">
        <span
          aria-hidden
          className="shrink-0 rounded-full"
          style={{ width: 6, height: 6, background: BUCKET_SWATCH[bucket] }}
        />
        <span className={cn('shrink-0', BUCKET_TEXT_CLASS[bucket])}>{BUCKET_LABEL[bucket]}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{composeUntriagedMeta(finding)}</span>
      </div>

      {modifyOpen && (
        <ModifyDrawer
          currentTarget={target}
          currentPriority={finding.priority}
          onRetag={onRetag}
          onReprioritize={onReprioritize}
          onClose={onCloseModify}
        />
      )}
    </div>
  );
}
