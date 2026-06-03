/**
 * navigationStore tests — task-backlog center-pane flag + mutual exclusion with
 * the human-review pane (opening one closes the other so App never renders both).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../navigationStore';

function reset(): void {
  useNavigationStore.setState({
    activeView: 'sessions',
    activeProjectId: null,
    humanReviewOpen: false,
    backlogOpen: false,
  });
}

describe('navigationStore — backlogOpen', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('openBacklog / closeBacklog set the flag', () => {
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    useNavigationStore.getState().closeBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('toggleBacklog flips the flag', () => {
    const { toggleBacklog } = useNavigationStore.getState();
    toggleBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    toggleBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('opening the backlog closes human review (mutual exclusion)', () => {
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('opening human review closes the backlog (mutual exclusion)', () => {
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('toggleBacklog while human review is open swaps panes', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.getState().toggleBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('closeBacklog leaves project navigation state untouched (rail-click contract)', () => {
    useNavigationStore.getState().navigateToProject(42);
    useNavigationStore.getState().openBacklog();
    useNavigationStore.getState().closeBacklog();
    const state = useNavigationStore.getState();
    expect(state.backlogOpen).toBe(false);
    expect(state.activeProjectId).toBe(42);
    expect(state.activeView).toBe('project');
  });

  it('navigateToProject dismisses both center panes (rail nav clears the task view)', () => {
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    useNavigationStore.getState().navigateToProject(7);
    const s = useNavigationStore.getState();
    expect(s.backlogOpen).toBe(false);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.activeProjectId).toBe(7);
    expect(s.activeView).toBe('project');
  });

  it('navigateToSessions dismisses both center panes', () => {
    useNavigationStore.getState().openBacklog();
    useNavigationStore.getState().navigateToSessions();
    const s = useNavigationStore.getState();
    expect(s.backlogOpen).toBe(false);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.activeView).toBe('sessions');
  });
});
