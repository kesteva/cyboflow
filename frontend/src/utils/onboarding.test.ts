/**
 * utils/onboarding — the neutral constants module the store, the gate, the
 * guided surface, and App's shell gate all read. Covers the shell-hiding
 * predicate (App renders the bare paper shell on it), the skipped-aware progress
 * numbering, the guided-step test, and the analytics slug table's bounds.
 */
import { describe, it, expect } from 'vitest';
import type { OnboardingStatus } from '../stores/onboardingStore';
import {
  ONBOARDING_ADD_PROJECT_STEP,
  ONBOARDING_ASSISTANT_STEPS,
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ONBOARDING_EVENTS,
  ONBOARDING_FIRST_SESSION_STEP,
  ONBOARDING_GUIDED_STEPS,
  ONBOARDING_HANDOFF_STEP,
  ONBOARDING_LAUNCHING_STEP,
  ONBOARDING_MODAL_STEPS,
  ONBOARDING_MODEL_STEP,
  ONBOARDING_PREF_KEY,
  ONBOARDING_PROJECT_DETAIL_STEP,
  ONBOARDING_PROJECT_HOME_STEP,
  ONBOARDING_STEP_COUNT,
  guidedStepNumber,
  guidedStepTotal,
  isGuidedStep,
  isOnboardingShellHidden,
  onboardingGuidedShell,
  onboardingStepName,
  visibleStepNumber,
  visibleStepTotal,
} from './onboarding';

const NONE: ReadonlySet<number> = new Set<number>();
/** The one conditional step, skipped when a single agent candidate was activated. */
const RUNTIME_SKIPPED: ReadonlySet<number> = new Set([ONBOARDING_DEFAULT_RUNTIME_STEP]);

describe('isOnboardingShellHidden', () => {
  it('hides the shell until the persisted snapshot read resolves', () => {
    for (const status of ['idle', 'active', 'skipped', 'completed'] as const) {
      expect(isOnboardingShellHidden({ hydrated: false, status, step: 0 })).toBe(true);
      expect(isOnboardingShellHidden({ hydrated: false, status, step: 12 })).toBe(true);
    }
  });

  it('hides the shell while the tour is active on the modal steps and the two project screens (0-8)', () => {
    for (let step = 0; step < ONBOARDING_PROJECT_HOME_STEP; step++) {
      expect(isOnboardingShellHidden({ hydrated: true, status: 'active', step })).toBe(true);
    }
  });

  it('mounts the shell for the in-shell guided steps (9-14) while the tour is still active', () => {
    for (let step = ONBOARDING_PROJECT_HOME_STEP; step < ONBOARDING_STEP_COUNT; step++) {
      expect(isOnboardingShellHidden({ hydrated: true, status: 'active', step })).toBe(false);
    }
  });

  it('mounts the shell once the tour is skipped, completed, or never started', () => {
    for (const status of ['idle', 'skipped', 'completed'] as const) {
      expect(isOnboardingShellHidden({ hydrated: true, status, step: 3 })).toBe(false);
    }
  });

  it('accepts the store slice shape verbatim', () => {
    const state: { hydrated: boolean; status: OnboardingStatus; step: number } = {
      hydrated: true,
      status: 'skipped',
      step: 4,
    };
    expect(isOnboardingShellHidden(state)).toBe(false);
  });
});

describe('onboardingGuidedShell', () => {
  it("is 'none' unless the tour is active and hydrated", () => {
    expect(onboardingGuidedShell({ hydrated: false, status: 'active', step: 12 })).toBe('none');
    for (const status of ['idle', 'skipped', 'completed'] as const) {
      expect(onboardingGuidedShell({ hydrated: true, status, step: 12 })).toBe('none');
    }
  });

  it("is 'none' on the modal steps and the two bare-paper project screens", () => {
    for (let step = 0; step < ONBOARDING_PROJECT_HOME_STEP; step++) {
      expect(onboardingGuidedShell({ hydrated: true, status: 'active', step })).toBe('none');
    }
  });

  it("is 'sidebar' for 9-11 and 'full' (sidebar + rail) for 12-14", () => {
    for (const step of [9, 10, 11]) {
      expect(onboardingGuidedShell({ hydrated: true, status: 'active', step })).toBe('sidebar');
    }
    for (const step of [12, 13, 14]) {
      expect(onboardingGuidedShell({ hydrated: true, status: 'active', step })).toBe('full');
    }
  });
});

