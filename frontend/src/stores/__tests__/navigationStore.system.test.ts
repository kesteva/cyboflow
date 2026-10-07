/**
 * navigationStore tests — `systemOpen` (System view).
 *
 * Mirrors the `verifyQueueOpen` / `projectOverviewOpen` mutual-exclusion suites:
 * opening the System view closes every sibling overlay and forces home; every
 * sibling-open action and every navigation action clears `systemOpen` in turn.
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
    systemOpen: false,
    projectOverviewOpen: false,
    agentsEnvOpen: false,
    agentsEnvAgentId: null,
  });
}

describe('navigationStore — systemOpen', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(useNavigationStore.getState().systemOpen).toBe(false);
  });

  it('openSystem / closeSystem set the flag and force home', () => {
    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().openSystem();
    expect(useNavigationStore.getState().systemOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');

    useNavigationStore.getState().closeSystem();
    expect(useNavigationStore.getState().systemOpen).toBe(false);
  });

  it('toggleSystem flips the flag and forces home', () => {
    useNavigationStore.getState().goToWizard();
    useNavigationStore.getState().toggleSystem();
    expect(useNavigationStore.getState().systemOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');
    useNavigationStore.getState().toggleSystem();
    expect(useNavigationStore.getState().systemOpen).toBe(false);
  });

  it.each(['openSystem', 'toggleSystem'] as const)('%s closes every sibling overlay', (action) => {
    useNavigationStore.setState({
      humanReviewOpen: true,
      backlogOpen: true,
      insightsOpen: true,
      workflowsOpen: true,
      experimentComparisonId: 'exp_1',
      verifyQueueOpen: true,
      projectOverviewOpen: true,
      agentsEnvOpen: true,
    });
    useNavigationStore.getState()[action]();
    const s = useNavigationStore.getState();
    expect(s.systemOpen).toBe(true);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
    expect(s.experimentComparisonId).toBeNull();
    expect(s.verifyQueueOpen).toBe(false);
    expect(s.projectOverviewOpen).toBe(false);
    expect(s.agentsEnvOpen).toBe(false);
  });

  const clearers: Array<[string, () => void]> = [
    ['openHumanReview', () => useNavigationStore.getState().openHumanReview()],
    ['toggleHumanReview', () => useNavigationStore.getState().toggleHumanReview()],
    ['openBacklog', () => useNavigationStore.getState().openBacklog()],
    ['toggleBacklog', () => useNavigationStore.getState().toggleBacklog()],
    ['openInsights', () => useNavigationStore.getState().openInsights()],
    ['toggleInsights', () => useNavigationStore.getState().toggleInsights()],
    ['openWorkflows', () => useNavigationStore.getState().openWorkflows()],
    ['toggleWorkflows', () => useNavigationStore.getState().toggleWorkflows()],
    ['openVerifyQueue', () => useNavigationStore.getState().openVerifyQueue()],
    ['toggleVerifyQueue', () => useNavigationStore.getState().toggleVerifyQueue()],
    ['openProjectOverview', () => useNavigationStore.getState().openProjectOverview()],
    ['toggleProjectOverview', () => useNavigationStore.getState().toggleProjectOverview()],
    ['openExperimentComparison', () => useNavigationStore.getState().openExperimentComparison('exp_1')],
    ['openAgentsEnv', () => useNavigationStore.getState().openAgentsEnv()],
    ['toggleAgentsEnv', () => useNavigationStore.getState().toggleAgentsEnv()],
    ['goHome', () => useNavigationStore.getState().goHome()],
    ['goToWizard', () => useNavigationStore.getState().goToWizard()],
    ['goToSession', () => useNavigationStore.getState().goToSession()],
    ['navigateToProject', () => useNavigationStore.getState().navigateToProject(7)],
    ['navigateToSessions', () => useNavigationStore.getState().navigateToSessions()],
  ];

  it.each(clearers)('%s clears systemOpen', (_name, act) => {
    useNavigationStore.getState().openSystem();
    expect(useNavigationStore.getState().systemOpen).toBe(true);
    act();
    expect(useNavigationStore.getState().systemOpen).toBe(false);
  });
});
