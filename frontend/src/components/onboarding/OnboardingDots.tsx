import { ONBOARDING_STEP_COUNT } from '../../utils/onboarding';

/**
 * The 8-dot progress row shared by the modal footer and the coach popover.
 * Completed + current dots are terracotta, upcoming are the hairline line
 * token; the current dot widens to 22px. Dots may only jump to already-visited
 * steps (goTo enforces the same maxVisited clamp in the store) so navigation
 * can never bypass the step-1 gate or a coach precondition.
 */
interface OnboardingDotsProps {
  step: number;
  maxVisitedStep: number;
  onGoTo: (step: number) => void;
}

export function OnboardingDots({ step, maxVisitedStep, onGoTo }: OnboardingDotsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-[5px]">
      {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => {
        const done = i <= step;
        const current = i === step;
        const reachable = i <= maxVisitedStep && i !== step;
        return (
          <button
            key={i}
            type="button"
            aria-label={`Go to step ${i + 1}`}
            disabled={!reachable}
            onClick={() => reachable && onGoTo(i)}
            // width/background transition mirrors the design (.16s); the current
            // dot widens to 22px, all others stay 6px.
            style={{ width: current ? 22 : 6, height: 5 }}
            className={`rounded-full transition-[width,background-color] duration-150 ${
              done ? 'bg-interactive' : 'bg-border-primary'
            } ${reachable ? 'cursor-pointer' : 'cursor-default'}`}
          />
        );
      })}
    </div>
  );
}
