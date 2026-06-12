/**
 * insights — shared contract for the Insights view (run statistics, usage
 * rollups, review-queue summary, code-quality buckets).
 *
 * Backend producers: main/src/orchestrator/insightsQueries.ts (pure DatabaseLike
 * SELECT helpers) surfaced via the `cyboflow.insights` tRPC router.
 * Frontend consumer: frontend/src/stores/insightsStore.ts + components/Insights/*.
 *
 * All fields are JSON primitives (string | number | boolean | null) so values
 * survive the tRPC/superjson boundary without Date-revival surprises —
 * timestamps are ISO-8601 strings, durations are milliseconds.
 *
 * Substrate caveat (see docs/ARCHITECTURE.md "Dual-substrate"): token usage is
 * aggregated from persisted SDK `assistant` payloads in `raw_events`. SDK runs
 * always carry usage; interactive runs carry it only when the transcript
 * normalizer preserved a `usage` object. `costUsd` comes from the terminal
 * `result` payload's `total_cost_usd` and is SDK-only (null elsewhere).
 */

// ---------------------------------------------------------------------------
// Statistics (mockup section 02)
// ---------------------------------------------------------------------------

/** Per-workflow run-outcome statistics derived purely from `workflow_runs`. */
export interface WorkflowRunStats {
  workflowId: string;
  workflowName: string;
  projectId: number;
  totalRuns: number;
  /** Runs in a non-terminal status (queued/starting/running/awaiting_review/awaiting_input/stuck/paused). */
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  /** outcome = 'merged'. */
  mergedRuns: number;
  /** outcome = 'dismissed'. */
  dismissedRuns: number;
  /**
   * Terminal status but outcome IS NULL — a data-integrity signal (see the
   * feasibility study: session-level merges do not stamp child-run outcomes
   * until the Phase-2 propagation lands).
   */
  nullOutcomeRuns: number;
  /** failedRuns / (completed+failed+canceled) * 100, rounded to 1dp; 0 when no terminal runs. */
  errorRatePct: number;
  /** AVG(ended_at - started_at) ms over terminal runs with both stamps; null when none. */
  avgDurationMs: number | null;
  /** MAX(created_at) ISO string; null when the workflow has never run. */
  lastRunAt: string | null;
}

/** Token/cost rollup for one run, aggregated from persisted `raw_events`. */
export interface RunUsageRollup {
  runId: string;
  /** Sums over `assistant` payloads' message.usage (NOT result.usage — result events double-count turn totals). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** inputTokens + outputTokens — mirrors messageProjection's display convention. */
  totalTokens: number;
  /** SUM of `result` payloads' total_cost_usd across turns; null when no result carried it. */
  costUsd: number | null;
  /** SUM of `result` payloads' num_turns; null when no result carried it. */
  numTurns: number | null;
  /** Count of `assistant` payloads that carried a usage object. */
  assistantMessageCount: number;
}

/** Per-workflow usage aggregate over the runs that have usage data. */
export interface WorkflowUsageStats {
  workflowId: string;
  workflowName: string;
  /** Runs whose rollup had assistantMessageCount > 0. */
  runsWithUsage: number;
  avgTotalTokens: number | null;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
}

/** Tokens attributed to one workflow step across recent runs (mockup S5). */
export interface StepTokenBucket {
  /** WorkflowStep.id from the run's effective definition, or 'unattributed' for
   *  usage seen before the first cyboflow_report_step tool_use. */
  stepId: string;
  totalTokens: number;
  assistantMessageCount: number;
}

/** One time-bucketed trend point (mockup S7 sparklines). */
export interface UsageTrendPoint {
  /** Local date bucket, 'YYYY-MM-DD'. */
  date: string;
  totalTokens: number;
  runs: number;
}

/**
 * Per-revision run statistics for one workflow's version history (mockup S6).
 *
 * A "revision" is a distinct `spec_json` snapshot of a workflow, content-addressed
 * by its `spec_hash` (sha256 of the exact spec text — see specHash.ts/computeSpecHash)
 * and recorded in the migration-025 `workflow_revisions` table. Runs are bucketed
 * by the `workflow_runs.spec_hash` frozen at run creation, so each revision's stats
 * cover ONLY the runs that executed that precise spec text — even after the live
 * `spec_json` is later edited into a newer revision.
 *
 * Runs created before migration 025 carry `spec_hash = NULL` and are therefore
 * INVISIBLE here by design (they belong to no recorded revision); they still count
 * in the workflow-wide {@link WorkflowRunStats} aggregate.
 */
