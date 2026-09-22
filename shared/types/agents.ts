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
import {
  providerForRuntime,
  WORKFLOW_AGENT_RUNTIME_LABELS,
  type WorkflowAgentRuntime,
} from './agentRuntime';

/**
 * The ONE cyboflow MCP tool a subagent may reference/call: the request-only,
 * fire-and-continue visual-verification enqueue (visual-verification P6). It
 * enqueues a request and returns immediately, never mutating workflow state, so
 * it does NOT break the single-writer invariant ("subagents request, never
 * mutate"). A subagent references it in TWO forms — the fully-qualified
 * frontmatter grant AND the bare call name in prose — both sanctioned.
 */
export const SANCTIONED_SUBAGENT_TOOL = 'mcp__cyboflow__cyboflow_request_verification';
export const SANCTIONED_SUBAGENT_TOOL_BARE = 'cyboflow_request_verification';

/**
 * True when `text` references a cyboflow_* ENTITY-WRITE tool — the single-writer
 * invariant an agent's description/prompt must not violate. The one sanctioned
 * request-only tool is stripped FIRST (fully-qualified form before the bare name,
 * since the bare name is its substring), so a legitimate visual-verify reference
 * does not trip the guard; any OTHER `cyboflow_` token then does. This is the
 * single source of truth shared by the backend validator, the renderer editor,
 * and the built-in bundle test.
 */
export function referencesForbiddenWriterTool(text: string): boolean {
  const withoutSanctioned = text
    .split(SANCTIONED_SUBAGENT_TOOL)
    .join('')
    .split(SANCTIONED_SUBAGENT_TOOL_BARE)
    .join('');
  return /cyboflow_/.test(withoutSanctioned);
}

/**
 * The models a workflow agent may PIN instead of inheriting the run model — the
 * bare family aliases (resolved to the current concrete snapshot at the spawn
 * seam, mirroring the quick-session picker). Only families are offered: a
 * per-subagent context-window variant would not survive markdown frontmatter.
 * `null` (the default) means "inherit the run model".
 */
export const AGENT_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type AgentModelAlias = (typeof AGENT_MODEL_ALIASES)[number];

/** Type guard for {@link AgentModelAlias} (the inherit case is represented as null). */
export function isAgentModelAlias(value: unknown): value is AgentModelAlias {
  return typeof value === 'string' && (AGENT_MODEL_ALIASES as readonly string[]).includes(value);
}

/** Human labels for each pinnable model, kept in sync with the picker snapshots. */
export const AGENT_MODEL_LABELS: Record<AgentModelAlias, string> = {
  fable: 'Fable 5.1',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

/** The sentinel label shown when an agent inherits the run model. */
export const INHERIT_RUN_MODEL_LABEL = 'inherits run model';

/** Display label for an agent's pinned model, or the inherit sentinel for null. */
export function agentModelLabel(model: AgentModelAlias | null): string {
  return model === null ? INHERIT_RUN_MODEL_LABEL : AGENT_MODEL_LABELS[model];
}

/**
 * The three pin fields that together decide what an agent actually runs as.
 * Named so surfaces that render this triple (the Agents-catalogue chip, the
 * workflow-editor step card) can pass one value instead of re-declaring the
 * shape — and cannot quietly drop `runtime`/`providerModel` and fall back to
 * reading the Claude alias alone.
 */
export interface AgentRunTarget {
  runtime: WorkflowAgentRuntime | null;
  model: AgentModelAlias | null;
  providerModel: string | null;
}

/**
 * Compact "what will this agent run as" label for the Agents-catalogue card chip.
 * Folds the agent's pinned runtime + model into ONE deterministic string, so a
 * Codex-pinned agent no longer reads as "inherits run model" (the old chip looked
 * only at the Claude `model` alias and ignored `runtime`/`providerModel`):
 *   - inherit runtime (null): the pinned Claude model label, else the inherit
 *     sentinel (a legacy row with a model but no runtime still shows the model);
 *   - a NON-CLAUDE runtime: the pinned provider model id, else the runtime label
 *     ("Codex SDK", "OMP");
 *   - a Claude runtime: the pinned Claude model label, else the runtime label.
 *
 * `providerModel` is the caller's already-normalized (`providerModel ??
 * codexModel`) value for this agent's resolved non-Claude provider. The
 * non-Claude arm is selected through the runtime→provider registry, not a
 * `=== 'codex-sdk'` test: an OMP-pinned agent otherwise fell through to the
 * Claude arm and read as "inherits run model" — the exact bug this function was
 * written to fix, one provider later.
 */
export function agentRunTargetLabel(cfg: AgentRunTarget): string {
  const { runtime, model, providerModel } = cfg;
  if (runtime === null) {
    return model === null ? INHERIT_RUN_MODEL_LABEL : AGENT_MODEL_LABELS[model];
  }
  if (providerForRuntime(runtime) !== 'claude') {
    return providerModel !== null && providerModel !== ''
      ? providerModel
      : WORKFLOW_AGENT_RUNTIME_LABELS[runtime];
  }
  return model === null ? WORKFLOW_AGENT_RUNTIME_LABELS[runtime] : AGENT_MODEL_LABELS[model];
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
  /**
   * The CLI runtime this agent pins (one of the WORKFLOW_AGENT_RUNTIMES), or
   * `null` to inherit the run-level provider/runtime. Seeds the editor's runtime
   * picker; the spawn-time overlay resolves it via `resolveStepAgent` so a
   * programmatic step spawns this agent on the chosen runtime.
   */
  runtime: WorkflowAgentRuntime | null;
  /**
   * The model id for this agent's resolved non-Claude provider (e.g. used when
   * `runtime === 'codex-sdk'`), or `null` for that provider's default. Ignored
   * for Claude runtimes. Already normalized (`providerModel ?? codexModel`) by
   * the server, so this and {@link codexModel} always carry the same value.
   */
  providerModel: string | null;
  /** @deprecated Mirrors {@link providerModel} for callers that have not migrated. */
  codexModel: string | null;
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
