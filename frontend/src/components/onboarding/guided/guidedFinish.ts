import type { Project } from '../../../types/project';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { expandAgentRail } from '../../agentRail/railCollapsed';
import { primeAssistantGreeting } from '../../agentRail/onboardingGreeting';

/**
 * The guided set-up's terminal side effects, in the ONE order that works.
 *
 * The app shell is unmounted while the tour is active (App.tsx swaps it for the
 * onboarding surface), so everything the post-tour shell should come up with
 * has to be staged BEFORE the `completed` transition mounts it:
 *
 *  1. `expandAgentRail()` — AgentRail's collapse state is a localStorage-seeded
 *     useState initializer, read on the mount that step 3 triggers.
 *  2. `primeAssistantGreeting(name)` — same story for AgentThreadView's one-shot
 *     greeting (both via stageTourExit); `setActiveProjectId(project.id)` BEFORE `openHumanReview()`,
 *     because the project tree's mount-time load auto-selects the first project
 *     via `navigateToProject` whenever no project is active — and that opens the
 *     project OVERVIEW, which would override the review queue we just asked
 *     for. Stamping the id first makes that auto-select a no-op.
 *  3. `finish()` — flips the store to 'completed', which is what actually
 *     mounts the shell.
 *
 * `project === null` is the no-project finale (nothing to navigate to): rail
 * expanded with the generic greeting, tour completed, LandingHome's empty state.
 */
/**
 * The side effects EVERY tour exit shares — the rail opens with a greeting
 * whether the user added a project, said "Not sure yet", skipped the guided
 * set-up, or finished at the handoff card. Must run BEFORE the store
 * transition that mounts the shell (see finishGuidedSetup); the store itself
 * stays pure, so each exit's call site stages this, then transitions.
 */
export function stageTourExit(projectName: string | null): void {
  expandAgentRail();
  primeAssistantGreeting(projectName);
}

export function finishGuidedSetup(project: Project | null): void {
  stageTourExit(project?.name ?? null);
  if (project !== null) {
    const nav = useNavigationStore.getState();
    nav.setActiveProjectId(project.id);
    nav.openHumanReview();
  }
  useOnboardingStore.getState().finish();
}
