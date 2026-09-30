/**
 * navigationStore tests — `systemOpen` (System view).
 *
 * Mirrors the `verifyQueueOpen` / `projectOverviewOpen` mutual-exclusion
 * suites: opening System closes every sibling overlay, and every sibling-open
 * or navigation action clears `systemOpen` in turn.
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
  });
}

const st = () => useNavigationStore.getState();

describe('navigationStore — systemOpen', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(st().systemOpen).toBe(false);
  });

  it('openSystem / closeSystem set the flag and force home', () => {
    st().goToSession();
    st().openSystem();
    expect(st().systemOpen).toBe(true);
    expect(st().view).toBe('home');
    st().closeSystem();
    expect(st().systemOpen).toBe(false);
  });

  it('toggleSystem flips the flag and forces home', () => {
    st().goToWizard();
    st().toggleSystem();
    expect(st().systemOpen).toBe(true);
    expect(st().view).toBe('home');
    st().toggleSystem();
    expect(st().systemOpen).toBe(false);
  });

  it('opening System closes every sibling overlay', () => {
    useNavigationStore.setState({
      humanReviewOpen: true,
      backlogOpen: true,
      insightsOpen: true,
      workflowsOpen: true,
      experimentComparisonId: 'exp-1',
      verifyQueueOpen: true,
      projectOverviewOpen: true,
    });
    st().openSystem();
    const s = st();
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
    expect(s.experimentComparisonId).toBeNull();
    expect(s.verifyQueueOpen).toBe(false);
    expect(s.projectOverviewOpen).toBe(false);
  });

  const siblingOpeners: Array<[string, () => void]> = [
    ['openHumanReview', () => st().openHumanReview()],
    ['toggleHumanReview', () => st().toggleHumanReview()],
    ['openBacklog', () => st().openBacklog()],
    ['toggleBacklog', () => st().toggleBacklog()],
    ['openInsights', () => st().openInsights()],
    ['toggleInsights', () => st().toggleInsights()],
    ['openWorkflows', () => st().openWorkflows()],
    ['toggleWorkflows', () => st().toggleWorkflows()],
    ['openExperimentComparison', () => st().openExperimentComparison('exp-1')],
    ['openVerifyQueue', () => st().openVerifyQueue()],
    ['toggleVerifyQueue', () => st().toggleVerifyQueue()],
    ['openProjectOverview', () => st().openProjectOverview()],
    ['toggleProjectOverview', () => st().toggleProjectOverview()],
    ['goHome', () => st().goHome()],
    ['goToWizard', () => st().goToWizard()],
    ['goToSession', () => st().goToSession()],
    ['navigateToProject', () => st().navigateToProject(7)],
    ['navigateToSessions', () => st().navigateToSessions()],
  ];

  it.each(siblingOpeners)('%s clears systemOpen', (_name, act) => {
    st().openSystem();
    expect(st().systemOpen).toBe(true);
    act();
    expect(st().systemOpen).toBe(false);
  });
});
