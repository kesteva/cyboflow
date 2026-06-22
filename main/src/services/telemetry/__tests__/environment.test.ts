import { describe, it, expect } from 'vitest';
import { environmentFromBuildInfo } from '../environment';

describe('environmentFromBuildInfo', () => {
  it('is development when unpackaged (pnpm dev / electron dev), regardless of buildInfo', () => {
    expect(environmentFromBuildInfo(false, null)).toBe('development');
    expect(environmentFromBuildInfo(false, { environment: 'stable' })).toBe('development');
    expect(environmentFromBuildInfo(false, { environment: 'beta' })).toBe('development');
  });

  it('is development for a packaged build with no release stamp (local build:mac dev .dmg)', () => {
    expect(environmentFromBuildInfo(true, null)).toBe('development');
    expect(environmentFromBuildInfo(true, {})).toBe('development');
    expect(environmentFromBuildInfo(true, { environment: 'development' })).toBe('development');
  });

  it('honors an explicit release stamp on a packaged build', () => {
    expect(environmentFromBuildInfo(true, { environment: 'stable' })).toBe('stable');
    expect(environmentFromBuildInfo(true, { environment: 'beta' })).toBe('beta');
  });

  it('falls back to development for an unrecognized / malformed environment value', () => {
    expect(environmentFromBuildInfo(true, { environment: 'production' })).toBe('development');
    expect(environmentFromBuildInfo(true, { environment: 42 })).toBe('development');
    expect(environmentFromBuildInfo(true, { environment: null })).toBe('development');
  });
});
