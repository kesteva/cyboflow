/**
 * navigationStore tests — human-review center-pane flag.
 *
 * Regression guard for the bug where picking a project/session/run from the
 * rail while the human-review pane was open left the center stuck on the
 * review queue. The fix lifts `humanReviewOpen` into this store so the rail
 * handlers (DraggableProjectTreeView) can dismiss it via closeHumanReview().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../navigationStore';

function reset(): void {
  useNavigationStore.setState({
    activeView: 'sessions',
    activeProjectId: null,
    humanReviewOpen: false,
  });
}

describe('navigationStore — humanReviewOpen', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('openHumanReview / closeHumanReview set the flag', () => {
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);

    useNavigationStore.getState().closeHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('toggleHumanReview flips the flag', () => {
    const { toggleHumanReview } = useNavigationStore.getState();
    toggleHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    toggleHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('closeHumanReview is idempotent when already closed', () => {
    useNavigationStore.getState().closeHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('closeHumanReview leaves project navigation state untouched (rail-click contract)', () => {
    // Simulate the rail handler: a project is active and the review pane is open.
    useNavigationStore.getState().navigateToProject(42);
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);

    // Picking a project/session/run closes review without disturbing selection.
    useNavigationStore.getState().closeHumanReview();
    const state = useNavigationStore.getState();
    expect(state.humanReviewOpen).toBe(false);
    expect(state.activeProjectId).toBe(42);
    expect(state.activeView).toBe('project');
  });
});
