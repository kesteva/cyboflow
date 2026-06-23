/**
 * UntriagedList — the UNTRIAGED section of the triage surface: the untriaged
 * findings (newest-first, P0→P1→P2 tiebreak) capped at the top 5, with a
 * "Show N more untriaged" / "Collapse" toggle, an empty state, and the
 * single-open-drawer invariant threaded down from {@link FindingsSection}.
 *
 * The list is project-scoped only at the action layer: each finding carries its
 * `project_id`, so the row actions forward the right project to the store (the
 * cross-project view mixes findings from several projects). The rendered set comes
 * from {@link useVisibleTriageFindings}, so once a finding is selected the list
 * narrows to that selection's project alongside the rest of the surface.
 */
import {
  useInsightsStore,
  useVisibleTriageFindings,
  selectUntriaged,
} from '../../stores/insightsStore';
import type { TriageFinding } from '../../stores/insightsStore';
import { UntriagedRow } from './UntriagedRow';
import type { FindingProposedTarget, FindingPriority } from '../../../../shared/types/reviews';

/** How many untriaged rows show before the "Show N more" toggle. */
const UNTRIAGED_TOP_N = 5;

/** Lift the finding's proposedTarget from its payload (null when absent). */
function findingTarget(f: TriageFinding): FindingProposedTarget | null {
  const payload = f.payload;
  if (payload && payload.kind === 'finding' && payload.proposedTarget !== undefined) {
    return payload.proposedTarget;
  }
  return null;
}

interface UntriagedListProps {
  /** The currently-open modify drawer's finding id (single-open), or null. */
  openModifyId: string | null;
  /** Open/close a row's modify drawer (null closes all). */
  onOpenModify: (id: string | null) => void;
}

/** UntriagedList — see the file header. */
export function UntriagedList({ openModifyId, onOpenModify }: UntriagedListProps): React.JSX.Element {
  const triageFindings = useVisibleTriageFindings();
  const expanded = useInsightsStore((s) => s.untriagedExpanded);
  const toggleExpand = useInsightsStore((s) => s.toggleUntriagedExpand);
  const approveFinding = useInsightsStore((s) => s.approveFinding);
  const dismissFinding = useInsightsStore((s) => s.dismissFinding);
  const setFindingTag = useInsightsStore((s) => s.setFindingTag);
  const setFindingPriority = useInsightsStore((s) => s.setFindingPriority);

  const untriaged = selectUntriaged(triageFindings);
  const visible = expanded ? untriaged : untriaged.slice(0, UNTRIAGED_TOP_N);
  const hiddenCount = untriaged.length - visible.length;

  // Approve handler with OD-3: an UNTAGGED finding (no proposedTarget) defaults to
  // the Quick fix bucket on approve. The store's bucketing folds a null target to
  // 'doc', so we explicitly tag it 'fix' first (applied-not-consumed, still
  // untriaged so the backend mutate guard passes) BEFORE staging it into READY.
  // A finding the human already tagged keeps that tag.
  const handleApprove = (finding: TriageFinding): void => {
    if (findingTarget(finding) === null) {
      void setFindingTag(finding.project_id, finding.id, 'fix');
    }
    void approveFinding(finding.project_id, finding.id);
  };

  return (
    <div className="mt-4" data-testid="untriaged-list">
      <div className="eyebrow mb-1 text-text-tertiary">Untriaged</div>

      {untriaged.length === 0 ? (
        <p
          className="py-8 text-center text-sm text-text-muted"
          data-testid="untriaged-empty"
        >
          Nothing to triage — agents report findings via cyboflow_report_finding during runs.
        </p>
      ) : (
        <div role="list">
          {visible.map((finding) => (
            <UntriagedRow
              key={finding.id}
              finding={finding}
              modifyOpen={openModifyId === finding.id}
              onApprove={() => handleApprove(finding)}
              onDismiss={() => void dismissFinding(finding.project_id, finding.id)}
              onToggleModify={() => onOpenModify(openModifyId === finding.id ? null : finding.id)}
              onRetag={(target: FindingProposedTarget) =>
                void setFindingTag(finding.project_id, finding.id, target)
              }
              onReprioritize={(priority: FindingPriority) =>
                void setFindingPriority(finding.project_id, finding.id, priority)
              }
              onCloseModify={() => onOpenModify(null)}
            />
          ))}

          {(hiddenCount > 0 || expanded) && (
            <button
              type="button"
              onClick={toggleExpand}
              data-testid="untriaged-toggle"
              className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-interactive transition-colors duration-[120ms] hover:text-interactive-active"
            >
              {expanded ? 'Collapse' : `Show ${hiddenCount} more untriaged`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
