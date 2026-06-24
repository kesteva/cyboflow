/**
 * CompoundingTray — the sticky footer of the triage surface: a cf-pulse status
 * dot, the pluralized selected-findings tally, and the "Run compounding session
 * (N) →" CTA that routes the human's EXACT selection into the start wizard.
 *
 * The CTA opens {@link useNavigationStore.goToWizard} preselecting the `compound`
 * flow and carrying the selected finding ids (`selectedFindingIds`) in stable
 * bucket order ({@link selectSelectedFindingIds}). Because a compound run is
 * single-project and the surface narrows to the selection's project the moment a
 * finding is checked, the selection ALWAYS has one project — so the CTA always
 * threads `lockProjectId` (the explicit `projectFilter` when the view is scoped,
 * else {@link selectLockProjectId} derived from the selection). With the project
 * pinned AND `compound` preselected, the wizard skips both the project and workflow
 * steps and opens straight on ③ Configure. Gated on having at least one project.
 */
import { Button } from '../ui/Button';
import {
  useInsightsStore,
  selectSelectedFindingIds,
  selectLockProjectId,
  selectTallyParts,
} from '../../stores/insightsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useProjectsCount } from '../../stores/landingStore';
import { pluralizeTally } from './findingsTagMeta';

/** CompoundingTray — see the file header. */
export function CompoundingTray(): React.JSX.Element | null {
  // The tally/CTA count off the raw set; the selection is single-project anyway
  // (selecting a finding locks the READY section to its project), so a project
  // filter here would be a no-op.
  const triageFindings = useInsightsStore((s) => s.triageFindings);
  // Gate on having at least one project — the wizard's first step is project
  // selection, so the CTA is pointless without one.
  const hasProjects = useProjectsCount() > 0;

  const tally = selectTallyParts(triageFindings);
  const n = tally.count;

  const handleRun = (): void => {
    const findings = useInsightsStore.getState().triageFindings;
    const ids = selectSelectedFindingIds(findings);
    // The selection is single-project (the surface locks to the selected finding's
    // project), so we can always pin the wizard's project — skipping the project
    // step. Prefer an explicit scoped `projectFilter`, else derive it from the
    // selection; both resolve to the same project when a finding is selected.
    const projectFilter = useInsightsStore.getState().projectFilter;
    const lockProjectId = projectFilter ?? selectLockProjectId(findings);
    useNavigationStore.getState().goToWizard({
      preselectWorkflowName: 'compound',
      selectedFindingIds: ids,
      ...(lockProjectId !== null ? { lockProjectId } : {}),
    });
  };

  if (!hasProjects) return null;

  return (
    <div
      className="sticky bottom-0 z-sticky -mx-1 mt-4 flex items-center gap-3 border-t border-border-primary bg-bg-secondary/95 px-1 py-2.5 backdrop-blur"
      data-testid="compounding-tray"
    >
      <span aria-hidden className="cf-pulse h-2 w-2 shrink-0 rounded-full bg-interactive" />
      <span className="text-xs tabular-nums text-text-secondary">{pluralizeTally(tally)}</span>
      <Button
        variant="primary"
        size="sm"
        disabled={n === 0}
        onClick={handleRun}
        data-testid="run-compounding-session"
        className="ml-auto"
      >
        Run compounding session ({n}) →
      </Button>
    </div>
  );
}
