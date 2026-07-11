import type { AgentProvider } from '../../../../shared/types/agentRuntime';
import {
  CODEX_COMPATIBLE_DEFAULT_MODEL,
  normalizeAgentModelSelection,
} from '../../../../shared/types/agentModels';
import { resolveModelAlias } from './claude/modelContext';

/**
 * Resolve a spawn-seam model value against the agent provider that will run it.
 *
 * This is intentionally stricter than Claude's alias resolver: session/workflow
 * rows can outlive runtime changes, so the spawn seam must not hand `opus` to
 * Codex or `gpt-*` to Claude. Codex falls back to its bundled-runtime-compatible
 * model rather than the potentially newer account default. Unknown
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

  // The bundled Codex runtime may not support the user's newer account default.
  // Pin automatic, absent, and incompatible persisted selections to the newest
  // model this runtime is known to support instead of omitting the model field.
  if (!value || value.toLowerCase() === 'auto') {
    return CODEX_COMPATIBLE_DEFAULT_MODEL;
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
