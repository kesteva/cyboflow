import { useEffect } from 'react';
import type { Project } from '../../../types/project';
import { useConfigStore } from '../../../stores/configStore';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import {
  ONBOARDING_EVENTS,
  ONBOARDING_ADD_PROJECT_STEP,
  ONBOARDING_ASSISTANT_RAIL_STEP,
  ONBOARDING_FIRST_IDEA_STEP,
  ONBOARDING_FIRST_SESSION_STEP,
  ONBOARDING_IDEA_PROPOSALS_STEP,
  ONBOARDING_LAUNCHING_STEP,
  ONBOARDING_PROJECT_DETAIL_STEP,
  ONBOARDING_PROJECT_HOME_STEP,
} from '../../../utils/onboarding';
import { AddProjectChoice } from './AddProjectChoice';
import { AssistantRailStep } from './AssistantRailStep';
import { ExistingProjectPicker } from './ExistingProjectPicker';
import { FirstIdeaStep } from './FirstIdeaStep';
import { FirstSessionStep } from './FirstSessionStep';
import { IdeaProposalsStep } from './IdeaProposalsStep';
import { LaunchingStep } from './LaunchingStep';
import { NewProjectForm } from './NewProjectForm';
import { ProjectHomeStep } from './ProjectHomeStep';
import { SessionTypesPreviewStep } from './SessionTypesPreviewStep';
import {
  adoptProjectIntoTour,
  finishGuidedSetup,
  leaveGuidedSetup,
  openLaunchedSession,
  stageTourExit,
} from './guidedFinish';

/**
 * The onboarding tour's second phase: full-window guided set-up (steps 7-14).
 *
 * Unlike the modal steps (a body-portal card over a scrim, owned by
 * OnboardingGate) these screens render INSIDE the shell row, so the TitleBar's
 * native drag region keeps working above them. Two hosts mount this surface:
 *
 *  - Steps 7-8 (bare paper): App.tsx swaps the whole [sidebar | center | rail]
 *    row for a paper container holding only this surface. Step 7 asks which
 *    kind of project to start from; step 8 renders the screen that choice
 *    selected. 'unsure' skips step 8 (the store walks straight to 9 with
 *    `guidedProject` null). Step 8's create handler hands over to step 9 via
 *    guidedFinish.continueIntoShell.
 *  - Steps 9-14 (in the shell): App.tsx mounts the real shell — Sidebar
 *    (inert) beside this surface in the CENTRE slot, the AgentRail from step
 *    12 — see utils/onboarding.onboardingGuidedShell. With a project the
 *    screens render around `guidedProject` and every exit runs the finale
 *    (guidedFinish) onto Human review; "Skip the set-up" parks it instead
 *    (leaveGuidedSetup → Sidebar "Resume setup"). The Sidebar is clickable
 *    throughout — navigating through it parks the tour too
 *    (guidedNavPause). Without a project (the "Not sure yet" branch) the same
 *    steps render their no-project variants — "your projects
 *    will live here", "what do you want to get done with Cyboflow?", a
 *    read-only preview of the session types — and exit to LandingHome; step
 *    14 is never reached.
 *
 * Steps 10-12 need the global assistant: the surface stamps the Settings flag
 * onto the store (`assistantAvailable`) so next() steps over them when it is
 * off. Steps 10-11 host the REAL assistant thread in the centre (the same
 * store + transcript the rail renders), so the step-12 "it moved into the rail"
 * is literally the rail mounting over the same conversation.
 */
