import type { AgentProvider } from './agentRuntime';

/**
 * Reasoning-effort vocabulary, per provider.
 *
 * The providers expose DIFFERENT scales (IDEA-029): Claude's `--effort` flag /
 * Messages-API `output_config.effort` accepts `low..max`, Codex's
 * `reasoning_effort` accepts `none..xhigh`, and OMP's thinking level accepts
 * `off..max`. The overlap is `low..xhigh`; Codex alone has `none`, OMP alone has
 * `off`, and OMP is the only provider whose scale spans both ends. A control
 * that offers effort must therefore key its option list to the agent's provider
 * — see {@link effortLevelsForProvider}.
 *
 * This is intentionally PROVIDER-scoped, not per-model. Per-model narrowing
 * (e.g. a Codex "Luna" tier that tops out below `xhigh`) is a later refinement:
 * the Codex model catalogue is discovered dynamically and carries no effort
 * capability today, so there is nothing to key a per-model map on yet.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
/**
 * OMP's `--thinking` also accepts `auto`, deliberately NOT modelled here.
 * `auto` means "let OMP decide", which is what the ABSENCE of a selection
 * already means everywhere in this module — `normalizeEffortSelection` returns
 * `undefined` for no selection and the spawn seams then omit the flag. Adding it
 * as a value would give the picker two different spellings of the same outcome,
 * and would make `undefined` and `'auto'` indistinguishable in persisted state.
 * (Verified against omp v17.3.2: off|minimal|low|medium|high|xhigh|max|auto.)
 */
export const OMP_EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
export type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number];
export type OmpEffortLevel = (typeof OMP_EFFORT_LEVELS)[number];
// Pi shares OMP's named thinking-level scale (pi's `:<thinking>` model suffix
// and setThinkingLevel use the same off/minimal/…/max rungs). Aliased, not
// copied: the two scales stay in lockstep until one actually diverges.
export const PI_EFFORT_LEVELS = OMP_EFFORT_LEVELS;
export type PiEffortLevel = OmpEffortLevel;

/** The union of every effort value any provider accepts. */
export type ReasoningEffort = ClaudeEffortLevel | CodexEffortLevel | OmpEffortLevel;

/**
 * Every effort value across every provider, de-duplicated, for the wire schema.
 * Persistence is provider-agnostic (the resolved provider isn't known when a
 * `WorkflowAgentConfig` is validated), so the Zod enum accepts the whole union;
 * provider-specific validity is enforced later by {@link normalizeEffortSelection}.
 *
 * OMP's `off` is the one net-new member (its `minimal` is already Codex's).
 * Placed next to `none` because the two are the same rung on different scales
 * and the tuple reads low-to-high; the existing members keep their relative
 * order, and nothing keys off the index — every consumer is a `z.enum` or a Set
 * membership test, so widening only ADDS an accepted value and cannot change
 * what an already-persisted one means.
 */
export const ALL_EFFORT_LEVELS = [
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const CLAUDE_EFFORT_SET = new Set<string>(CLAUDE_EFFORT_LEVELS);
const CODEX_EFFORT_SET = new Set<string>(CODEX_EFFORT_LEVELS);
const OMP_EFFORT_SET = new Set<string>(OMP_EFFORT_LEVELS);
const PI_EFFORT_SET = OMP_EFFORT_SET;
const ALL_EFFORT_SET = new Set<string>(ALL_EFFORT_LEVELS);

/** Each provider's own ordered scale, low-to-high. Exhaustive by construction. */
const EFFORT_LEVELS_BY_PROVIDER: Readonly<Record<AgentProvider, readonly ReasoningEffort[]>> = {
  claude: CLAUDE_EFFORT_LEVELS,
  codex: CODEX_EFFORT_LEVELS,
  omp: OMP_EFFORT_LEVELS,
  pi: PI_EFFORT_LEVELS,
};

const EFFORT_SETS_BY_PROVIDER: Readonly<Record<AgentProvider, ReadonlySet<string>>> = {
  claude: CLAUDE_EFFORT_SET,
  codex: CODEX_EFFORT_SET,
  omp: OMP_EFFORT_SET,
  pi: PI_EFFORT_SET,
};

/** Narrow an arbitrary value to a known effort level (provider-agnostic). */
export function isAnyEffortLevel(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ALL_EFFORT_SET.has(value);
}

/**
 * Type predicate for Claude's effort scale — narrows to {@link ClaudeEffortLevel}
 * so a value can be assigned to the Agent SDK's `Options.effort` / the `--effort`
 * flag (which reject Codex-only `none`/`minimal`).
 */
export function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return typeof value === 'string' && CLAUDE_EFFORT_SET.has(value);
}

/** The ordered effort options valid for `provider`, for UI pickers. */
export function effortLevelsForProvider(provider: AgentProvider): readonly ReasoningEffort[] {
  return EFFORT_LEVELS_BY_PROVIDER[provider];
}

/** True when `effort` is an accepted value for `provider`'s effort scale. */
export function isValidEffortForProvider(provider: AgentProvider, effort: string): boolean {
  return EFFORT_SETS_BY_PROVIDER[provider].has(effort.toLowerCase().trim());
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
