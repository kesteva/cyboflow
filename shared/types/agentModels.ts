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

/**
 * Product-owned picker catalog for the bundled Codex runtime.
 *
 * Keep this aligned with the visible entries returned by `model/list` when the
 * pinned `@openai/codex` runtime is upgraded. `auto` is intentionally included:
 * the spawn seam resolves it to {@link CODEX_COMPATIBLE_DEFAULT_MODEL} so older
 * account defaults cannot select a model the bundled runtime does not support.
 */
export const CODEX_MODEL_OPTIONS = [
  {
    id: 'auto',
    label: 'Auto/default',
    description: `Use the compatible Codex default (${CODEX_COMPATIBLE_DEFAULT_MODEL})`,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Strong model for everyday coding',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Fast, efficient model for simpler coding tasks',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Ultra-fast coding model',
  },
] as const;

const CODEX_MODEL_OPTION_SET = new Set<string>(CODEX_MODEL_OPTIONS.map((option) => option.id));

export function isCodexModelOption(model: string): boolean {
  return CODEX_MODEL_OPTION_SET.has(model.toLowerCase().trim());
}

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
