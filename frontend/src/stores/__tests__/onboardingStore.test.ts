/**
 * onboardingStore — the pure 8-step tour machine. Covers boot hydration (all
 * four branches), the step-1 credential gate, coach-step advance-by-doing rules
 * (anchorActioned / realEvent), dot/goTo maxVisited clamping, and the
 * skip↔resume round trip. All transitions are synchronous — the async side
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
    s().hydrate({ version: 1, status: 'completed', step: 7 }, 0);
    expect(s().status).toBe('completed');
  });

  it('a mid-tour snapshot resumes as skipped at the clamped step (5 → 4)', () => {
    s().hydrate({ version: 1, status: 'active', step: 5 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(4);
    expect(s().maxVisitedStep).toBe(4);
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

  it('next() never advances a coach step', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().next();
    expect(s().step).toBe(4);
    expect(s().status).toBe('active');
  });

  it('anchorActioned parks steps 4/5 in pending', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().anchorActioned();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(4);

    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().anchorActioned();
    expect(s().status).toBe('pending');
  });

  it('anchorActioned on step 6 jumps straight to the rail map (step 7)', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(7);
    expect(s().maxVisitedStep).toBe(7);
  });

  it('realEvent lands the matching next step from pending', () => {
    useOnboardingStore.setState({ status: 'pending', step: 4, maxVisitedStep: 4 });
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(5);

    useOnboardingStore.setState({ status: 'pending', step: 5, maxVisitedStep: 5 });
    s().realEvent('workflow-run-started');
    expect(s().step).toBe(6);

    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().realEvent('project-created');
    expect(s().step).toBe(4);
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

  it('resume from a live coach pending step returns to the SAME step (only hydrate clamps)', () => {
    useOnboardingStore.setState({ status: 'pending', step: 5, maxVisitedStep: 5 });
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(5);
  });

  it('begin resets detection + consent for a clean replay', () => {
    useOnboardingStore.setState({ status: 'skipped', step: 6, detection: DETECTED, connected: true, permMode: 'dontAsk' });
    s().begin(true);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().replay).toBe(true);
    expect(s().detection).toBeNull();
    expect(s().connected).toBe(false);
    expect(s().permMode).toBe('auto');
  });
});
