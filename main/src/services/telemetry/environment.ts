/**
 * Telemetry environment resolution. Kept free of `electron` / SDK imports so the
 * pure mapping below is unit-testable in plain Node (the impure reader that
 * touches `app` / the filesystem lives in ./index).
 *
 * 'development' deliberately covers BOTH `pnpm dev` (unpackaged) AND a locally
 * packaged dev `.dmg` (`build:mac`); only the release pipeline (`release:mac` /
 * `release:mac:beta`) stamps a 'stable' / 'beta' environment into buildInfo.json.
 * Usage metrics fire ONLY for release builds; Sentry tags every event with this
 * environment so dev noise is filterable.
 */
export type TelemetryEnvironment = 'development' | 'stable' | 'beta';

/**
 * Pure mapping from packaged-state + buildInfo contents to the environment.
 * A packaged build is only treated as a real release when buildInfo.json carries
 * an explicit release stamp; an unstamped packaged build (a local `build:mac`
 * dev .dmg) is 'development'.
 */
export function environmentFromBuildInfo(
  isPackaged: boolean,
  buildInfo: { environment?: unknown } | null,
): TelemetryEnvironment {
  if (!isPackaged) return 'development';
  if (buildInfo && (buildInfo.environment === 'stable' || buildInfo.environment === 'beta')) {
    return buildInfo.environment;
  }
  return 'development';
}
