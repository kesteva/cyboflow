import { ONBOARDING_MODAL_STEPS, visibleStepNumber } from '../../utils/onboarding';

/**
 * The progress dot row shared by the modal footer and the coach popover.
 * Completed + current dots are terracotta, upcoming are the hairline line
 * token; the current dot widens to 22px. Dots may only jump to already-visited
 * steps (goTo enforces the same maxVisited clamp in the store) so navigation
 * can never bypass the step-1 gate or a coach precondition.
 *
 * A step this run SKIPS (the conditional Default-agent step on a single-provider
 * install) renders no dot at all — an unreachable dot in the rail reads as a
 * step the tour refuses to advance to. The labels count visible steps too, so
 * they match the "STEP n / N" header.
 */
interface OnboardingDotsProps {
  step: number;
  maxVisitedStep: number;
  /** Step indices this run does not show; defaults to none. */
  skippedSteps?: ReadonlySet<number>;
  onGoTo: (step: number) => void;
}

const NO_SKIPPED: ReadonlySet<number> = new Set<number>();

export function OnboardingDots({
  step,
  maxVisitedStep,
  skippedSteps = NO_SKIPPED,
  onGoTo,
}: OnboardingDotsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-[5px]">
      {ONBOARDING_MODAL_STEPS
        .filter((i) => !skippedSteps.has(i))
        .map((i) => {
        const done = i <= step;
        const current = i === step;
        const reachable = i <= maxVisitedStep && i !== step;
        return (
          <button
            key={i}
            type="button"
            aria-label={`Go to step ${visibleStepNumber(i, skippedSteps)}`}
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
