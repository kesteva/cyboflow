/**
 * agentProviderGuard — the CALL-LEVEL enforcement of the per-provider access
 * toggles (Settings → Integrations / the onboarding Connect step).
 *
 * Why this exists on top of the launch-seam checks: gating only creation
 * (WorkflowRegistry.createRun, the quick-session IPC handler) leaves every
 * ALREADY-OPEN session able to keep issuing turns — switch Claude off and an
 * existing chat still continues, because a follow-up turn never re-enters a
 * create path. The toggle has to hold at the moment a provider is actually
 * called, not only when a session is born.
 *
 * The guard is installed at every seam where a turn genuinely reaches a vendor,
 * so no path can bypass it:
 *   1. `utils/lazyAgentSdk.loadSdkQuery()` — EVERY Claude Agent SDK `query()`
 *      in the app resolves the function through it, per call (chat turns, the
 *      eval/pairwise judges, the programmatic monitor, verification agents, the
 *      VLM judge, the model catalogue). One assert covers them all.
 *   2. `AbstractCliManager.spawnCliProcess` + each subclass override — every
 *      cold spawn of a CLI/PTY/app-server process.
 *   3. `CodexAppServerClient.start()` — the one spawn seam shared by the Codex
 *      SDK manager and the Codex eval juror (which bypasses that manager).
 *   4. `relayOrSpawnPtyPanel` — a keystroke relayed into an ALREADY-LIVE PTY
 *      never respawns, so the spawn guard alone would miss it.
 *
 * The DISPATCH seams (`sessions:input`, `startCodexSdkTurn`) assert as well,
 * ahead of the seams above. Not for coverage — for ORDER: each of them flips the
 * session to 'running' (and persists the user turn) BEFORE reaching the spawn,
 * and nothing rolls that back, because the turn-end listeners key off events a
 * refused turn never emits. Asserting only at the vendor seam therefore left the
 * chat painting a phantom "thinking" placeholder and a live Stop button over a
 * turn that never ran. Refuse before the side effects, not after.
 *
 * Resolver injection (rather than importing ConfigManager) keeps this module
 * free of concrete-service imports and leaves it inert in unit/headless
 * contexts: the DEFAULT resolver allows everything, so any test or fixture that
 * never calls `setAgentProviderAccessResolver` behaves byte-identically to
 * before the toggles existed. index.ts wires the real resolver at boot,
 * folding in the demo-mode exemption (demo dispatches to the scripted
 * DemoCliManager, never a real vendor).
 */
import {
  AGENT_PROVIDER_LABELS,
  formatAgentProviderDisabled,
  type AgentProvider,
} from '../../../shared/types/agentRuntime';


/**
 * Thrown when a call is attempted against a provider the user switched off.
 * Carries `provider` so a caller can map it back onto a UI affordance without
 * parsing the message.
 */
export class AgentProviderDisabledError extends Error {
  readonly provider: AgentProvider;

  constructor(provider: AgentProvider, context: string) {
    // Carries the machine prefix (shared/types/agentRuntime) because every IPC
    // surface flattens this to a bare string — the renderer parses it back into
    // {provider, message} to show the reason plus an "Open Settings" affordance.
    super(
      formatAgentProviderDisabled(
        provider,
        `${AGENT_PROVIDER_LABELS[provider]} is turned off, so ${context} cannot run. ` +
          `Turn ${AGENT_PROVIDER_LABELS[provider]} back on in Settings → Integrations to continue.`,
      ),
    );
    this.name = 'AgentProviderDisabledError';
    this.provider = provider;
  }
}

type AgentProviderAccessResolver = (provider: AgentProvider) => boolean;

/** Allow-all default — keeps unit/headless contexts byte-identical. */
const ALLOW_ALL: AgentProviderAccessResolver = () => true;

let resolver: AgentProviderAccessResolver = ALLOW_ALL;

/**
 * Install the authoritative resolver (index.ts at boot, from ConfigManager).
 * Passing `null` restores the allow-all default — used by tests to undo an
 * install without leaking state across files.
 */
export function setAgentProviderAccessResolver(next: AgentProviderAccessResolver | null): void {
  resolver = next ?? ALLOW_ALL;
}

/** True when `provider` may be called right now. */
export function isAgentProviderAllowed(provider: AgentProvider): boolean {
  try {
    return resolver(provider);
  } catch {
    // A throwing resolver must never harden into an outage: fail OPEN, matching
    // the absent-config floor (a provider is enabled unless explicitly off).
    return true;
  }
}

/**
 * Throw unless `provider` may be called. `context` names the call in the
 * user-facing message, e.g. 'this chat turn' or 'the Codex app server'.
 */
export function assertAgentProviderAllowed(provider: AgentProvider, context: string): void {
  if (!isAgentProviderAllowed(provider)) {
    throw new AgentProviderDisabledError(provider, context);
  }
}

/**
 * The user-facing message when `error` is a provider-disabled refusal, else
 * null.
 *
 * IPC handlers deliberately collapse a caught error into a generic string so
 * internals never reach the renderer — which also swallowed THIS refusal,
 * leaving the chat showing a bare "Failed · click to retry" with no reason. Call
 * this first in such a catch and return its result when non-null: the message is
 * authored for the user, carries the machine code the renderer parses to offer
 * "Open Settings → Integrations", and leaks nothing.
 *
 * Matches by name as well as by instance so an error that crossed a module or
 * process boundary (losing its prototype) is still recognized.
 */
export function agentProviderDisabledMessage(error: unknown): string | null {
  if (error instanceof AgentProviderDisabledError) return error.message;
  if (
    error instanceof Error &&
    error.name === 'AgentProviderDisabledError' &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return null;
}
