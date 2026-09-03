/**
 * Guided step 12 — "Meet the Cyboflow assistant". The AgentRail joins the shell
 * at this step; the callouts below draw the design's leader arrows to it —
 * "ask it anything" to the rail header, "let it act" to its composer (no
 * GuidedMarker chips on the rail itself: the whole rail is being introduced).
 */
import { GuidedCallout, GuidedFooter, GuidedScreen } from './GuidedScreen';
import { GUIDED_TARGETS } from './GuidedLeader';
import { ONBOARDING_ASSISTANT_RAIL_STEP } from '../../../utils/onboarding';

export interface AssistantRailStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

export function AssistantRailStep({
  onContinue,
  onSkip,
}: AssistantRailStepProps): React.JSX.Element {
  return (
    <GuidedScreen
      step={ONBOARDING_ASSISTANT_RAIL_STEP}
      centered
      title="Meet the Cyboflow assistant"
      intro={
        <>
          That conversation didn’t go anywhere — it moved into the rail on the right. At any
          point you can manage everything in Cyboflow through the{' '}
          <strong className="font-semibold text-text-primary">Cyboflow assistant</strong>.
        </>
      }
      footer={
        <GuidedFooter
          skipLabel="Skip the set-up"
          onSkip={onSkip}
          skipTestId="onboarding-guided-skip"
          primaryLabel="Continue →"
          onPrimary={onContinue}
          primaryTestId="onboarding-assistant-rail-continue"
        />
      }
    >
      <div className="flex flex-col gap-2">
        <GuidedCallout
          n={1}
          leaderTo={GUIDED_TARGETS.assistantHeader}
          title="Ask it anything, any time"
          body="What’s running, what’s blocked, what a flow does, why a session stopped."
        />
        <GuidedCallout
          n={2}
          leaderTo={GUIDED_TARGETS.assistantComposer}
          title="Let it act, with your confirmation"
          body="Add ideas, reprioritize the backlog, launch a flow, edit a workflow — every action is a card you confirm or dismiss."
        />
      </div>
    </GuidedScreen>
  );
}
