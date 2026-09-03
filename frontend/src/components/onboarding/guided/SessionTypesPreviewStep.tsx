/**
 * Guided step 13 on the "Not sure yet" branch — "Sessions you can launch".
 * There is no project to launch into, so this is a read-only preview of the
 * same three options FirstSessionStep offers (shared copy: ./sessionChoices),
 * and its only exit is "Finish set-up →" — the no-project finale (rail open
 * with the greeting, LandingHome's empty state). Step 14 is never reached
 * on this branch.
 */
import { GuidedFooter, GuidedScreen } from './GuidedScreen';
import { SESSION_CHOICES } from './sessionChoices';
import { ONBOARDING_FIRST_SESSION_STEP } from '../../../utils/onboarding';

export interface SessionTypesPreviewStepProps {
  onFinish: () => void;
}

export function SessionTypesPreviewStep({ onFinish }: SessionTypesPreviewStepProps): React.JSX.Element {
  return (
    <GuidedScreen
      step={ONBOARDING_FIRST_SESSION_STEP}
      title="Sessions you can launch"
      intro={
        <>
          Once you’ve added a project, every session below runs in its own worktree of it. When
          one needs you, it lands in the{' '}
          <strong className="font-semibold text-text-primary">Human review</strong> queue at the
          top of the left rail.
        </>
      }
      footer={
        <GuidedFooter
          primaryLabel="Finish set-up →"
          onPrimary={onFinish}
          primaryTestId="onboarding-session-preview-finish"
        />
      }
    >
      <ul aria-label="Session types" className="flex w-full flex-col gap-2 text-left">
        {SESSION_CHOICES.map((choice) => (
          <li
            key={choice.value}
            className="flex items-start gap-[11px] border border-border-primary bg-surface-primary px-[15px] py-[13px]"
          >
            <span
              aria-hidden="true"
              className="flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center bg-[var(--paper-3)] text-[9px] font-bold text-text-secondary"
            >
              {choice.key}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="block text-[12px] font-bold text-text-primary">{choice.title}</span>
                <span className="text-[9px] uppercase tracking-[.14em] text-text-tertiary">
                  {choice.tag}
                </span>
              </span>
              <span className="mt-[3px] block text-[10px] leading-[1.55] text-text-tertiary">
                {choice.body}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] leading-[1.55] text-text-tertiary">
        Add a project from the home screen or the sidebar whenever you’re ready — the assistant in
        the rail can help you pick a session for it.
      </p>
    </GuidedScreen>
  );
}
