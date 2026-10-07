import { describe, expect, it } from 'vitest';
import {
  CLOUD_PRODUCTION_ORIGIN,
  CLOUD_STAGING_ORIGIN,
  isStagingOrigin,
  resolveCloudOrigin,
} from '../cloudOrigins';

describe('resolveCloudOrigin', () => {
  it('release builds always use production, even with an override', () => {
    expect(resolveCloudOrigin(undefined, false)).toBe(CLOUD_PRODUCTION_ORIGIN);
    expect(resolveCloudOrigin('staging', false)).toBe(CLOUD_PRODUCTION_ORIGIN);
    expect(resolveCloudOrigin('http://127.0.0.1:8787', false)).toBe(CLOUD_PRODUCTION_ORIGIN);
  });

  it('dev builds default to staging', () => {
    expect(resolveCloudOrigin(undefined, true)).toBe(CLOUD_STAGING_ORIGIN);
    expect(resolveCloudOrigin(null, true)).toBe(CLOUD_STAGING_ORIGIN);
    expect(resolveCloudOrigin('', true)).toBe(CLOUD_STAGING_ORIGIN);
    expect(resolveCloudOrigin('staging', true)).toBe(CLOUD_STAGING_ORIGIN);
  });

  it("dev 'production' selects production", () => {
    expect(resolveCloudOrigin('production', true)).toBe(CLOUD_PRODUCTION_ORIGIN);
  });

  it('dev accepts an https origin and a local wrangler origin', () => {
    expect(resolveCloudOrigin('https://cloud-preview.example.com', true)).toBe('https://cloud-preview.example.com');
    expect(resolveCloudOrigin('https://cloud-preview.example.com/', true)).toBe('https://cloud-preview.example.com');
    expect(resolveCloudOrigin('http://127.0.0.1:8787', true)).toBe('http://127.0.0.1:8787');
  });

  it('dev rejects everything else to staging', () => {
    for (const raw of [
      'http://evil.com',
      'https://x.com/path',
      'https://x.com?q',
      'https://x.com#frag',
      'https://u:p@x.com',
      'http://127.0.0.1',
      'http://localhost:8787',
      'ftp://x.com',
      'not a url',
      42,
      { origin: 'https://x.com' },
      true,
    ]) {
      expect(resolveCloudOrigin(raw, true)).toBe(CLOUD_STAGING_ORIGIN);
    }
  });
});

describe('isStagingOrigin', () => {
  it('is true only for the staging origin', () => {
    expect(isStagingOrigin(CLOUD_STAGING_ORIGIN)).toBe(true);
    expect(isStagingOrigin(CLOUD_PRODUCTION_ORIGIN)).toBe(false);
    expect(isStagingOrigin('http://127.0.0.1:8787')).toBe(false);
  });
});
