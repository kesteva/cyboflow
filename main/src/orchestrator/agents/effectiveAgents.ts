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
import type { WorkflowVariantAgentOverrides } from '../../../../shared/types/experiments';
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
  };
}

/** Build an `EffectiveAgent` from a standalone custom override row. */
function customAgent(override: AgentOverrideRow): EffectiveAgent {
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
