/**
 * onboardingTelemetry — the pure transition→usage-event mapper. Exercises the
 * full onboarding funnel: the pristine boot entry, per-step views (modal +
 * coachmark), the Settings replay start, Sidebar resume, skip/abandon, realEvent
 * advances out of 'pending', silent parking, and the completion event. All the
 * async firing lives in OnboardingGate and is not exercised here.
 */
import { describe, it, expect } from 'vitest';
import { onboardingTelemetryEvents, type OnboardingTelemetrySlice } from '../onboardingTelemetry';
import { ONBOARDING_STEP_COUNT, ONBOARDING_STEP_NAMES } from '../../utils/onboarding';

/** A hydrated 'active' slice at a given step, overridable per field. */
function slice(over: Partial<OnboardingTelemetrySlice> = {}): OnboardingTelemetrySlice {
  return { status: 'active', step: 0, maxVisitedStep: 0, replay: false, hydrated: true, ...over };
}

describe('onboardingTelemetry — step-name table', () => {
  it('has one stable slug per tour step', () => {
    expect(ONBOARDING_STEP_NAMES).toHaveLength(ONBOARDING_STEP_COUNT);
    expect(new Set(ONBOARDING_STEP_NAMES).size).toBe(ONBOARDING_STEP_COUNT);
  });
});

describe('onboardingTelemetry — boot resolve', () => {
  it('pristine first-run (idle → active) emits started + the step-0 view', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      slice({ step: 0 }),
    );
    expect(events).toEqual([
      { name: 'onboarding_started', props: { trigger: 'first_run' } },
      { name: 'onboarding_step_viewed', props: { step: 0, name: 'welcome' } },
    ]);
  });

  it('existing install (idle → completed) emits nothing', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      { status: 'completed', step: 0, maxVisitedStep: 0, replay: false, hydrated: true },
    );
    expect(events).toEqual([]);
  });

  it('clamped mid-tour resume (idle → skipped) emits nothing', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      { status: 'skipped', step: 4, maxVisitedStep: 4, replay: false, hydrated: true },
    );
    expect(events).toEqual([]);
  });
});

describe('onboardingTelemetry — per-step views', () => {
  it('a forward advance emits the new step view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 0 }), slice({ step: 1, maxVisitedStep: 1 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 1, name: 'connect' } }]);
  });

  it('a backward move re-emits the step view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 2, maxVisitedStep: 2 }), slice({ step: 1, maxVisitedStep: 2 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 1, name: 'connect' } }]);
  });

  it('every step index maps to its named view', () => {
    for (let step = 1; step < ONBOARDING_STEP_COUNT; step++) {
      const events = onboardingTelemetryEvents(slice({ step: step - 1 }), slice({ step, maxVisitedStep: step }));
      expect(events).toEqual([
        { name: 'onboarding_step_viewed', props: { step, name: ONBOARDING_STEP_NAMES[step] } },
      ]);
    }
  });

  it('a realEvent jump that skips pointer steps (4 → 8) emits only the landed view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 4, maxVisitedStep: 4 }), slice({ step: 8, maxVisitedStep: 8 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 8, name: 'ship' } }]);
  });

  it('a no-op transition (same status, same step) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice({ step: 3 }), slice({ step: 3 }))).toEqual([]);
  });
});

describe('onboardingTelemetry — lifecycle', () => {
  it('the Settings replay (→ active, step 0, maxVisited 0, replay) emits started:replay + view', () => {
    const events = onboardingTelemetryEvents(
      { status: 'completed', step: 10, maxVisitedStep: 10, replay: false, hydrated: true },
      slice({ status: 'active', step: 0, maxVisitedStep: 0, replay: true }),
    );
    expect(events).toEqual([
      { name: 'onboarding_started', props: { trigger: 'replay' } },
      { name: 'onboarding_step_viewed', props: { step: 0, name: 'welcome' } },
    ]);
  });

  it('a Sidebar resume (skipped → active, same step) emits resumed', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 3, maxVisitedStep: 3 }),
      slice({ status: 'active', step: 3, maxVisitedStep: 3 }),
    );
    expect(events).toEqual([{ name: 'onboarding_resumed', props: { step: 3 } }]);
  });

  it('a realEvent out of pending (pending → active, 7 → 8) reads as a view, not a resume', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'pending', step: 7, maxVisitedStep: 7 }),
      slice({ status: 'active', step: 8, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 8, name: 'ship' } }]);
  });

  it('a skip (active → skipped) records the step abandoned at', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 6, maxVisitedStep: 6 }),
      slice({ status: 'skipped', step: 6, maxVisitedStep: 6 }),
    );
    expect(events).toEqual([{ name: 'onboarding_skipped', props: { step: 6, name: 'model' } }]);
  });

  it('parking (active → pending) is silent', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 8, maxVisitedStep: 8 }),
      slice({ status: 'pending', step: 8, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([]);
  });

  it('completion (active → completed) records the furthest step reached', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 10, maxVisitedStep: 10 }),
      slice({ status: 'completed', step: 10, maxVisitedStep: 10 }),
    );
    expect(events).toEqual([{ name: 'onboarding_completed', props: { furthest_step: 10 } }]);
  });

  it('an idle target (never expected post-boot) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice(), slice({ status: 'idle' }))).toEqual([]);
  });
});
