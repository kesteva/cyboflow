/**
 * CompoundingTray — the sticky footer of the triage surface: a cf-pulse status
 * dot, the pluralized selected-findings tally, and the "Run compounding session
 * (N) →" CTA that routes the human's EXACT selection into the start wizard.
 *
 * The CTA opens {@link useNavigationStore.goToWizard} preselecting the `compound`
 * flow and carrying the selected finding ids (`selectedFindingIds`); the wizard
 * still has the user pick substrate / permission / project before launch (D4). The
 * ids come from {@link selectSelectedFindingIds} in stable bucket order. When the
 * Insights view is scoped to a single project, that id is threaded as
 * `lockProjectId`; cross-project, the wizard's chosen project scopes the launch
 * (OD-4). Gated on having at least one project (the wizard's first step is project
 * selection).
 */
import { Button } from '../ui/Button';
import {
  useInsightsStore,
  selectSelectedFindingIds,
  selectTallyParts,
} from '../../stores/insightsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useProjectsCount } from '../../stores/landingStore';
import { pluralizeTally } from './findingsTagMeta';

/** CompoundingTray — see the file header. */
export function CompoundingTray(): React.JSX.Element | null {
  const triageFindings = useInsightsStore((s) => s.triageFindings);
  // Gate on having at least one project — the wizard's first step is project
  // selection, so the CTA is pointless without one.
  const hasProjects = useProjectsCount() > 0;

  const tally = selectTallyParts(triageFindings);
  const n = tally.count;

  const handleRun = (): void => {
    const ids = selectSelectedFindingIds(useInsightsStore.getState().triageFindings);
    const projectFilter = useInsightsStore.getState().projectFilter;
    useNavigationStore.getState().goToWizard({
      preselectWorkflowName: 'compound',
      selectedFindingIds: ids,
      ...(projectFilter !== null ? { lockProjectId: projectFilter } : {}),
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
