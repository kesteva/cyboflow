/**
 * guidedNavPause — from step 9 on the Sidebar beside the guided column is
 * CLICKABLE. When the user navigates through it (Human review, the backlog, a
 * project row, a session…) the tour parks itself ('skipped', resumable from the
 * Sidebar "Resume setup" card) so the centre can show what they asked for.
 *
 * Detection is a navigationStore subscription over the fields a Sidebar click
 * changes. Two kinds of navigation must NOT park the tour:
 *  - the tour's own (the finale opening Human review, step 8 stamping the
 *    active project) — those run inside {@link tourNavigation};
 *  - `activeProjectId` alone (the project tree's mount-time auto-select, the
 *    no-project branch adopting a freshly created project) — not watched.
 * Settings is a modal over everything, so it is not watched either.
 */
import { useNavigationStore, type NavigationState } from '../../../stores/navigationStore';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { ONBOARDING_PROJECT_HOME_STEP } from '../../../utils/onboarding';

const WATCHED: ReadonlyArray<keyof NavigationState> = [
  'view',
  'humanReviewOpen',
  'backlogOpen',
  'insightsOpen',
  'workflowsOpen',
  'experimentComparisonId',
  'verifyQueueOpen',
  'projectOverviewOpen',
  'wizardOpts',
];

let tourDriven = 0;

/** Run `fn` with its navigation changes exempt from the pause. */
export function tourNavigation<T>(fn: () => T): T {
  tourDriven++;
  try {
    return fn();
  } finally {
    tourDriven--;
  }
}

/** True when a Sidebar-driven navigation should park the tour right now. */
export function shouldPauseForNavigation(next: NavigationState, prev: NavigationState): boolean {
  if (tourDriven > 0) return false;
  const o = useOnboardingStore.getState();
  if (!o.hydrated || o.status !== 'active' || o.step < ONBOARDING_PROJECT_HOME_STEP) return false;
  return WATCHED.some((k) => next[k] !== prev[k]);
}

/** Subscribe; returns the unsubscribe. Mounted once by App. */
export function installGuidedNavPause(): () => void {
  return useNavigationStore.subscribe((next, prev) => {
    if (shouldPauseForNavigation(next, prev)) useOnboardingStore.getState().skip();
  });
}
