import { describe, it, expect } from 'vitest';
import { runModelLabel, AGENT_MODEL_LABELS, MODEL_FAMILY_COLORS } from '../agents';

describe('runModelLabel', () => {
  it('inherit case: null model on Claude -> Auto', () => {
    expect(runModelLabel(null, 'claude')).toBe('Auto');
  });

  it('inherit case: empty-string model on Claude -> Auto', () => {
    expect(runModelLabel('', 'claude')).toBe('Auto');
  });

  it('inherit case: literal "auto" model on Claude -> Auto', () => {
    expect(runModelLabel('auto', 'claude')).toBe('Auto');
  });

  it('inherit case: null model on a non-Claude provider -> Auto/default', () => {
    expect(runModelLabel(null, 'codex')).toBe('Auto/default');
  });

  it('inherit case: empty-string model on a non-Claude provider -> Auto/default', () => {
    expect(runModelLabel('', 'codex')).toBe('Auto/default');
  });

  it('inherit case: literal "auto" model on a non-Claude provider -> Auto/default', () => {
    expect(runModelLabel('auto', 'omp')).toBe('Auto/default');
  });

  it('non-Claude provider model id is returned verbatim', () => {
    expect(runModelLabel('gpt-5.6-sol', 'codex')).toBe('gpt-5.6-sol');
  });

  it('a Claude alias resolves to its AGENT_MODEL_LABELS entry', () => {
    expect(runModelLabel('opus', 'claude')).toBe(AGENT_MODEL_LABELS.opus);
    expect(runModelLabel('sonnet', 'claude')).toBe(AGENT_MODEL_LABELS.sonnet);
    expect(runModelLabel('haiku', 'claude')).toBe(AGENT_MODEL_LABELS.haiku);
    expect(runModelLabel('fable', 'claude')).toBe(AGENT_MODEL_LABELS.fable);
  });

  it('a Claude alias resolves the same way regardless of the stated provider', () => {
    // The alias check runs before the provider is consulted at all — a
    // mislabeled provider on a genuinely-aliased model still names the model.
    expect(runModelLabel('opus', null)).toBe(AGENT_MODEL_LABELS.opus);
  });

  it('null provider on a non-alias inherit case reads as non-Claude', () => {
    expect(runModelLabel(null, null)).toBe('Auto/default');
  });
});

describe('MODEL_FAMILY_COLORS', () => {
  it('carries exactly the six ModelFamily buckets', () => {
    expect(Object.keys(MODEL_FAMILY_COLORS).sort()).toEqual(
      ['auto', 'fable', 'haiku', 'opus', 'other', 'sonnet'].sort(),
    );
  });

  it('every swatch is a 7-character hex color', () => {
    for (const color of Object.values(MODEL_FAMILY_COLORS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
