import { describe, it, expect } from 'vitest';
import { environmentFromBuildInfo } from '../environment';

describe('environmentFromBuildInfo', () => {
  it('is local when unpackaged (pnpm dev / electron dev), regardless of buildInfo', () => {
    expect(environmentFromBuildInfo(false, null)).toBe('local');
    expect(environmentFromBuildInfo(false, { environment: 'stable' })).toBe('local');
    expect(environmentFromBuildInfo(false, { environment: 'dev' })).toBe('local');
  });

  it('is local for a packaged build with no release stamp (local build:mac .dmg)', () => {
    expect(environmentFromBuildInfo(true, null)).toBe('local');
    expect(environmentFromBuildInfo(true, {})).toBe('local');
    expect(environmentFromBuildInfo(true, { environment: 'local' })).toBe('local');
  });

  it('honors an explicit release stamp on a packaged build', () => {
    expect(environmentFromBuildInfo(true, { environment: 'stable' })).toBe('stable');
    // The Cyboflow Dev release channel (formerly "beta") — the dev .dmg for testing.
    expect(environmentFromBuildInfo(true, { environment: 'dev' })).toBe('dev');
  });

  it('falls back to local for an unrecognized / malformed environment value', () => {
    expect(environmentFromBuildInfo(true, { environment: 'beta' })).toBe('local');
    expect(environmentFromBuildInfo(true, { environment: 'production' })).toBe('local');
    expect(environmentFromBuildInfo(true, { environment: 42 })).toBe('local');
    expect(environmentFromBuildInfo(true, { environment: null })).toBe('local');
  });
});
