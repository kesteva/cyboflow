/**
 * Guided step 12 — "Meet the Cyboflow assistant". The AgentRail joins the shell
 * at this step; its column pairs with the callouts below (no GuidedMarker on
 * the rail itself — the whole rail is the thing being introduced).
 */
import { GuidedCallout, GuidedFooter, GuidedScreen } from './GuidedScreen';
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
          title="Ask it anything, any time"
          body="What’s running, what’s blocked, what a flow does, why a session stopped."
        />
        <GuidedCallout
          n={2}
          title="Let it act, with your confirmation"
          body="Add ideas, reprioritize the backlog, launch a flow, edit a workflow — every action is a card you confirm or dismiss."
        />
      </div>
    </GuidedScreen>
  );
}
