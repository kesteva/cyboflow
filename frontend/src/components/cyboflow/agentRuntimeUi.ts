import type {
  AgentRuntime,
  SessionAgentRuntime,
  WorkflowLaunchableRuntime,
} from '../../../../shared/types/agentRuntime';
import {
  isSessionAgentRuntime,
  isWorkflowLaunchableRuntime,
  providerForRuntime,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import type { CliSubstrate } from '../../../../shared/types/substrate';

export type LaunchAgentRuntime = SessionAgentRuntime | WorkflowLaunchableRuntime;

/**
 * Re-exported so the renderer's launch surfaces resolve a provider through the
 * SAME prefix registry the main-side seams use — this module used to carry its
 * own `startsWith('codex-')` copy, which would map an unregistered runtime into
 * the Claude pickers with no error.
 */
export { providerForRuntime };

export function substrateForRuntime(runtime: LaunchAgentRuntime): CliSubstrate | undefined {
  if (runtime === 'claude-interactive') return 'interactive';
  if (runtime === 'claude-sdk') return 'sdk';
  return undefined;
}

export function workflowRuntimeForLaunch(
  runtime: LaunchAgentRuntime,
): WorkflowLaunchableRuntime | null {
  if (runtime === 'codex-pty') return null;
  return isWorkflowLaunchableRuntime(runtime) ? runtime : null;
}

export function quickSessionRuntimeForLaunch(runtime: LaunchAgentRuntime): SessionAgentRuntime {
  return runtime;
}

/**
 * The launch-picker projection of a PERSISTED runtime — a stored per-run-type
 * default or `config.defaultAgentRuntime`, either of which may be absent or (via
 * a hand-edited config.json) name a runtime no picker offers.
 *
 * `undefined` means "seed nothing here and fall through to the surface's own
 * default", which is what every seeding seam did with its own
 * `!== undefined && !== 'codex-exec'` pair. The POLICY now comes from
 * `RUNTIME_CAPABILITIES.selectableInPickers`; `isSessionAgentRuntime` supplies
 * the narrowing (LaunchAgentRuntime and SessionAgentRuntime coincide), so a
 * runtime marked unselectable can never reach a picker even if the two ever
 * diverge.
 */
export function launchRuntimeForPickers(
  runtime: AgentRuntime | undefined,
): LaunchAgentRuntime | undefined {
  if (!isRuntimeSelectableInPickers(runtime)) return undefined;
  return isSessionAgentRuntime(runtime) ? runtime : undefined;
}

export function isCodexRuntime(runtime: LaunchAgentRuntime): boolean {
  return providerForRuntime(runtime) === 'codex';
}

export function isOmpRuntime(runtime: LaunchAgentRuntime): boolean {
  return providerForRuntime(runtime) === 'omp';
}
