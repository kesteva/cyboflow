import { visibleStepNumber, visibleStepTotal } from '../../utils/onboarding';
import { ONBOARDING_TITLES } from './copy';
import { CyboflowMark } from './CyboflowMark';
import { OnboardingDots } from './OnboardingDots';

const NO_SKIPPED: ReadonlySet<number> = new Set<number>();

/** Footer primary-button descriptor, computed per step by the gate. */
export interface PrimaryAction {
  label: string;
  disabled: boolean;
  /** Native title tooltip (used for the gated step-1 disabled state). */
  title?: string;
  onClick: () => void;
}

interface OnboardingModalCardProps {
  step: number;
  maxVisitedStep: number;
  /** Step indices this run does not show (see OnboardingDots). */
  skippedSteps?: ReadonlySet<number>;
  /** Step 0 renders the full-bleed hero header instead of the compact bar. */
  hero: boolean;
  children: React.ReactNode;
  primary: PrimaryAction;
  onBack: () => void;
  onSkip: () => void;
  onGoTo: (step: number) => void;
}

/**
 * The 468×512 centered onboarding card (the modal steps). Fixed compact header
 * (terracotta) except step 0's hero, a scrolling body, and a fixed footer:
 * Skip · dots · Back · primary. The full-screen wrapper captures pointer events
 * but does NOT dismiss — onboarding is gated, not click-away closable. It has no
 * darkening scrim: the shell is unmounted for the tour's duration, so the only
 * thing behind the card is the spiral wrapper peeling off bare paper, and a
 * dimming layer on top of that reads as a second, competing fade.
 */
export function OnboardingModalCard({
  step,
  maxVisitedStep,
  skippedSteps,
  hero,
  children,
  primary,
  onBack,
  onSkip,
  onGoTo,
}: OnboardingModalCardProps): React.JSX.Element {
  const showBack = step > 0;
  const visible = skippedSteps ?? NO_SKIPPED;
  return (
    <div className="pointer-events-auto fixed inset-0 flex items-center justify-center p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ONBOARDING_TITLES[step]}
        /* max-h/max-w-full: the card's 468×512 is a PREFERRED size, not a floor.
           The app window has no minHeight, so on a short (non-fullscreen) window
           a hard 512 overflows the centered wrapper equally top and bottom — and
           since the wrapper does not scroll, the footer carrying Back/primary is
           clipped off-screen with no way to reach it. Capping instead lets the
           already-scrolling body absorb the shortfall and keeps the footer up. */
        className="relative flex max-h-full max-w-full flex-col overflow-hidden border border-border-emphasized bg-bg-primary shadow-modal"
        style={{ width: 468, height: 512 }}
      >
        {/* Compact header — every modal step but 0, whose hero lives in the body. */}
        {!hero && (
          <div className="flex flex-shrink-0 items-center gap-2.5 bg-interactive px-5 py-[13px] text-text-on-interactive">
            <CyboflowMark size={18} className="flex-shrink-0 opacity-90" />
            <span className="flex-1 text-[15px] font-bold tracking-[-.01em]">{ONBOARDING_TITLES[step]}</span>
            <span className="text-[9px] tracking-[.14em] text-text-on-interactive/80">
              STEP {visibleStepNumber(step, visible)} / {visibleStepTotal(visible)}
            </span>
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center gap-2.5 border-t border-border-primary px-5 py-[13px]">
          <button
            type="button"
            onClick={onSkip}
            data-testid="onboarding-skip"
            className="border-none bg-transparent py-2 pl-0 pr-2 text-[10px] font-semibold uppercase tracking-[.1em] text-text-tertiary transition-colors hover:text-text-primary"
          >
            Skip
          </button>
          <OnboardingDots
            step={step}
            maxVisitedStep={maxVisitedStep}
            skippedSteps={visible}
            onGoTo={onGoTo}
          />
          <span className="flex-1" />
          {showBack && (
            <button
              type="button"
              onClick={onBack}
              className="border border-border-primary bg-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[.12em] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
            >
              ← Back
            </button>
          )}
          <button
            type="button"
            disabled={primary.disabled}
            title={primary.disabled ? primary.title : undefined}
            onClick={primary.onClick}
            className={
              primary.disabled
                ? 'cursor-not-allowed border border-border-primary bg-[var(--paper-3)] px-[15px] py-2 text-[10px] font-bold uppercase tracking-[.12em] text-text-disabled'
                : 'border border-border-emphasized bg-[var(--ink)] px-[15px] py-2 text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive'
            }
          >
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  );
}
