/**
 * navigationStore tests — `experimentComparisonId` (A/B testing slice C).
 *
 * Mirrors the `workflowsOpen` mutual-exclusion suite: opening the comparison
 * overlay closes all four sibling overlays and forces the home view; every
 * sibling-open action / nav action clears `experimentComparisonId` in turn.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../navigationStore';

function reset(): void {
  useNavigationStore.setState({
    view: 'home',
    wizardOpts: null,
    activeView: 'sessions',
    activeProjectId: null,
    humanReviewOpen: false,
    backlogOpen: false,
    insightsOpen: false,
    workflowsOpen: false,
    experimentComparisonId: null,
  });
}

describe('navigationStore — experimentComparisonId', () => {
  beforeEach(reset);

  it('defaults to null', () => {
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();
  });

  it('openExperimentComparison sets the id and forces the home view', () => {
    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().openExperimentComparison('exp_1');
    const s = useNavigationStore.getState();
    expect(s.experimentComparisonId).toBe('exp_1');
    expect(s.view).toBe('home');
  });

  it('closeExperimentComparison clears the id', () => {
    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().closeExperimentComparison();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();
  });

  it('opening the comparison closes all four sibling overlays', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.setState({ backlogOpen: true, insightsOpen: true, workflowsOpen: true });
    useNavigationStore.getState().openExperimentComparison('exp_1');
    const s = useNavigationStore.getState();
    expect(s.experimentComparisonId).toBe('exp_1');
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
  });

  it('opening any sibling overlay closes the comparison (reverse exclusion)', () => {
    const open = (): void => {
      reset();
      useNavigationStore.getState().openExperimentComparison('exp_1');
      expect(useNavigationStore.getState().experimentComparisonId).toBe('exp_1');
    };

    open();
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().toggleHumanReview();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().toggleBacklog();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().openInsights();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().toggleInsights();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().openWorkflows();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    open();
    useNavigationStore.getState().toggleWorkflows();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();
  });

  it('goHome / goToWizard / goToSession all clear the comparison', () => {
    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().goHome();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().goToWizard();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();

    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().goToSession();
    expect(useNavigationStore.getState().experimentComparisonId).toBeNull();
  });

  it('navigateToProject / navigateToSessions clear the comparison (rail nav contract)', () => {
    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().navigateToProject(11);
    let s = useNavigationStore.getState();
    expect(s.experimentComparisonId).toBeNull();
    expect(s.activeProjectId).toBe(11);

    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().navigateToSessions();
    s = useNavigationStore.getState();
    expect(s.experimentComparisonId).toBeNull();
    expect(s.activeView).toBe('sessions');
  });

  it('closeExperimentComparison leaves project navigation state untouched', () => {
    useNavigationStore.getState().navigateToProject(42);
    useNavigationStore.getState().openExperimentComparison('exp_1');
    useNavigationStore.getState().closeExperimentComparison();
    const s = useNavigationStore.getState();
    expect(s.experimentComparisonId).toBeNull();
    expect(s.activeProjectId).toBe(42);
    expect(s.activeView).toBe('project');
  });
});
