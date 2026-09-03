/**
 * FirstIdeaStep — guided step 10 (ONBOARDING_FIRST_IDEA_STEP): "Build a
 * backlog of ideas". A single composer that sends the user's first backlog
 * idea(s) straight to the real global assistant thread, primed with a hidden
 * onboarding context hint (see ./firstIdeaHint) that steers the reply toward
 * a create-backlog-items proposal. The send is fire-and-forget — step 11
 * (IdeaProposalsStep) hosts the live thread and renders the in-flight turn.
 *
 * `project === null` is the "Not sure yet" branch: no project to file ideas
 * against, so the composer asks "What do you want to get done with Cyboflow?"
 * instead and the hint primes the assistant to explain how the flows fit that
 * goal (no proposal).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAgentThreadStore } from '../../../stores/agentThreadStore';
import type { GuidedProject } from '../../../stores/onboardingStore';
import { ONBOARDING_FIRST_IDEA_STEP } from '../../../utils/onboarding';
import { buildFirstIdeaContextHint } from './firstIdeaHint';
import { GuidedFooter, GuidedScreen } from './GuidedScreen';

export interface FirstIdeaStepProps {
  /** The guided project, or null on the no-project branch. */
  project: GuidedProject | null;
  onSent: () => void;
  onSkip: () => void;
}

export function FirstIdeaStep({ project, onSent, onSkip }: FirstIdeaStepProps): React.JSX.Element {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useAgentThreadStore((s) => s.sendMessage);
  const threadReady = useAgentThreadStore((s) => s.thread !== null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !threadReady) return;
    void sendMessage(trimmed, { contextHint: buildFirstIdeaContextHint(project) });
    onSent();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasProject = project !== null;
  return (
    <GuidedScreen
      step={ONBOARDING_FIRST_IDEA_STEP}
      title={hasProject ? 'Build a backlog of ideas' : 'Tell the assistant what you’re after'}
      intro={
        hasProject
          ? 'Now that you’ve got a project set up, Cyboflow lets you keep a backlog of ideas for it — things you want to tackle: features, bug fixes, pretty much anything. One or two sentences is all you need to get started.'
          : 'Cyboflow runs AI coding flows against your projects — planning, building, shipping, in parallel. Tell the assistant what you’re hoping to get done and it will point you at the right place to start. One or two sentences is all you need.'
      }
      footer={
        <GuidedFooter
          skipLabel={hasProject ? 'Skip — I’ll add ideas later' : 'Skip — I’ll ask later'}
          onSkip={onSkip}
          skipTestId="onboarding-guided-skip-ideas"
          primaryLabel="Send →"
          onPrimary={handleSend}
          primaryDisabled={text.trim().length === 0 || !threadReady}
          primaryTestId="onboarding-first-idea-send"
        />
      }
    >
      <p className="mb-2 text-[12px] font-bold text-text-primary">
        {hasProject
          ? `What’s the next thing you want to get done in ${project.name}?`
          : 'What do you want to get done with Cyboflow?'}
      </p>
      <div className="flex items-start gap-2.5 border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px]">
        <span aria-hidden="true" className="pt-0.5 text-interactive">
          &#9656;
        </span>
        <textarea
          ref={textareaRef}
          rows={3}
          aria-label={hasProject ? 'Your first idea' : 'What you want to get done'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            hasProject
              ? 'e.g. Add a map view of nearby walkers… or: the sign-up form breaks on iOS Safari'
              : 'e.g. Ship features on my side project faster… or: clear a backlog of bugs without babysitting each fix'
          }
          className="w-full resize-none bg-transparent text-[12px] leading-[1.6] text-text-primary outline-none placeholder:italic placeholder:text-text-tertiary"
        />
      </div>
      <p className="mt-1.5 text-[10px] text-text-tertiary">
        {hasProject
          ? '⌘↵ to send · Mention several things at once — the assistant will split them up.'
          : '⌘↵ to send · The assistant will suggest which flow fits and what to set up first.'}
      </p>
    </GuidedScreen>
  );
}
