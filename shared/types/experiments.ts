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

/**
 * Lifecycle status of a workflow variant (migration 046).
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

/** Which arm of a side-by-side experiment a run belongs to (migration 046 column). */
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

/** `workflow_variants` DB row (migration 046). */
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
