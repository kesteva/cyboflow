/**
 * agents — wire shapes for the Agents catalogue / editor (tRPC `cyboflow.agents`).
 *
 * `AgentEntry` is the post-write effective view of one agent (a builtin, a
 * builtin-with-override, or a custom). It is returned by every `agents.*`
 * procedure and consumed by the renderer via `AppRouter` inference. Agents are
 * MODEL-AGNOSTIC: they inherit the run's model, so `AgentStats.model` is the
 * literal string `'inherits run model'` and per-agent `costUsd` is always `null`
 * (run_usage is run-scoped; no per-agent attribution exists).
 */

import type { CliTool } from './cliTools';

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
  model: 'inherits run model';
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
