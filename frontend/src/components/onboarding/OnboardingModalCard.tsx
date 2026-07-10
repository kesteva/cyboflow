import cyboflowLogo from '../../assets/cyboflow-logo.svg';
import { ONBOARDING_STEP_COUNT } from '../../utils/onboarding';
import { ONBOARDING_TITLES } from './copy';
import { OnboardingDots } from './OnboardingDots';

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
  /** Step 0 renders the full-bleed hero header instead of the compact bar. */
  hero: boolean;
  children: React.ReactNode;
  primary: PrimaryAction;
  onBack: () => void;
  onSkip: () => void;
  onGoTo: (step: number) => void;
}

/**
 * The 468×512 centered onboarding card (steps 0,1,2,3,7). Fixed compact header
 * (terracotta) except step 0's hero, a scrolling body, and a fixed footer:
 * Skip · dots · Back · primary. The scrim captures pointer events but does NOT
 * dismiss — onboarding is gated, not click-away closable.
 */
export function OnboardingModalCard({
  step,
  maxVisitedStep,
  hero,
  children,
  primary,
  onBack,
  onSkip,
  onGoTo,
}: OnboardingModalCardProps): React.JSX.Element {
  const showBack = step > 0;
  return (
    <div className="pointer-events-auto fixed inset-0 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-modal-overlay" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ONBOARDING_TITLES[step]}
        className="relative flex flex-col overflow-hidden border border-border-emphasized bg-bg-primary shadow-modal"
        style={{ width: 468, height: 512 }}
      >
        {/* Compact header — steps 1,2,3,7. Step 0's hero lives inside the body. */}
        {!hero && (
          <div className="flex flex-shrink-0 items-center gap-2.5 bg-interactive px-5 py-[13px] text-on-interactive">
            <img
              src={cyboflowLogo}
              alt=""
              aria-hidden="true"
              className="h-[18px] w-[18px] opacity-90"
              style={{ filter: 'brightness(0) invert(1)' }}
            />
            <span className="flex-1 text-[15px] font-bold tracking-[-.01em]">{ONBOARDING_TITLES[step]}</span>
            <span className="text-[9px] tracking-[.14em] text-on-interactive/80">
              STEP {step + 1} / {ONBOARDING_STEP_COUNT}
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
          <OnboardingDots step={step} maxVisitedStep={maxVisitedStep} onGoTo={onGoTo} />
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
