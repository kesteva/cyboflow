/**
 * VariantSelector — per-launch workflow A/B variant choice (migration 048),
 * following the {@link ModelSelector} / {@link SubstrateSelector} template:
 * controlled (value/onChange), fed by `trpc.cyboflow.variants.list` via
 * {@link useWorkflowVariants}.
 *
 * Renders NOTHING when the workflow has zero variants — launches then behave
 * exactly as today (no `variantId`/`baseline` sent, the picker occupies no
 * layout space). Once at least one variant exists, offers (in order):
 *   - "Rotation (auto)" — ONLY when >=2 ACTIVE variants have weight>0; this is
 *     also the DEFAULT selection in that case (seeded once via a one-shot
 *     effect on first load, mirroring SubstrateSelector's self-correction).
 *   - "Baseline (no variant)" — always offered once any variant exists.
 *   - Each ACTIVE variant by label; each DRAFT variant suffixed " (draft)".
 *   - PAUSED / RETIRED variants are never offered (still pinnable via restart /
 *     experiment arms, per the resolver, just not from this picker).
 *
 * Shared by WorkflowPicker's Configure section and SessionStartWizard's
 * Advanced options so the option logic + default never drifts between the two
 * launch surfaces.
 */
import { useEffect, useRef } from 'react';
import { useWorkflowVariants } from '../../stores/variantsStore';
import {
  buildVariantSelectorOptions,
  defaultVariantSelection,
  selectionForSentinel,
  sentinelForSelection,
  type VariantSelection,
} from './variantSelectorLogic';

interface VariantSelectorProps {
  workflowId: string;
  value: VariantSelection;
  onChange: (selection: VariantSelection) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
}

export function VariantSelector({
  workflowId,
  value,
  onChange,
  id = 'variant-select',
  label = 'Variant',
}: VariantSelectorProps): React.JSX.Element | null {
  const { variants, loaded } = useWorkflowVariants(workflowId);
  const options = buildVariantSelectorOptions(variants);

  // One-shot default seeding: the FIRST time this workflow's variant list
  // resolves, hand the parent the architect-specified default ("Rotation
  // (auto)" when eligible, else "Baseline") so an un-touched picker launches
  // with the right behavior. Guarded per-workflowId so switching the picker's
  // target workflow re-seeds once for the new workflow, but the user's own
  // subsequent choice is never overwritten.
  const seededForWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (seededForWorkflowId.current === workflowId) return;
    seededForWorkflowId.current = workflowId;
    if (options.length > 0) onChange(defaultVariantSelection(variants));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, workflowId]);

  if (!loaded || options.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={sentinelForSelection(value)}
        onChange={(e) => onChange(selectionForSentinel(e.target.value))}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select workflow variant"
      >
        {options.map((opt) => (
          <option key={opt.sentinel} value={opt.sentinel}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
