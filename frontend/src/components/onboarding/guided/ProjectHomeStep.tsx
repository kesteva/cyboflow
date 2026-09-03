/**
 * Guided step 9 — "Your project lives here". First in-shell guided screen: the
 * Sidebar is now mounted (inert) beside this column, showing the project the
 * user just added. Two callouts pair with GuidedMarkers on the Sidebar's
 * project row (n=1) and its "Start new session" button (n=2) — see
 * DraggableProjectTreeView.tsx.
 */
import { GuidedCallout, GuidedFooter, GuidedScreen } from './GuidedScreen';
import { ONBOARDING_PROJECT_HOME_STEP } from '../../../utils/onboarding';

export interface ProjectHomeStepProps {
  projectName: string;
  onContinue: () => void;
  onSkip: () => void;
}

export function ProjectHomeStep({
  projectName,
  onContinue,
  onSkip,
}: ProjectHomeStepProps): React.JSX.Element {
  return (
    <GuidedScreen
      step={ONBOARDING_PROJECT_HOME_STEP}
      centered
      title="Your project lives here"
      intro={
        <>
          Now that you’ve added your first project, you can find it in the left rail under{' '}
          <strong className="font-semibold text-text-primary">Projects &amp; Sessions</strong>.
          Everything an agent does for{' '}
          <strong className="font-semibold text-text-primary">{projectName}</strong> hangs off
          this row.
        </>
      }
      footer={
        <GuidedFooter
          skipLabel="Skip the set-up"
          onSkip={onSkip}
          skipTestId="onboarding-guided-skip"
          primaryLabel="Continue →"
          onPrimary={onContinue}
          primaryTestId="onboarding-project-home-continue"
        />
      }
    >
      <div className="flex flex-col gap-2">
        <GuidedCallout
          n={1}
          title="Click the project to get an overview of it"
          body="Branches, sessions, running flows, your backlog, next steps. You can see everything going on in your project here."
        />
        <GuidedCallout
          n={2}
          title="Start a new agent session within the project"
          body="Every session opens in its own git worktree, so agents work in parallel without stepping on each other or on you."
        />
      </div>
    </GuidedScreen>
  );
}
