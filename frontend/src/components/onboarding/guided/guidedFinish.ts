import type { Project } from '../../../types/project';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useOnboardingStore, type LaunchedSession } from '../../../stores/onboardingStore';
import { expandAgentRail } from '../../agentRail/railCollapsed';
import { primeAssistantGreeting } from '../../agentRail/onboardingGreeting';

/**
 * The guided set-up's terminal side effects, in the ONE order that works.
 *
 * Before step 9 the app shell is unmounted (App.tsx swaps it for the onboarding
 * surface), so everything the post-tour shell should come up with has to be
 * staged BEFORE the `completed` transition mounts it:
 *
 *  1. `expandAgentRail()` — AgentRail's collapse state is a localStorage-seeded
 *     useState initializer, read on the mount the transition triggers.
 *  2. `primeAssistantGreeting(name)` — same story for AgentThreadView's one-shot
 *     greeting; `setActiveProjectId(project.id)` BEFORE `openHumanReview()`,
 *     because the project tree's mount-time load auto-selects the first project
 *     via `navigateToProject` whenever no project is active — and that opens the
 *     project OVERVIEW, which would override the review queue we just asked
 *     for. Stamping the id first makes that auto-select a no-op.
 *  3. `finish()` — flips the store to 'completed', which is what actually
 *     mounts (or, from step 9 on, keeps) the shell.
 *
 * From step 9 on the shell is ALREADY mounted around the guided column, and from
 * step 11 on the assistant thread already holds a real conversation — so the
 * in-shell exits pass `greet: false`: a "dogwalkr is set up" greeting parked in
 * localStorage would otherwise surface on some later rail remount, out of
 * context. `expandAgentRail()` is harmless either way (the rail is open).
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

export interface FinishGuidedSetupOptions {
  /**
   * Park the one-shot rail greeting (default true). The in-shell screens that
   * already hosted the assistant conversation pass false — see the module doc.
   */
  greet?: boolean;
  /**
   * Skip the Human-review navigation (default false). Step 14's "Open the
   * session" navigates to the launched session itself before calling this.
   */
  keepView?: boolean;
}

export function finishGuidedSetup(
  project: Pick<Project, 'id' | 'name'> | null,
  opts: FinishGuidedSetupOptions = {},
): void {
  if (opts.greet ?? true) {
    stageTourExit(project?.name ?? null);
  } else {
    expandAgentRail();
  }
  if (project !== null) {
    const nav = useNavigationStore.getState();
    nav.setActiveProjectId(project.id);
    if (!opts.keepView) nav.openHumanReview();
  }
  useOnboardingStore.getState().finish();
}

/**
 * Step 8's success path: the project exists, the tour continues INTO the shell
 * (step 9 mounts the Sidebar beside the guided column). Stamps the active
 * project FIRST — the same auto-select hazard as the finale — then records the
 * project on the store, which is the step-9 transition.
 */
export function continueIntoShell(project: Pick<Project, 'id' | 'name'>): void {
  useNavigationStore.getState().setActiveProjectId(project.id);
  useOnboardingStore.getState().projectAdded({ id: project.id, name: project.name });
}

/**
 * Step 14's "Open the session →": select what step 13 launched so the centre
 * swaps to the session workspace — a flow run for planner/ship (the run is the
 * workspace, like LandingHome's openRunSession), the quick session itself for
 * 'quick' (like openQuickSession). Then the finale, keeping that view.
 */
export function openLaunchedSession(
  project: Pick<Project, 'id' | 'name'>,
  launched: LaunchedSession,
): void {
  const cyboflow = useCyboflowStore.getState();
  if (launched.runId !== null) {
    cyboflow.setActiveRun(launched.runId, launched.sessionId);
  } else {
    cyboflow.setActiveQuickSession(launched.sessionId, undefined);
  }
  const nav = useNavigationStore.getState();
  nav.setActiveProjectId(project.id);
  nav.goToSession();
  finishGuidedSetup(project, { greet: false, keepView: true });
}
