/**
 * onboardingStore — the pure 11-step tour machine. Covers boot hydration (all
 * four branches), the step-1 credential gate, coach-step advance-by-doing rules
 * (anchorActioned / realEvent), the Configure pointer steps (5-7: next()
 * advances, the last pointer parks pending), dot/goTo maxVisited clamping, and
 * the skip↔resume round trip. All transitions are synchronous — the async side
 * effects live in OnboardingGate and are not exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ClaudeDetectionResult } from '../../../../shared/types/onboarding';
import { useOnboardingStore, isNextGateBlocked } from '../onboardingStore';

const DETECTED: ClaudeDetectionResult = {
  credentials: { found: true, source: 'keychain', account: 'a@b.co' },
  binary: { found: true, path: '/usr/bin/claude', version: 'v1.4.2' },
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

  it('mid-tour snapshots on context-bound coach steps (5-8) resume clamped to 4', () => {
    for (const step of [5, 6, 7, 8]) {
      reset();
      s().hydrate({ version: 1, status: 'active', step }, 1);
      expect(s().status).toBe('skipped');
      expect(s().step).toBe(4);
      expect(s().maxVisitedStep).toBe(4);
    }
  });

  it('a mid-tour snapshot on step 9 (rail anchor always exists) keeps that step', () => {
    s().hydrate({ version: 1, status: 'active', step: 9 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(9);
  });

  it('a mid-tour snapshot on a modal step keeps that step', () => {
    s().hydrate({ version: 1, status: 'pending', step: 3 }, 0);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(3);
  });
});

describe('onboardingStore — step-1 gate', () => {
  beforeEach(reset);

  it('isNextGateBlocked blocks step 1 until detected AND connected', () => {
    expect(isNextGateBlocked({ step: 1, detection: null, connected: false })).toBe(true);
    expect(isNextGateBlocked({ step: 1, detection: DETECTED, connected: false })).toBe(true);
    expect(isNextGateBlocked({ step: 1, detection: DETECTED, connected: true })).toBe(false);
    // Non-step-1 is never gated.
    expect(isNextGateBlocked({ step: 0, detection: null, connected: false })).toBe(false);
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
});

describe('onboardingStore — coach steps advance by doing', () => {
  beforeEach(reset);

  it('next() never advances a do-step (4, 8, 9)', () => {
    for (const step of [4, 8, 9]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().next();
      expect(s().step).toBe(step);
      expect(s().status).toBe('active');
    }
  });

  it('anchorActioned on step 4 advances straight to the first Configure pointer (5)', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('anchorActioned on step 8 parks pending', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8 });
    s().anchorActioned();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(8);
  });

  it('anchorActioned on step 9 jumps straight to the rail map (step 10)', () => {
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 9 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(10);
    expect(s().maxVisitedStep).toBe(10);
  });

  it('anchorActioned is a no-op on pointer steps', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(5);
  });

  it('realEvent lands the matching next step from pending', () => {
    useOnboardingStore.setState({ status: 'pending', step: 7, maxVisitedStep: 7 });
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(8);

    useOnboardingStore.setState({ status: 'pending', step: 8, maxVisitedStep: 8 });
    s().realEvent('workflow-run-started');
    expect(s().step).toBe(9);

    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().realEvent('project-created');
    expect(s().step).toBe(4);
  });

  it('quick-session-created advances from ANY Configure-page step (4-7)', () => {
    for (const step of [4, 5, 6, 7]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().realEvent('quick-session-created');
      expect(s().status).toBe('active');
      expect(s().step).toBe(8);
    }
  });

  it('realEvent ignores wrong-step / wrong-kind signals', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().realEvent('workflow-run-started'); // wrong kind for step 4
    expect(s().step).toBe(4);

    useOnboardingStore.setState({ status: 'skipped', step: 4, maxVisitedStep: 4 });
    s().realEvent('quick-session-created'); // not active/pending
    expect(s().step).toBe(4);
    expect(s().status).toBe('skipped');
  });
});

describe('onboardingStore — Configure pointer steps (5-7)', () => {
  beforeEach(reset);

  it('next() advances pointer steps 5 → 6 → 7', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().next();
    expect(s().step).toBe(6);
    s().next();
    expect(s().step).toBe(7);
    expect(s().maxVisitedStep).toBe(7);
  });

  it('next() on the last pointer (7) parks pending until the session launches', () => {
    useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 7 });
    s().next();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(7);
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(8);
  });

  it('next() on step 7 advances normally when step 8 was already reached (revisit)', () => {
    useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 9 });
    s().next();
    expect(s().status).toBe('active');
    expect(s().step).toBe(8);
  });
});

describe('onboardingStore — forceNext (anchor-lost escape)', () => {
  beforeEach(reset);

  it('force-advances a do-step that next() refuses (4 → 5)', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().next();
    expect(s().step).toBe(4); // next() is a no-op on the do-step
    s().forceNext();
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('force-advances the later do-steps (8 → 9, 9 → 10)', () => {
    useOnboardingStore.setState({ status: 'active', step: 8, maxVisitedStep: 8 });
    s().forceNext();
    expect(s().step).toBe(9);
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 9 });
    s().forceNext();
    expect(s().step).toBe(10);
    expect(s().maxVisitedStep).toBe(10);
  });

  it('is a no-op unless active', () => {
    useOnboardingStore.setState({ status: 'pending', step: 8, maxVisitedStep: 8 });
    s().forceNext();
    expect(s().step).toBe(8);
    expect(s().status).toBe('pending');
  });

  it('completes from the last step', () => {
    useOnboardingStore.setState({ status: 'active', step: 10, maxVisitedStep: 10 });
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

  it('resume from a live coach pending step returns to the SAME step (steps 8-9 keep place)', () => {
    useOnboardingStore.setState({ status: 'pending', step: 8, maxVisitedStep: 8 });
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(8);
  });

  it('resume from a Configure pointer (5-7) clamps to step 4 to rebuild the wizard', () => {
    for (const step of [5, 6, 7]) {
      reset();
      useOnboardingStore.setState({ status: 'skipped', step, maxVisitedStep: 7 });
      s().resume();
      expect(s().status).toBe('active');
      expect(s().step).toBe(4);
      expect(s().maxVisitedStep).toBe(4); // reset so dots can't jump back onto missing anchors
    }
  });

  it('resume clamps a Configure pointer from pending too', () => {
    useOnboardingStore.setState({ status: 'pending', step: 6, maxVisitedStep: 6 });
    s().resume();
    expect(s().step).toBe(4);
  });

  it('begin resets detection + consent for a clean replay', () => {
    useOnboardingStore.setState({ status: 'skipped', step: 9, detection: DETECTED, connected: true, permMode: 'dontAsk' });
    s().begin(true);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().replay).toBe(true);
    expect(s().detection).toBeNull();
    expect(s().connected).toBe(false);
    expect(s().permMode).toBe('auto');
  });
});
