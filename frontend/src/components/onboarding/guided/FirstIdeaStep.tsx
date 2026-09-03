/**
 * FirstIdeaStep — guided step 10 (ONBOARDING_FIRST_IDEA_STEP): "Build a
 * backlog of ideas". A single composer that sends the user's first backlog
 * idea(s) straight to the real global assistant thread, primed with a hidden
 * onboarding context hint (see ./firstIdeaHint) that steers the reply toward
 * a create-backlog-items proposal. The send is fire-and-forget — step 11
 * (IdeaProposalsStep) hosts the live thread and renders the in-flight turn.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAgentThreadStore } from '../../../stores/agentThreadStore';
import type { GuidedProject } from '../../../stores/onboardingStore';
import { ONBOARDING_FIRST_IDEA_STEP } from '../../../utils/onboarding';
import { buildFirstIdeaContextHint } from './firstIdeaHint';
import { GuidedFooter, GuidedScreen } from './GuidedScreen';

export interface FirstIdeaStepProps {
  project: GuidedProject;
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

  return (
    <GuidedScreen
      step={ONBOARDING_FIRST_IDEA_STEP}
      title="Build a backlog of ideas"
      intro="Now that you’ve got a project set up, Cyboflow lets you keep a backlog of ideas for it — things you want to tackle: features, bug fixes, pretty much anything. One or two sentences is all you need to get started."
      footer={
        <GuidedFooter
          skipLabel="Skip — I’ll add ideas later"
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
        What’s the next thing you want to get done in {project.name}?
      </p>
      <div className="flex items-start gap-2.5 border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px]">
        <span aria-hidden="true" className="pt-0.5 text-interactive">
          &#9656;
        </span>
        <textarea
          ref={textareaRef}
          rows={3}
          aria-label="Your first idea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Add a map view of nearby walkers… or: the sign-up form breaks on iOS Safari"
          className="w-full resize-none bg-transparent text-[12px] leading-[1.6] text-text-primary outline-none placeholder:italic placeholder:text-text-tertiary"
        />
      </div>
      <p className="mt-1.5 text-[10px] text-text-tertiary">
        ⌘↵ to send · Mention several things at once — the assistant will split them up.
      </p>
    </GuidedScreen>
  );
}
