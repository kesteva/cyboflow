/**
 * Shared types for the workflow A/B testing feature (variants + experiments).
 *
 * Slice A (this file's initial content) owns the variant-registry + arm types:
 * WorkflowVariantStatus / ExperimentArm / WorkflowVariantAgentDelta /
 * WorkflowVariantAgentOverrides / WorkflowVariantRow, plus the shared
 * `isExperimentArmSettled` predicate. Slices B/C append experiment + comparison
 * types below without touching these.
 *
 * Cross-slice contract: there is ONE definition of `ExperimentArm` and ONE
 * `isExperimentArmSettled` predicate — used by the rotation resolver (A), the
 * experiment reconcile + decide guard (B), and pairwise readiness (C).
 */
import type { WorkflowRunStatus } from './cyboflow';
import type { RunUsageRollup, RunEval, QualityFinding } from './insights';

/**
 * Lifecycle status of a workflow variant (migration 048).
 *
 * - `draft`   — the default at creation. Defined, pinnable (restart / experiment
 *               arms load it explicitly), usable in a side-by-side experiment,
 *               but NEVER auto-rotated. Creating two variants for a head-to-head
 *               therefore does NOT silently start randomizing normal launches.
 * - `active`  — "in rotation". The randomized-mode resolver picks only among
 *               active, weight>0 variants.
 * - `paused`  — temporarily out of rotation; still explicitly pinnable.
 * - `retired` — hidden from pickers and rotation; kept for historical stats.
 */
export type WorkflowVariantStatus = 'draft' | 'active' | 'paused' | 'retired';

/** The four `WorkflowVariantStatus` values, for zod/enum construction + iteration. */
export const WORKFLOW_VARIANT_STATUSES: readonly WorkflowVariantStatus[] = [
  'draft',
  'active',
  'paused',
  'retired',
] as const;

/** Which arm of a side-by-side experiment a run belongs to (migration 048 column). */
export type ExperimentArm = 'A' | 'B';

/**
 * A per-agent delta a variant applies over the effective agent set at spawn.
 * Only the fields present are overridden; `systemPrompt` replaces the agent's
 * prompt, `model` narrows the agent's model alias (validated at apply time).
 */
export interface WorkflowVariantAgentDelta {
  systemPrompt?: string;
  model?: string;
}

/** Map of `agentKey -> delta`, stored JSON-encoded in workflow_variants.agent_overrides_json. */
export type WorkflowVariantAgentOverrides = Record<string, WorkflowVariantAgentDelta>;

/** `workflow_variants` DB row (migration 048). */
export interface WorkflowVariantRow {
  id: string;
  workflow_id: string;
  label: string;
  /** Frozen resolved definition (never '{}' for a built-in variant). */
  spec_json: string;
  agent_overrides_json: string | null;
  /** Per-variant model-alias default (nullable). */
  model: string | null;
  /** Per-variant execution-model default (nullable). */
  execution_model: 'orchestrated' | 'programmatic' | null;
  /** Rotation weight (>= 0). */
  weight: number;
  status: WorkflowVariantStatus;
  created_at: string;
  updated_at: string;
}

/**
 * A run is "settled" for experiment purposes once it reaches any terminal-ish
 * status where its output is stable enough to grade / decide on. Shared across
 * the reconcile (B), pairwise readiness (C), and decide guard (B) so those three
 * never drift. Note this INCLUDES `awaiting_review` (a rested run whose work is
 * done and awaiting the human gate), not only the hard-terminal statuses.
 */
export function isExperimentArmSettled(status: string): boolean {
  return (
    status === 'awaiting_review' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled'
  );
}

/**
 * Compile-time guard that the literals in `isExperimentArmSettled` stay valid
 * `WorkflowRunStatus` members — a status rename would fail this reference rather
 * than silently make the predicate dead. Not exported; type-level only.
 */
type _SettledStatuses = Extract<
  WorkflowRunStatus,
  'awaiting_review' | 'completed' | 'failed' | 'canceled'
