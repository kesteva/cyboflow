import {
  type ClaudeDetectionState,
  type ProviderDetectionResult,
} from '../../../shared/types/onboarding';
import { detectClaudeCredentials } from '../utils/claudeCredentials';
import { detectClaudeBinary } from '../utils/claudeBinaryDetection';
import type { AppServices } from './types';

/**
 * The CLAUDE half of the onboarding provider probe — the on-demand Claude Code
 * login/binary check. Idempotent, side-effect free, and UNCACHED: the onboarding
 * "Check again" button and the Settings recheck both re-invoke it and must see
 * fresh results after the user logs in or installs the binary.
 *
 * Registration lives in `providerDetection.ts`, which owns the provider→probe
 * registry behind the generic `providers:detect` channel; this module just
 * supplies Claude's probe so each provider keeps its own evidence-gathering.
 *
 * The overall `state` is computed HERE (main-side) so every consumer agrees on
 * the mapping (shared/types/onboarding.ts):
 *   credentials.found            → 'detected'
 *   !credentials.found && binary → 'loggedOut'
 *   neither                      → 'missing'
 */
export function computeState(credentialsFound: boolean, binaryFound: boolean): ClaudeDetectionState {
  if (credentialsFound) return 'detected';
  if (binaryFound) return 'loggedOut';
  return 'missing';
}

export async function probeClaudeDetection(
  services: AppServices,
): Promise<ProviderDetectionResult<'claude'>> {
  const configuredPath = services.configManager.getConfig()?.claudeExecutablePath;
  const [credentials, binary] = await Promise.all([
    detectClaudeCredentials(),
    detectClaudeBinary(configuredPath),
  ]);
  return { credentials, binary, state: computeState(credentials.found, binary.found) };
}
