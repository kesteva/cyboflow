import { describe, it, expect } from 'vitest';
import { computeState } from './claudeDetection';

// The server-computed step-1 state mapping (shared/types/onboarding.ts):
//   credentials.found            -> 'detected'
//   !credentials.found && binary -> 'loggedOut'
//   neither                      -> 'missing'
describe('computeState (onboarding step-1 mapping)', () => {
  it('credentials found -> detected (regardless of binary)', () => {
    expect(computeState(true, true)).toBe('detected');
    expect(computeState(true, false)).toBe('detected');
  });

  it('no credentials but binary present -> loggedOut', () => {
    expect(computeState(false, true)).toBe('loggedOut');
  });

  it('neither -> missing', () => {
    expect(computeState(false, false)).toBe('missing');
  });
});
