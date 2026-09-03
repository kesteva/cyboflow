/**
 * Shared chrome for the IN-SHELL guided screens (tour steps 9-14) — the design
 * canvas's 620px "guided column": eyebrow rail ("GUIDED SET-UP · STEP n OF N"),
 * the 40px mark, a 24px headline, a 12px intro, the step's body, and the
 * skip-link / primary footer. Steps 7-8 predate this and carry their own copy of
 * the same chrome (ExistingProjectPicker / NewProjectForm) — keep the classes in
 * sync if either changes.
 *
 * Numbering reads the store directly (the current step + the skipped set), so a
 * screen only says WHICH step it is; an assistant-off run renumbers itself.
 */
import { useRef } from 'react';
import { GuidedLeader, type GuidedTarget } from './GuidedLeader';
import cyboflowLogo from '../../../assets/cyboflow-logo.svg';
import { skippedStepSet, useOnboardingStore } from '../../../stores/onboardingStore';
import { guidedStepNumber, guidedStepTotal } from '../../../utils/onboarding';

export interface GuidedScreenProps {
  /** Tour step index (9-14) — drives the eyebrow numbering. */
  step: number;
  title: string;
  /** Intro paragraph under the headline. Pass a fragment for inline emphasis. */
  intro: React.ReactNode;
  children?: React.ReactNode;
  /** Rendered below the body — normally a {@link GuidedFooter}. */
  footer?: React.ReactNode;
  /** Centre the headline/intro (the callout screens do; the form-like ones don't). */
  centered?: boolean;
  testId?: string;
}

export function GuidedScreen({
  step,
  title,
  intro,
  children,
  footer,
  centered = false,
  testId,
}: GuidedScreenProps): React.JSX.Element {
  const multiRuntime = useOnboardingStore((s) => s.multiRuntime);
  const assistantAvailable = useOnboardingStore((s) => s.assistantAvailable);
  const skipped = skippedStepSet({ multiRuntime, assistantAvailable });
  const n = guidedStepNumber(step, skipped);
  const total = guidedStepTotal(skipped);

  return (
    <div className="flex flex-col" data-testid={testId}>
      <div className="mb-[18px] flex items-center gap-2.5">
        <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">GUIDED SET-UP</span>
        <span aria-hidden="true" className="flex-1 border-t border-dashed border-border-primary" />
        <span className="text-[9px] tracking-[.14em] text-text-tertiary" data-testid="guided-step-eyebrow">
          STEP {n} OF {total}
        </span>
      </div>

      <div className={centered ? 'flex flex-col items-center text-center' : 'flex flex-col'}>
        <img src={cyboflowLogo} alt="" aria-hidden="true" className="mb-5 h-10 w-10" />
        <h1 className="text-[24px] font-extrabold tracking-[-.01em] text-text-primary">{title}</h1>
        <p className="mb-6 mt-2 text-[12px] leading-[1.6] text-text-secondary">{intro}</p>
      </div>

      {children}

      {footer}
    </div>
  );
}

export interface GuidedCalloutProps {
  /** The numbered chip — matches the {@link GuidedMarker} of the same number in the shell. */
  n: number;
  title: string;
  body: React.ReactNode;
  testId?: string;
  /**
   * Draw the design's dashed, curved arrow from this chip to a shell element
   * (see {@link GuidedLeader} / GUIDED_TARGETS).
   */
  leaderTo?: GuidedTarget;
}

/**
 * A numbered explanation card ("① Click the project to get an overview of it").
 * The number pairs with a GuidedMarker of the same value placed on the shell
 * element it describes; `leaderTo` additionally draws the arrow to it.
 */
export function GuidedCallout({
  n,
  title,
  body,
  testId,
  leaderTo,
}: GuidedCalloutProps): React.JSX.Element {
  const chipRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={cardRef}
      className="flex items-start gap-[11px] border border-border-primary bg-surface-primary px-[15px] py-[13px] text-left"
      data-testid={testId}
    >
      <span
        ref={chipRef}
        aria-hidden="true"
        className="flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center bg-interactive text-[9px] font-bold text-[var(--paper)]"
      >
        {n}
      </span>
      {leaderTo !== undefined && (
        <GuidedLeader
          from={chipRef}
          card={cardRef}
          to={leaderTo}
          testId={testId !== undefined ? `${testId}-leader` : undefined}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold text-text-primary">{title}</span>
        <span className="mt-[3px] block text-[10px] leading-[1.55] text-text-tertiary">{body}</span>
      </span>
    </div>
  );
}

export interface GuidedFooterProps {
  /** Left-hand quiet link ("Skip the set-up", "Skip — I'll add ideas later"). Omit for none. */
  skipLabel?: string;
  onSkip?: () => void;
  skipTestId?: string;
  /** Optional middle secondary button (bordered), e.g. "Done — stay here". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryTestId?: string;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryTestId?: string;
}

export function GuidedFooter({
  skipLabel,
  onSkip,
  skipTestId,
  secondaryLabel,
  onSecondary,
  secondaryTestId,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryTestId,
}: GuidedFooterProps): React.JSX.Element {
  return (
    <div className="mt-[22px] flex w-full items-center gap-2">
      {skipLabel !== undefined && (
        <button
          type="button"
          data-testid={skipTestId}
          onClick={onSkip}
          className="border-none bg-transparent py-2 pl-0 pr-2 text-[10px] font-semibold uppercase tracking-[.1em] text-text-tertiary transition-colors hover:text-text-primary"
        >
          {skipLabel}
        </button>
      )}
      <span className="flex-1" />
      {secondaryLabel !== undefined && (
        <button
          type="button"
          data-testid={secondaryTestId}
          onClick={onSecondary}
          className="border border-border-primary bg-surface-primary px-4 py-[9px] text-[10px] font-semibold uppercase tracking-[.12em] text-text-secondary transition-colors hover:border-interactive hover:text-interactive"
        >
          {secondaryLabel}
        </button>
      )}
      <button
        type="button"
        data-testid={primaryTestId}
        onClick={onPrimary}
        disabled={primaryDisabled}
        className={
          primaryDisabled
            ? 'cursor-not-allowed border border-border-primary bg-[var(--paper-3)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-text-disabled'
            : 'border border-border-emphasized bg-[var(--ink)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive'
        }
      >
        {primaryLabel}
      </button>
    </div>
  );
}
