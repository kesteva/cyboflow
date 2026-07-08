import type {
  AgentProvider,
  SessionAgentRuntime,
  WorkflowAgentRuntime,
} from '../../../../shared/types/agentRuntime';
import type { CliSubstrate } from '../../../../shared/types/substrate';

export type LaunchAgentRuntime = SessionAgentRuntime | WorkflowAgentRuntime;

export function providerForRuntime(runtime: LaunchAgentRuntime): AgentProvider {
  return runtime.startsWith('codex-') ? 'codex' : 'claude';
}

export function substrateForRuntime(runtime: LaunchAgentRuntime): CliSubstrate | undefined {
  if (runtime === 'claude-interactive') return 'interactive';
  if (runtime === 'claude-sdk') return 'sdk';
  return undefined;
}

export function workflowRuntimeForLaunch(runtime: LaunchAgentRuntime): WorkflowAgentRuntime | null {
  return runtime === 'codex-pty' ? null : runtime;
}

export function isCodexRuntime(runtime: LaunchAgentRuntime): boolean {
  return providerForRuntime(runtime) === 'codex';
}