>;
const _settledStatusesAreValid: readonly _SettledStatuses[] = [
  'awaiting_review',
  'completed',
  'failed',
  'canceled',
];
void _settledStatusesAreValid;

// ===========================================================================
// Slice B — side-by-side experiments (migration 049)
//
// Appended below slice A's variant types; the ExperimentArm definition above is
// shared (one definition, cross-slice contract). Slice C appends comparison /
// stats types below these without touching them.
// ===========================================================================

/**
 * Experiment kind. `side_by_side` is a two-arm head-to-head; `rotation`
 * (migration 058) is an ongoing randomized rotation over a workflow's live
 * baseline + its active variants, tracked as a first-class experiment record.
 */
export type ExperimentKind = 'side_by_side' | 'rotation';

/**
 * Sentinel variant id for the "Current workflow (baseline)" arm of a side-by-side
 * experiment (precedent: the `__quick__` sentinel workflow name). Stored verbatim
 * in `experiments.variant_a_id` / `variant_b_id` (both NOT NULL, migration 049) so
 * a user with ONE variant can test it head-to-head against the live workflow.
 *
 * A baseline arm LAUNCHES as baseline (`workflow_runs.variant_id` NULL) — the run
 * launcher pins it via `launchOptions.baseline` (VariantResolver returns null
 * WITHOUT rotating). It never collides with a real variant id (those are `wfv_…`).
 * The value coincides with variantSelectorLogic's `BASELINE_SENTINEL`, but this one
 * is the cross-boundary EXPERIMENT-ARM sentinel — importable by both the launch UI
 * and the main-process router (variantSelectorLogic is frontend-only).
 */
export const BASELINE_VARIANT_SENTINEL = '__baseline__';

/** True when an experiment arm id is the baseline sentinel rather than a real variant. */
export function isBaselineArm(variantId: string): boolean {
  return variantId === BASELINE_VARIANT_SENTINEL;
}

/**
 * Lifecycle of a side-by-side experiment (migration 049, `experiments.status`).
 *
 * - `running`   — one or both arms still executing.
 * - `grading`   — both arms settled (isExperimentArmSettled); awaiting the human
 *                 decision. Flipped by `reconcileExperimentStatus`.
 * - `decided`   — a winner was promoted (or both discarded) via experiments.decide.
 * - `abandoned` — torn down before a decision (rollback / explicit abandon /
 *                 half-created crash recovery).
 * - `superseded` — (rotation only, migration 058) a rotation experiment closed
 *                 because its ARM-SET MEMBERSHIP changed (a variant activated/
 *                 retired, or the baseline opted in/out); a successor row replaces
 *                 it. Terminal. A pure weight change does NOT supersede.
 */
export type ExperimentStatus = 'running' | 'grading' | 'decided' | 'abandoned' | 'superseded';

/** The five `ExperimentStatus` values, for zod/enum construction + iteration. */
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  'running',
  'grading',
  'decided',
  'abandoned',
  'superseded',
] as const;

/**
 * A settled experiment can no longer be re-run/re-decided; rerun/switchToRotation
 * require it. `superseded` (a rotation replaced by a successor) is terminal too.
 */
export function isExperimentSettled(status: string): boolean {
  return status === 'decided' || status === 'abandoned' || status === 'superseded';
}

