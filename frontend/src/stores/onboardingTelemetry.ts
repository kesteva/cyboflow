/**
 * onboardingTelemetry — the PURE mapping from an onboardingStore transition to
 * the usage events it should emit. Kept out of both the store (which must stay
 * side-effect free) and OnboardingGate (a thin subscription shell) so the funnel
 * logic is synchronously unit-testable. Every step the user actually SEES emits
 * `onboarding_step_viewed`; the lifecycle events bracket the run.
 *
 * Design notes tied to the store's transition semantics
 * (see stores/onboardingStore.ts):
 * - The boot resolve (idle → hydrated) is a real tour entry ONLY when it lands
 *   'active' (a pristine first-run auto-start). A completed/skipped resolve is an
 *   existing install or a clamped mid-tour resume that never showed a step.
 * - begin()/restart() (Settings → Replay walkthrough) resets to step 0 with
 *   maxVisited 0 → distinguishable from a Sidebar resume(), which keeps the step.
 * - realEvent() advancing out of 'pending' (7→8, 8→9) moves the step, so it reads
 *   as a normal step view, NOT a resume.
 * - active → pending (a coach step parking for a real action) is silent.
 */
import type { TelemetryEventMap } from '../../../shared/types/telemetry';
import { onboardingStepName } from '../utils/onboarding';
import type { OnboardingStatus } from './onboardingStore';

/** The subset of store state the mapper reads (state + prevState from subscribe). */
export interface OnboardingTelemetrySlice {
  status: OnboardingStatus;
  step: number;
  maxVisitedStep: number;
  replay: boolean;
  hydrated: boolean;
}

/** A single usage event to fire, with its name correlated to its typed props. */
export type OnboardingTelemetryEvent =
  | { name: 'onboarding_started'; props: TelemetryEventMap['onboarding_started'] }
  | { name: 'onboarding_step_viewed'; props: TelemetryEventMap['onboarding_step_viewed'] }
  | { name: 'onboarding_skipped'; props: TelemetryEventMap['onboarding_skipped'] }
  | { name: 'onboarding_resumed'; props: TelemetryEventMap['onboarding_resumed'] }
  | { name: 'onboarding_completed'; props: TelemetryEventMap['onboarding_completed'] };

function stepViewed(step: number): OnboardingTelemetryEvent {
  return { name: 'onboarding_step_viewed', props: { step, name: onboardingStepName(step) } };
}

/**
 * Map one store transition to the usage events to emit. Pure — returns [] for
 * transitions that carry no analytics meaning (idle, no-op, parking).
 */
export function onboardingTelemetryEvents(
  prev: OnboardingTelemetrySlice,
  next: OnboardingTelemetrySlice,
): OnboardingTelemetryEvent[] {
  if (next.status === 'idle') return [];

  // Boot resolve: only a pristine auto-start is a real entry.
  if (!prev.hydrated && next.hydrated) {
    if (next.status === 'active') {
      return [{ name: 'onboarding_started', props: { trigger: 'first_run' } }, stepViewed(next.step)];
    }
    return [];
  }

  const statusChanged = next.status !== prev.status;
  const stepChanged = next.step !== prev.step;

  if (statusChanged) {
    if (next.status === 'active') {
      // begin()/restart resets to step 0 with maxVisited 0 → the Settings replay.
      if (next.replay && next.step === 0 && next.maxVisitedStep === 0) {
        return [{ name: 'onboarding_started', props: { trigger: 'replay' } }, stepViewed(0)];
      }
      // realEvent advancing out of 'pending' moves the step; a Sidebar resume keeps it.
      if (stepChanged) return [stepViewed(next.step)];
      return [{ name: 'onboarding_resumed', props: { step: next.step } }];
    }
    if (next.status === 'skipped') {
      return [{ name: 'onboarding_skipped', props: { step: next.step, name: onboardingStepName(next.step) } }];
    }
    if (next.status === 'completed') {
      return [{ name: 'onboarding_completed', props: { furthest_step: next.maxVisitedStep } }];
    }
    // active → pending (parking for a real action) is silent.
    return [];
  }

  // Same status: a step move within the active tour (next/back/goTo/realEvent).
  if (next.status === 'active' && stepChanged) return [stepViewed(next.step)];
  return [];
}
