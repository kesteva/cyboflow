import type { AgentProvider } from '../../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import { resolveModelAlias } from './claude/modelContext';

/**
 * Resolve a spawn-seam model value against the agent provider that will run it.
 *
 * This is intentionally stricter than Claude's alias resolver: session/workflow
 * rows can outlive runtime changes, so the spawn seam must not hand `opus` to
 * Codex or `gpt-*` to Claude. Automatic Codex selection omits the model so the
 * same runtime that advertises `model/list` also owns default selection. Unknown
 * non-cross-family ids still pass through so future/custom ids are not blocked.
 */
export function resolveAgentModelAlias(
  provider: AgentProvider,
  model?: string | null,
): string | undefined {
  const value = normalizeAgentModelSelection(provider, model);

  if (provider === 'claude') {
    if (!value || value.toLowerCase() === 'auto') return undefined;
    return resolveModelAlias(value);
  }

  if (!value || value.toLowerCase() === 'auto') {
    return undefined;
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