/** `experiments` DB row (migration 049; nullable relaxations in 057). */
export interface ExperimentRow {
  id: string;
  /** Nullable since 057: a global-workflow rotation has no project. Always set for side-by-side. */
  project_id: number | null;
  workflow_id: string;
  kind: ExperimentKind;
  /** Nullable since 057: a rotation pins no base branch. Always set for side-by-side. */
  base_branch: string | null;
  /** Nullable since 057: a rotation pins no SHA. Always set for side-by-side. */
  base_sha: string | null;
  /** Nullable since 057: a rotation's arms live in experiment_rotation_arms. Always set for side-by-side. */
  variant_a_id: string | null;
  /** Nullable since 057: see variant_a_id. */
  variant_b_id: string | null;
  run_a_id: string | null;
  run_b_id: string | null;
  session_a_id: string | null;
  session_b_id: string | null;
  seed_idea_id: string | null;
  seed_idea_clone_a_id: string | null;
  seed_idea_clone_b_id: string | null;
  status: ExperimentStatus;
  winner_run_id: string | null;
  winner_arm: ExperimentArm | null;
  merge_sha: string | null;
  decided_at: string | null;
  /** Soft chain link to the source experiment (experiments.rerun); NULL for an original. */
  rerun_of_experiment_id: string | null;
  /** The variant adopted as the base workflow (experiments.promoteVariant); '__baseline__' when the baseline arm won. NULL until promoted. */
  promoted_variant_id: string | null;
  promoted_arm: ExperimentArm | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `experiment_seed_tasks` DB row (migration 051) — per-arm task-clone mapping for
 * a SPRINT experiment. A sprint arm runs a real task set, so startSideBySide
 * clones every selected seed task PER ARM (each clone experiment-tagged, hence
 * board-hidden) and launches the arm with its clone `taskIds`. This mapping lets
 * decide fold each winner clone's outcome (body + stage) back onto its ORIGINAL
 * task and sweep every clone (both arms) on decide / discard / abandon / recovery.
 */
export interface ExperimentSeedTaskRow {
  experiment_id: string;
  arm: ExperimentArm;
  original_task_id: string;
  clone_task_id: string;
  created_at: string;
}

/**
 * `experiment_rotation_arms` DB row (migration 058) — one arm-set snapshot row per
 * arm of a ROTATION experiment, captured at open. `variant_id` is a real variant
 * id or the `BASELINE_VARIANT_SENTINEL` ('__baseline__') for the live-baseline arm.
 * `label` + `weight_at_open` are denormalized so the snapshot survives a later
 * variant delete / re-weight. An arm-set MEMBERSHIP change closes the experiment
 * (status='superseded') and opens a successor with a fresh set of these rows.
 */
export interface ExperimentRotationArmRow {
  experiment_id: string;
  variant_id: string;
  label: string;
  weight_at_open: number;
  created_at: string;
}

/** Result of `experiments.startSideBySide`. */
export interface StartSideBySideResult {
  experimentId: string;
  armA: { runId: string; sessionId: string };
  armB: { runId: string; sessionId: string };
}

/** Result of `experiments.decide` / `abandon` / `rerun` / `switchToRotation` status mutations. */
export interface DecideResult {
  experimentId: string;
  status: ExperimentStatus;
  winnerRunId: string | null;
}

// ===========================================================================
// Slice C — pairwise grading + per-variant stats + comparison payloads
// (migration 050, experiment_comparisons). Appended below slices A/B without
// touching their exports.
// ===========================================================================

/** Pairwise preference mapped back to arm identity (position bias cancelled). */
export type PairwisePreference = 'A' | 'B' | 'tie';

/** Lifecycle of the pairwise comparison row (experiment_comparisons.eval_status). */
export type ComparisonStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

/** Minimum runs before a variant's aggregates are treated as non-provisional (display-only). */
export const MIN_VARIANT_RUNS = 5;

/**
 * One pairwise judge sample. `positionAFirst` records which arm was shown as
 * "Solution 1" so the raw→arm mapping is auditable; `rawPreference` is the
 * judge's neutral-label output; `preference` is the mapped-back arm identity.
 */
export interface PairwiseSample {
  sampleIndex: number;
  positionAFirst: boolean;
  rawPreference: '1' | '2' | 'tie';
  preference: PairwisePreference;
  confidence: number; // 0..1
  rationale: string;
}

/** Aggregate verdict over the surviving K pairwise samples. */
export interface PairwiseVerdict {
  preference: PairwisePreference;
  confidence: number; // mean confidence of the winning-side samples (0 for tie)
  rationale: string; // representative (highest-confidence winning-side) rationale
  aCount: number;
  bCount: number;
  tieCount: number;
  sampleCount: number; // valid samples that survived (<= K)
  perSample: PairwiseSample[];
}

/** `experiment_comparisons` DB row (migration 050). */
export interface ExperimentComparisonRow {
  id: string;
  experiment_id: string;
  run_id_a: string;
  run_id_b: string;
  eval_status: ComparisonStatus;
  base_sha: string | null;
  diff_a_text: string | null;
  diff_b_text: string | null;
  diff_a_stats_json: string | null;
  diff_b_stats_json: string | null;
  seed_context: string | null;
  sample_count: number | null;
  per_sample_json: string | null;
  preference: PairwisePreference | null;
  confidence: number | null;
  rationale: string | null;
  a_count: number;
  b_count: number;
  tie_count: number;
  judge_model: string | null;
  judge_build_id: string | null;
  prompt_hash: string | null;
  error: string | null;
  decision_review_item_id: string | null;
  snapshot_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-variant rotation aggregate (insights.variantStats). */
export interface VariantStats {
  variantId: string;
  variantLabel: string; // denormalized; survives variant deletion
  variantStatus: WorkflowVariantStatus | null; // NULL = variant deleted
  weight: number | null;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  activeRuns: number;
  mergedRuns: number;
  dismissedRuns: number;
  nullOutcomeRuns: number;
  successRatePct: number;
  avgDurationMs: number | null;
  avgTotalTokens: number | null;
  avgCostUsd: number | null;
  avgEvalScore: number | null;
  findingsCount: number;
  postMergeBugCount: number; // via slice B's caused_by_run_id
  lowSample: boolean; // runs < MIN_VARIANT_RUNS
}

/** One arm of the assembled comparison payload. */
export interface ExperimentArmView {
  runId: string;
  arm: ExperimentArm;
  variantLabel: string;
  status: string; // workflow_runs.status
  usage: RunUsageRollup | null;
  evalSummary: RunEval | null;
  findings: QualityFinding[];
  entitySummary: { ideas: number; epics: number; tasks: number };
}

/** Assembled comparison payload (experiments.getComparison). */
export interface ExperimentComparisonPayload {
  experimentId: string;
  comparisonStatus: ComparisonStatus | 'absent';
  baseSha: string | null;
  /** When the frozen diffs were captured (experiment_comparisons.snapshot_at); null pre-capture. */
  snapshotAt: string | null;
  verdict: PairwiseVerdict | null;
  armA: ExperimentArmView;
  armB: ExperimentArmView;
}

/** Frozen per-arm diff texts (experiments.getComparisonDiffs); worktree-independent. */
export interface ExperimentComparisonDiffs {
  baseSha: string | null;
  armA: { runId: string; label: string; diff: string };
  armB: { runId: string; label: string; diff: string };
}

/** Human decision recorded on a decided experiment (derived from winner_arm). */
export type ExperimentDecision = 'promote_a' | 'promote_b' | 'discard';

/** Dashboard list row (experiments.listForDashboard) — includes rerun-chain fields. */
export interface ExperimentSummary {
  experimentId: string;
  workflowId: string;
  baseBranch: string;
  variantAId: string;
  variantBId: string;
  armALabel: string;
  armBLabel: string;
  verdictPreference: PairwisePreference | null;
  verdictConfidence: number | null;
  decision: ExperimentDecision | null; // from slice B's experiments.winner_arm
  status: ExperimentStatus;
  decidedAt: string | null;
  createdAt: string;
  /** Soft chain link to the source experiment (experiments.rerun); NULL for an original. */
  rerunOfExperimentId: string | null;
  /**
   * Stable grouping key for chaining repeated head-to-heads into a series in the
   * dashboard: the root of the rerun chain when known, else the sorted variant
   * pair. Computed server-side so the client groups without walking the chain.
   */
  seriesKey: string;
}

/** Live "comparison ready" toast payload (experiments.onComparisonReady). */
export interface ExperimentComparisonReadyEvent {
  experimentId: string;
  preference: PairwisePreference;
  status: ComparisonStatus;
}
