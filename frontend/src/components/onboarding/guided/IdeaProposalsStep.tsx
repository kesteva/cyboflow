/**
 * IdeaProposalsStep — guided step 11 (ONBOARDING_IDEA_PROPOSALS_STEP):
 * "Here’s how I’d capture that". Hosts the real global assistant thread
 * inside the guided column (AgentThreadView variant="guided" — no onboarding
 * greeting, no suggestion chips) so the user sees the assistant's reply to
 * step 10's send and its create-backlog-items proposal, can confirm it or
 * keep talking, before moving on. Continue is always enabled: the user may
 * leave whether or not a proposal was confirmed — step 13 copes with an
 * empty backlog.
 *
 * `project === null` is the "Not sure yet" branch: the thread holds the
 * assistant's answer to "what do you want to get done with Cyboflow?" — an
 * explanation, not a proposal — so the copy reads "Here’s how Cyboflow can
 * help" and Continue is the only way on.
 */
import type { GuidedProject } from '../../../stores/onboardingStore';
import { ONBOARDING_IDEA_PROPOSALS_STEP } from '../../../utils/onboarding';
import { AgentThreadView } from '../../agentRail/AgentThreadView';
import { GuidedFooter, GuidedScreen } from './GuidedScreen';

export interface IdeaProposalsStepProps {
  /** The guided project, or null on the no-project branch. */
  project: GuidedProject | null;
  onContinue: () => void;
  onSkip: () => void;
}

export function IdeaProposalsStep({
  project,
  onContinue,
  onSkip,
}: IdeaProposalsStepProps): React.JSX.Element {
  const hasProject = project !== null;
  return (
    <GuidedScreen
      step={ONBOARDING_IDEA_PROPOSALS_STEP}
      title={hasProject ? 'Here’s how I’d capture that' : 'Here’s how Cyboflow can help'}
      intro={
        hasProject
          ? 'The assistant read what you wrote and proposes backlog items. Confirm to create them, or tell it what to change first — nothing is written until you confirm.'
          : 'The assistant read what you’re after and explains where to start. Keep asking if anything is unclear — once you add a project, it can turn this into a backlog for you.'
      }
      footer={
        <GuidedFooter
          {...(hasProject
            ? { skipLabel: 'Skip — I’ll add ideas later', onSkip, skipTestId: 'onboarding-guided-skip-ideas' }
            : {})}
          primaryLabel="Continue →"
          onPrimary={onContinue}
          primaryTestId="onboarding-idea-proposals-continue"
        />
      }
    >
      <div
        data-testid="onboarding-idea-thread"
        className="flex flex-col overflow-hidden border border-border-primary bg-bg-secondary"
        // Tall enough that a proposal card in the bottom slot leaves the
        // transcript readable: grow with the window, never below 440px.
        style={{ height: 'clamp(440px, calc(100vh - 320px), 760px)' }}
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentThreadView
            variant="guided"
            composerPlaceholder={hasProject ? 'Not quite? Tell me what to change…' : 'Ask a follow-up…'}
          />
        </div>
      </div>
    </GuidedScreen>
  );
}
