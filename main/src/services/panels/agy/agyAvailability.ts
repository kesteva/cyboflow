import { findExecutableInPath, getShellPath } from '../../../utils/shellPath';
import { probeCliVersion } from '../cli/cliVersionProbe';
import { evaluateAgyVersionPolicy, AGY_MIN_SUPPORTED_VERSION, AGY_TESTED_VERSION } from './agyVersions';
import type { ProviderDetectionResult } from '../../../../../shared/types/onboarding';

/**
 * Antigravity's onboarding/Settings availability probe.
 *
 * Side-effect free and UNCACHED, per the onboarding probe contract in
 * `providerDetection.ts`.
 */
export async function detectAgyAvailability(
  customPath?: string,
): Promise<ProviderDetectionResult<'agy'>> {
  const configuredPath = customPath?.trim();
  const resolvedPath = configuredPath || findExecutableInPath('agy');
  if (!resolvedPath) {
    return { state: 'unavailable', binaryPath: null, version: null };
  }

  let rawVersion: string;
  try {
    const probe = await probeCliVersion(resolvedPath, { ...process.env, PATH: getShellPath() });
    rawVersion = probe.version;
  } catch {
    return { state: 'unavailable', binaryPath: resolvedPath, version: null };
  }

  const verdict = evaluateAgyVersionPolicy(rawVersion);
  if (!verdict.ok) {
    return { state: 'unavailable', binaryPath: resolvedPath, version: rawVersion };
  }
  if (verdict.aboveTested) {
    console.warn(
      `[AGY] detected version ${rawVersion} is newer than the last version this integration was tested against (${AGY_TESTED_VERSION}, floor ${AGY_MIN_SUPPORTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
    );
  }
  return { state: 'detected', binaryPath: resolvedPath, version: rawVersion };
}
