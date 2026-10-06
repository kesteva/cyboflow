/**
 * runClaudeSdkSessionPreflights — the SHARED fail-closed pre-flight ladder every
 * SDK-PINNED session door must clear BEFORE anything is provisioned.
 *
 * Extracted from the two hand-maintained copies it used to live in — the design
 * branch of `sessions:create-quick` (main/src/ipc/session.ts) and
 * `createDesignSession` (main/src/index.ts, the planner's design-mode fork) —
 * and now also serves the open-idea-session door
 * (main/src/services/openIdeaSessionCore.ts). A third hand-kept copy is exactly
 * how these ladders drift.
 *
 * The three rungs, IN ORDER (the order is load-bearing — the detection probe
 * would otherwise report a perfectly healthy account the user disabled):
 *   1. the Claude provider is switched on at all (Settings → Integrations);
 *   2. Claude credentials/binary detect (same helpers + state mapping as
 *      onboarding's `computeState`, so "available" means one thing everywhere);
 *   3. the global interactivePtyOnly lock is OFF — it forces every session onto
 *      the PTY substrate, which no SDK-pinned door can accept. (Demo mode's
 *      forced 'sdk' pin is COMPATIBLE with an SDK pin and is deliberately not
 *      checked.)
 *
 * Returns a structured `reason` rather than a message: each door keeps its OWN
 * user-facing wording ("Design sessions require…" vs "Idea sessions require…"),
 * so extracting the probe changed no string anywhere.
 */
import { detectClaudeCredentials } from '../utils/claudeCredentials';
import { detectClaudeBinary } from '../utils/claudeBinaryDetection';
import { computeState as computeClaudeDetectionState } from '../ipc/claudeDetection';

export type ClaudeSdkPreflightFailure =
  /** The Claude provider is turned off in Settings → Integrations. */
  | 'provider_disabled'
  /** Claude credentials/binary did not detect (`computeState !== 'detected'`). */
  | 'claude_not_detected'
  /** The install is locked to interactive-PTY-only, which no SDK pin can satisfy. */
  | 'interactive_pty_only';

export type ClaudeSdkPreflightResult = { ok: true } | { ok: false; reason: ClaudeSdkPreflightFailure };

/**
 * The ConfigManager slice the ladder reads. Structural so the real
 * ConfigManager satisfies it and a unit test can pass three literals.
 */
export interface ClaudeSdkPreflightConfig {
  isAgentProviderEnabled(provider: 'claude'): boolean;
  isInteractivePtyOnly(): boolean;
  getConfig(): { claudeExecutablePath?: string } | undefined;
}

export async function runClaudeSdkSessionPreflights(
  configManager: ClaudeSdkPreflightConfig,
): Promise<ClaudeSdkPreflightResult> {
  if (!configManager.isAgentProviderEnabled('claude')) {
    return { ok: false, reason: 'provider_disabled' };
  }

  const [credentials, binary] = await Promise.all([
    detectClaudeCredentials(),
    detectClaudeBinary(configManager.getConfig()?.claudeExecutablePath),
  ]);
  if (computeClaudeDetectionState(credentials.found, binary.found) !== 'detected') {
    return { ok: false, reason: 'claude_not_detected' };
  }

  if (configManager.isInteractivePtyOnly()) {
    return { ok: false, reason: 'interactive_pty_only' };
  }

  return { ok: true };
}
