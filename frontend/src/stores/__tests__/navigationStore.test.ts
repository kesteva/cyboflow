/**
 * navigationStore tests — center-pane view state machine + human-review flag.
 *
 * Two concerns:
 *   1. The `view` discriminant ('home' | 'wizard' | 'session') and its
 *      transitions (goHome / goToWizard / goToSession), including the rule that
 *      the rail-driven overlays + project/sessions nav force `view: 'home'` so
 *      the overlays only ever render over the home surface.
 *   2. Regression guard for the bug where picking a project/session/run from the
 *      rail while the human-review pane was open left the center stuck on the
 *      review queue (humanReviewOpen lifted into this store so the rail handlers
 *      in DraggableProjectTreeView can dismiss it via closeHumanReview()).
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
  });
}

describe('navigationStore — view state machine', () => {
  beforeEach(reset);

  it('defaults to the home view with no wizard opts', () => {
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.wizardOpts).toBeNull();
  });

  it('goToWizard stores opts, switches to wizard, and clears the overlays', () => {
    // Overlays open first so we can assert the wizard clears them.
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.getState().goToWizard({ lockProjectId: 3, allowQuick: true });
    const s = useNavigationStore.getState();
    expect(s.view).toBe('wizard');
    expect(s.wizardOpts).toEqual({ lockProjectId: 3, allowQuick: true });
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
  });

  it('goToWizard() with no args stores an empty opts object', () => {
    useNavigationStore.getState().goToWizard();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('wizard');
    expect(s.wizardOpts).toEqual({});
  });

  it('goHome resets the view, clears wizard opts, and closes both overlays', () => {
    useNavigationStore.getState().goToWizard({ lockProjectId: 9 });
    useNavigationStore.setState({ humanReviewOpen: true, backlogOpen: true });
    useNavigationStore.getState().goHome();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.wizardOpts).toBeNull();
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
  });

  it('goToSession switches to the session view and clears the overlays', () => {
    useNavigationStore.getState().openBacklog();
    useNavigationStore.getState().goToSession();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('session');
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
  });

  it('toggleHumanReview forces the home view', () => {
    useNavigationStore.getState().goToSession();
    expect(useNavigationStore.getState().view).toBe('session');
    useNavigationStore.getState().toggleHumanReview();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.humanReviewOpen).toBe(true);
  });

  it('openBacklog / toggleBacklog force the home view', () => {
    useNavigationStore.getState().goToWizard();
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().view).toBe('home');

    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().toggleBacklog();
    expect(useNavigationStore.getState().view).toBe('home');
  });

  it('navigateToProject forces home, sets the project, and clears overlays', () => {
    useNavigationStore.getState().goToWizard({ lockProjectId: 1 });
    useNavigationStore.setState({ humanReviewOpen: true, backlogOpen: true });
    useNavigationStore.getState().navigateToProject(5);
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.activeView).toBe('project');
    expect(s.activeProjectId).toBe(5);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
  });

  it('navigateToSessions forces home and clears overlays', () => {
    useNavigationStore.getState().goToSession();
    useNavigationStore.setState({ backlogOpen: true });
    useNavigationStore.getState().navigateToSessions();
    const s = useNavigationStore.getState();
    expect(s.view).toBe('home');
    expect(s.activeView).toBe('sessions');
    expect(s.activeProjectId).toBeNull();
    expect(s.backlogOpen).toBe(false);
  });
});

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
