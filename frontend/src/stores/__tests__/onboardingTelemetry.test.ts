/**
 * onboardingTelemetry — the pure transition→usage-event mapper. Exercises the
 * full 9-step funnel: the pristine boot entry, per-step views (the seven modal
 * cards AND the two guided set-up screens), the Settings replay start, the
 * Sidebar resume/dismiss pair, skip/abandon, and the three ways a run completes
 * (handoff "Skip the set-up", add-project "Not sure yet", the project finale).
 * All the async firing lives in OnboardingGate and is not exercised here.
 */
import { describe, it, expect } from 'vitest';
import { onboardingTelemetryEvents, type OnboardingTelemetrySlice } from '../onboardingTelemetry';
import {
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEP_NAMES,
  ONBOARDING_MODAL_STEPS,
  ONBOARDING_GUIDED_STEPS,
} from '../../utils/onboarding';

/** A hydrated 'active' slice at a given step, overridable per field. */
function slice(over: Partial<OnboardingTelemetrySlice> = {}): OnboardingTelemetrySlice {
  return { status: 'active', step: 0, maxVisitedStep: 0, replay: false, hydrated: true, ...over };
}

describe('onboardingTelemetry — step-name table', () => {
  it('has exactly 15 entries, one stable slug per tour step', () => {
    expect(ONBOARDING_STEP_COUNT).toBe(15);
    expect(ONBOARDING_STEP_NAMES).toHaveLength(15);
    expect(new Set(ONBOARDING_STEP_NAMES).size).toBe(ONBOARDING_STEP_COUNT);
  });

  it('matches the full stable 15-step order end to end', () => {
    expect(ONBOARDING_STEP_NAMES).toEqual([
      'welcome', // 0
      'connect', // 1
      'default_runtime', // 2
      'model', // 3
      'permission', // 4
      'telemetry', // 5
      'handoff', // 6
      'add_project', // 7
      'project_detail', // 8
      'project_home', // 9
      'first_idea', // 10
      'idea_proposals', // 11
      'assistant_rail', // 12
      'first_session', // 13
      'launching', // 14
    ]);
  });

  it('carries the Model slug at index 3, between the Default-agent and Permission steps', () => {
    expect(ONBOARDING_STEP_NAMES[2]).toBe('default_runtime');
    expect(ONBOARDING_STEP_NAMES[3]).toBe('model');
    expect(ONBOARDING_STEP_NAMES[4]).toBe('permission');
  });

  it('drops every retired coachmark slug', () => {
    for (const gone of ['quick_session', 'substrate', 'session_permission', 'ship', 'human_review', 'rail_map']) {
      expect(ONBOARDING_STEP_NAMES).not.toContain(gone);
    }
  });
});

describe('onboardingTelemetry — step-group constants (modal/guided)', () => {
  it('ONBOARDING_MODAL_STEPS is exactly the seven modal-card steps', () => {
    expect(ONBOARDING_MODAL_STEPS).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('ONBOARDING_GUIDED_STEPS is exactly the eight full-window set-up screens', () => {
    expect(ONBOARDING_GUIDED_STEPS).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('modal and guided sets partition the 15 steps with no overlap and no gaps', () => {
    const all = [...ONBOARDING_MODAL_STEPS, ...ONBOARDING_GUIDED_STEPS].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => i));
    expect(new Set(all).size).toBe(ONBOARDING_STEP_COUNT);
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

  it('a mid-tour snapshot resolving to skipped emits nothing', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      { status: 'skipped', step: 5, maxVisitedStep: 5, replay: false, hydrated: true },
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
    const events = onboardingTelemetryEvents(
      slice({ step: 3, maxVisitedStep: 3 }),
      slice({ step: 2, maxVisitedStep: 3 }),
    );
    expect(events).toEqual([
      { name: 'onboarding_step_viewed', props: { step: 2, name: 'default_runtime' } },
    ]);
  });

  it('every step index maps to its named view — the guided screens included', () => {
    for (let step = 1; step < ONBOARDING_STEP_COUNT; step++) {
      const events = onboardingTelemetryEvents(slice({ step: step - 1 }), slice({ step, maxVisitedStep: step }));
      expect(events).toEqual([
        { name: 'onboarding_step_viewed', props: { step, name: ONBOARDING_STEP_NAMES[step] } },
      ]);
    }
  });

  it('the handoff → guided hand-off (6 → 7) and the detail advance (7 → 8) each emit one view', () => {
    expect(onboardingTelemetryEvents(slice({ step: 6, maxVisitedStep: 6 }), slice({ step: 7, maxVisitedStep: 7 })))
      .toEqual([{ name: 'onboarding_step_viewed', props: { step: 7, name: 'add_project' } }]);
    expect(onboardingTelemetryEvents(slice({ step: 7, maxVisitedStep: 7 }), slice({ step: 8, maxVisitedStep: 8 })))
      .toEqual([{ name: 'onboarding_step_viewed', props: { step: 8, name: 'project_detail' } }]);
  });

  it('a Connect advance that steps OVER the skipped Default-agent step (1 → 3) emits only the landed view', () => {
    const events = onboardingTelemetryEvents(
      slice({ step: 1, maxVisitedStep: 1 }),
      slice({ step: 3, maxVisitedStep: 3 }),
    );
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 3, name: 'model' } }]);
  });

  it('a no-op transition (same status, same step) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice({ step: 3 }), slice({ step: 3 }))).toEqual([]);
  });
});

