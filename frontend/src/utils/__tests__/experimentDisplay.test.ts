import { describe, expect, it } from 'vitest';

import { BASELINE_VARIANT_SENTINEL } from '../../../../shared/types/experiments';
import {
  armDisplayLabel,
  experimentChallengerLabel,
  experimentDisplayName,
} from '../experimentDisplay';

const baseline = { variantId: BASELINE_VARIANT_SENTINEL, label: 'Baseline' };
const terse = { variantId: 'wfv_abc123', label: 'terse-prompts' };
const verbose = { variantId: 'wfv_def456', label: 'verbose-prompts' };

describe('armDisplayLabel', () => {
  it('renders the baseline sentinel as "baseline" regardless of label text', () => {
    expect(armDisplayLabel(baseline)).toBe('baseline');
  });

  it('renders a real variant by its label', () => {
    expect(armDisplayLabel(terse)).toBe('terse-prompts');
  });

  it('falls back for an empty variant label', () => {
    expect(armDisplayLabel({ variantId: 'wfv_x', label: '' })).toBe('variant');
  });
});

describe('experimentChallengerLabel', () => {
  it('baseline vs variant -> the variant label (either arm order)', () => {
    expect(experimentChallengerLabel(baseline, terse)).toBe('terse-prompts');
    expect(experimentChallengerLabel(terse, baseline)).toBe('terse-prompts');
  });

  it('variant vs variant -> "<a> vs <b>"', () => {
    expect(experimentChallengerLabel(terse, verbose)).toBe('terse-prompts vs verbose-prompts');
  });

  it('baseline vs baseline (degenerate) -> "baseline"', () => {
    expect(experimentChallengerLabel(baseline, baseline)).toBe('baseline');
  });
});

describe('experimentDisplayName', () => {
  it('composes "<workflow> A/B · <challenger>"', () => {
    expect(experimentDisplayName('sprint', baseline, terse)).toBe('sprint A/B · terse-prompts');
  });

  it('tolerates a missing workflow name', () => {
    expect(experimentDisplayName('', baseline, terse)).toBe('workflow A/B · terse-prompts');
  });
});
