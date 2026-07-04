/**
 * variantSelectorLogic — pure helpers behind {@link VariantSelector}, split out
 * so the option-building / default-selection / launch-payload rules are unit
 * testable without mounting the component (mirrors the split used by
 * backlogSelectors.ts and deriveLastUsedByWorkflow).
 *
 * Architect rulings (Slice A, 2026-07-04; threshold revised post-review) encoded here:
 *   - "Rotation (auto)" is offered when the workflow has >=1 ACTIVE variant
 *     with weight>0, and it is the DEFAULT selection in that case. >=1 (not
 *     >=2) keeps every launch surface consistent: one-click launches send no
 *     variant fields and the backend resolver rotates whenever ANY active
 *     weight>0 variant exists — a picker defaulting to Baseline at exactly one
 *     active variant would force-pin baseline where every other surface
 *     assigns that variant.
 *   - "Baseline (no variant)" is always offered once any variant exists.
 *   - Each ACTIVE variant is offered by its label; each DRAFT variant is offered
 *     suffixed " (draft)" (draft variants are pinnable, per the plan).
 *   - PAUSED / RETIRED variants are never offered.
 *   - Zero variants → no options at all (VariantSelector renders nothing and
 *     launches behave exactly as today — see VariantSelector.tsx).
 */
import type { WorkflowVariantRow } from '../../stores/variantsStore';

/** The three possible outcomes of the selector, independent of DOM representation. */
export type VariantSelection =
  | { mode: 'rotation' }
  | { mode: 'baseline' }
  | { mode: 'variant'; variantId: string };

/** One renderable `<option>`: a stable sentinel value + display label + the selection it represents. */
export interface VariantSelectorOption {
  sentinel: string;
  label: string;
  selection: VariantSelection;
}

/** Native `<select>` sentinel for the "Rotation (auto)" option (never collides with a `wfv_` variant id). */
export const ROTATION_SENTINEL = '__rotation__';
/** Native `<select>` sentinel for the "Baseline (no variant)" option. */
export const BASELINE_SENTINEL = '__baseline__';

/** A variant counts toward rotation eligibility iff active AND weight > 0 (weight=0 = pinnable-but-never-rotated). */
export function countActiveRotationCandidates(variants: WorkflowVariantRow[]): number {
  return variants.filter((v) => v.status === 'active' && v.weight > 0).length;
}

/**
 * "Rotation (auto)" is offered (and is the default) at >=1 active weight>0
 * variant — mirroring the backend VariantResolver, which rotates whenever any
 * such variant exists (a one-candidate rotation deterministically picks it).
 */
export function isRotationEligible(variants: WorkflowVariantRow[]): boolean {
  return countActiveRotationCandidates(variants) >= 1;
}

/** Variants individually selectable in the picker: active (in rotation) + draft (pinnable). */
export function pickableVariants(variants: WorkflowVariantRow[]): WorkflowVariantRow[] {
  return variants.filter((v) => v.status === 'active' || v.status === 'draft');
}

/**
 * Build the full ordered option list for a workflow's variants. Empty when the
 * workflow has zero variants (VariantSelector renders nothing in that case —
 * this helper still returns [] so callers can early-return themselves).
 */
export function buildVariantSelectorOptions(variants: WorkflowVariantRow[]): VariantSelectorOption[] {
  if (variants.length === 0) return [];
  const options: VariantSelectorOption[] = [];
  if (isRotationEligible(variants)) {
    options.push({ sentinel: ROTATION_SENTINEL, label: 'Rotation (auto)', selection: { mode: 'rotation' } });
  }
  options.push({ sentinel: BASELINE_SENTINEL, label: 'Baseline (no variant)', selection: { mode: 'baseline' } });
  for (const v of pickableVariants(variants)) {
    options.push({
      sentinel: v.id,
      label: v.status === 'draft' ? `${v.label} (draft)` : v.label,
      selection: { mode: 'variant', variantId: v.id },
    });
  }
  return options;
}

/**
 * The selector's default selection once its option list is known: "Rotation
 * (auto)" when eligible (>=1 active weight>0 variant), else "Baseline (no
 * variant)". Used to seed the parent's controlled state on first load — see
 * VariantSelector's one-shot seeding effect.
 */
export function defaultVariantSelection(variants: WorkflowVariantRow[]): VariantSelection {
  return isRotationEligible(variants) ? { mode: 'rotation' } : { mode: 'baseline' };
}

/** Map a selection to its native `<select>` sentinel value. */
export function sentinelForSelection(selection: VariantSelection): string {
  if (selection.mode === 'rotation') return ROTATION_SENTINEL;
  if (selection.mode === 'baseline') return BASELINE_SENTINEL;
  return selection.variantId;
}

/** Map a native `<select>` sentinel value back to a selection. */
export function selectionForSentinel(sentinel: string): VariantSelection {
  if (sentinel === ROTATION_SENTINEL) return { mode: 'rotation' };
  if (sentinel === BASELINE_SENTINEL) return { mode: 'baseline' };
  return { mode: 'variant', variantId: sentinel };
}

/**
 * Map a {@link VariantSelection} to the fields `runs.start` expects (migration
 * 046 `variantId` + `baseline`). "Rotation" sends NEITHER field — the
 * launcher's VariantResolver applies weighted rotation exactly as it does when
 * a workflow has no picker at all (byte-identical to omitting the picker).
 */
export function variantSelectionToStartInput(
  selection: VariantSelection,
): { variantId?: string; baseline?: boolean } {
  if (selection.mode === 'variant') return { variantId: selection.variantId };
  if (selection.mode === 'baseline') return { baseline: true };
  return {};
}
