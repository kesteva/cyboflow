/**
 * navigationStore tests — `projectOverviewOpen` (Project Overview page).
 *
 * Mirrors the `workflowsOpen` / `experimentComparisonId` mutual-exclusion
 * suites: opening the overview closes every sibling overlay and forces the
 * home view; every sibling-open action / nav action clears
 * `projectOverviewOpen` in turn. The one asymmetry: `navigateToProject` SETS
 * `projectOverviewOpen` to true (rather than clearing it like every other
 * sibling) — that is the feature, clicking a project row now opens the
 * overview page instead of merely highlighting the row.
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
    verifyQueueOpen: false,
    projectOverviewOpen: false,
    agentsEnvOpen: false,
    agentsEnvAgentId: null,
  });
}

describe('navigationStore — projectOverviewOpen', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);
  });

  it('openProjectOverview / closeProjectOverview set the flag and force home', () => {
    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().openProjectOverview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');

    useNavigationStore.getState().closeProjectOverview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);
  });

  it('toggleProjectOverview flips the flag and forces home', () => {
    useNavigationStore.getState().goToWizard();
    useNavigationStore.getState().toggleProjectOverview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');
    useNavigationStore.getState().toggleProjectOverview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);
  });

  it('opening the project overview closes all six sibling overlays', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.setState({
      backlogOpen: true,
      insightsOpen: true,
      workflowsOpen: true,
      experimentComparisonId: 'exp_1',
      verifyQueueOpen: true,
      agentsEnvOpen: true,
    });
    useNavigationStore.getState().openProjectOverview();
    const s = useNavigationStore.getState();
    expect(s.projectOverviewOpen).toBe(true);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
    expect(s.experimentComparisonId).toBeNull();
    expect(s.verifyQueueOpen).toBe(false);
    expect(s.agentsEnvOpen).toBe(false);
  });

  it('opening/toggling any sibling overlay closes the project overview (reverse exclusion)', () => {
    const open = (): void => {
      reset();
      useNavigationStore.getState().openProjectOverview();
      expect(useNavigationStore.getState().projectOverviewOpen).toBe(true);
    };

    open();
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleHumanReview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleBacklog();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openInsights();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleInsights();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openWorkflows();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleWorkflows();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openVerifyQueue();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleVerifyQueue();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openExperimentComparison('exp_1');
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().openAgentsEnv();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    open();
    useNavigationStore.getState().toggleAgentsEnv();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);
  });

  it('toggleProjectOverview while a sibling is open swaps panes', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.getState().toggleProjectOverview();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(true);
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('goHome / goToWizard / goToSession all clear the project overview', () => {
    useNavigationStore.getState().openProjectOverview();
    useNavigationStore.getState().goHome();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    useNavigationStore.getState().openProjectOverview();
    useNavigationStore.getState().goToWizard();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);

    useNavigationStore.getState().openProjectOverview();
    useNavigationStore.getState().goToSession();
    expect(useNavigationStore.getState().projectOverviewOpen).toBe(false);
  });

  it('navigateToSessions clears the project overview (rail nav contract)', () => {
    useNavigationStore.getState().openProjectOverview();
    useNavigationStore.getState().navigateToSessions();
    const s = useNavigationStore.getState();
    expect(s.projectOverviewOpen).toBe(false);
    expect(s.activeView).toBe('sessions');
  });

  it('navigateToProject SETS projectOverviewOpen (the feature) alongside activeProjectId, and clears every other sibling', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.setState({
      backlogOpen: true,
      insightsOpen: true,
      workflowsOpen: true,
      experimentComparisonId: 'exp_1',
      verifyQueueOpen: true,
      agentsEnvOpen: true,
    });
    useNavigationStore.getState().navigateToProject(5);
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.activeView).toBe('project');
    expect(s.activeProjectId).toBe(5);
    expect(s.projectOverviewOpen).toBe(true);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
    expect(s.experimentComparisonId).toBeNull();
    expect(s.verifyQueueOpen).toBe(false);
    expect(s.agentsEnvOpen).toBe(false);
  });

  it('navigateToProject opens the overview even when nothing else was open', () => {
    useNavigationStore.getState().navigateToProject(9);
    const s = useNavigationStore.getState();
    expect(s.projectOverviewOpen).toBe(true);
    expect(s.activeProjectId).toBe(9);
  });

  it('closeProjectOverview leaves project navigation state untouched (rail-click contract)', () => {
    useNavigationStore.getState().navigateToProject(42);
    useNavigationStore.getState().closeProjectOverview();
    const s = useNavigationStore.getState();
    expect(s.projectOverviewOpen).toBe(false);
    expect(s.activeProjectId).toBe(42);
    expect(s.activeView).toBe('project');
  });
});
