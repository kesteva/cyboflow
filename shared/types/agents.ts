/**
 * agents — wire shapes for the Agents catalogue / editor (tRPC `cyboflow.agents`).
 *
 * `AgentEntry` is the post-write effective view of one agent (a builtin, a
 * builtin-with-override, or a custom). It is returned by every `agents.*`
 * procedure and consumed by the renderer via `AppRouter` inference. An agent
 * inherits the run's model by default (`AgentEntry.model === null`,
 * `AgentStats.model` shows the {@link INHERIT_RUN_MODEL_LABEL} sentinel) but MAY
 * pin one of {@link AGENT_MODEL_ALIASES}; per-agent `costUsd` is always `null`
 * (run_usage is run-scoped; no per-agent attribution exists).
 */

import type { CliTool } from './cliTools';

/**
 * The models a workflow agent may PIN instead of inheriting the run model — the
 * bare family aliases (resolved to the current concrete snapshot at the spawn
 * seam, mirroring the quick-session picker). Only families are offered: a
 * per-subagent context-window variant would not survive markdown frontmatter.
 * `null` (the default) means "inherit the run model".
 */
export const AGENT_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;
export type AgentModelAlias = (typeof AGENT_MODEL_ALIASES)[number];

/** Type guard for {@link AgentModelAlias} (the inherit case is represented as null). */
export function isAgentModelAlias(value: unknown): value is AgentModelAlias {
  return typeof value === 'string' && (AGENT_MODEL_ALIASES as readonly string[]).includes(value);
}

/** Human labels for each pinnable model, kept in sync with the picker snapshots. */
export const AGENT_MODEL_LABELS: Record<AgentModelAlias, string> = {
  opus: 'Opus 4.8',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

/** The sentinel label shown when an agent inherits the run model. */
export const INHERIT_RUN_MODEL_LABEL = 'inherits run model';

/** Display label for an agent's pinned model, or the inherit sentinel for null. */
export function agentModelLabel(model: AgentModelAlias | null): string {
  return model === null ? INHERIT_RUN_MODEL_LABEL : AGENT_MODEL_LABELS[model];
}

export interface AgentUsageStep {
  workflowName: string;
  stepNames: string[];
  phaseColor: string;
}

export interface AgentUsage {
  /** Number of distinct workflows whose steps resolve to this agent (bound usage). */
  workflowCount: number;
  /** Per-workflow step binding, for the "Bound to N steps" inspector list. */
  usedBy: AgentUsageStep[];
  /**
   * Workflow names whose PROSE dispatches this agent (`subagent_type:"<key>"` /
   * `cyboflow-<key>`) without a `step.agent` binding — so the 4 step-unbound but
   * fully-effective prose agents render "Dispatched by …" rather than "0 workflows".
   */
  dispatchedBy: string[];
}

export interface AgentStats {
  /**
   * Display label for the agent's model: {@link INHERIT_RUN_MODEL_LABEL} when it
   * inherits the run model, else the pinned model's friendly label
   * ({@link AGENT_MODEL_LABELS}). Computed server-side from {@link AgentEntry.model}.
   */
  model: string;
  estPromptTokens: number;
  costUsd: null;
  lastEditedAt: string | null;
  toolsEnabled: number;
  toolsTotal: number;
}

export type AgentSource = 'builtin' | 'builtin-override' | 'custom';

export interface AgentEntry {
  agentKey: string;
  name: string;
  role: 'planner' | 'sprint' | 'compound' | string;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  /**
   * The model this agent pins (one of {@link AGENT_MODEL_ALIASES}), or `null` to
   * inherit the run model. Seeds the editor's model picker; the spawn-time overlay
   * resolves it to a concrete snapshot in the subagent `model:` frontmatter.
   */
  model: AgentModelAlias | null;
  /** MCP server names this agent may call; rendered as `mcp__<server>__*` on the tools line. */
  enabledMcps: string[];
  source: AgentSource;
  isCustom: boolean;
  isOverridden: boolean;
  usage: AgentUsage;
  stats: AgentStats;
}

/** Emitted on the `cyboflow.agents.onChanged` subscription after every write. */
export interface AgentChangedEvent {
  projectId: number;
  agentKey: string;
}
