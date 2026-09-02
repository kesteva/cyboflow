import { useOnboardingStore } from '../../../stores/onboardingStore';
import {
  ONBOARDING_ADD_PROJECT_STEP,
  ONBOARDING_PROJECT_DETAIL_STEP,
} from '../../../utils/onboarding';
import { AddProjectChoice } from './AddProjectChoice';
import { ExistingProjectPicker } from './ExistingProjectPicker';
import { NewProjectForm } from './NewProjectForm';

/**
 * The onboarding tour's second phase: full-window guided set-up.
 *
 * Unlike the modal steps (a body-portal card over a scrim, owned by
 * OnboardingGate) these screens render INSIDE the shell row — App.tsx swaps the
 * [sidebar | center | rail] row for a bare-paper container and mounts this —
 * so the TitleBar's native drag region keeps working above them.
 *
 * Step 7 asks which kind of project to start from; step 8 renders the screen
 * that choice selected. 'unsure' never reaches step 8 (the store completes the
 * tour from step 7's next()), so the branch here is a straight existing/new
 * split with 'existing' as the fallback.
 */
export function GuidedSetupSurface(): React.JSX.Element | null {
  const step = useOnboardingStore((s) => s.step);
  const projectChoice = useOnboardingStore((s) => s.projectChoice);
  const setProjectChoice = useOnboardingStore((s) => s.setProjectChoice);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const skip = useOnboardingStore((s) => s.skip);

  let screen: React.JSX.Element | null = null;
  if (step === ONBOARDING_ADD_PROJECT_STEP) {
    screen = (
      <AddProjectChoice
        value={projectChoice}
        onChange={setProjectChoice}
        onNext={next}
        onSkip={skip}
      />
    );
  } else if (step === ONBOARDING_PROJECT_DETAIL_STEP) {
    screen =
      projectChoice === 'new' ? (
        <NewProjectForm onBack={back} />
      ) : (
        <ExistingProjectPicker onBack={back} />
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
