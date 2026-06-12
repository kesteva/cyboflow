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
 *   3. The three-way mutual-exclusion invariant between the full-width center
 *      overlays (humanReviewOpen / backlogOpen / insightsOpen): opening any one
 *      closes the other two, and every nav action (goHome/goToWizard/goToSession/
 *      navigateToProject/navigateToSessions) clears all three so the center only
 *      ever hosts one overlay at a time.
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

describe('navigationStore — insightsOpen mutual exclusion', () => {
  beforeEach(reset);

  it('defaults to closed', () => {
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('openInsights / closeInsights set the flag and force home', () => {
    useNavigationStore.getState().goToSession();
    useNavigationStore.getState().openInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');

    useNavigationStore.getState().closeInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('toggleInsights flips the flag and forces home', () => {
    useNavigationStore.getState().goToWizard();
    useNavigationStore.getState().toggleInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(true);
    expect(useNavigationStore.getState().view).toBe('home');
    useNavigationStore.getState().toggleInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('opening insights closes human review AND the backlog', () => {
    useNavigationStore.getState().openHumanReview();
    useNavigationStore.setState({ backlogOpen: true });
    useNavigationStore.getState().openInsights();
    const s = useNavigationStore.getState();
    expect(s.insightsOpen).toBe(true);
    expect(s.humanReviewOpen).toBe(false);
    expect(s.backlogOpen).toBe(false);
  });

  it('opening human review closes insights (reverse exclusion)', () => {
    useNavigationStore.getState().openInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(true);
    useNavigationStore.getState().openHumanReview();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('opening the backlog closes insights (reverse exclusion)', () => {
    useNavigationStore.getState().openInsights();
    expect(useNavigationStore.getState().insightsOpen).toBe(true);
    useNavigationStore.getState().openBacklog();
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('toggling either sibling open while insights is up clears insights', () => {
    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().toggleHumanReview();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);

    reset();
    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().toggleBacklog();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('goHome / goToWizard / goToSession all clear insights', () => {
    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().goHome();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);

    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().goToWizard();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);

    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().goToSession();
    expect(useNavigationStore.getState().insightsOpen).toBe(false);
  });

  it('navigateToProject / navigateToSessions clear insights (rail nav contract)', () => {
    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().navigateToProject(11);
    let s = useNavigationStore.getState();
    expect(s.insightsOpen).toBe(false);
    expect(s.activeProjectId).toBe(11);
    expect(s.activeView).toBe('project');

    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().navigateToSessions();
    s = useNavigationStore.getState();
    expect(s.insightsOpen).toBe(false);
    expect(s.activeView).toBe('sessions');
  });

  it('closeInsights leaves project navigation state untouched (rail-click contract)', () => {
    useNavigationStore.getState().navigateToProject(42);
    useNavigationStore.getState().openInsights();
    useNavigationStore.getState().closeInsights();
    const s = useNavigationStore.getState();
    expect(s.insightsOpen).toBe(false);
    expect(s.activeProjectId).toBe(42);
    expect(s.activeView).toBe('project');
  });
});
