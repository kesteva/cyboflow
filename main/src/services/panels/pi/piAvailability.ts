import { findExecutableInPath, getShellPath } from '../../../utils/shellPath';
import { probeCliVersion } from '../cli/cliVersionProbe';
import { evaluatePiVersionPolicy, PI_MIN_SUPPORTED_VERSION, PI_TESTED_VERSION } from './piVersions';
import type { ProviderDetectionResult } from '../../../../../shared/types/onboarding';

/**
 * Pi's onboarding/Settings availability probe — the pi sibling of
 * {@link detectOmpAvailability}, with the same deliberate thinness: pi owns
 * its own provider credentials (`~/.pi`, its `/login` flow), so Cyboflow has
 * no account to introspect. "Available" means exactly "a usable binary
 * (present, `--version` succeeds, at/above the floor) is on this machine",
 * never anything about which model providers pi itself can reach.
 *
 * Side-effect free and UNCACHED, per the onboarding probe contract in
 * `providerDetection.ts`. The discovery ladder is explicit custom path →
 * `findExecutableInPath('pi')` → version probe → floor policy; there is no
 * Settings custom-path field yet (no `piExecutablePath` config key), but
 * `customPath` is accepted so one can wire straight in later.
 */
export async function detectPiAvailability(
  customPath?: string,
): Promise<ProviderDetectionResult<'pi'>> {
  const configuredPath = customPath?.trim();
  const resolvedPath = configuredPath || findExecutableInPath('pi');
  if (!resolvedPath) {
    return { state: 'unavailable', binaryPath: null, version: null };
  }

  let rawVersion: string;
  try {
    const probe = await probeCliVersion(resolvedPath, { ...process.env, PATH: getShellPath() });
    rawVersion = probe.version;
  } catch {
    // Found on disk but `--version` failed — report unavailable rather than
    // claim a usable binary.
    return { state: 'unavailable', binaryPath: resolvedPath, version: null };
  }

  const verdict = evaluatePiVersionPolicy(rawVersion);
  if (!verdict.ok) {
    // Report the raw version so the Integrations card can explain WHY
    // ("found pi 0.80.1, need >= 0.84.0") instead of a bare "not found".
    return { state: 'unavailable', binaryPath: resolvedPath, version: rawVersion };
  }
  if (verdict.aboveTested) {
    console.warn(
      `[PI] detected version ${rawVersion} is newer than the last version this integration was tested against (${PI_TESTED_VERSION}, floor ${PI_MIN_SUPPORTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
    );
  }
  return { state: 'detected', binaryPath: resolvedPath, version: rawVersion };
}
