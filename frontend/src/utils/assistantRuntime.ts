/**
 * resolveAssistantRuntimeFromConfig — the renderer's one call site for
 * "which runtime hosts the global assistant right now" (docs/proposals/
 * ASSISTANT-CODEX-RUNTIME.md §4). Wraps the shared `resolveAssistantRuntime`
 * resolver with the SAME provider-access read every other runtime picker in
 * this app uses (`isAgentProviderEnabled` against the resolved
 * `agentProviderAccess` map), so this can never disagree with
 * SubstrateSelector / the agent editors about whether a provider is on.
 *
 * A null/undefined config (not yet loaded) resolves to the Claude floor,
 * same as an absent `assistantRuntime` + absent `defaultAgentRuntime` would.
 */
import { resolveAssistantRuntime, type AssistantRuntime } from '../../../shared/types/agentThread';
import { isAgentProviderEnabled, resolveAgentProviderAccess } from '../../../shared/types/agentRuntime';
import type { AppConfig } from '../types/config';

export function resolveAssistantRuntimeFromConfig(
  config: AppConfig | null | undefined,
): AssistantRuntime {
  const access = resolveAgentProviderAccess(config?.agentProviderAccess);
  return resolveAssistantRuntime({
    assistantRuntime: config?.assistantRuntime,
    defaultAgentRuntime: config?.defaultAgentRuntime,
    isProviderEnabled: (provider) => isAgentProviderEnabled(access, provider),
  });
}
