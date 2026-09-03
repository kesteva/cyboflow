/**
 * Guided step 9 — "Your project lives here". First in-shell guided screen: the
 * Sidebar is now mounted (inert) beside this column, showing the project the
 * user just added. Two callouts pair with GuidedMarkers on the Sidebar's
 * project row (n=1) and its "Start new session" button (n=2), each with the
 * design's dashed leader arrow (GuidedLeader) — see DraggableProjectTreeView.tsx.
 *
 * `projectName === null` is the "Not sure yet" branch: the Sidebar shows its
 * empty state, so the screen becomes "Your projects will live here" — callout
 * 1 draws the leader arrow to the empty state's ringed Add Project button (see
 * DraggableProjectTreeView.tsx), and the two project callouts follow unmarked
 * (there is no row yet), in the future tense.
 */
import { GuidedCallout, GuidedFooter, GuidedScreen } from './GuidedScreen';
import { GUIDED_TARGETS } from './GuidedLeader';
import { ONBOARDING_PROJECT_HOME_STEP } from '../../../utils/onboarding';

export interface ProjectHomeStepProps {
  /** The guided project's name, or null when the user has not added one. */
  projectName: string | null;
  onContinue: () => void;
  onSkip: () => void;
}

export function ProjectHomeStep({
  projectName,
  onContinue,
  onSkip,
}: ProjectHomeStepProps): React.JSX.Element {
  const hasProject = projectName !== null;
  return (
    <GuidedScreen
      step={ONBOARDING_PROJECT_HOME_STEP}
      centered
      title={hasProject ? 'Your project lives here' : 'Your projects will live here'}
      intro={
        hasProject ? (
          <>
            Now that you’ve added your first project, you can find it in the left rail under{' '}
            <strong className="font-semibold text-text-primary">Projects &amp; Sessions</strong>.
            Everything an agent does for{' '}
            <strong className="font-semibold text-text-primary">{projectName}</strong> hangs off
            this row.
          </>
        ) : (
          <>
            Once you add a project, it shows up in the left rail under{' '}
            <strong className="font-semibold text-text-primary">Projects &amp; Sessions</strong>.
            Everything an agent does for a project hangs off its row.
          </>
        )
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
        {!hasProject && (
          <GuidedCallout
            n={1}
            leaderTo={GUIDED_TARGETS.addProject}
            testId="onboarding-callout-add-project"
            title="Click Add Project to add your first one at any time"
            body="Point Cyboflow at an existing folder or create a new project from scratch. Everything else on this tour waits for you here."
          />
        )}
        <GuidedCallout
          n={hasProject ? 1 : 2}
          leaderTo={hasProject ? GUIDED_TARGETS.projectRow : undefined}
          title={
            hasProject
              ? 'Click the project to get an overview of it'
              : 'Click a project to get an overview of it'
          }
          body="Branches, sessions, running flows, your backlog, next steps. You can see everything going on in your project here."
        />
        <GuidedCallout
          n={hasProject ? 2 : 3}
          leaderTo={hasProject ? GUIDED_TARGETS.startSession : undefined}
          title="Start a new agent session within the project"
          body="Every session opens in its own git worktree, so agents work in parallel without stepping on each other or on you."
        />
      </div>
    </GuidedScreen>
  );
}
