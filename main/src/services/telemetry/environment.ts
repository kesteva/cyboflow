/**
 * Telemetry environment resolution. Kept free of `electron` / SDK imports so the
 * pure mapping below is unit-testable in plain Node (the impure reader that
 * touches `app` / the filesystem lives in ./index).
 *
 *   - 'local'  — `pnpm dev` (unpackaged), an explicit CYBOFLOW_BUILD_ENV=local
 *                build, or a pre-fix .dmg built before the variant-based stamp.
 *   - 'dev'    — a "Cyboflow Dev" variant .dmg (build:mac:dev* / release:mac:dev).
 *   - 'stable' — a stable-variant .dmg (build:mac* / release:mac).
 *
 * scripts/inject-build-info.js stamps EVERY packaged build: CYBOFLOW_BUILD_ENV
 * ('stable' | 'dev' | 'local') wins when set (the release pipeline sets it),
 * otherwise the stamp follows the build VARIANT — so a hand-built `build:mac`
 * .dmg handed to a tester reports 'stable', not 'local' (the 0.1.14 lesson:
 * its Sentry events hid under the same bucket as pnpm-dev runs). Sentry tags
 * every event with this environment so channels are filterable.
 */
export type TelemetryEnvironment = 'local' | 'dev' | 'stable';

/**
 * Pure mapping from packaged-state + buildInfo contents to the environment.
 * A packaged build reports whatever 'stable'/'dev' stamp buildInfo.json carries
 * (inject-build-info.js stamps every build from CYBOFLOW_BUILD_ENV or the build
 * variant); anything else — an explicit 'local' stamp, or a pre-fix artifact
 * with no recognized stamp — is 'local'.
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
