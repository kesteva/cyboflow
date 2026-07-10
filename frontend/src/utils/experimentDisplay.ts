/**
 * Display-name helpers for A/B experiments (rail group rows + the experiment
 * home header). One place owns the `<workflow> A/B · <challenger>` naming rule
 * so the sidebar and ExperimentComparisonView can never drift.
 *
 * Naming decision (2026-07-09): derived at render time from the experiment's
 * arm labels — no migration, works retroactively for existing experiments.
 * Baseline-ness is judged by the VARIANT ID (BASELINE_VARIANT_SENTINEL), never
 * by parsing the label text.
 */
import { BASELINE_VARIANT_SENTINEL } from '../../../shared/types/experiments';

/** One arm's identity for display purposes. */
export interface ExperimentArmDisplay {
  /**
   * `experiments.variant_a_id` / `variant_b_id` — may be the baseline sentinel;
   * nullable since migration 058 relaxed the columns (rotation experiments carry
   * no fixed pair). A null is simply "not the baseline arm" here.
   */
  variantId: string | null;
  /** Denormalized variant label (survives variant deletion); '' tolerated. */
  label: string;
}

/** Label for a single arm row: 'baseline' for the sentinel arm, else its variant label. */
export function armDisplayLabel(arm: ExperimentArmDisplay): string {
  if (arm.variantId === BASELINE_VARIANT_SENTINEL) return 'baseline';
  return arm.label || 'variant';
}

/**
 * The "challenger" shown after the `·` in the experiment display name:
 * - baseline vs variant  -> the variant's label (the thing being tested)
 * - variant vs variant   -> '<a> vs <b>'
 * - baseline vs baseline -> 'baseline' (degenerate, but must not crash)
 */
export function experimentChallengerLabel(a: ExperimentArmDisplay, b: ExperimentArmDisplay): string {
  const aIsBaseline = a.variantId === BASELINE_VARIANT_SENTINEL;
  const bIsBaseline = b.variantId === BASELINE_VARIANT_SENTINEL;
  if (aIsBaseline && bIsBaseline) return 'baseline';
  if (aIsBaseline) return armDisplayLabel(b);
  if (bIsBaseline) return armDisplayLabel(a);
  return `${armDisplayLabel(a)} vs ${armDisplayLabel(b)}`;
}

/** Full experiment display name: `<workflow> A/B · <challenger>`. */
export function experimentDisplayName(
  workflowName: string,
  a: ExperimentArmDisplay,
  b: ExperimentArmDisplay,
): string {
  return `${workflowName || 'workflow'} A/B · ${experimentChallengerLabel(a, b)}`;
}
