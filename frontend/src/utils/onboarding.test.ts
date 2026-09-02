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
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ONBOARDING_EVENTS,
  ONBOARDING_GUIDED_STEPS,
  ONBOARDING_HANDOFF_STEP,
  ONBOARDING_MODAL_STEPS,
  ONBOARDING_MODEL_STEP,
  ONBOARDING_PREF_KEY,
  ONBOARDING_PROJECT_DETAIL_STEP,
  ONBOARDING_STEP_COUNT,
  isGuidedStep,
  isOnboardingShellHidden,
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
      expect(isOnboardingShellHidden({ hydrated: false, status })).toBe(true);
    }
  });

  it('hides the shell while the tour is active (modal AND guided phases)', () => {
    expect(isOnboardingShellHidden({ hydrated: true, status: 'active' })).toBe(true);
  });

  it('mounts the shell once the tour is skipped, completed, or never started', () => {
    for (const status of ['idle', 'skipped', 'completed'] as const) {
      expect(isOnboardingShellHidden({ hydrated: true, status })).toBe(false);
    }
  });

  it('accepts the store slice shape verbatim', () => {
    const state: { hydrated: boolean; status: OnboardingStatus } = { hydrated: true, status: 'skipped' };
    expect(isOnboardingShellHidden(state)).toBe(false);
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
  it('is true for exactly the two full-window set-up screens', () => {
    expect(isGuidedStep(ONBOARDING_ADD_PROJECT_STEP)).toBe(true);
    expect(isGuidedStep(ONBOARDING_PROJECT_DETAIL_STEP)).toBe(true);
    for (const step of [0, 1, 2, 3, 4, 5, ONBOARDING_HANDOFF_STEP, 9, -1]) {
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