describe('guidedStepTotal / guidedStepNumber (guided screens only)', () => {
  const ASSISTANT_SKIPPED: ReadonlySet<number> = new Set(ONBOARDING_ASSISTANT_STEPS);

  it('numbers the eight guided screens 1-8 when the assistant is on', () => {
    expect(guidedStepTotal(NONE)).toBe(8);
    expect(guidedStepNumber(ONBOARDING_ADD_PROJECT_STEP, NONE)).toBe(1);
    expect(guidedStepNumber(ONBOARDING_PROJECT_HOME_STEP, NONE)).toBe(3);
    expect(guidedStepNumber(ONBOARDING_LAUNCHING_STEP, NONE)).toBe(8);
  });

  it('drops the three assistant screens when the assistant is off (5 screens)', () => {
    expect(guidedStepTotal(ASSISTANT_SKIPPED)).toBe(5);
    expect(guidedStepNumber(ONBOARDING_PROJECT_HOME_STEP, ASSISTANT_SKIPPED)).toBe(3);
    expect(guidedStepNumber(ONBOARDING_FIRST_SESSION_STEP, ASSISTANT_SKIPPED)).toBe(4);
    expect(guidedStepNumber(ONBOARDING_LAUNCHING_STEP, ASSISTANT_SKIPPED)).toBe(5);
  });

  it('the modal-only Default-agent skip does not touch the guided numbering', () => {
    expect(guidedStepTotal(RUNTIME_SKIPPED)).toBe(8);
    expect(guidedStepNumber(ONBOARDING_LAUNCHING_STEP, RUNTIME_SKIPPED)).toBe(8);
  });
});

describe('visibleStepTotal / visibleStepNumber (modal cards only)', () => {
  const MODAL_COUNT = ONBOARDING_MODAL_STEPS.length;

  it('numbers every modal step 1-based when nothing is skipped', () => {
    expect(visibleStepTotal(NONE)).toBe(MODAL_COUNT);
    for (const step of ONBOARDING_MODAL_STEPS) {
      expect(visibleStepNumber(step, NONE)).toBe(step + 1);
    }
  });

  it('drops the skipped Default-agent step from the total and renumbers everything after it', () => {
    expect(visibleStepTotal(RUNTIME_SKIPPED)).toBe(MODAL_COUNT - 1);
    expect(visibleStepNumber(0, RUNTIME_SKIPPED)).toBe(1); // welcome
    expect(visibleStepNumber(1, RUNTIME_SKIPPED)).toBe(2); // connect
    expect(visibleStepNumber(3, RUNTIME_SKIPPED)).toBe(3); // model — "STEP 3 / 6"
    expect(visibleStepNumber(4, RUNTIME_SKIPPED)).toBe(4); // permission
    expect(visibleStepNumber(6, RUNTIME_SKIPPED)).toBe(6); // handoff — "STEP 6 / 6"
  });

  it('reports the position a skipped step WOULD occupy rather than 0 (Back/goTo race a toggle)', () => {
    expect(visibleStepNumber(ONBOARDING_DEFAULT_RUNTIME_STEP, RUNTIME_SKIPPED)).toBe(2);
  });

  it('excludes the guided screens: they report the last modal position, never past it', () => {
    for (const step of ONBOARDING_GUIDED_STEPS) {
      expect(visibleStepNumber(step, NONE)).toBe(MODAL_COUNT);
    }
    expect(visibleStepNumber(99, NONE)).toBe(MODAL_COUNT);
    expect(visibleStepNumber(ONBOARDING_STEP_COUNT - 1, RUNTIME_SKIPPED)).toBe(MODAL_COUNT - 1);
  });
});

describe('isGuidedStep', () => {
  it('is true for exactly the eight full-window set-up screens (7-14)', () => {
    for (let step = ONBOARDING_ADD_PROJECT_STEP; step <= ONBOARDING_LAUNCHING_STEP; step++) {
      expect(isGuidedStep(step)).toBe(true);
    }
    for (const step of [0, 1, 2, 3, 4, 5, ONBOARDING_HANDOFF_STEP, ONBOARDING_STEP_COUNT, -1]) {
      expect(isGuidedStep(step)).toBe(false);
    }
  });
});

describe('onboardingStepName', () => {
  it('maps each index to its slug', () => {
    expect(onboardingStepName(0)).toBe('welcome');
    expect(onboardingStepName(ONBOARDING_DEFAULT_RUNTIME_STEP)).toBe('default_runtime');
    expect(onboardingStepName(ONBOARDING_MODEL_STEP)).toBe('model');
    expect(onboardingStepName(ONBOARDING_HANDOFF_STEP)).toBe('handoff');
    expect(onboardingStepName(ONBOARDING_ADD_PROJECT_STEP)).toBe('add_project');
    expect(onboardingStepName(ONBOARDING_PROJECT_DETAIL_STEP)).toBe('project_detail');
  });

  it('falls back to welcome for an out-of-range index', () => {
    expect(onboardingStepName(ONBOARDING_STEP_COUNT)).toBe('welcome');
    expect(onboardingStepName(-1)).toBe('welcome');
  });
});

describe('module constants', () => {
  it('keeps the frozen preference key (the schema version lives inside the JSON)', () => {
    expect(ONBOARDING_PREF_KEY).toBe('cyboflow_onboarding_state_v1');
  });

  it('exposes only the pre-existing project-created event', () => {
    expect(ONBOARDING_EVENTS).toEqual({ projectCreated: 'project-created' });
  });
});