export interface WorkflowRevisionStats {
  workflowId: string;
  /** sha256 hex of this revision's spec_json (the bucket key). */
  specHash: string;
  /** ISO-8601 timestamp the revision was first recorded (workflow_revisions.created_at). */
  firstSeenAt: string;
  /**
   * True when this revision's hash equals the hash of the workflow's CURRENT live
   * `spec_json` (computeSpecHash over `workflows.spec_json`) — i.e. the revision a
   * new run would execute right now. At most one revision per workflow is current.
   */
  isCurrent: boolean;
  /** Total runs that froze this spec_hash. */
  runs: number;
  /** Runs with outcome='merged'. */
  mergedRuns: number;
  /** Runs with status='failed'. */
  failedRuns: number;
  /**
   * merged / (terminal runs with an outcome) * 100, rounded to 1dp; 0 when no
   * terminal-with-outcome run exists. "Terminal with outcome" = a run that reached
   * a merged/dismissed disposition — the denominator excludes still-running and
   * outcome-unstamped runs so a half-finished revision is not penalized.
   */
  successRatePct: number;
  /** Mean total_tokens over this revision's materialized run_usage rows; null when none. */
  avgTotalTokens: number | null;
}

// ---------------------------------------------------------------------------
// Review-queue summary (mockup section 01 counters)
// ---------------------------------------------------------------------------

export interface ReviewItemSummary {
  total: number;
  pending: number;
  resolved: number;
  dismissed: number;
  pendingByKind: {
    finding: number;
    permission: number;
    decision: number;
    human_task: number;
  };
}

// ---------------------------------------------------------------------------
// Code quality (mockup section 03)
// ---------------------------------------------------------------------------

/**
 * A `kind='finding'` review item joined with its creating run, flattened for
 * the code-quality columns. `sourceStep` is parsed from the chokepoint-stamped
 * `source` ('agent:<step-or-role>' — see mcpQueryHandler.resolveReviewItemRunContext).
 */
export interface QualityFinding {
  id: string;
  projectId: number;
  title: string;
  severity: 'info' | 'warning' | 'error' | null;
  status: 'pending' | 'resolved' | 'dismissed';
  /** Raw provenance string, e.g. 'agent:executor'. */
  source: string | null;
  /** The '<step-or-role>' tail of an 'agent:' source; null when unparseable. */
  sourceStep: string | null;
  /** FindingPayload.category when the payload carried one. */
  category: string | null;
  /** FindingPayload.locations when the payload carried them. */
  locations: Array<{ path: string; line?: number }>;
  createdAt: string;
  resolution: string | null;
  runId: string | null;
  runOutcome: string | null;
  runEndedAt: string | null;
  workflowName: string | null;
}

export type QualityBucket = 'in_workflow' | 'verification' | 'post_merge';

/**
 * Payload category that explicitly marks a finding as a post-merge regression
 * (Phase-3 convention; classifyQualityFinding honors it from day one).
 */
export const POST_MERGE_FINDING_CATEGORY = 'post-merge-bug';

/** Step-id fragments that classify a finding as caught during verification. */
const VERIFICATION_STEP_PATTERN = /verify|review|test/i;

/**
 * v1 bucketing rule for the three code-quality columns:
 *  1. post_merge   — explicitly categorized POST_MERGE_FINDING_CATEGORY, OR
 *                    created AFTER its run merged (runOutcome='merged' and
 *                    createdAt > runEndedAt).
 *  2. verification — creating step id matches /verify|review|test/i.
 *  3. in_workflow  — everything else.
 * Pure + shared so backend tests and frontend rendering cannot drift.
 */
export function classifyQualityFinding(f: QualityFinding): QualityBucket {
  if (f.category === POST_MERGE_FINDING_CATEGORY) return 'post_merge';
  if (
    f.runOutcome === 'merged' &&
    f.runEndedAt !== null &&
    f.createdAt > f.runEndedAt
  ) {
    return 'post_merge';
  }
  if (f.sourceStep !== null && VERIFICATION_STEP_PATTERN.test(f.sourceStep)) {
    return 'verification';
  }
  return 'in_workflow';
}

/** Parse the '<step-or-role>' tail of an 'agent:' provenance source. */
export function parseSourceStep(source: string | null): string | null {
  if (source === null) return null;
  const match = /^agent:(.+)$/.exec(source);
  return match === null ? null : match[1];
}
