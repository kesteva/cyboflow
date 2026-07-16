/**
 * onboardingStore — the pure 12-step tour machine. Covers boot hydration (all
 * four branches) including the version-1 → version-2 snapshot migration (the
 * Telemetry step's insertion at index 3), the step-1 credential gate,
 * coach-step advance-by-doing rules (anchorActioned / realEvent), the
 * Configure pointer steps (6-8: next() advances, the last pointer parks
 * pending), dot/goTo maxVisited clamping, and the skip↔resume round trip. All
 * transitions are synchronous — the async side effects live in OnboardingGate
 * and are not exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ClaudeDetectionResult, CodexDetectionResult } from '../../../../shared/types/onboarding';
import {
  useOnboardingStore,
  isNextGateBlocked,
  migratePersistedOnboarding,
  migrateV1StepIndex,
  clampResumeStep,
} from '../onboardingStore';

const DETECTED: ClaudeDetectionResult = {
  credentials: { found: true, source: 'keychain', account: 'a@b.co' },
  binary: { found: true, path: '/usr/bin/claude', version: 'v1.4.2' },
  state: 'detected',
};

const CODEX_DETECTED: CodexDetectionResult = {
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
  state: 'detected',
};

function reset(): void {
  useOnboardingStore.setState({
    status: 'idle',
    step: 0,
    maxVisitedStep: 0,
    replay: false,
    detection: null,
    connected: false,
    codexDetection: null,
    codexConnected: false,
    permMode: 'auto',
    hydrated: false,
  });
}

const s = () => useOnboardingStore.getState();

describe('onboardingStore — hydrate', () => {
  beforeEach(reset);

  it('pristine install (no snapshot, no projects) starts the tour active at step 0', () => {
    s().hydrate(null, 0);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().maxVisitedStep).toBe(0);
    expect(s().hydrated).toBe(true);
  });

  it('existing install (no snapshot, projects present) is marked completed without showing the tour', () => {
    s().hydrate(null, 3);
    expect(s().status).toBe('completed');
    expect(s().hydrated).toBe(true);
  });

  it('a completed snapshot stays completed', () => {
    s().hydrate({ version: 1, status: 'completed', step: 10 }, 0);
    expect(s().status).toBe('completed');
  });

  it('v1 snapshots on the old context-bound coach steps (5-8, migrating to new 6-9) resume clamped to 5', () => {
    for (const step of [5, 6, 7, 8]) {
      reset();
      s().hydrate({ version: 1, status: 'active', step }, 1);
      expect(s().status).toBe('skipped');
      expect(s().step).toBe(5);
      expect(s().maxVisitedStep).toBe(5);
    }
  });

  it('a mid-tour snapshot on step 10 (rail anchor always exists) keeps that step', () => {
    s().hydrate({ version: 1, status: 'active', step: 9 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(10);
  });

  it('a mid-tour snapshot on a modal step keeps that step', () => {
    s().hydrate({ version: 1, status: 'pending', step: 3 }, 0);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(4);
  });
});

describe('onboardingStore — v1 → v2 snapshot migration', () => {
  beforeEach(reset);

  it('migrateV1StepIndex leaves the unmoved prefix (0-2) unchanged', () => {
    expect(migrateV1StepIndex(0)).toBe(0);
    expect(migrateV1StepIndex(1)).toBe(1);
    expect(migrateV1StepIndex(2)).toBe(2);
  });

  it('migrateV1StepIndex shifts old index 3 onward forward by one', () => {
    expect(migrateV1StepIndex(3)).toBe(4); // old Add project → new Add project
    expect(migrateV1StepIndex(10)).toBe(11); // old Rail map → new Rail map
  });

  it('migratePersistedOnboarding is a no-op for an already-v2 snapshot', () => {
    const v2 = { version: 2 as const, status: 'active' as const, step: 4 };
    expect(migratePersistedOnboarding(v2)).toEqual(v2);
  });

  it('migratePersistedOnboarding leaves a v1 completed snapshot completed, step untouched', () => {
    const migrated = migratePersistedOnboarding({ version: 1, status: 'completed', step: 10 });
    expect(migrated).toEqual({ version: 2, status: 'completed', step: 10 });
  });

  it('migratePersistedOnboarding remaps a v1 active/pending/skipped snapshot at the 0-2 boundary unchanged', () => {
    for (const step of [0, 1, 2]) {
      const migrated = migratePersistedOnboarding({ version: 1, status: 'active', step });
      expect(migrated).toEqual({ version: 2, status: 'active', step });
    }
  });

  it('migratePersistedOnboarding remaps a v1 snapshot at index 3 (old Add project → new index 4)', () => {
    const migrated = migratePersistedOnboarding({ version: 1, status: 'pending', step: 3 });
    expect(migrated).toEqual({ version: 2, status: 'pending', step: 4 });
  });

  it('migratePersistedOnboarding remaps a v1 snapshot at index 10 (old Rail map → new index 11)', () => {
    const migrated = migratePersistedOnboarding({ version: 1, status: 'skipped', step: 10 });
    expect(migrated).toEqual({ version: 2, status: 'skipped', step: 11 });
  });

  it('hydrate migrates a v1 snapshot end-to-end before clamping (old step 3 → new 4, kept)', () => {
    s().hydrate({ version: 1, status: 'active', step: 3 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(4);
    expect(s().maxVisitedStep).toBe(4);
  });

  it('hydrate migrates a v1 snapshot on an old context-bound coach step (old 7 → new 8, clamped to 5)', () => {
    // old step 7 (last Configure pointer) → new step 8, which falls inside the
    // 6-9 context-bound clamp range and resumes at 5.
    s().hydrate({ version: 1, status: 'active', step: 7 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('hydrate migrates a v1 snapshot on old step 10 (rail map, unaffected by the clamp) to new 11', () => {
    s().hydrate({ version: 1, status: 'active', step: 10 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(11);
  });

  it('clampResumeStep still clamps out-of-range values to the valid 0-11 window', () => {
    expect(clampResumeStep(-1)).toBe(0);
    expect(clampResumeStep(99)).toBe(11);
  });

  it('hydrate accepts a v2 snapshot directly, applying only the clamp (not the v1 shift)', () => {
    s().hydrate({ version: 2, status: 'active', step: 4 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(4); // NOT shifted again — already the new-schema index
  });
});

describe('onboardingStore — step-1 gate', () => {
  beforeEach(reset);

  it('isNextGateBlocked accepts either detected and enabled provider', () => {
    expect(isNextGateBlocked({
      step: 1,
      detection: null,
      connected: false,
      codexDetection: null,
      codexConnected: false,
    })).toBe(true);
    expect(isNextGateBlocked({
      step: 1,
      detection: DETECTED,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    })).toBe(true);
    expect(isNextGateBlocked({
      step: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: null,
      codexConnected: false,
    })).toBe(false);
    expect(isNextGateBlocked({
      step: 1,
      detection: null,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    })).toBe(false);
    // Non-step-1 is never gated.
    expect(isNextGateBlocked({
      step: 0,
      detection: null,
      connected: false,
      codexDetection: null,
      codexConnected: false,
    })).toBe(false);
  });

  it('next() is a no-op on step 1 while the gate is closed, and advances once open', () => {
    useOnboardingStore.setState({ status: 'active', step: 1, maxVisitedStep: 1, detection: DETECTED, connected: false });
    s().next();
    expect(s().step).toBe(1);
    s().setConnected(true);
    s().next();
    expect(s().step).toBe(2);
    expect(s().maxVisitedStep).toBe(2);
  });

  it('next() advances with Codex enabled even when Claude is unavailable', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: null,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    });
    s().next();
    expect(s().step).toBe(2);
  });
});

describe('onboardingStore — coach steps advance by doing', () => {
  beforeEach(reset);

  it('next() never advances a do-step (5, 9, 10)', () => {
    for (const step of [5, 9, 10]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().next();
      expect(s().step).toBe(step);
      expect(s().status).toBe('active');
    }
  });

  it('anchorActioned on step 5 advances straight to the first Configure pointer (6)', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(6);
    expect(s().maxVisitedStep).toBe(6);
  });

  it('anchorActioned on step 9 parks pending', () => {
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 9 });
    s().anchorActioned();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(9);
  });

  it('anchorActioned on step 10 jumps straight to the rail map (step 11)', () => {
    useOnboardingStore.setState({ status: 'active', step: 10, maxVisitedStep: 10 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(11);
    expect(s().maxVisitedStep).toBe(11);
  });

  it('anchorActioned is a no-op on pointer steps', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(6);
  });

  it('realEvent lands the matching next step from pending', () => {
    useOnboardingStore.setState({ status: 'pending', step: 8, maxVisitedStep: 8 });
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(9);

    useOnboardingStore.setState({ status: 'pending', step: 9, maxVisitedStep: 9 });
    s().realEvent('workflow-run-started');
    expect(s().step).toBe(10);

    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().realEvent('project-created');
    expect(s().step).toBe(5);
  });

  it('quick-session-created advances from ANY Configure-page step (5-8)', () => {
    for (const step of [5, 6, 7, 8]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().realEvent('quick-session-created');
      expect(s().status).toBe('active');
      expect(s().step).toBe(9);
    }
  });

  it('realEvent ignores wrong-step / wrong-kind signals', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().realEvent('workflow-run-started'); // wrong kind for step 5
    expect(s().step).toBe(5);

    useOnboardingStore.setState({ status: 'skipped', step: 5, maxVisitedStep: 5 });
    s().realEvent('quick-session-created'); // not active/pending
    expect(s().step).toBe(5);
    expect(s().status).toBe('skipped');
  });
});

describe('onboardingStore — Configure pointer steps (6-8)', () => {
  beforeEach(reset);

  it('next() advances pointer steps 6 → 7 → 8', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().next();
    expect(s().step).toBe(7);
    s().next();
    expect(s().step).toBe(8);
    expect(s().maxVisitedStep).toBe(8);
  });

  it('next() on the last pointer (8) parks pending until the session launches', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8 });
    s().next();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(8);
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(9);
  });

  it('next() on step 8 advances normally when step 9 was already reached (revisit)', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 10 });
    s().next();
    expect(s().status).toBe('active');
    expect(s().step).toBe(9);
  });
});

describe('onboardingStore — forceNext (anchor-lost escape)', () => {
  beforeEach(reset);

  it('force-advances a do-step that next() refuses (5 → 6)', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().next();
    expect(s().step).toBe(5); // next() is a no-op on the do-step
    s().forceNext();
    expect(s().step).toBe(6);
    expect(s().maxVisitedStep).toBe(6);
  });

  it('force-advances the later do-steps (9 → 10, 10 → 11)', () => {
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 9 });
    s().forceNext();
    expect(s().step).toBe(10);
    useOnboardingStore.setState({ status: 'active', step: 10, maxVisitedStep: 10 });
    s().forceNext();
    expect(s().step).toBe(11);
    expect(s().maxVisitedStep).toBe(11);
  });

  it('is a no-op unless active', () => {
    useOnboardingStore.setState({ status: 'pending', step: 9, maxVisitedStep: 9 });
    s().forceNext();
    expect(s().step).toBe(9);
    expect(s().status).toBe('pending');
  });

  it('completes from the last step', () => {
    useOnboardingStore.setState({ status: 'active', step: 11, maxVisitedStep: 11 });
    s().forceNext();
    expect(s().status).toBe('completed');
  });
});

describe('onboardingStore — goTo / skip / resume', () => {
  beforeEach(reset);

  it('goTo only revisits steps within maxVisited and ignores the current step', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().goTo(5); // beyond maxVisited
    expect(s().step).toBe(3);
    s().goTo(3); // same step
    expect(s().step).toBe(3);
    s().goTo(1); // reachable
    expect(s().step).toBe(1);
  });

  it('skip then resume round-trips to the same step', () => {
    useOnboardingStore.setState({ status: 'active', step: 2, maxVisitedStep: 2 });
    s().skip();
    expect(s().status).toBe('skipped');
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(2);
  });

  it('skip then resume round-trips on the new Telemetry step (3)', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().skip();
    expect(s().status).toBe('skipped');
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(3); // modal step, never disconnects — no clamp
  });

  it('resume from a live coach pending step returns to the SAME step (steps 9-10 keep place)', () => {
    useOnboardingStore.setState({ status: 'pending', step: 9, maxVisitedStep: 9 });
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(9);
  });

  it('resume from a Configure pointer (6-8) clamps to step 5 to rebuild the wizard', () => {
    for (const step of [6, 7, 8]) {
      reset();
      useOnboardingStore.setState({ status: 'skipped', step, maxVisitedStep: 8 });
      s().resume();
      expect(s().status).toBe('active');
      expect(s().step).toBe(5);
      expect(s().maxVisitedStep).toBe(5); // reset so dots can't jump back onto missing anchors
    }
  });

  it('resume clamps a Configure pointer from pending too', () => {
    useOnboardingStore.setState({ status: 'pending', step: 7, maxVisitedStep: 7 });
    s().resume();
    expect(s().step).toBe(5);
  });

  it('dismiss permanently completes the tour from skipped or pending', () => {
    for (const status of ['skipped', 'pending'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 7, maxVisitedStep: 7 });
      s().dismiss();
      expect(s().status).toBe('completed');
      expect(s().step).toBe(7); // step kept for the persisted snapshot + telemetry
    }
  });

  it('dismiss is a no-op unless skipped/pending (never from an active tour)', () => {
    for (const status of ['active', 'idle', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 5, maxVisitedStep: 5 });
      s().dismiss();
      expect(s().status).toBe(status);
    }
  });

  it('begin resets provider detection + consent for a clean replay', () => {
    useOnboardingStore.setState({
      status: 'skipped',
      step: 10,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
      permMode: 'dontAsk',
    });
    s().begin(true);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().replay).toBe(true);
    expect(s().detection).toBeNull();
    expect(s().connected).toBe(false);
    expect(s().codexDetection).toBeNull();
    expect(s().codexConnected).toBe(false);
    expect(s().permMode).toBe('auto');
  });
});

describe('onboardingStore — Telemetry step (3)', () => {
  beforeEach(reset);

  it('next() advances Permission → Telemetry → Add project like any other modal step', () => {
    useOnboardingStore.setState({ status: 'active', step: 2, maxVisitedStep: 2 });
    s().next();
    expect(s().step).toBe(3);
    s().next();
    expect(s().step).toBe(4);
    expect(s().maxVisitedStep).toBe(4);
  });

  it('back() from Telemetry (3) returns to Permission (2)', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().back();
    expect(s().step).toBe(2);
  });

  it('goTo reaches the Telemetry step once visited', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().goTo(3);
    expect(s().step).toBe(3);
  });

  it('is included in ONBOARDING_MODAL_STEPS, not the coach/pointer sets', async () => {
    const { ONBOARDING_MODAL_STEPS, ONBOARDING_COACH_STEPS, ONBOARDING_POINTER_STEPS } = await import('../../utils/onboarding');
    expect(ONBOARDING_MODAL_STEPS).toContain(3);
    expect(ONBOARDING_COACH_STEPS).not.toContain(3);
    expect(ONBOARDING_POINTER_STEPS).not.toContain(3);
  });
});
