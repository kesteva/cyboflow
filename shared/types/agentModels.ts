import type { AgentProvider } from './agentRuntime';

export const CLAUDE_MODEL_ALIASES = [
  'fable',
  'opus',
  'opus-250k',
  'sonnet',
  'sonnet-250k',
  'haiku',
] as const;

export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/**
 * Model pinned when a Codex launch requests automatic/default selection.
 *
 * Cyboflow bundles a fixed Codex runtime, so delegating to the account default
 * can select a model that the bundled runtime does not support. Keep this value
 * aligned with the concrete Codex model exposed by the launch UI.
 */
export const CODEX_COMPATIBLE_DEFAULT_MODEL = 'gpt-5.5';

const CLAUDE_MODEL_ALIAS_SET = new Set<string>(CLAUDE_MODEL_ALIASES);

export function isClaudeModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return CLAUDE_MODEL_ALIAS_SET.has(key) || key.startsWith('claude-');
}

export function isCodexModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return key.startsWith('gpt-') || key.startsWith('codex-') || /^o[1-9](?:-|$)/.test(key);
}

/**
 * Normalize a persisted picker value against the provider that owns it.
 *
 * This preserves valid user-facing aliases such as `opus`, `sonnet`, and `gpt-*`
 * while dropping stale cross-provider values that can remain after changing a
 * session/workflow runtime. `default` is treated as no explicit selection; `auto`
 * is preserved because existing UI/read-model paths may display it even though
 * spawn seams omit the model flag for it.
 */
export function normalizeAgentModelSelection(
  provider: AgentProvider,
  model?: string | null,
): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;

  const key = value.toLowerCase();
  if (key === 'default') return undefined;

  if (provider === 'claude') {
    if (isCodexModelFamily(key)) return undefined;
    return value;
  }

  if (isClaudeModelFamily(key)) return undefined;
  return value;
}
