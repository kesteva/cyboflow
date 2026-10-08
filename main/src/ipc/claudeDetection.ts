import {
  type ClaudeDetectionState,
  type ProviderDetectionResult,
} from '../../../shared/types/onboarding';
import { detectClaudeCredentials } from '../utils/claudeCredentials';
import { detectClaudeBinary } from '../utils/claudeBinaryDetection';
import type { ClaudeAuthAccount } from '../../../shared/types/claudeAuth';
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
 *
 * Credential PRESENCE is not a working login: a Keychain entry or an
 * `oauthAccount` marker in ~/.claude.json can outlive a logout or a revoked
 * session. So when the presence probe says "found", the CLI is asked too
 * (`claude auth status`, the bundled binary the sessions run); an explicit
 * `loggedIn: false` demotes the result to not-found, which the onboarding
 * Connect step answers with its in-app sign-in. No answer (no binary, a CLI
 * too old for `auth status`) keeps the presence verdict — fail open.
 */
export function computeState(credentialsFound: boolean, binaryFound: boolean): ClaudeDetectionState {
  if (credentialsFound) return 'detected';
  if (binaryFound) return 'loggedOut';
  return 'missing';
}

/**
 * `probeLoginStatus` is injected (providerDetection.ts passes
 * ipc/claudeAuth's `probeClaudeLoginStatus`) rather than imported, so this
 * module stays free of the electron-bound binary resolver: the SDK preflight
 * imports `computeState` from here.
 */
export async function probeClaudeDetection(
  services: AppServices,
  probeLoginStatus: (configuredPath: string | undefined) => Promise<ClaudeAuthAccount | null> = async () => null,
): Promise<ProviderDetectionResult<'claude'>> {
  const configuredPath = services.configManager.getConfig()?.claudeExecutablePath;
  const [presence, binary] = await Promise.all([
    detectClaudeCredentials(),
    detectClaudeBinary(configuredPath),
  ]);
  let credentials = presence;
  if (presence.found) {
    const status = await probeLoginStatus(configuredPath);
    if (status !== null && !status.loggedIn) {
      credentials = { found: false, source: null, account: null };
    } else if (status?.email && credentials.account === null) {
      credentials = { ...credentials, account: status.email };
    }
  }
  return { credentials, binary, state: computeState(credentials.found, binary.found) };
}
