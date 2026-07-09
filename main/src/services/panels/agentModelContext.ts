import type { AgentProvider } from '../../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import { resolveModelAlias } from './claude/modelContext';

/**
 * Resolve a spawn-seam model value against the agent provider that will run it.
 *
 * This is intentionally stricter than Claude's alias resolver: session/workflow
 * rows can outlive runtime changes, so the spawn seam must treat a stale model
 * family as "no explicit model" instead of handing `opus` to Codex or `gpt-*` to
 * Claude. Unknown non-cross-family ids still pass through so future/custom model
 * ids are not blocked by this compatibility guard.
 */
export function resolveAgentModelAlias(
  provider: AgentProvider,
  model?: string | null,
): string | undefined {
  const value = normalizeAgentModelSelection(provider, model);
  if (!value || value.toLowerCase() === 'auto') return undefined;

  if (provider === 'claude') {
    return resolveModelAlias(value);
  }

  return value;
}

export function displayAgentModelSelection(
  provider: AgentProvider,
  model: string | null | undefined,
  fallback: string,
): string {
  return normalizeAgentModelSelection(provider, model) ?? fallback;
}
