/**
 * navigationStore tests: `agentsEnvOpen` / `agentsEnvTab` / `agentsEnvAgentId` (Agents & Environments pane).
 *
 * Mirrors the System-view suite: opening the pane closes every sibling overlay and forces home; every
 * sibling-open action and every navigation action clears `agentsEnvOpen` in turn. Settings is a modal and
 * neither clears nor is cleared by the pane.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useNavigationStore } from '../navigationStore';

const TAB_KEY = 'cyboflow.agentsEnv.tab';

function reset(): void {
  localStorage.clear();
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
    agentsEnvTab: 'agents',
    agentsEnvAgentId: null,
    settingsOpen: false,
  });
}

describe('navigationStore: agents & environments', () => {
  beforeEach(reset);

  it('defaults to closed with tab agents and no agent', () => {
    const s = useNavigationStore.getState();
    expect(s.agentsEnvOpen).toBe(false);
    expect(s.agentsEnvTab).toBe('agents');
    expect(s.agentsEnvAgentId).toBeNull();
  });

  it('openAgentsEnv forces home and closes every sibling', () => {
    useNavigationStore.setState({
      humanReviewOpen: true,
      backlogOpen: true,
      insightsOpen: true,
      workflowsOpen: true,
      experimentComparisonId: 'exp_1',
      verifyQueueOpen: true,
      systemOpen: true,
      projectOverviewOpen: true,
    });
    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().openAgentsEnv();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.agentsEnvOpen).toBe(true);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
    expect(s.insightsOpen).toBe(false);
    expect(s.workflowsOpen).toBe(false);
    expect(s.experimentComparisonId).toBeNull();
    expect(s.verifyQueueOpen).toBe(false);
    expect(s.systemOpen).toBe(false);
    expect(s.projectOverviewOpen).toBe(false);
  });

  it('toggleAgentsEnv opens then closes and clears the agent', () => {
    useNavigationStore.getState().toggleAgentsEnv();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(true);
    useNavigationStore.getState().selectPersistentAgent('a1');
    expect(useNavigationStore.getState().agentsEnvAgentId).toBe('a1');
    useNavigationStore.getState().toggleAgentsEnv();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(false);
    expect(useNavigationStore.getState().agentsEnvAgentId).toBeNull();
  });

  it('openAgentsEnv({agentId}) forces the agents tab', () => {
    useNavigationStore.getState().setAgentsEnvTab('environments');
    useNavigationStore.getState().openAgentsEnv({ agentId: 'a1' });
    const s = useNavigationStore.getState();
    expect(s.agentsEnvTab).toBe('agents');
    expect(s.agentsEnvAgentId).toBe('a1');
  });

  it('openAgentsEnv() without an agent lands on the card list and keeps the tab', () => {
    useNavigationStore.getState().setAgentsEnvTab('environments');
    useNavigationStore.getState().openAgentsEnv({ agentId: 'a1' });
    useNavigationStore.getState().closeAgentsEnv();
    useNavigationStore.getState().openAgentsEnv();
    const s = useNavigationStore.getState();
    expect(s.agentsEnvAgentId).toBeNull();
    expect(s.agentsEnvTab).toBe('agents');
  });

  it('setAgentsEnvTab persists and clears the agent for environments', () => {
    useNavigationStore.getState().selectPersistentAgent('a1');
    useNavigationStore.getState().setAgentsEnvTab('environments');
    expect(localStorage.getItem(TAB_KEY)).toBe('environments');
    expect(useNavigationStore.getState().agentsEnvAgentId).toBeNull();
    useNavigationStore.getState().selectPersistentAgent('a2');
    useNavigationStore.getState().setAgentsEnvTab('agents');
    expect(useNavigationStore.getState().agentsEnvAgentId).toBe('a2');
  });

  it('reads the tab from localStorage at module init', async () => {
    localStorage.setItem(TAB_KEY, 'environments');
    vi.resetModules();
    let mod = await import('../navigationStore');
    expect(mod.useNavigationStore.getState().agentsEnvTab).toBe('environments');

    localStorage.setItem(TAB_KEY, 'garbage');
    vi.resetModules();
    mod = await import('../navigationStore');
    expect(mod.useNavigationStore.getState().agentsEnvTab).toBe('agents');

    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      vi.resetModules();
      mod = await import('../navigationStore');
      expect(mod.useNavigationStore.getState().agentsEnvTab).toBe('agents');
    } finally {
      spy.mockRestore();
    }
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
    ['openSystem', () => useNavigationStore.getState().openSystem()],
    ['toggleSystem', () => useNavigationStore.getState().toggleSystem()],
    ['openProjectOverview', () => useNavigationStore.getState().openProjectOverview()],
    ['toggleProjectOverview', () => useNavigationStore.getState().toggleProjectOverview()],
    ['openExperimentComparison', () => useNavigationStore.getState().openExperimentComparison('exp_1')],
    ['goHome', () => useNavigationStore.getState().goHome()],
    ['goToWizard', () => useNavigationStore.getState().goToWizard()],
    ['goToSession', () => useNavigationStore.getState().goToSession()],
    ['navigateToProject', () => useNavigationStore.getState().navigateToProject(7)],
    ['navigateToSessions', () => useNavigationStore.getState().navigateToSessions()],
  ];

  it.each(clearers)('%s clears agentsEnvOpen', (_name, act) => {
    useNavigationStore.getState().openAgentsEnv();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(true);
    act();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(false);
  });

  it('close actions of other panes do not touch agentsEnvOpen', () => {
    useNavigationStore.getState().openAgentsEnv();
    useNavigationStore.getState().closeSystem();
    useNavigationStore.getState().closeBacklog();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(true);
  });

  it('opening Settings does not clear the pane', () => {
    useNavigationStore.getState().openAgentsEnv();
    useNavigationStore.getState().openSettings('integrations');
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(true);
  });
});
