import type { AgentProvider } from './agentRuntime';

/**
 * Reasoning-effort vocabulary, per provider.
 *
 * The two providers expose DIFFERENT scales (IDEA-029): Claude's `--effort`
 * flag / Messages-API `output_config.effort` accepts `low..max`, while Codex's
 * `reasoning_effort` accepts `none..xhigh`. The overlap is `low..xhigh`; only
 * Claude has `max` and only Codex has `none`/`minimal`. A control that offers
 * effort must therefore key its option list to the agent's provider — see
 * {@link effortLevelsForProvider}.
 *
 * This is intentionally PROVIDER-scoped, not per-model. Per-model narrowing
 * (e.g. a Codex "Luna" tier that tops out below `xhigh`) is a later refinement:
 * the Codex model catalogue is discovered dynamically and carries no effort
 * capability today, so there is nothing to key a per-model map on yet.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
export type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number];

/** The union of every effort value either provider accepts. */
export type ReasoningEffort = ClaudeEffortLevel | CodexEffortLevel;

/**
 * Every effort value across both providers, de-duplicated, for the wire schema.
 * Persistence is provider-agnostic (the resolved provider isn't known when a
 * `WorkflowAgentConfig` is validated), so the Zod enum accepts the whole union;
 * provider-specific validity is enforced later by {@link normalizeEffortSelection}.
 */
export const ALL_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const CLAUDE_EFFORT_SET = new Set<string>(CLAUDE_EFFORT_LEVELS);
const CODEX_EFFORT_SET = new Set<string>(CODEX_EFFORT_LEVELS);
const ALL_EFFORT_SET = new Set<string>(ALL_EFFORT_LEVELS);

/** Narrow an arbitrary value to a known effort level (provider-agnostic). */
export function isAnyEffortLevel(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ALL_EFFORT_SET.has(value);
}

/** The ordered effort options valid for `provider`, for UI pickers. */
export function effortLevelsForProvider(provider: AgentProvider): readonly ReasoningEffort[] {
  return provider === 'codex' ? CODEX_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
}

/** True when `effort` is an accepted value for `provider`'s effort scale. */
export function isValidEffortForProvider(provider: AgentProvider, effort: string): boolean {
  const key = effort.toLowerCase().trim();
  return (provider === 'codex' ? CODEX_EFFORT_SET : CLAUDE_EFFORT_SET).has(key);
}

/**
 * Normalize a persisted effort selection against the provider that owns it —
 * the effort twin of `normalizeAgentModelSelection` in {@link ./agentModels}.
 *
 * `default` / empty is treated as no explicit selection (`undefined`). A value
 * outside the provider's scale (e.g. a Codex-only `minimal` left on a config
 * whose runtime later flipped to Claude, or Claude's `max` on a Codex agent) is
 * dropped rather than forwarded to a spawn that would reject it.
 */
export function normalizeEffortSelection(
  provider: AgentProvider,
  effort?: string | null,
): ReasoningEffort | undefined {
  const value = effort?.trim();
  if (!value) return undefined;
  const key = value.toLowerCase();
  if (key === 'default') return undefined;
  if (!isValidEffortForProvider(provider, key)) return undefined;
  return key as ReasoningEffort;
}
