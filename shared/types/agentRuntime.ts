/**
 * Provider/runtime selection for Cyboflow agent sessions and workflow runs.
 *
 * This is intentionally separate from the legacy Claude-only CliSubstrate
 * (`'sdk' | 'interactive'`). Provider answers "which agent family?" while
 * runtime answers "which transport for that family?".
 */

import type { CliSubstrate } from './substrate';

export type AgentProvider = 'claude' | 'codex';

export type AgentRuntime =
  | 'claude-sdk'
  | 'claude-interactive'
  | 'codex-sdk'
  | 'codex-pty'
  | 'codex-exec';

export type SessionAgentRuntime = Exclude<AgentRuntime, 'codex-exec'>;

export type WorkflowAgentRuntime = Exclude<AgentRuntime, 'codex-pty' | 'codex-exec'>;

export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';
export const DEFAULT_SESSION_AGENT_RUNTIME: SessionAgentRuntime = 'claude-sdk';
export const DEFAULT_WORKFLOW_AGENT_RUNTIME: WorkflowAgentRuntime = 'claude-sdk';

export const AGENT_PROVIDERS = ['claude', 'codex'] as const;

export const SESSION_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'codex-pty',
] as const;

export const WORKFLOW_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
] as const;

export function isWorkflowRuntimeSupported(runtime: WorkflowAgentRuntime): boolean {
  return WORKFLOW_AGENT_RUNTIMES.includes(runtime);
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isSessionAgentRuntime(value: unknown): value is SessionAgentRuntime {
  return typeof value === 'string' && (SESSION_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function isWorkflowAgentRuntime(value: unknown): value is WorkflowAgentRuntime {
  return typeof value === 'string' && (WORKFLOW_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function claudeRuntimeFromSubstrate(
  substrate: CliSubstrate,
): Extract<WorkflowAgentRuntime, 'claude-sdk' | 'claude-interactive'> {
  return substrate === 'interactive' ? 'claude-interactive' : 'claude-sdk';
}
