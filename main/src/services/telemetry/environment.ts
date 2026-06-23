/**
 * Telemetry environment resolution. Kept free of `electron` / SDK imports so the
 * pure mapping below is unit-testable in plain Node (the impure reader that
 * touches `app` / the filesystem lives in ./index).
 *
 *   - 'local'  — `pnpm dev` (unpackaged) OR an unstamped local `build:mac` .dmg.
 *   - 'dev'    — the "Cyboflow Dev" release .dmg: the dev build distributed for
 *                active testing before a stable release.
 *   - 'stable' — the stable release .dmg.
 *
 * Only the release pipeline (`release:mac` / `release:mac:dev`) stamps a
 * 'stable' / 'dev' environment into buildInfo.json. Usage metrics fire ONLY for
 * release builds ('dev' or 'stable'); Sentry tags every event with this
 * environment so the Dev-channel testing builds are filterable from stable.
 */
export type TelemetryEnvironment = 'local' | 'dev' | 'stable';

/**
 * Pure mapping from packaged-state + buildInfo contents to the environment.
 * A packaged build is only treated as a real release when buildInfo.json carries
 * an explicit release stamp; an unstamped packaged build (a local `build:mac`
 * .dmg) is 'local'.
 */
export function environmentFromBuildInfo(
  isPackaged: boolean,
  buildInfo: { environment?: unknown } | null,
): TelemetryEnvironment {
  if (!isPackaged) return 'local';
  if (buildInfo && (buildInfo.environment === 'stable' || buildInfo.environment === 'dev')) {
    return buildInfo.environment;
  }
  return 'local';
}
