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
import type { AgentEntry, AgentSource, AgentUsage } from '../../../../shared/types/agents';
import type { BuiltInAgent } from './agentCatalogue';

/** The effective (post-override) view of one agent. */
export interface EffectiveAgent {
  agentKey: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
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
 * Assemble the tRPC `AgentEntry` wire shape from an effective agent, its backing
 * override row (for `lastEditedAt`), and its computed usage.
 *
 * `estPromptTokens` is a coarse char/4 estimate; `model` is the literal
 * `'inherits run model'` and `costUsd` is always `null` (no per-agent attribution).
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
    source: effective.source,
    isCustom: effective.source === 'custom',
    isOverridden: effective.source === 'builtin-override',
    usage,
    stats: {
      model: 'inherits run model',
      estPromptTokens: Math.ceil(effective.systemPrompt.length / 4),
      costUsd: null,
      lastEditedAt: override?.updated_at ?? null,
      toolsEnabled: effective.tools.length,
      toolsTotal: CLI_TOOLS.length,
    },
  };
}