export function GuidedSetupSurface(): React.JSX.Element | null {
  const step = useOnboardingStore((s) => s.step);
  const maxVisitedStep = useOnboardingStore((s) => s.maxVisitedStep);
  const projectChoice = useOnboardingStore((s) => s.projectChoice);
  const setProjectChoice = useOnboardingStore((s) => s.setProjectChoice);
  const guidedProject = useOnboardingStore((s) => s.guidedProject);
  const launched = useOnboardingStore((s) => s.launched);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const skip = useOnboardingStore((s) => s.skip);
  const skipIdeas = useOnboardingStore((s) => s.skipIdeas);
  const sessionLaunched = useOnboardingStore((s) => s.sessionLaunched);
  const setAssistantAvailable = useOnboardingStore((s) => s.setAssistantAvailable);

  // Settings → Assistant. Absent config ⇒ enabled (matches App's rail gate).
  const assistantEnabled = useConfigStore((s) => s.config?.assistantEnabled !== false);
  useEffect(() => {
    setAssistantAvailable(assistantEnabled);
  }, [assistantEnabled, setAssistantAvailable]);

  // The rail greeting is for a rail that never held a conversation. Once step
  // 11 was reached the thread has real turns, so the in-shell exits skip it.
  const greet = maxVisitedStep < ONBOARDING_IDEA_PROPOSALS_STEP;
  const exitTour = (): void => finishGuidedSetup(guidedProject, { greet });
  // "Skip the set-up" parks the tour (Sidebar "Resume setup" card) instead.
  const leaveTour = (): void => leaveGuidedSetup(guidedProject, { greet });

  // The no-project branch: the Sidebar is clickable from step 9, and step 9's
  // first callout points at its Add Project button — when that lands, adopt the
  // project so the remaining screens switch to their with-project variants.
  const adopting = step >= ONBOARDING_PROJECT_HOME_STEP && guidedProject === null;
  useEffect(() => {
    if (!adopting) return;
    const onCreated = (event: Event): void => {
      const project = (event as CustomEvent<Project | undefined>).detail;
      if (project === undefined || project === null) return;
      adoptProjectIntoTour(project);
    };
    window.addEventListener(ONBOARDING_EVENTS.projectCreated, onCreated);
    return () => window.removeEventListener(ONBOARDING_EVENTS.projectCreated, onCreated);
  }, [adopting]);

  let screen: React.JSX.Element | null = null;
  if (step === ONBOARDING_ADD_PROJECT_STEP) {
    screen = (
      <AddProjectChoice
        value={projectChoice}
        onChange={setProjectChoice}
        onNext={next}
        onSkip={() => {
          stageTourExit(null);
          skip();
        }}
      />
    );
  } else if (step === ONBOARDING_PROJECT_DETAIL_STEP) {
    screen =
      projectChoice === 'new' ? (
        <NewProjectForm onBack={back} />
      ) : (
        <ExistingProjectPicker onBack={back} />
      );
  } else if (step === ONBOARDING_PROJECT_HOME_STEP) {
    screen = (
      <ProjectHomeStep
        projectName={guidedProject?.name ?? null}
        onContinue={next}
        onSkip={leaveTour}
      />
    );
  } else if (step === ONBOARDING_FIRST_IDEA_STEP) {
    screen = <FirstIdeaStep project={guidedProject} onSent={next} onSkip={skipIdeas} />;
  } else if (step === ONBOARDING_IDEA_PROPOSALS_STEP) {
    screen = <IdeaProposalsStep project={guidedProject} onContinue={next} onSkip={skipIdeas} />;
  } else if (step === ONBOARDING_ASSISTANT_RAIL_STEP) {
    screen = <AssistantRailStep onContinue={next} onSkip={leaveTour} />;
  } else if (step === ONBOARDING_FIRST_SESSION_STEP) {
    screen =
      guidedProject !== null ? (
        <FirstSessionStep
          project={guidedProject}
          onLaunched={sessionLaunched}
          onFinishWithoutLaunching={exitTour}
        />
      ) : (
        <SessionTypesPreviewStep onFinish={exitTour} />
      );
  } else if (step === ONBOARDING_LAUNCHING_STEP && guidedProject !== null && launched !== null) {
    screen = (
      <LaunchingStep
        projectId={guidedProject.id}
        projectName={guidedProject.name}
        launched={launched}
        onStay={exitTour}
        onOpenSession={() => openLaunchedSession(guidedProject, launched)}
      />
    );
  }

  if (screen === null) return null;

  return (
    // my-auto (not items-center) so a window shorter than the column scrolls
    // from the top instead of clipping the heading off-screen.
    <div
      data-testid="onboarding-guided"
      className="flex flex-1 justify-center overflow-y-auto p-10"
    >
      <div className="my-auto w-[620px] max-w-full">{screen}</div>
    </div>
  );
}
