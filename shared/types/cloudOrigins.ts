/** Desktop-facing cyboflow cloud origins (accounts + sync + relay desktop API, path-routed on one origin). */
export const CLOUD_STAGING_ORIGIN = 'https://cloud-staging.cyboflow.com';
export const CLOUD_PRODUCTION_ORIGIN = 'https://cloud.cyboflow.com';

/**
 * The origin this build signs in to. Pure.
 *  - release build (devBuild=false): always CLOUD_PRODUCTION_ORIGIN (any override ignored).
 *  - dev build: undefined/null/'' → staging; 'staging' → staging; 'production' → production;
 *    a URL string → accepted only as `https:` with empty path, no query/hash/credentials, or `http:` with
 *    hostname exactly '127.0.0.1' and an explicit port (local wrangler dev) → `url.origin`;
 *    anything else → staging (the caller logs one warning per distinct rejected value).
 */
export function resolveCloudOrigin(raw: unknown, devBuild: boolean): string {
  if (!devBuild) return CLOUD_PRODUCTION_ORIGIN;
  if (raw === undefined || raw === null || raw === '' || raw === 'staging') return CLOUD_STAGING_ORIGIN;
  if (raw === 'production') return CLOUD_PRODUCTION_ORIGIN;
  if (typeof raw !== 'string') return CLOUD_STAGING_ORIGIN;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return CLOUD_STAGING_ORIGIN;
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return CLOUD_STAGING_ORIGIN;
  if (u.pathname !== '/' && u.pathname !== '') return CLOUD_STAGING_ORIGIN;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '') return u.origin;
  return CLOUD_STAGING_ORIGIN;
}

export function isStagingOrigin(origin: string): boolean {
  return origin === CLOUD_STAGING_ORIGIN;
}