describe('onboardingTelemetry — lifecycle', () => {
  it('the Settings replay (→ active, step 0, maxVisited 0, replay) emits started:replay + view', () => {
    const events = onboardingTelemetryEvents(
      { status: 'completed', step: 8, maxVisitedStep: 8, replay: false, hydrated: true },
      slice({ status: 'active', step: 0, maxVisitedStep: 0, replay: true }),
    );
    expect(events).toEqual([
      { name: 'onboarding_started', props: { trigger: 'replay' } },
      { name: 'onboarding_step_viewed', props: { step: 0, name: 'welcome' } },
    ]);
  });

  it('a Sidebar resume (skipped → active, same step) emits resumed', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 4, maxVisitedStep: 4 }),
      slice({ status: 'active', step: 4, maxVisitedStep: 4 }),
    );
    expect(events).toEqual([{ name: 'onboarding_resumed', props: { step: 4 } }]);
  });

  it('a clamping resume (skipped → active, 8 → 7) still emits resumed, not a step view', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 8, maxVisitedStep: 8 }),
      slice({ status: 'active', step: 7, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([{ name: 'onboarding_resumed', props: { step: 7 } }]);
  });

  it('a skip records the step abandoned at, guided screens included', () => {
    expect(
      onboardingTelemetryEvents(
        slice({ status: 'active', step: 5, maxVisitedStep: 5 }),
        slice({ status: 'skipped', step: 5, maxVisitedStep: 5 }),
      ),
    ).toEqual([{ name: 'onboarding_skipped', props: { step: 5, name: 'telemetry' } }]);

    expect(
      onboardingTelemetryEvents(
        slice({ status: 'active', step: 8, maxVisitedStep: 8 }),
        slice({ status: 'skipped', step: 8, maxVisitedStep: 8 }),
      ),
    ).toEqual([{ name: 'onboarding_skipped', props: { step: 8, name: 'project_detail' } }]);
  });

  it('a skip on the Model step (3) records its own slug', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 3, maxVisitedStep: 3 }),
      slice({ status: 'skipped', step: 3, maxVisitedStep: 3 }),
    );
    expect(events).toEqual([{ name: 'onboarding_skipped', props: { step: 3, name: 'model' } }]);
  });

  it('the handoff early exit (active step 6 → completed) records the furthest step reached', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 6, maxVisitedStep: 6 }),
      slice({ status: 'completed', step: 6, maxVisitedStep: 6 }),
    );
    expect(events).toEqual([{ name: 'onboarding_completed', props: { furthest_step: 6 } }]);
  });

  it('the "Not sure yet" exit (active step 7 → completed) is a completion too', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 7, maxVisitedStep: 7 }),
      slice({ status: 'completed', step: 7, maxVisitedStep: 7 }),
    );
    expect(events).toEqual([{ name: 'onboarding_completed', props: { furthest_step: 7 } }]);
  });

  it('the project finale (finish() from step 8) completes with the full furthest step', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 8, maxVisitedStep: 8 }),
      slice({ status: 'completed', step: 8, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([{ name: 'onboarding_completed', props: { furthest_step: 8 } }]);
  });

  it('a Sidebar dismiss (skipped → completed) is a dismiss, not a completion', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 6, maxVisitedStep: 6 }),
      slice({ status: 'completed', step: 6, maxVisitedStep: 6 }),
    );
    expect(events).toEqual([{ name: 'onboarding_dismissed', props: { step: 6, name: 'handoff' } }]);
  });

  it('an idle target (never expected post-boot) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice(), slice({ status: 'idle' }))).toEqual([]);
  });
});
