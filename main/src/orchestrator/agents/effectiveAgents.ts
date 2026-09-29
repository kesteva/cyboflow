/**
 * effectiveAgents — merge the parsed built-in catalogue with a project's
 * `agent_overrides` rows into the effective agent set the gallery + spawn-overlay
 * consume, and assemble the tRPC `AgentEntry` wire shape.
 *
 * An override TOTAL-REPLACES description / systemPrompt / tools / role for the
 * builtin it shadows (`source` becomes `builtin-override`); the frontmatter
 * `name` is ALWAYS `cyboflow-<key>` regardless of stored name. Unoverridden
 * builtins keep their verbatim `rawContent` so the overlay can write them
 * byte-for-byte. `is_custom` rows append as `source: 'custom'` agents (no
 * rawContent — the overlay renders them via `renderAgentMarkdown`).
 *
 * Imports `AgentOverrideRow` type-only (no DB/Electron runtime dependency).
 */
import type { AgentOverrideRow } from '../../database/models';
import type { CliTool } from '../../../../shared/types/cliTools';
import { isCliTool, CLI_TOOLS } from '../../../../shared/types/cliTools';
import type {
  AgentEntry,
  AgentModelAlias,
  AgentSource,
  AgentUsage,
} from '../../../../shared/types/agents';
import { agentModelLabel, isAgentModelAlias } from '../../../../shared/types/agents';
import type { WorkflowAgentRuntime } from '../../../../shared/types/agentRuntime';
import { isWorkflowLaunchableRuntime } from '../../../../shared/types/agentRuntime';
import type { ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import { isAnyEffortLevel } from '../../../../shared/types/reasoningEffort';
import type { WorkflowVariantAgentOverrides } from '../../../../shared/types/experiments';
import type { RunAgentTargetOverrides, WorkflowAgentConfig } from '../../../../shared/types/workflows';
import { ensureResultSection, isGrantableMcpServer } from './agentValidation';
import type { BuiltInAgent } from './agentCatalogue';

/** The effective (post-override) view of one agent. */
export interface EffectiveAgent {
  agentKey: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  /** The agent's pinned model alias, or `null` to inherit the run model. */
  model: AgentModelAlias | null;
  /** MCP server names this agent may call; rendered as `mcp__<server>__*` on the tools line. */
  enabledMcps: string[];
  source: AgentSource;
  /** Present for unoverridden builtins so the overlay can write the `.md` verbatim. */
  rawContent?: string;
  /**
   * The CLI runtime/provider this agent runs on, when overridden. Absent ->
   * inherit the run-level provider/runtime (no per-agent source sets this yet).
   */
  runtime?: WorkflowAgentRuntime;
  /**
   * The model id for this agent's resolved NON-CLAUDE provider, when overridden
   * (e.g. used when `runtime === 'codex-sdk'`). Already normalized via
   * `providerModel ?? codexModel` at the point this is set — see
   * {@link runtimeFields} — so `codexModel` below always mirrors it. Absent ->
   * inherit.
   */
  providerModel?: string;
  /** @deprecated Mirrors {@link providerModel} for callers that have not migrated. */
  codexModel?: string;
  /**
   * Reasoning-effort override carried verbatim from the config; the whole
   * cross-provider union (see {@link ReasoningEffort}). Narrowed to the resolved
   * provider's scale at the spawn seam. Absent -> inherit the run/CLI default.
   */
  effort?: ReasoningEffort;
}

/** Parse an override row's `tools_json` into a filtered `CliTool[]`. */
function parseTools(toolsJson: string): CliTool[] {
  let raw: unknown;
  try {
    raw = JSON.parse(toolsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is CliTool => typeof t === 'string' && isCliTool(t));
}

/** Parse an override row's `enabled_mcps_json` into a string[] of MCP server names. */
function parseMcps(mcpsJson: string | null | undefined): string[] {
  if (!mcpsJson) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(mcpsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Narrow an override row's `model` cell (a free-form `string | null`, or
 * `undefined` on a DB predating migration 036) to a known {@link AgentModelAlias}
 * or `null` (inherit). An unrecognized value falls back to inherit.
 */
function parseAgentModel(value: string | null | undefined): AgentModelAlias | null {
  return isAgentModelAlias(value) ? value : null;
}

/**
 * Narrow an override row's `runtime` cell (`string | null`, or `undefined` on a
 * DB predating migration 070) to a known {@link WorkflowAgentRuntime} or
 * `undefined` (inherit). An unrecognized value falls back to inherit.
 */
function parseAgentRuntime(value: string | null | undefined): WorkflowAgentRuntime | undefined {
  return isWorkflowLaunchableRuntime(value) ? value : undefined;
}

/**
 * Narrow an override row's `codex_model` or `provider_model` cell to a
 * non-empty string, or `undefined`. Both columns share this shape (free-form,
 * nullable); the caller decides which cell to normalize.
 */
function parseProviderModel(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Merge one builtin with its override (or `null`). When an override is present it
 * total-replaces description/systemPrompt/tools/role and source becomes
 * `builtin-override`; otherwise the builtin is returned as `source: 'builtin'`
 * with its verbatim `rawContent`. The name is always `cyboflow-<key>`.
 */
export function mergeAgent(
  builtin: BuiltInAgent,
  override: AgentOverrideRow | null,
): EffectiveAgent {
  const name = `cyboflow-${builtin.agentKey}`;
  if (override === null) {
    return {
      agentKey: builtin.agentKey,
      name,
      role: builtin.role,
      description: builtin.description,
      systemPrompt: builtin.systemPrompt,
      tools: builtin.tools,
      model: null, // an unoverridden builtin always inherits the run model
      enabledMcps: [],
      source: 'builtin',
      rawContent: builtin.rawContent,
    };
  }
  return {
    agentKey: builtin.agentKey,
    name,
    role: override.role ?? builtin.role,
    description: override.description,
    systemPrompt: override.system_prompt,
    tools: parseTools(override.tools_json),
    model: parseAgentModel(override.model),
    enabledMcps: parseMcps(override.enabled_mcps_json),
    source: 'builtin-override',
    ...runtimeFields(override),
  };
}

/**
 * The optional `runtime` / `providerModel` overlay carried by an override row.
 * Spread onto an EffectiveAgent so an inherited runtime stays ABSENT (undefined),
 * keeping the `agent.runtime === undefined` fallback checks in the overlay exact.
 *
 * `providerModel` is the READ-SEAM normalization: `row.provider_model ??
 * row.codex_model` (an explicit `provider_model` wins; a pre-104 row with only
 * `codex_model` set still resolves). `codexModel` on the returned object always
 * mirrors the SAME resolved value, so a not-yet-migrated reader sees the
 * correct model id under either key.
 */
function runtimeFields(override: AgentOverrideRow): {
  runtime?: WorkflowAgentRuntime;
  providerModel?: string;
  codexModel?: string;
} {
  const runtime = parseAgentRuntime(override.runtime);
  const providerModel = parseProviderModel(override.provider_model) ?? parseProviderModel(override.codex_model);
  return {
    ...(runtime ? { runtime } : {}),
    ...(providerModel ? { providerModel, codexModel: providerModel } : {}),
  };
}

/** Build an `EffectiveAgent` from a standalone custom override row. */
export function customAgent(override: AgentOverrideRow): EffectiveAgent {
  return {
    agentKey: override.agent_key,
    name: `cyboflow-${override.agent_key}`,
    role: override.role ?? 'custom',
    description: override.description,
    systemPrompt: override.system_prompt,
    tools: parseTools(override.tools_json),
    model: parseAgentModel(override.model),
    enabledMcps: parseMcps(override.enabled_mcps_json),
    source: 'custom',
    ...runtimeFields(override),
  };
}

/**
 * Compute the full effective agent set: every builtin merged with its matching
 * override (by `agent_key`), followed by each `is_custom` override appended as a
 * custom agent.
 */
export function computeEffectiveAgents(
  builtins: Map<string, BuiltInAgent>,
  overrides: AgentOverrideRow[],
): EffectiveAgent[] {
  const byKey = new Map<string, AgentOverrideRow>();
  for (const row of overrides) byKey.set(row.agent_key, row);

  const effective: EffectiveAgent[] = [];
  for (const builtin of builtins.values()) {
    effective.push(mergeAgent(builtin, byKey.get(builtin.agentKey) ?? null));
  }
  for (const row of overrides) {
    if (row.is_custom === 1) effective.push(customAgent(row));
  }
  return effective;
}

/**
 * Apply a workflow VARIANT's per-agent deltas ON TOP of an already-computed
 * effective agent set (A/B testing, migration 048). Pure — no DB / FS.
 *
 * For each agent whose `agentKey` has a delta:
 *   - `systemPrompt` (when present) replaces the agent's prompt;
 *   - `model` (when a valid {@link isAgentModelAlias} alias) narrows the model;
 *     an unrecognized alias leaves the existing model unchanged;
 *   - `rawContent` is DROPPED and `source` flips `builtin → builtin-override`, so
 *     the overlay renders the delta via `renderAgentMarkdown` instead of writing
 *     the stale verbatim `.md`. (A `builtin-override` / `custom` agent keeps its
 *     source; it already renders.)
 *
 * Merge order at the call site (agentOverlayWriter) is
 * `computeEffectiveAgents(builtins, projectOverrides)` FIRST, THEN this — so the
 * VARIANT delta WINS over the project override for the fields it touches. An agent
 * key with no matching effective agent (e.g. a delta targeting a custom agent that
 * was later deleted) is silently ignored — deltas never ADD agents.
 */
export function applyVariantAgentDeltas(
  effective: EffectiveAgent[],
  deltas: WorkflowVariantAgentOverrides,
): EffectiveAgent[] {
  return effective.map((agent) => {
    const delta = deltas[agent.agentKey];
    if (!delta) return agent;

    const systemPrompt = delta.systemPrompt ?? agent.systemPrompt;
    const model = isAgentModelAlias(delta.model) ? delta.model : agent.model;
    const source = agent.source === 'builtin' ? 'builtin-override' : agent.source;

    // Drop rawContent so the overlay renders via renderAgentMarkdown (the flipped
    // source guarantees a builtin no longer writes its stale verbatim body).
    const { rawContent: _dropped, ...rest } = agent;
    void _dropped;
    return { ...rest, systemPrompt, model, source };
  });
}

/**
 * Apply a WORKFLOW's per-agent configs (workflow-scoped agent configs) ON TOP of an
 * already-computed effective agent set. Pure — no DB / FS.
 *
 * For each agent whose `agentKey` has a config:
 *   - `custom` (when a non-null OBJECT) REPLACES description/systemPrompt/tools/
 *     enabledMcps from the embedded copy — a workflow-scoped custom agent.
 *     parseWorkflowDefinition passes `agentConfigs` through UNVALIDATED, so an
 *     out-of-band-edited spec can carry a non-object `custom`, non-array `tools`/
 *     `enabledMcps`, or non-string description/systemPrompt. Every embedded field is
 *     coerced defensively (non-object custom → treated as absent; tools → `[]` when
 *     not an array, then filtered to known {@link CliTool}s; enabledMcps → `[]` when
 *     not an array, then filtered to GRANTABLE servers via
 *     {@link isGrantableMcpServer} — the single-writer cyboflow MCP can never leak
 *     into a rendered grant even from an out-of-band-edited spec; non-string
 *     description/systemPrompt → the existing value is kept) so a malformed config
 *     degrades THIS one agent instead of throwing out of the whole overlay. The
 *     applied prompt is normalized via {@link ensureResultSection}, mirroring the
 *     Agents-pane router's pre-persist normalization;
 *   - `model` (when a valid {@link isAgentModelAlias} alias) replaces the model; an
 *     unrecognized alias leaves the existing model unchanged;
 *   - `runtime` (when a valid {@link isWorkflowLaunchableRuntime} value) replaces the
 *     runtime; an unrecognized value leaves the existing runtime unchanged. This
 *     slice is TYPES + RESOLUTION ONLY — nothing downstream reads `runtime` yet;
 *   - `providerModel` (when a non-empty string; its deprecated alias `codexModel`
 *     is read the SAME way — `providerModel ?? codexModel`, an explicit
 *     `providerModel` wins) replaces the resolved non-Claude provider's model id;
 *     anything else leaves the existing value unchanged;
 *   - in ANY of these cases `rawContent` is DROPPED and `source` flips `builtin →
 *     builtin-override`, so the overlay renders the config via `renderAgentMarkdown`
 *     instead of writing the stale verbatim builtin `.md`. (A `builtin-override` /
 *     `custom` agent keeps its source; it already renders.)
 *
 * Merge order at the call site (agentOverlayWriter) is
 * `computeEffectiveAgents(builtins, projectOverrides)` FIRST, THEN this, THEN
 * `applyVariantAgentDeltas` — so a WORKFLOW config WINS over the project override
 * (Agents-pane pin/body) but a VARIANT delta still wins over the workflow config for
 * the fields it touches. A config key with no matching effective agent is silently
 * ignored (configs never ADD agents — an unspawnable key is a no-op). An empty
 * config (none of `model`, `custom`, `runtime`, `providerModel`/`codexModel`, which
 * the editor never persists) leaves its agent unchanged.
 */
export function applyWorkflowAgentConfigs(
  effective: EffectiveAgent[],
  configs: Record<string, WorkflowAgentConfig>,
): EffectiveAgent[] {
  return effective.map((agent) => {
    const config = configs[agent.agentKey];
    if (
      !config ||
      (config.custom === undefined &&
        config.model === undefined &&
        config.runtime === undefined &&
        config.providerModel === undefined &&
        config.codexModel === undefined &&
        config.effort === undefined)
    ) {
      return agent;
    }

    let { description, systemPrompt, tools, enabledMcps } = agent;
    // The embedded copy is unvalidated (see the doc comment) — read it as unknown
    // and coerce each field so a malformed spec never throws here. A non-object
    // custom is treated as absent (no body fields change).
    const custom: unknown = config.custom;
    const hasCustom = custom !== null && typeof custom === 'object';
    if (hasCustom) {
      const c = custom as Record<string, unknown>;
      if (typeof c.description === 'string') description = c.description;
      // Mirror the Agents-pane router's pre-persist normalization on the APPLIED
      // copy prompt: a rendered body always carries a `## Result` section (no-op
      // when already present). A non-string prompt keeps the base value verbatim.
      if (typeof c.systemPrompt === 'string') systemPrompt = ensureResultSection(c.systemPrompt);
      // Drop any tool that isn't a known CliTool (mirrors effectiveAgents' parseTools);
      // a non-array tools field coerces to [].
      tools = Array.isArray(c.tools)
        ? c.tools.filter((t): t is CliTool => typeof t === 'string' && isCliTool(t))
        : [];
      // Grants must survive the SAME single-writer/name checks the Agents-pane
      // chokepoint enforces (the zod write path already rejects these, but an
      // out-of-band-edited spec bypasses it and this list becomes a real
      // `mcp__<server>__*` grant in the rendered frontmatter).
      enabledMcps = Array.isArray(c.enabledMcps)
        ? c.enabledMcps.filter((m): m is string => typeof m === 'string' && isGrantableMcpServer(m))
        : [];
    }
    const model = isAgentModelAlias(config.model) ? config.model : agent.model;
    const runtime = isWorkflowLaunchableRuntime(config.runtime) ? config.runtime : agent.runtime;
    // READ-SEAM normalization: an explicit config.providerModel wins over its
    // deprecated alias config.codexModel (an out-of-band-edited spec, or a
    // pre-generalization MCP write, may still carry only the old key).
    const configProviderModel =
      typeof config.providerModel === 'string' && config.providerModel.length > 0
        ? config.providerModel
        : typeof config.codexModel === 'string' && config.codexModel.length > 0
          ? config.codexModel
          : undefined;
    const providerModel = configProviderModel ?? agent.providerModel;
    const effort = isAnyEffortLevel(config.effort) ? config.effort : agent.effort;

    // Nothing valid applied (a malformed custom that degraded to absent AND no valid
    // model/runtime/providerModel/effort) → leave the agent fully untouched, exactly
    // like an empty `{}` config: no spurious source flip / rawContent drop.
    if (
      !hasCustom &&
      model === agent.model &&
      runtime === agent.runtime &&
      providerModel === agent.providerModel &&
      effort === agent.effort
    ) {
      return agent;
    }

    const source = agent.source === 'builtin' ? 'builtin-override' : agent.source;

    // Drop rawContent so the overlay renders via renderAgentMarkdown (the flipped
    // source guarantees a builtin no longer writes its stale verbatim body).
    const { rawContent: _dropped, ...rest } = agent;
    void _dropped;
    // codexModel mirrors the resolved providerModel so a not-yet-migrated reader
    // sees the correct value under either key (same contract as runtimeFields).
    return {
      ...rest,
      description,
      systemPrompt,
      tools,
      enabledMcps,
      model,
      runtime,
      providerModel,
      codexModel: providerModel,
      effort,
      source,
    };
  });
}

/**
 * Apply a RUN's operator-written agent-target overrides
 * (workflow_runs.agent_target_overrides_json — the "Switch runtime & retry"
 * action on a limit-paused programmatic run) ON TOP of an already-resolved
 * effective agent set. Pure — no DB / FS. Mirrors {@link applyWorkflowAgentConfigs}
 * for the four target fields only (no `custom` body, no addendum):
 *   - `runtime` (a valid launchable runtime) replaces the runtime;
 *   - `model` (a valid alias) replaces the model; `null` CLEARS it to `null`
 *     (inherit the run model) — a switch onto a non-Claude provider writes
 *     `model: null` so a workflow-pinned Claude alias cannot ride along;
 *   - `providerModel` (non-empty) replaces it; `null` CLEARS it (absent);
 *   - `effort` (a known effort level) replaces it; `null` CLEARS it (absent).
 *
 * Nothing changed → the SAME object (no spurious source flip). Otherwise
 * `rawContent` is dropped, `builtin` flips to `builtin-override`, and `codexModel`
 * mirrors `providerModel`. There is deliberately no `'*'` wildcard key: the writer
 * names every agent it covers. A key with no matching agent is ignored (overrides
 * never ADD agents).
 *
 * Merge order at the call site (`resolveRunEffectiveAgents`): AFTER the workflow
 * `agentConfigs` and the variant deltas, BEFORE `applyPromptAddenda` — the
 * operator's mid-run directive is the highest-precedence target layer.
 */
export function applyRunAgentTargetOverrides(
  effective: EffectiveAgent[],
  overrides: RunAgentTargetOverrides,
): EffectiveAgent[] {
  return effective.map((agent) => {
    const target = overrides[agent.agentKey];
    if (!target) return agent;

    const runtime = isWorkflowLaunchableRuntime(target.runtime) ? target.runtime : agent.runtime;
    const model =
      target.model === null ? null : isAgentModelAlias(target.model) ? target.model : agent.model;
    const providerModel =
      target.providerModel === null
        ? undefined
        : typeof target.providerModel === 'string' && target.providerModel.length > 0
          ? target.providerModel
          : agent.providerModel;
    const effort =
      target.effort === null ? undefined : isAnyEffortLevel(target.effort) ? target.effort : agent.effort;

    if (
      runtime === agent.runtime &&
      model === agent.model &&
      providerModel === agent.providerModel &&
      effort === agent.effort
    ) {
      return agent;
    }

    const source = agent.source === 'builtin' ? 'builtin-override' : agent.source;
    const { rawContent: _dropped, providerModel: _pm, codexModel: _cm, effort: _ef, ...rest } = agent;
    void _dropped;
    void _pm;
    void _cm;
    void _ef;
    return {
      ...rest,
      model,
      runtime,
      ...(providerModel !== undefined ? { providerModel, codexModel: providerModel } : {}),
      ...(effort !== undefined ? { effort } : {}),
      source,
    };
  });
}

/**
 * The heading the prompt addendum is filed under in the rendered agent body.
 *
 * A heading rather than a bare paragraph on purpose: a builtin body ends with its
 * `## Result` contract, and text appended without a heading would read as part of
 * that contract instead of as a separate instruction.
 */
const PROMPT_ADDENDUM_HEADING = '## Tuning-level addendum';

/**
 * Append each workflow agent config's `promptAddendum` to the agent's ALREADY
 * RESOLVED system prompt (plan D5). Pure — no DB / FS.
 *
 * This is the LAST layer, applied after `applyWorkflowAgentConfigs` AND
 * `applyVariantAgentDeltas`, so the addendum lands on whatever prompt actually
 * won: a project's hardened `agent_overrides` body, a workflow-scoped `custom`
 * copy, or a variant delta's wholesale replacement. That ordering is the whole
 * point of the field — a preset that folded a removed lane step's work into a
 * surviving agent must COMPOSE with the project's own agent policy rather than
 * clobber it (an embedded `custom` copy would total-replace
 * description/systemPrompt/tools/enabledMcps, silently erasing a project's tool
 * and MCP restrictions).
 *
 * It touches exactly ONE field. `tools`, `enabledMcps`, `model`, `runtime`,
 * `providerModel`, `effort`, `description` and `role` are carried through
 * untouched by construction.
 *
 * `rawContent` is DROPPED and `source` flips `builtin -> builtin-override` on any
 * agent that receives an addendum — WITHOUT that, the overlay would write the
 * unoverridden builtin's verbatim `.md` and the addendum would never reach the
 * spawned subagent at all (`installAgentOverlay` prefers `rawContent` over the
 * rendered body). An empty / whitespace-only addendum is a no-op, so it can
 * never trigger a spurious source flip.
 */
export function applyPromptAddenda(
  effective: EffectiveAgent[],
  configs: Record<string, WorkflowAgentConfig>,
): EffectiveAgent[] {
  return effective.map((agent) => {
    const raw = configs[agent.agentKey]?.promptAddendum;
    if (typeof raw !== 'string') return agent;
    const addendum = raw.trim();
    if (addendum.length === 0) return agent;

    const source = agent.source === 'builtin' ? 'builtin-override' : agent.source;
    const { rawContent: _dropped, ...rest } = agent;
    void _dropped;
    return {
      ...rest,
      systemPrompt: `${agent.systemPrompt}\n\n${PROMPT_ADDENDUM_HEADING}\n\n${addendum}`,
      source,
    };
  });
}

/**
 * Assemble the tRPC `AgentEntry` wire shape from an effective agent, its backing
 * override row (for `lastEditedAt`), and its computed usage.
 *
 * `estPromptTokens` is a coarse char/4 estimate; `model` carries the raw alias (or
 * null) for the editor while `stats.model` is its display label; `costUsd` is
 * always `null` (no per-agent attribution).
 */
export function buildEffectiveEntry(
  effective: EffectiveAgent,
  override: AgentOverrideRow | null,
  usage: AgentUsage,
): AgentEntry {
  return {
    agentKey: effective.agentKey,
    name: effective.name,
    role: effective.role,
    description: effective.description,
    systemPrompt: effective.systemPrompt,
    tools: effective.tools,
    model: effective.model,
    runtime: effective.runtime ?? null,
    providerModel: effective.providerModel ?? effective.codexModel ?? null,
    codexModel: effective.codexModel ?? effective.providerModel ?? null,
    enabledMcps: effective.enabledMcps,
    source: effective.source,
    isCustom: effective.source === 'custom',
    isOverridden: effective.source === 'builtin-override',
    usage,
    stats: {
      model: agentModelLabel(effective.model),
      estPromptTokens: Math.ceil(effective.systemPrompt.length / 4),
      costUsd: null,
      lastEditedAt: override?.updated_at ?? null,
      toolsEnabled: effective.tools.length,
      toolsTotal: CLI_TOOLS.length,
    },
  };
}
