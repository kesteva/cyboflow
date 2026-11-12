import { describe, it, expect } from 'vitest';
import { clampUserCap, computeDetectedTier, effectiveTier } from '../tierRule';
import { TierCapAboveDetectedError } from '../errors';
import type {
  CapabilityTier, CheckStatus, PreflightCheckResult, PreflightRuntimes, TierImpact,
} from '../../../../../shared/types/hosts';

const TIERS: Array<CapabilityTier | null> = [null, 'cli', 'full'];

function check(status: CheckStatus, tierImpact: TierImpact): PreflightCheckResult {
  return { id: 'git', label: 'x', status, detail: '', tierImpact, durationMs: 0 };
}
const rt = (claudeSdk: boolean, codexSdk = false): PreflightRuntimes =>
  ({ claudeSdk, codexSdk, claudeCli: false, codexCli: false });

describe('effectiveTier', () => {
  const expected: Record<string, CapabilityTier | null> = {
    'null|null': null, 'null|cli': null, 'null|full': null,
    'cli|null': 'cli', 'cli|cli': 'cli', 'cli|full': 'cli',
    'full|null': 'full', 'full|cli': 'cli', 'full|full': 'full',
  };
  for (const d of TIERS) {
    for (const c of TIERS) {
      it(`detected=${d} cap=${c}`, () => {
        expect(effectiveTier(d, c)).toBe(expected[`${d}|${c}`]);
      });
    }
  }
});

describe('clampUserCap', () => {
  it('null stays null, cli stays cli', () => {
    for (const d of TIERS) {
      expect(clampUserCap(d, null)).toBeNull();
      expect(clampUserCap(d, 'cli')).toBe('cli');
    }
  });
  it('full throws TierCapAboveDetectedError', () => {
    for (const d of TIERS) expect(() => clampUserCap(d, 'full')).toThrow(TierCapAboveDetectedError);
  });
});

describe('computeDetectedTier', () => {
  it('a non-pass blocks-cli check yields null, even with SDKs', () => {
    for (const s of ['fail', 'warn', 'skipped', 'na'] as const) {
      expect(computeDetectedTier([check(s, 'blocks-cli')], rt(true))).toBeNull();
    }
  });
  it('a passing blocks-cli check is neutral', () => {
    expect(computeDetectedTier([check('pass', 'blocks-cli')], rt(true))).toBe('full');
  });
  it('blocks-full fail or skipped caps at cli', () => {
    expect(computeDetectedTier([check('fail', 'blocks-full')], rt(true))).toBe('cli');
    expect(computeDetectedTier([check('skipped', 'blocks-full')], rt(true, true))).toBe('cli');
  });
  it('blocks-full pass/warn/na does not cap', () => {
    for (const s of ['pass', 'warn', 'na'] as const) {
      expect(computeDetectedTier([check(s, 'blocks-full')], rt(true))).toBe('full');
    }
  });
  it('none-impact failures never change the tier', () => {
    expect(computeDetectedTier([check('fail', 'none')], rt(true))).toBe('full');
    expect(computeDetectedTier([check('fail', 'none')], rt(false))).toBe('cli');
  });
  it('full needs an SDK runtime; either suffices', () => {
    expect(computeDetectedTier([], rt(false, false))).toBe('cli');
    expect(computeDetectedTier([], rt(true, false))).toBe('full');
    expect(computeDetectedTier([], rt(false, true))).toBe('full');
  });
  it('blocks-cli takes precedence over blocks-full', () => {
    expect(computeDetectedTier([check('fail', 'blocks-full'), check('fail', 'blocks-cli')], rt(true))).toBeNull();
  });
});
