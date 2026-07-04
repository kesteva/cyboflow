/**
 * Unit tests for variantSelectorLogic — the pure option-building / default-
 * selection / launch-payload rules behind VariantSelector.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';
import {
  BASELINE_SENTINEL,
  ROTATION_SENTINEL,
  buildVariantSelectorOptions,
  defaultVariantSelection,
  isRotationEligible,
  selectionForSentinel,
  sentinelForSelection,
  variantSelectionToStartInput,
} from '../variantSelectorLogic';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Variant A',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    weight: 1,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('isRotationEligible', () => {
  it('is false with zero variants', () => {
    expect(isRotationEligible([])).toBe(false);
  });

  it('is true with exactly one active weight>0 variant (surface consistency: the backend resolver rotates at >=1)', () => {
    expect(isRotationEligible([makeVariant({ id: 'a' })])).toBe(true);
  });

  it('is true with two active weight>0 variants', () => {
    expect(
      isRotationEligible([makeVariant({ id: 'a' }), makeVariant({ id: 'b' })]),
    ).toBe(true);
  });

  it('excludes a weight=0 active variant from the eligibility count', () => {
    expect(isRotationEligible([makeVariant({ id: 'a', weight: 0 })])).toBe(false);
    // ...but a second, weighted active variant keeps eligibility.
    expect(
      isRotationEligible([
        makeVariant({ id: 'a', weight: 0 }),
        makeVariant({ id: 'b' }),
      ]),
    ).toBe(true);
  });

  it('excludes draft/paused/retired variants from the eligibility count', () => {
    expect(
      isRotationEligible([
        makeVariant({ id: 'a', status: 'draft' }),
        makeVariant({ id: 'b', status: 'paused' }),
        makeVariant({ id: 'c', status: 'retired' }),
      ]),
    ).toBe(false);
    // A single ACTIVE sibling is what makes the set eligible.
    expect(
      isRotationEligible([
        makeVariant({ id: 'a', status: 'draft' }),
        makeVariant({ id: 'd', status: 'active' }),
      ]),
    ).toBe(true);
  });
});

describe('buildVariantSelectorOptions', () => {
  it('returns [] for zero variants (VariantSelector hides entirely)', () => {
    expect(buildVariantSelectorOptions([])).toEqual([]);
  });

  it('omits "Rotation (auto)" when no active weight>0 variant exists (draft-only)', () => {
    const options = buildVariantSelectorOptions([makeVariant({ id: 'a', status: 'draft' })]);
    expect(options.some((o) => o.sentinel === ROTATION_SENTINEL)).toBe(false);
    // Baseline is still offered once any variant exists.
    expect(options.some((o) => o.sentinel === BASELINE_SENTINEL)).toBe(true);
  });

  it('offers "Rotation (auto)" first with >=1 active weight>0 variant', () => {
    const single = buildVariantSelectorOptions([makeVariant({ id: 'a' })]);
    expect(single[0]).toMatchObject({ sentinel: ROTATION_SENTINEL, selection: { mode: 'rotation' } });
    const pair = buildVariantSelectorOptions([
      makeVariant({ id: 'a' }),
      makeVariant({ id: 'b' }),
    ]);
    expect(pair[0]).toMatchObject({ sentinel: ROTATION_SENTINEL, selection: { mode: 'rotation' } });
  });

  it('suffixes a draft variant\'s label with " (draft)"', () => {
    const options = buildVariantSelectorOptions([
      makeVariant({ id: 'a', label: 'Variant A', status: 'draft' }),
    ]);
    const variantOption = options.find((o) => o.sentinel === 'a');
    expect(variantOption?.label).toBe('Variant A (draft)');
  });

  it('does not suffix an active variant\'s label', () => {
    const options = buildVariantSelectorOptions([makeVariant({ id: 'a', label: 'Variant A' })]);
    const variantOption = options.find((o) => o.sentinel === 'a');
    expect(variantOption?.label).toBe('Variant A');
  });

  it('excludes paused and retired variants entirely', () => {
    const options = buildVariantSelectorOptions([
      makeVariant({ id: 'paused', status: 'paused' }),
      makeVariant({ id: 'retired', status: 'retired' }),
    ]);
    expect(options.some((o) => o.sentinel === 'paused')).toBe(false);
    expect(options.some((o) => o.sentinel === 'retired')).toBe(false);
    // Baseline still offered (a variant exists, just none pickable individually).
    expect(options.some((o) => o.sentinel === BASELINE_SENTINEL)).toBe(true);
  });
});

describe('defaultVariantSelection', () => {
  it('defaults to rotation when eligible (>=1 active weight>0 variant)', () => {
    expect(defaultVariantSelection([makeVariant({ id: 'a' })])).toEqual({ mode: 'rotation' });
    expect(
      defaultVariantSelection([makeVariant({ id: 'a' }), makeVariant({ id: 'b' })]),
    ).toEqual({ mode: 'rotation' });
  });

  it('defaults to baseline when not rotation-eligible (no active weight>0 variant)', () => {
    expect(defaultVariantSelection([makeVariant({ id: 'a', status: 'draft' })])).toEqual({ mode: 'baseline' });
    expect(defaultVariantSelection([])).toEqual({ mode: 'baseline' });
  });
});

describe('sentinel <-> selection round-trip', () => {
  it('round-trips rotation', () => {
    const sel = { mode: 'rotation' as const };
    expect(selectionForSentinel(sentinelForSelection(sel))).toEqual(sel);
  });

  it('round-trips baseline', () => {
    const sel = { mode: 'baseline' as const };
    expect(selectionForSentinel(sentinelForSelection(sel))).toEqual(sel);
  });

  it('round-trips a variant pin', () => {
    const sel = { mode: 'variant' as const, variantId: 'wfv_42' };
    expect(selectionForSentinel(sentinelForSelection(sel))).toEqual(sel);
  });
});

describe('variantSelectionToStartInput', () => {
  it('rotation sends neither variantId nor baseline', () => {
    expect(variantSelectionToStartInput({ mode: 'rotation' })).toEqual({});
  });

  it('baseline sends { baseline: true }', () => {
    expect(variantSelectionToStartInput({ mode: 'baseline' })).toEqual({ baseline: true });
  });

  it('a variant pin sends { variantId }', () => {
    expect(variantSelectionToStartInput({ mode: 'variant', variantId: 'wfv_7' })).toEqual({
      variantId: 'wfv_7',
    });
  });
});
