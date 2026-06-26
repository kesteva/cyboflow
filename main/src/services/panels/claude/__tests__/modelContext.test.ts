import { describe, it, expect } from 'vitest';
import { CONTEXT_1M_BETA, modelSupportsContext1M, resolveModelAlias } from '../modelContext';

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
      // Opus 1M rides the [1m] id suffix, never the Sonnet-only beta.
      expect(modelSupportsContext1M('claude-opus-4-8[1m]')).toBe(false);
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

  describe('resolveModelAlias', () => {
    it('pins the bare aliases to current concrete snapshots', () => {
      // Opus carries the [1m] suffix (its 1M window comes from the id, not a beta).
      expect(resolveModelAlias('opus')).toBe('claude-opus-4-8[1m]');
      expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
    });

    it('matches aliases case/space-insensitively', () => {
      expect(resolveModelAlias('Opus')).toBe('claude-opus-4-8[1m]');
      expect(resolveModelAlias(' SONNET ')).toBe('claude-sonnet-4-6');
    });

    it('passes through "auto" (the SDK owns model choice)', () => {
      expect(resolveModelAlias('auto')).toBe('auto');
    });

    it('passes through undefined/null/empty unchanged', () => {
      expect(resolveModelAlias(undefined)).toBeUndefined();
      expect(resolveModelAlias(null)).toBeUndefined();
      expect(resolveModelAlias('')).toBe('');
    });

    it('leaves an already-concrete or unrecognized id exactly as pinned', () => {
      // A caller that deliberately pinned an older snapshot is not "upgraded".
      expect(resolveModelAlias('claude-opus-4-7')).toBe('claude-opus-4-7');
      expect(resolveModelAlias('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
      expect(resolveModelAlias('some-future-model')).toBe('some-future-model');
    });

    it('the pinned Sonnet id still qualifies for the 1M beta', () => {
      // The pinning + 1M gate must compose: opus→4.8 keeps no beta, sonnet→4.6
      // still matches the /sonnet-4/ gate so the 1M window is requested.
      expect(modelSupportsContext1M(resolveModelAlias('sonnet'))).toBe(true);
      expect(modelSupportsContext1M(resolveModelAlias('opus'))).toBe(false);
    });
  });
});
