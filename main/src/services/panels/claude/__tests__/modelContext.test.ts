import { describe, it, expect } from 'vitest';
import { CONTEXT_1M_BETA, modelSupportsContext1M } from '../modelContext';

describe('modelContext', () => {
  it('CONTEXT_1M_BETA is the Sonnet 1M beta flag', () => {
    expect(CONTEXT_1M_BETA).toBe('context-1m-2025-08-07');
  });

  describe('modelSupportsContext1M', () => {
    it('accepts the bare "sonnet" alias (latest Sonnet 4.x)', () => {
      expect(modelSupportsContext1M('sonnet')).toBe(true);
      expect(modelSupportsContext1M('Sonnet')).toBe(true);
      expect(modelSupportsContext1M(' sonnet ')).toBe(true);
    });

    it('accepts explicit Sonnet 4.x model ids', () => {
      expect(modelSupportsContext1M('claude-sonnet-4-5')).toBe(true);
      expect(modelSupportsContext1M('claude-sonnet-4-6')).toBe(true);
    });

    it('rejects non-Sonnet families', () => {
      expect(modelSupportsContext1M('opus')).toBe(false);
      expect(modelSupportsContext1M('haiku')).toBe(false);
      expect(modelSupportsContext1M('claude-opus-4-8')).toBe(false);
    });

    it('rejects auto/empty (resolved model unknown — beta is Sonnet-only)', () => {
      expect(modelSupportsContext1M('auto')).toBe(false);
      expect(modelSupportsContext1M(undefined)).toBe(false);
      expect(modelSupportsContext1M(null)).toBe(false);
      expect(modelSupportsContext1M('')).toBe(false);
    });

    it('rejects older Sonnet 3.x ids (beta is Sonnet 4/4.5 only)', () => {
      expect(modelSupportsContext1M('claude-3-5-sonnet')).toBe(false);
      expect(modelSupportsContext1M('claude-sonnet-3-7')).toBe(false);
    });
  });
});
