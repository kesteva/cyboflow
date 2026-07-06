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
  /**
   * `workflow_runs.started_at` as an ISO-8601 string; null when the run has not
   * started yet (or the run row is absent). Carried alongside the token rollup so
   * the summary panel can show total runtime without a second round-trip; the
   * token aggregation itself never reads it (folded in by selectRunUsageRollups).
   */
  startedAt: string | null;
  /**
   * `workflow_runs.ended_at` as an ISO-8601 string; null while the run is still in
   * flight (at the human-review gate / awaiting_review it is typically still null,
   * so the panel renders elapsed = now - startedAt until close-out stamps it).
   */
  endedAt: string | null;
}

/** Per-workflow usage aggregate over the runs that have usage data. */
export interface WorkflowUsageStats {
  workflowId: string;
  workflowName: string;
  /** Runs whose rollup had assistantMessageCount > 0. */
  runsWithUsage: number;
  avgTotalTokens: number | null;
  /** Sum of totalTokens (input + output, cache excluded) across runsWithUsage;
   *  null when no run has usage. Backs the by-flow token bars. */
  totalTokens: number | null;
  /** Sum of cache_read + cache_creation tokens across runsWithUsage; null when no
   *  run has usage. Surfaced as the card's secondary "cache" stat — the headline
   *  totalTokens excludes cache, but cost INCLUDES it (cache reads are billed at
   *  ~10% of input), so without this the token figure looks absurd next to the $. */
  totalCacheTokens: number | null;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
}

/**
 * One day x model token bucket for the 30-day usage chart at the top of the
 * Statistics section. Buckets come from the raw_events assistant-message scan:
 * `day` is the UTC date slice of raw_events.created_at, `model` is the SDK
 * assistant message's `message.model` ('unknown' when absent). Token fields
 * follow the RunUsageRollup convention — totalTokens = input + output, cache
 * counted separately and excluded from the total. Days with no usage emit no
 * bucket (the chart component fills the axis).
 */
