/**
 * Dynamic-workflow progress tracking — shared contract.
 *
 * "Dynamic workflows" are Claude Code's in-session multi-agent orchestration
 * (the `Workflow` tool, triggered by the `ultracode` keyword or `/effort
 * ultracode`). Cyboflow does NOT launch these itself — it passively DETECTS
 * that a session's agent launched one (by watching the normalized
 * ClaudeStreamEvent pipeline for the Workflow tool_use/tool_result pair) and
 * then visualizes live progress from the CLI's on-disk artifacts:
 *
 *   - `<sessionDir>/subagents/workflows/wf_<id>/journal.jsonl` — append-only
 *     `{type:'started'|'result', agentId, ...}` lines, one pair per subagent.
 *     This is the live tail target.
 *   - `<sessionDir>/workflows/scripts/<name>-wf_<id>.js` — the persisted
 *     script; its `export const meta = {name, description, phases}` is parsed
 *     to pre-render the phase plan.
 *   - `<sessionDir>/workflows/wf_<id>.json` — terminal record written ONCE at
 *     completion (status, summary, totals). Its appearance is the
 *     authoritative completion signal; the in-stream `<task-notification>`
 *     block is the low-latency accelerator.
 *
 * Main-process side: main/src/orchestrator/dynamicWorkflows/ (tracker,
 * detector, journal tailer, script-meta parser). Renderer side:
 * frontend/src/stores/dynamicWorkflowStore.ts. The tRPC surface is
 * `cyboflow.dynamicWorkflows.{list,onChanged}`.
 */

/** One phase title from the workflow script's `meta.phases` array. */
export interface DynamicWorkflowPhase {
  title: string;
  detail?: string;
}

/**
 * One subagent's lifecycle, derived from journal.jsonl lines:
 * a `started` line creates the agent as 'running'; the matching `result`
 * line (same agentId) flips it to 'done'.
 */
export interface DynamicWorkflowAgent {
  agentId: string;
  status: 'running' | 'done';
}

/** Terminal totals lifted from the wf_<id>.json completion record. */
export interface DynamicWorkflowTotals {
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  durationMs?: number;
}

/**
 * Full tracked state of one dynamic-workflow run inside a session.
 *
 * Keyed by `wfRunId` (the CLI's `wf_*` id) — a session can launch several
 * workflows over its lifetime. `runId` is the cyboflow workflow_runs id
 * hosting the session (the `__quick__` sentinel run for quick sessions),
 * recorded so review items can carry run_id provenance.
 */
export interface DynamicWorkflowRunState {
  /** The CLI's workflow run id (`wf_*`), parsed from the launch tool_result. */
  wfRunId: string;
  /** The CLI's background task id (`w*`), parsed from the launch tool_result. */
  taskId: string;
  /** Cyboflow workflow_runs id hosting the session (sentinel run for quick sessions). */
  runId: string;
  sessionId: string;
  /** Project the session belongs to (for landing-home grouping). */
  projectId: number;
  /** Session display name (for landing-home cards). */
  sessionName: string;
  /** Workflow name from script meta (fallback: derived from the script filename). */
  name: string;
  description?: string;
  /** Phase plan from script meta. Static plan only — journal lines carry no phase attribution. */
  phases: DynamicWorkflowPhase[];
  /** Live per-agent lifecycle from journal.jsonl. */
  agents: DynamicWorkflowAgent[];
  status: 'running' | 'completed' | 'failed';
  /** ISO-8601, stamped at detection time. */
  startedAt: string;
  /** ISO-8601, stamped when the terminal record / failure is observed. */
  completedAt?: string;
  /** Summary string from the wf_<id>.json completion record. */
  summary?: string;
  totals?: DynamicWorkflowTotals;
}

/**
 * Payload of the `cyboflow.dynamicWorkflows.onChanged` subscription.
 * Emitted on every state change (launch detected, agent started/finished,
 * completion observed). Carries the FULL state snapshot — receivers replace,
 * never merge.
 */
export interface DynamicWorkflowChangedEvent {
  state: DynamicWorkflowRunState;
}

/**
 * `source` value stamped on human_task review items created at workflow
 * completion — used by the merge/dismiss auto-resolve sweep to find them.
 */
export const DYNAMIC_WORKFLOW_REVIEW_SOURCE = 'dynamic_workflow';
