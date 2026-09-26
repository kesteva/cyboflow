/**
 * driveEngineSelection — the §B3 rule and its degrade provenance
 * (docs/proposals/runbook-optional-verification.md §B3).
 */
import { describe, expect, it } from 'vitest';
import {
  degradeReasonForProbe,
  finalizeDriveEngine,
  intendXcode,
  type XcodeProbeSummary,
} from '../driveEngineSelection';

const probe = (outcome: XcodeProbeSummary['outcome'], approval: XcodeProbeSummary['approval'] = 'approved'): XcodeProbeSummary => ({
  outcome,
  approval,
  detail: `probe said ${outcome}`,
});

describe('intendXcode (phase 1, before acquire)', () => {
  it('attempts xcode under auto when the probe is available OR inconclusive', () => {
    expect(intendXcode('auto', probe('available'))).toEqual({ attempt: true });
    // An unreadable grant is not a confident "not approved": StartSession decides.
    expect(intendXcode('auto', probe('inconclusive', 'unknown'))).toEqual({ attempt: true });
  });

  it('a pinned xcode obeys the probe the same way — degrade, never refuse to run', () => {
    expect(intendXcode('xcode', probe('approval-required', 'missing'))).toEqual({
      attempt: false,
      degradeReason: 'xcode-approval-missing',
      detail: 'probe said approval-required',
    });
  });

  it('maps an expired grant and an expiring one to xcode-approval-expired', () => {
    expect(intendXcode('auto', probe('approval-required', 'expired'))).toMatchObject({
      degradeReason: 'xcode-approval-expired',
    });
    expect(intendXcode('auto', probe('expiring', 'expiring'))).toMatchObject({ degradeReason: 'xcode-approval-expired' });
  });

  it('an unwired probe is xcode-unavailable, recorded rather than silent', () => {
    expect(intendXcode('auto', null)).toMatchObject({ attempt: false, degradeReason: 'xcode-unavailable' });
    expect(intendXcode('auto', probe('unavailable', 'unknown'))).toMatchObject({ degradeReason: 'xcode-unavailable' });
  });

  it('never attempts, and records no degrade, when the request did not ask for xcode', () => {
    expect(intendXcode('maestro', probe('available'))).toEqual({ attempt: false, degradeReason: null, detail: null });
    expect(intendXcode('none', probe('available'))).toEqual({ attempt: false, degradeReason: null, detail: null });
  });
});

describe('finalizeDriveEngine (phase 2, the exported rung)', () => {
  it('xcode drives when its session came up', () => {
    expect(finalizeDriveEngine({ requested: 'auto', xcode: { ok: true }, maestroAvailable: true })).toEqual({
      requested: 'auto',
      used: 'xcode',
      degradeReason: null,
      degradeDetail: null,
    });
  });

  it('a failed StartSession falls to maestro, carrying the degrade reason', () => {
    expect(
      finalizeDriveEngine({
        requested: 'xcode',
        xcode: { ok: false, degradeReason: 'xcode-session-failed', detail: 'bound another device' },
        maestroAvailable: true,
      }),
    ).toEqual({ requested: 'xcode', used: 'maestro', degradeReason: 'xcode-session-failed', degradeDetail: 'bound another device' });
  });

  it('with no maestro either, the rung is none — still recorded, still run', () => {
    expect(
      finalizeDriveEngine({
        requested: 'auto',
        xcode: { ok: false, degradeReason: 'xcode-approval-missing', detail: null },
        maestroAvailable: false,
      }),
    ).toMatchObject({ used: 'none', degradeReason: 'xcode-approval-missing' });
  });

  it('requested none is none whatever the host has', () => {
    expect(finalizeDriveEngine({ requested: 'none', xcode: { ok: true }, maestroAvailable: true }).used).toBe('none');
  });

  it('requested maestro without a pinnable maestro is none, with no xcode degrade', () => {
    expect(
      finalizeDriveEngine({
        requested: 'maestro',
        xcode: { ok: false, degradeReason: null, detail: null },
        maestroAvailable: false,
      }),
    ).toEqual({ requested: 'maestro', used: 'none', degradeReason: null, degradeDetail: null });
  });
});

describe('degradeReasonForProbe', () => {
  it('is null exactly for the two outcomes that still attempt xcode', () => {
    expect(degradeReasonForProbe({ outcome: 'available', approval: 'approved' })).toBeNull();
    expect(degradeReasonForProbe({ outcome: 'inconclusive', approval: 'unknown' })).toBeNull();
    expect(degradeReasonForProbe({ outcome: 'approval-required', approval: 'binary-changed' })).toBe(
      'xcode-approval-missing',
    );
  });
});