export interface DailyModelUsagePoint {
  /** UTC day, 'YYYY-MM-DD'. */
  day: string;
  /** Model id as reported by the assistant message, or 'unknown'. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** inputTokens + outputTokens (cache excluded). */
  totalTokens: number;
  assistantMessageCount: number;
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
 * and recorded in the migration-026 `workflow_revisions` table. Runs are bucketed
 * by the `workflow_runs.spec_hash` frozen at run creation, so each revision's stats
 * cover ONLY the runs that executed that precise spec text — even after the live
 * `spec_json` is later edited into a newer revision.
 *
 * Runs created before migration 026 carry `spec_hash = NULL` and are therefore
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
    notification: number;
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

// ---------------------------------------------------------------------------
// Run evaluation (code-review eval rubric — migration 043 `run_evals`)
// ---------------------------------------------------------------------------

/**
 * Worker state machine for one `run_evals` row:
 *   - pending  : row created at the human-review trigger; judge not yet dispatched.
 *   - running  : the K-sample jury is in flight.
 *   - complete : scores/dimensions/CI persisted.
 *   - failed   : the worker gave up (see RunEval.error).
 * Mirrors the DB CHECK on `run_evals.eval_status`.
 */
export type RunEvalStatus = 'pending' | 'running' | 'complete' | 'failed';

/** Quality band derived from the overall score; null until eval_status='complete'. */
export type RunEvalBand = 'Excellent' | 'Good' | 'Fair' | 'Poor';

/**
 * One rubric dimension's scored result (parsed from `run_evals.dimensions_json`).
 * `active` is false when the dimension did not apply to this run's diff (it is
 * then excluded from the weighted overall). Counts are over the K jury samples.
 */
export interface RunEvalDimension {
  /** Stable dimension key (e.g. 'correctness'). */
  key: string;
  /** Human-readable dimension label. */
  name: string;
  /** Weight in the overall score (rubric scale, 0-100; the dimensions sum to 100). */
  weight: number;
  /** 0-100 integer; null until the dimension is scored. */
  score: number | null;
  /** Whether the dimension applied to this run (inactive ones are excluded). */
  active: boolean;
  passCount: number;
  failCount: number;
  unknownCount: number;
}

/**
 * One jury sample's raw structured verdict, kept verbatim (parsed from
 * `run_evals.per_sample_json`). The judge's output schema is owned by the eval
 * worker (sibling module), so this stays an opaque-but-typed record here — the
 * read path never interprets its interior, only surfaces it for drill-down.
 */
export type RunEvalSample = Record<string, unknown>;

/**
 * The canonical evaluation for one workflow run, mirroring the migration-043
 * `run_evals` columns in camelCase. JSON columns are parsed defensively by the
 * query layer: malformed JSON yields a null field rather than throwing.
 *
 * Score/band/CI/dimensions/perSample are null until `evalStatus === 'complete'`.
 * All timestamps are ISO-8601 strings per this file's boundary convention.
 */
export interface RunEval {
  runId: string;
  /** Rubric version (composite PK half); e.g. '1.1'. */
  rubricVersion: string;
  evalStatus: RunEvalStatus;
  /** Copied from workflow_runs.base_sha; null on legacy/unmaterialized runs. */
  baseSha: string | null;
  /**
   * Frozen unified diff captured at the trigger. EXCLUDED from the polled read
   * (`insights.runEval`) because it can be multi-MB — always null there; a future
   * drill-down would fetch it via a dedicated read.
   */
  diffText: string | null;
  /** Parsed `diff_stats_json` aggregate; null when absent or malformed. */
  diffStats: Record<string, unknown> | null;
  /** Parsed `gate_results_json` (folded step_results when present); null otherwise. */
  gateResults: Record<string, unknown> | null;
  /** True once a human-review re-fire touched this row (request-changes loop). */
  humanInfluenced: boolean;
  /** ISO timestamp of the trigger capture. */
  snapshotAt: string;
  /** 0-100 overall; null until complete. */
  overallScore: number | null;
  band: RunEvalBand | null;
  /**
   * Naive [min, max] SPREAD of the per-sample overall scores (NOT a statistical
   * confidence interval — the Agent SDK exposes no temperature knob); null until
   * complete. Surfaced in the UI as "sample spread", not "95% CI".
   */
  ciLow: number | null;
  ciHigh: number | null;
  /** Deterministic-gate-failure sentinel. */
  gated: boolean;
  /** Confirmed high/critical security soft-cap fired. */
  securityFlag: boolean;
  /** SCP-1 unimplemented-acceptance-criterion cap fired (doc `requirements_unmet`). */
  requirementsUnmet: boolean;
  /**
   * Catastrophic-cap trigger tokens (sub-check ids and/or 'security') when the
   * overall score was soft-capped at Fair (≤69); null when the score was not
   * capped. Lets a capped 69 be told apart from an organic Fair 69.
   */
  capTriggers: string[] | null;
  /** Per-dimension scored results; null until complete or when malformed. */
  dimensions: RunEvalDimension[] | null;
  /**
   * Raw K jury structured outputs. EXCLUDED from the polled read (`insights.runEval`)
   * — always null there; kept in the type for a future drill-down read.
   */
  perSample: RunEvalSample[] | null;
  /** Concrete judge model id; null until running. */
  judgeModel: string | null;
  /** K actually completed; null until running. */
  sampleCount: number | null;
  /** sha256 of the judge prompt; null until running. */
  promptHash: string | null;
  /** App version string of the build that produced the eval; null until running. */
  judgeBuildId: string | null;
  workflowId: string;
  /** Denormalized at trigger (workflows are user-editable/deletable). */
  workflowName: string;
  /** workflow_runs.spec_hash; null on pre-migration-026 runs. */
  specHash: string | null;
  /** workflow_runs.model; null/'auto' = SDK default. */
  runModel: string | null;
  /** Parsed `subagent_models_json` (step→model map); null when absent/malformed. */
  subagentModels: Record<string, unknown> | null;
  /** Reserved pre-run difficulty signal; NULL in v1 (not yet derivable). */
  difficultyProxyPrerun: number | null;
  /** Populated when evalStatus='failed'. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
