/**
 * IdeaProposalsStep — guided step 11 (ONBOARDING_IDEA_PROPOSALS_STEP):
 * "Here’s how I’d capture that". Hosts the real global assistant thread
 * inside the guided column (AgentThreadView variant="guided" — no onboarding
 * greeting, no suggestion chips) so the user sees the assistant's reply to
 * step 10's send and its create-backlog-items proposal, can confirm it or
 * keep talking, before moving on. Continue is always enabled: the user may
 * leave whether or not a proposal was confirmed — step 13 copes with an
 * empty backlog.
 */
import type { GuidedProject } from '../../../stores/onboardingStore';
import { ONBOARDING_IDEA_PROPOSALS_STEP } from '../../../utils/onboarding';
import { AgentThreadView } from '../../agentRail/AgentThreadView';
import { GuidedFooter, GuidedScreen } from './GuidedScreen';

export interface IdeaProposalsStepProps {
  project: GuidedProject;
  onContinue: () => void;
  onSkip: () => void;
}

export function IdeaProposalsStep({
  project: _project,
  onContinue,
  onSkip,
}: IdeaProposalsStepProps): React.JSX.Element {
  return (
    <GuidedScreen
      step={ONBOARDING_IDEA_PROPOSALS_STEP}
      title="Here’s how I’d capture that"
      intro="The assistant read what you wrote and proposes backlog items. Confirm to create them, or tell it what to change first — nothing is written until you confirm."
      footer={
        <GuidedFooter
          skipLabel="Skip — I’ll add ideas later"
          onSkip={onSkip}
          skipTestId="onboarding-guided-skip-ideas"
          primaryLabel="Continue →"
          onPrimary={onContinue}
          primaryTestId="onboarding-idea-proposals-continue"
        />
      }
    >
      <div
        data-testid="onboarding-idea-thread"
        className="flex h-[440px] flex-col overflow-hidden border border-border-primary bg-bg-secondary"
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentThreadView
            variant="guided"
            composerPlaceholder="Not quite? Tell me what to change…"
          />
        </div>
      </div>
    </GuidedScreen>
  );
}
