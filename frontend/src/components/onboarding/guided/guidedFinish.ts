import type { Project } from '../../../types/project';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { expandAgentRail } from '../../agentRail/AgentRail';
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
 *     greeting; and `openHumanReview()` so the shell lands on the review queue
 *     rather than the generic home surface.
 *  3. `finish()` — flips the store to 'completed', which is what actually
 *     mounts the shell.
 *
 * `project === null` is the no-project finale (nothing to greet or navigate to):
 * rail expanded, tour completed, LandingHome's empty state.
 */
export function finishGuidedSetup(project: Project | null): void {
  expandAgentRail();
  if (project !== null) {
    primeAssistantGreeting(project.name);
    useNavigationStore.getState().openHumanReview();
  }
  useOnboardingStore.getState().finish();
}
