/**
 * onboardingStore — the pure 9-step tour machine (7 modal cards + 2 guided
 * set-up screens). Covers boot hydration (all branches) including the
 * version-1 → 2 → 3 → 4 snapshot migrations, the step-1 credential gate, the
 * CONDITIONAL Default-agent step (shown only when Connect left 2+ of
 * {claude, codex} activated — OMP never counts), the step-3 model/effort
 * selections, both early exits (handoff "Skip the set-up", add-project "Not sure
 * yet"), the guided step-8 rules (next() is inert; finish() completes), dot/goTo
 * maxVisited clamping, and the skip↔resume round trip. All transitions are
 * synchronous — the async side effects live in OnboardingGate and the guided
 * surface, and are not exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ClaudeDetectionResult,
  CodexDetectionResult,
  ProviderDetectionResult,
} from '../../../../shared/types/onboarding';
import {
  useOnboardingStore,
  activatedProviders,
  defaultAgentCandidates,
  isNextGateBlocked,
  isStepSkipped,
  migratePersistedOnboarding,
  migrateV1StepIndex,
  migrateV2StepIndex,
  migrateV3StepIndex,
  skippedStepSet,
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

const OMP_DETECTED: ProviderDetectionResult<'omp'> = {
  binaryPath: '/usr/local/bin/omp',
  version: '0.9.1',
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
    ompDetection: null,
    ompConnected: false,
    permMode: 'auto',
    defaultProvider: null,
    multiRuntime: true,
    defaultModel: null,
    defaultEffort: null,
    modelPhase: 'model',
    handoffChoice: 'continue',
    projectChoice: 'existing',
    guidedProject: null,
    assistantAvailable: true,
    sessionChoice: 'planner',
    launched: null,
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

  it('a completed snapshot stays completed (the project count is never consulted)', () => {
    s().hydrate({ version: 4, status: 'completed', step: 8 }, 0);
    expect(s().status).toBe('completed');
    expect(s().hydrated).toBe(true);
  });

  it('a completed v1 snapshot stays completed', () => {
    s().hydrate({ version: 1, status: 'completed', step: 10 }, 0);
    expect(s().status).toBe('completed');
  });

  it('a mid-tour v4 snapshot resumes as skipped at the same step', () => {
    s().hydrate({ version: 4, status: 'active', step: 5 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('a snapshot parked on a guided screen hydrates as skipped at the clamped step (resumable)', () => {
    for (const [step, expected] of [[7, 7], [8, 7], [12, 7], [14, 7]] as const) {
      for (const status of ['active', 'skipped'] as const) {
        reset();
        s().hydrate({ version: 4, status, step }, 0);
        expect(s().status).toBe('skipped');
        expect(s().step).toBe(expected);
      }
    }
  });

  it('a legacy pending snapshot hydrates as skipped', () => {
    s().hydrate({ version: 3, status: 'pending', step: 4 }, 0);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(5); // v3 telemetry (4) → v4 telemetry (5)
  });

  it('a v1 mid-tour snapshot migrates end to end before clamping (old 3 → new 6)', () => {
    // v1 step 3 (Add project) → v2 4 → v3 5 → v4 6 (the handoff step).
    s().hydrate({ version: 1, status: 'active', step: 3 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(6);
    expect(s().maxVisitedStep).toBe(6);
  });

  it('hydrate marks the boot gate resolved on every branch', () => {
    for (const call of [
      () => s().hydrate(null, 0),
      () => s().hydrate(null, 2),
      () => s().hydrate({ version: 4, status: 'completed', step: 3 }, 0),
      () => s().hydrate({ version: 4, status: 'skipped', step: 3 }, 0),
    ]) {
      reset();
      call();
      expect(s().hydrated).toBe(true);
    }
  });
});

describe('onboardingStore — snapshot migration', () => {
  it('migrateV1StepIndex leaves the unmoved prefix (0-2) unchanged and shifts 3 onward', () => {
    expect(migrateV1StepIndex(0)).toBe(0);
    expect(migrateV1StepIndex(2)).toBe(2);
    expect(migrateV1StepIndex(3)).toBe(4);
    expect(migrateV1StepIndex(10)).toBe(11);
  });

  it('migrateV2StepIndex leaves the unmoved prefix (0-1) unchanged and shifts 2 onward', () => {
    expect(migrateV2StepIndex(0)).toBe(0);
    expect(migrateV2StepIndex(1)).toBe(1);
    expect(migrateV2StepIndex(2)).toBe(3);
    expect(migrateV2StepIndex(11)).toBe(12);
  });

  it('migrateV3StepIndex keeps 0-2, shifts permission/telemetry, and folds everything else onto the handoff step', () => {
    expect(migrateV3StepIndex(0)).toBe(0);
    expect(migrateV3StepIndex(1)).toBe(1);
    expect(migrateV3StepIndex(2)).toBe(2);
    expect(migrateV3StepIndex(3)).toBe(4); // permission
    expect(migrateV3StepIndex(4)).toBe(5); // telemetry
    expect(migrateV3StepIndex(5)).toBe(6); // old add-project modal
    expect(migrateV3StepIndex(9)).toBe(6); // old model coachmark
    expect(migrateV3StepIndex(12)).toBe(6); // old rail map
  });

  it('migratePersistedOnboarding is a no-op for an already-v4 snapshot', () => {
    const v4 = { version: 4 as const, status: 'active' as const, step: 5 };
    expect(migratePersistedOnboarding(v4)).toEqual(v4);
  });

  it('migratePersistedOnboarding walks a v1 snapshot through every remap', () => {
    // 0/1 predate all three insertions. v1 2 (Permission) is shifted by v2→v3 to
    // 3, then by v3→v4 to 4. v1 3 (Add project) is shifted by v1→v2 to 4 and by
    // v2→v3 to 5, which v3→v4 folds onto the handoff step.
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 0 })).toEqual({
      version: 4,
      status: 'active',
      step: 0,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 2 })).toEqual({
      version: 4,
      status: 'active',
      step: 4,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 3 })).toEqual({
      version: 4,
      status: 'active',
      step: 6,
    });
  });

  it('migratePersistedOnboarding applies only the v3→v4 remap to a v3 snapshot', () => {
    const table: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 5],
      [5, 6],
      [9, 6],
      [12, 6],
    ];
    for (const [from, to] of table) {
      expect(migratePersistedOnboarding({ version: 3, status: 'skipped', step: from })).toEqual({
        version: 4,
        status: 'skipped',
        step: to,
      });
    }
  });

  it('migratePersistedOnboarding applies both later remaps to a v2 snapshot', () => {
    // v2 1 → v3 1 → v4 1; v2 2 → v3 3 → v4 4 (permission).
    expect(migratePersistedOnboarding({ version: 2, status: 'active', step: 1 })).toEqual({
      version: 4,
      status: 'active',
      step: 1,
    });
    expect(migratePersistedOnboarding({ version: 2, status: 'active', step: 2 })).toEqual({
      version: 4,
      status: 'active',
      step: 4,
    });
  });

  it('migratePersistedOnboarding folds the retired pending status into skipped', () => {
    expect(migratePersistedOnboarding({ version: 3, status: 'pending', step: 9 })).toEqual({
      version: 4,
      status: 'skipped',
      step: 6,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'pending', step: 3 })).toEqual({
      version: 4,
      status: 'skipped',
      step: 6,
    });
  });

  it('migratePersistedOnboarding leaves a completed snapshot completed, step UNTOUCHED', () => {
    for (const version of [1, 2, 3] as const) {
      expect(migratePersistedOnboarding({ version, status: 'completed', step: 12 })).toEqual({
        version: 4,
        status: 'completed',
        step: 12,
      });
    }
    // Right on (and just below) an old shift boundary, where a regression to
    // "always remap" would surface first.
    expect(migratePersistedOnboarding({ version: 1, status: 'completed', step: 3 })).toEqual({
      version: 4,
      status: 'completed',
      step: 3,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'completed', step: 2 })).toEqual({
      version: 4,
      status: 'completed',
      step: 2,
    });
  });

  it('clampResumeStep sends every guided screen past the branch choice (8-14) back to it', () => {
    for (const step of [8, 9, 10, 11, 12, 13, 14]) {
      expect(clampResumeStep(step)).toBe(7);
    }
  });

  it('clampResumeStep passes every other in-window step through', () => {
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(clampResumeStep(step)).toBe(step);
    }
  });

  it('clampResumeStep clamps out-of-range values into the 0-14 window', () => {
    expect(clampResumeStep(-1)).toBe(0);
    expect(clampResumeStep(99)).toBe(14);
  });
});

describe('onboardingStore — step-1 gate', () => {
  beforeEach(reset);

  it('isNextGateBlocked accepts either detected AND enabled provider', () => {
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
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: false,
    });
    s().next();
    expect(s().step).toBe(1);
    s().setConnected(true);
    s().next();
    // One candidate ⇒ the Default-agent step (2) is skipped; Model (3) is next.
    expect(s().step).toBe(3);
    expect(s().maxVisitedStep).toBe(3);
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
    expect(s().step).toBe(3);
  });
});

describe('onboardingStore — the conditional Default-agent step (2)', () => {
  beforeEach(reset);

  it('activatedProviders counts only providers that are BOTH detected and toggled on', () => {
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: true,
        codexDetection: CODEX_DETECTED,
        codexConnected: true,
        ompDetection: OMP_DETECTED,
        ompConnected: true,
      }),
    ).toEqual(['claude', 'codex', 'omp']);

    // Toggled on but never detected — a stale access map seeding a vanished
    // binary must not offer itself as "your default agent".
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: true,
        codexDetection: {
          state: 'unavailable',
          runtime: { found: false, path: null, version: null },
          account: { found: false, email: null, planType: null },
        },
        codexConnected: true,
        ompDetection: null,
        ompConnected: false,
      }),
    ).toEqual(['claude']);

    // Detected but toggled off.
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: false,
        codexDetection: CODEX_DETECTED,
        codexConnected: true,
        ompDetection: null,
        ompConnected: false,
      }),
    ).toEqual(['codex']);
  });

  it('defaultAgentCandidates drops OMP from the activated list', () => {
    expect(
      defaultAgentCandidates({
        detection: DETECTED,
        connected: true,
        codexDetection: CODEX_DETECTED,
        codexConnected: true,
        ompDetection: OMP_DETECTED,
        ompConnected: true,
      }),
    ).toEqual(['claude', 'codex']);

    expect(
      defaultAgentCandidates({
        detection: DETECTED,
        connected: true,
        codexDetection: null,
        codexConnected: false,
        ompDetection: OMP_DETECTED,
        ompConnected: true,
      }),
    ).toEqual(['claude']);
  });

  it('next() from Connect lands on step 2 when BOTH claude and codex are activated', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    });
    s().next();
    expect(s().step).toBe(2);
    expect(s().multiRuntime).toBe(true);
    s().next();
    expect(s().step).toBe(3);
  });

  it('multiRuntime IGNORES OMP — claude + omp is a single-candidate run', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      ompDetection: OMP_DETECTED,
      ompConnected: true,
      multiRuntime: true,
    });
    s().next();
    expect(s().multiRuntime).toBe(false);
    expect(s().step).toBe(3); // stepped straight over the Default-agent question
    expect(isStepSkipped(2, s())).toBe(true);
  });

  it('next() from Connect steps OVER step 2 with a single activated provider', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    });
    s().next();
    expect(s().step).toBe(3);
    expect(s().multiRuntime).toBe(false);
  });

  it('back() from Model steps over a skipped step 2 and lands on Connect', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3, multiRuntime: false });
    s().back();
    expect(s().step).toBe(1);
  });

  it('back() from Model lands on step 2 when it IS part of this run', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3, multiRuntime: true });
    s().back();
    expect(s().step).toBe(2);
  });

  it('goTo refuses the skipped step 2 even inside maxVisited', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4, multiRuntime: false });
    s().goTo(2);
    expect(s().step).toBe(4);
    s().goTo(1);
    expect(s().step).toBe(1);
  });

  it('the decision is re-made every time Connect is left, so enabling Codex brings the step back', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    });
    s().next();
    expect(s().step).toBe(3);
    expect(s().multiRuntime).toBe(false);

    s().goTo(1);
    s().setCodexConnected(true);
    s().next();
    expect(s().step).toBe(2);
    expect(s().multiRuntime).toBe(true);
  });

  it('skippedStepSet returns a stable identity per mode (no fresh Set per read)', () => {
    useOnboardingStore.setState({ multiRuntime: false });
    expect(skippedStepSet(s())).toBe(skippedStepSet(s()));
    expect([...skippedStepSet(s())]).toEqual([2]);
    useOnboardingStore.setState({ multiRuntime: true });
    expect(skippedStepSet(s()).size).toBe(0);
  });

  it('setDefaultProvider records the step-2 selection', () => {
    s().setDefaultProvider('codex');
    expect(s().defaultProvider).toBe('codex');
    s().setDefaultProvider(null);
    expect(s().defaultProvider).toBeNull();
  });
});

describe('onboardingStore — the Model step (3)', () => {
  beforeEach(reset);

  it('records the model, the effort, and the two-phase card state', () => {
    expect(s().defaultModel).toBeNull();
    expect(s().defaultEffort).toBeNull();
    expect(s().modelPhase).toBe('model');

    s().setDefaultModel('opus');
    s().setModelPhase('effort');
    s().setDefaultEffort('high');
    expect(s().defaultModel).toBe('opus');
    expect(s().modelPhase).toBe('effort');
    expect(s().defaultEffort).toBe('high');

    // CHANGE goes back to the model list; a Codex catalog id and its own scale
    // live in the same fields.
    s().setModelPhase('model');
    s().setDefaultModel('gpt-5.4-codex');
    s().setDefaultEffort('minimal');
    expect(s().modelPhase).toBe('model');
    expect(s().defaultModel).toBe('gpt-5.4-codex');
    expect(s().defaultEffort).toBe('minimal');
  });

  it('advances Model → Permission → Telemetry → Handoff like any other modal step', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().next();
    expect(s().step).toBe(4);
    s().next();
    expect(s().step).toBe(5);
    s().next();
    expect(s().step).toBe(6);
    expect(s().maxVisitedStep).toBe(6);
  });

  it('back() from Permission returns to Model', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().back();
    expect(s().step).toBe(3);
  });
});

describe('onboardingStore — the handoff step (6)', () => {
  beforeEach(reset);

  it("'continue' walks into the guided set-up (step 7)", () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6, handoffChoice: 'continue' });
    s().next();
    expect(s().status).toBe('active');
    expect(s().step).toBe(7);
    expect(s().maxVisitedStep).toBe(7);
  });

  it("'skip' completes the tour without touching the step", () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6, handoffChoice: 'skip' });
    s().next();
    expect(s().status).toBe('completed');
    expect(s().step).toBe(6);
  });

  it('setHandoffChoice flips the branch', () => {
    expect(s().handoffChoice).toBe('continue');
    s().setHandoffChoice('skip');
    expect(s().handoffChoice).toBe('skip');
  });

  it('back() from the handoff step returns to Telemetry', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().back();
    expect(s().step).toBe(5);
  });
});

describe('onboardingStore — the guided set-up steps (7, 8)', () => {
  beforeEach(reset);

  it("'existing' and 'new' advance to the detail screen (8)", () => {
    for (const choice of ['existing', 'new'] as const) {
      reset();
      useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 7, projectChoice: choice });
      s().next();
      expect(s().status).toBe('active');
      expect(s().step).toBe(8);
      expect(s().maxVisitedStep).toBe(8);
    }
  });

  it("'unsure' skips the detail step and continues into the shell with no project", () => {
    useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 7, projectChoice: 'unsure' });
    s().next();
    expect(s().status).toBe('active');
    expect(s().step).toBe(9);
    expect(s().maxVisitedStep).toBe(9);
    expect(s().guidedProject).toBeNull();
    // From there the walk is the ordinary one: 10-12 with the assistant, 13 without.
    s().next();
    expect(s().step).toBe(10);
    useOnboardingStore.setState({ step: 9, assistantAvailable: false });
    s().next();
    expect(s().step).toBe(13);
  });

  it('setProjectChoice records the branch', () => {
    expect(s().projectChoice).toBe('existing');
    s().setProjectChoice('new');
    expect(s().projectChoice).toBe('new');
    s().setProjectChoice('unsure');
    expect(s().projectChoice).toBe('unsure');
  });

  it('next() on step 8 is inert — the create handler completes the tour via finish()', () => {
    for (const choice of ['existing', 'new', 'unsure'] as const) {
      reset();
      useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8, projectChoice: choice });
      s().next();
      expect(s().status).toBe('active');
      expect(s().step).toBe(8);
    }
  });

  it('finish() completes from the detail screen', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8 });
    s().finish();
    expect(s().status).toBe('completed');
    expect(s().step).toBe(8);
  });

  it('back() walks the guided screens back into the modal phase (8 → 7 → 6)', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8 });
    s().back();
    expect(s().step).toBe(7);
    s().back();
    expect(s().step).toBe(6);
  });

  it('skip() from a guided step parks the tour at that step (Sidebar resume card)', () => {
    for (const step of [7, 8]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().skip();
      expect(s().status).toBe('skipped');
      expect(s().step).toBe(step);
    }
  });
});

describe('onboardingStore — goTo / skip / resume / dismiss', () => {
  beforeEach(reset);

  it('goTo only revisits steps within maxVisited and ignores the current step', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().goTo(6); // beyond maxVisited
    expect(s().step).toBe(4);
    s().goTo(4); // same step
    expect(s().step).toBe(4);
    s().goTo(1); // reachable
    expect(s().step).toBe(1);
  });

  it('skip then resume round-trips to the same modal step', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().skip();
    expect(s().status).toBe('skipped');
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(5);
  });

  it('resume is WARM: a tour parked on a guided screen comes back at the same step', () => {
    useOnboardingStore.setState({ status: 'skipped', step: 8, maxVisitedStep: 8, projectChoice: 'new' });
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(8);
    expect(s().projectChoice).toBe('new');
  });

  it('a COLD boot still clamps a parked guided step to the branch choice (hydrate)', () => {
    useOnboardingStore.setState({ status: 'idle', hydrated: false });
    s().hydrate({ version: 4, status: 'skipped', step: 12 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(7);
  });

  it('skip() is a no-op unless the tour is active', () => {
    for (const status of ['idle', 'skipped', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 4, maxVisitedStep: 4 });
      s().skip();
      expect(s().status).toBe(status);
    }
  });

  it('resume() is a no-op unless the tour is skipped', () => {
    for (const status of ['idle', 'active', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 8, maxVisitedStep: 8 });
      s().resume();
      expect(s().status).toBe(status);
      expect(s().step).toBe(8); // no clamp either
    }
  });

  it('dismiss permanently completes the tour from skipped, keeping the step', () => {
    useOnboardingStore.setState({ status: 'skipped', step: 5, maxVisitedStep: 5 });
    s().dismiss();
    expect(s().status).toBe('completed');
    expect(s().step).toBe(5); // step kept for the persisted snapshot + telemetry
  });

  it('dismiss is a no-op unless skipped (never from an active tour)', () => {
    for (const status of ['active', 'idle', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 6, maxVisitedStep: 6 });
      s().dismiss();
      expect(s().status).toBe(status);
    }
  });

  it('next()/back()/goTo() are inert unless the tour is active', () => {
    for (const status of ['idle', 'skipped', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 4, maxVisitedStep: 8 });
      s().next();
      s().back();
      s().goTo(2);
      expect(s().status).toBe(status);
      expect(s().step).toBe(4);
    }
  });

  it('begin resets detection, consent, and every step-3/6/7 answer for a clean replay', () => {
    useOnboardingStore.setState({
      status: 'skipped',
      step: 8,
      maxVisitedStep: 8,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
      ompDetection: OMP_DETECTED,
      ompConnected: true,
      permMode: 'dontAsk',
      defaultProvider: 'codex',
      multiRuntime: false,
      defaultModel: 'gpt-5.4-codex',
      defaultEffort: 'minimal',
      modelPhase: 'effort',
      handoffChoice: 'skip',
      projectChoice: 'unsure',
    });
    s().begin(true);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().maxVisitedStep).toBe(0);
    expect(s().replay).toBe(true);
    expect(s().detection).toBeNull();
    expect(s().connected).toBe(false);
    expect(s().codexDetection).toBeNull();
    expect(s().codexConnected).toBe(false);
    expect(s().ompDetection).toBeNull();
    expect(s().ompConnected).toBe(false);
    expect(s().permMode).toBe('auto');
    expect(s().defaultProvider).toBeNull();
    expect(s().multiRuntime).toBe(true);
    expect(s().defaultModel).toBeNull();
    expect(s().defaultEffort).toBeNull();
    expect(s().modelPhase).toBe('model');
    expect(s().handoffChoice).toBe('continue');
    expect(s().projectChoice).toBe('existing');
    expect(s().hydrated).toBe(true);
  });

  it('restart() is begin(true)', () => {
    useOnboardingStore.setState({ status: 'completed', step: 6, replay: false });
    s().restart();
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().replay).toBe(true);
  });
});

describe('onboardingStore — step-group membership', () => {
  it('the modal and guided sets partition the tour, with the conditional step in the modal half', async () => {
    const { ONBOARDING_MODAL_STEPS, ONBOARDING_GUIDED_STEPS, ONBOARDING_STEP_COUNT } = await import(
      '../../utils/onboarding'
    );
    expect(ONBOARDING_MODAL_STEPS).toContain(2);
    expect(ONBOARDING_MODAL_STEPS).toContain(3);
    expect(ONBOARDING_GUIDED_STEPS).not.toContain(2);
    expect([...ONBOARDING_MODAL_STEPS, ...ONBOARDING_GUIDED_STEPS]).toEqual(
      Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => i),
    );
  });
});

describe('onboardingStore — the in-shell guided steps (9-14)', () => {
  beforeEach(reset);

  const PROJECT = { id: 7, name: 'dogwalkr' };

  function activeAt(step: number, extra: Partial<ReturnType<typeof useOnboardingStore.getState>> = {}): void {
    useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step, hydrated: true, ...extra });
  }

  it('projectAdded() records the project and moves 8 → 9 (the in-shell handover)', () => {
    activeAt(8);
    useOnboardingStore.getState().projectAdded(PROJECT);
    const s = useOnboardingStore.getState();
    expect(s.step).toBe(9);
    expect(s.maxVisitedStep).toBe(9);
    expect(s.status).toBe('active');
    expect(s.guidedProject).toEqual(PROJECT);
  });

  it('projectAdded() is inert off step 8 or when the tour is not active', () => {
    activeAt(7);
    useOnboardingStore.getState().projectAdded(PROJECT);
    expect(useOnboardingStore.getState().step).toBe(7);
    expect(useOnboardingStore.getState().guidedProject).toBeNull();
    useOnboardingStore.setState({ status: 'completed', step: 8 });
    useOnboardingStore.getState().projectAdded(PROJECT);
    expect(useOnboardingStore.getState().guidedProject).toBeNull();
  });

  it('next() walks 9 → 10 → 11 → 12 → 13 with the assistant available', () => {
    activeAt(9);
    for (const expected of [10, 11, 12, 13]) {
      useOnboardingStore.getState().next();
      expect(useOnboardingStore.getState().step).toBe(expected);
    }
  });

  it('next() from 9 skips the three assistant steps when the assistant is off', () => {
    activeAt(9, { assistantAvailable: false });
    useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().step).toBe(13);
    expect(useOnboardingStore.getState().maxVisitedStep).toBe(13);
  });

  it('isStepSkipped / skippedStepSet cover the assistant steps, per the availability flag', () => {
    expect(isStepSkipped(10, { multiRuntime: true, assistantAvailable: false })).toBe(true);
    expect(isStepSkipped(11, { multiRuntime: true, assistantAvailable: false })).toBe(true);
    expect(isStepSkipped(12, { multiRuntime: true, assistantAvailable: false })).toBe(true);
    expect(isStepSkipped(13, { multiRuntime: true, assistantAvailable: false })).toBe(false);
    expect(isStepSkipped(10, { multiRuntime: true, assistantAvailable: true })).toBe(false);
    expect([...skippedStepSet({ multiRuntime: true, assistantAvailable: false })]).toEqual([10, 11, 12]);
    expect([...skippedStepSet({ multiRuntime: false, assistantAvailable: false })]).toEqual([2, 10, 11, 12]);
    expect([...skippedStepSet({ multiRuntime: false, assistantAvailable: true })]).toEqual([2]);
    // Stable identities per combination.
    expect(skippedStepSet({ multiRuntime: true, assistantAvailable: false })).toBe(
      skippedStepSet({ multiRuntime: true, assistantAvailable: false }),
    );
  });

  it('skipIdeas() jumps from 10 or 11 straight to the rail intro (12) — the tour continues', () => {
    activeAt(10);
    useOnboardingStore.getState().skipIdeas();
    expect(useOnboardingStore.getState().step).toBe(12);
    expect(useOnboardingStore.getState().status).toBe('active');
    activeAt(11);
    useOnboardingStore.getState().skipIdeas();
    expect(useOnboardingStore.getState().step).toBe(12);
  });

  it('skipIdeas() is inert outside 9-11', () => {
    for (const step of [8, 12, 13]) {
      activeAt(step);
      useOnboardingStore.getState().skipIdeas();
      expect(useOnboardingStore.getState().step).toBe(step);
    }
  });

  it('step 13 never advances via next(); sessionLaunched() records the launch and moves to 14', () => {
    activeAt(13);
    useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().step).toBe(13);
    const launched = { kind: 'planner' as const, sessionId: 'sess-1', runId: 'run-1' };
    useOnboardingStore.getState().sessionLaunched(launched);
    expect(useOnboardingStore.getState().step).toBe(14);
    expect(useOnboardingStore.getState().launched).toEqual(launched);
  });

  it('sessionLaunched() is inert off step 13', () => {
    activeAt(12);
    useOnboardingStore.getState().sessionLaunched({ kind: 'quick', sessionId: 's', runId: null });
    expect(useOnboardingStore.getState().step).toBe(12);
    expect(useOnboardingStore.getState().launched).toBeNull();
  });

  it('step 14 is terminal: next() is inert, finish() completes', () => {
    activeAt(14);
    useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().step).toBe(14);
    expect(useOnboardingStore.getState().status).toBe('active');
    useOnboardingStore.getState().finish();
    expect(useOnboardingStore.getState().status).toBe('completed');
  });

  it('back() is inert from step 9 on (the project already exists)', () => {
    for (const step of [9, 10, 11, 12, 13, 14]) {
      activeAt(step);
      useOnboardingStore.getState().back();
      expect(useOnboardingStore.getState().step).toBe(step);
    }
    activeAt(8);
    useOnboardingStore.getState().back();
    expect(useOnboardingStore.getState().step).toBe(7);
  });

  it('skip() from an in-shell step parks the tour; resume() returns to the same step with its project', () => {
    activeAt(12, { guidedProject: PROJECT });
    useOnboardingStore.getState().skip();
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(12);
    useOnboardingStore.getState().resume();
    expect(useOnboardingStore.getState().status).toBe('active');
    expect(useOnboardingStore.getState().step).toBe(12);
    expect(useOnboardingStore.getState().guidedProject).toEqual(PROJECT);
  });

  it('projectAdopted records a project on the no-project branch without moving the step', () => {
    activeAt(10, { guidedProject: null });
    useOnboardingStore.getState().projectAdopted(PROJECT);
    expect(useOnboardingStore.getState().guidedProject).toEqual(PROJECT);
    expect(useOnboardingStore.getState().step).toBe(10);
    // Never overwrites a recorded project, never before step 9, never when parked.
    useOnboardingStore.getState().projectAdopted({ id: 99, name: 'other' });
    expect(useOnboardingStore.getState().guidedProject).toEqual(PROJECT);
    activeAt(8, { guidedProject: null });
    useOnboardingStore.getState().projectAdopted(PROJECT);
    expect(useOnboardingStore.getState().guidedProject).toBeNull();
    activeAt(9, { guidedProject: null, status: 'skipped' });
    useOnboardingStore.getState().projectAdopted(PROJECT);
    expect(useOnboardingStore.getState().guidedProject).toBeNull();
  });

  it('setSessionChoice / setAssistantAvailable record their values; begin() resets all of it', () => {
    activeAt(13, { guidedProject: PROJECT, launched: { kind: 'quick', sessionId: 's', runId: null } });
    useOnboardingStore.getState().setSessionChoice('ship');
    useOnboardingStore.getState().setAssistantAvailable(false);
    expect(useOnboardingStore.getState().sessionChoice).toBe('ship');
    expect(useOnboardingStore.getState().assistantAvailable).toBe(false);
    useOnboardingStore.getState().begin(true);
    const s = useOnboardingStore.getState();
    expect(s.guidedProject).toBeNull();
    expect(s.launched).toBeNull();
    expect(s.sessionChoice).toBe('planner');
    expect(s.assistantAvailable).toBe(true);
  });

  it('a snapshot parked on any in-shell step (9-14) hydrates as skipped at the branch choice', () => {
    for (const step of [9, 10, 11, 12, 13, 14]) {
      for (const status of ['active', 'skipped'] as const) {
        useOnboardingStore.setState({ status: 'idle', hydrated: false });
        useOnboardingStore.getState().hydrate({ version: 4, status, step }, 1);
        expect(useOnboardingStore.getState().status).toBe('skipped');
        expect(useOnboardingStore.getState().step).toBe(7);
      }
    }
  });
});
