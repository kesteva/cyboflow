/**
 * guidedNavPause — Sidebar navigation during the in-shell guided steps parks
 * the tour; the tour's own navigation (tourNavigation) and bare
 * activeProjectId changes do not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { installGuidedNavPause, tourNavigation } from './guidedNavPause';
import { finishGuidedSetup, leaveGuidedSetup } from './guidedFinish';

let uninstall: (() => void) | null = null;

function activeAt(step: number): void {
  useOnboardingStore.setState({
    status: 'active',
    step,
    maxVisitedStep: step,
    hydrated: true,
    guidedProject: { id: 7, name: 'dogwalkr' },
  });
}

beforeEach(() => {
  localStorage.clear();
  useNavigationStore.setState({ view: 'home', humanReviewOpen: false, backlogOpen: false, activeProjectId: null });
  uninstall = installGuidedNavPause();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe('guidedNavPause', () => {
  it('parks the tour when the user navigates via the Sidebar on an in-shell step', () => {
    activeAt(9);
    useNavigationStore.getState().openBacklog();
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(9);
  });

  it('ignores navigation before step 9 (the shell is not on screen) and when not active', () => {
    activeAt(7);
    useNavigationStore.getState().openBacklog();
    expect(useOnboardingStore.getState().status).toBe('active');

    useOnboardingStore.setState({ status: 'completed', step: 12 });
    useNavigationStore.getState().openHumanReview();
    expect(useOnboardingStore.getState().status).toBe('completed');
  });

  it('ignores a bare activeProjectId change (tree auto-select, adoption)', () => {
    activeAt(10);
    useNavigationStore.getState().setActiveProjectId(7);
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('ignores navigation wrapped in tourNavigation', () => {
    activeAt(12);
    tourNavigation(() => useNavigationStore.getState().openHumanReview());
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('the finale and the park path navigate without tripping the pause', () => {
    activeAt(13);
    finishGuidedSetup({ id: 7, name: 'dogwalkr' }, { greet: false });
    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);

    activeAt(9);
    useNavigationStore.setState({ humanReviewOpen: false });
    leaveGuidedSetup({ id: 7, name: 'dogwalkr' }, { greet: false });
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(9);
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
  });
});
