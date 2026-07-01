import { describe, it, expect } from 'vitest';
import {
  CONTEXT_1M_BETA,
  hasContext1MSuffix,
  interactiveModelArg,
  modelSupportsContext1M,
  resolveModelAlias,
  sdkModelAndBetas,
} from '../modelContext';

describe('modelContext', () => {
  it('CONTEXT_1M_BETA is the Sonnet 1M beta flag', () => {
    expect(CONTEXT_1M_BETA).toBe('context-1m-2025-08-07');
  });

  describe('modelSupportsContext1M', () => {
    it('accepts explicit Sonnet 4.x model ids (the beta is Sonnet-4.x only)', () => {
      expect(modelSupportsContext1M('claude-sonnet-4-5')).toBe(true);
      expect(modelSupportsContext1M('claude-sonnet-4-6')).toBe(true);
    });

    it('rejects Sonnet 5 — its 1M window is native (no beta)', () => {
      expect(modelSupportsContext1M('claude-sonnet-5')).toBe(false);
      // The bare alias resolves to Sonnet 5 before the gate is consulted, so it
      // too is no longer special-cased as beta-needing.
      expect(modelSupportsContext1M('sonnet')).toBe(false);
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
      // Opus's 1M default carries the [1m] window marker; its -250k variant
      // doesn't. Sonnet 5 is 1M-native, so neither sonnet alias carries a marker.
      expect(resolveModelAlias('opus')).toBe('claude-opus-4-8[1m]');
      expect(resolveModelAlias('opus-250k')).toBe('claude-opus-4-8');
      expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
      expect(resolveModelAlias('sonnet-250k')).toBe('claude-sonnet-5');
      expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
    });

    it('pins the fable alias to the current Fable snapshot (1M-native, no marker)', () => {
      // Fable 5, like Sonnet 5, is 1M by default — the bare id already reports a
      // 1M window, so no [1m] marker and no context-1m beta.
      expect(resolveModelAlias('fable')).toBe('claude-fable-5');
      expect(resolveModelAlias('Fable')).toBe('claude-fable-5');
      expect(hasContext1MSuffix(resolveModelAlias('fable'))).toBe(false);
      expect(modelSupportsContext1M(resolveModelAlias('fable'))).toBe(false);
    });

    it('matches aliases case/space-insensitively', () => {
      expect(resolveModelAlias('Opus')).toBe('claude-opus-4-8[1m]');
      expect(resolveModelAlias(' SONNET ')).toBe('claude-sonnet-5');
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

    it('the pinned default aliases need no 1M beta (both windows are native)', () => {
      // opus→4.8[1m] (1M is the id suffix) and sonnet→claude-sonnet-5 (1M native)
      // both reach 1M without the Sonnet-4.x beta, so the gate returns false.
      expect(modelSupportsContext1M(resolveModelAlias('sonnet'))).toBe(false);
      expect(modelSupportsContext1M(resolveModelAlias('opus'))).toBe(false);
    });
  });

  describe('hasContext1MSuffix', () => {
    it('detects the [1m] window marker (case-insensitive)', () => {
      expect(hasContext1MSuffix('claude-opus-4-8[1m]')).toBe(true);
      expect(hasContext1MSuffix('claude-sonnet-4-6[1M]')).toBe(true);
      expect(hasContext1MSuffix('claude-opus-4-8')).toBe(false);
      expect(hasContext1MSuffix(undefined)).toBe(false);
    });
  });

  describe('sdkModelAndBetas — per-family 1M translation', () => {
    it('Opus 1M keeps the [1m] id and emits no beta', () => {
      expect(sdkModelAndBetas(resolveModelAlias('opus'))).toEqual({
        model: 'claude-opus-4-8[1m]',
        betas: [],
      });
    });

    it('Sonnet 5 emits the bare id and no beta (1M is native)', () => {
      expect(sdkModelAndBetas(resolveModelAlias('sonnet'))).toEqual({
        model: 'claude-sonnet-5',
        betas: [],
      });
    });

    it('a directly-pinned Sonnet 4.x [1m] id still strips the marker and rides the beta', () => {
      // Back-compat: the Sonnet-4.x 1M-via-beta path is preserved for a caller
      // that explicitly pins the legacy marked id (the default alias no longer does).
      expect(sdkModelAndBetas('claude-sonnet-4-6[1m]')).toEqual({
        model: 'claude-sonnet-4-6',
        betas: [CONTEXT_1M_BETA],
      });
    });

    it('the -250k variants emit the bare id and no beta', () => {
      expect(sdkModelAndBetas(resolveModelAlias('opus-250k'))).toEqual({
        model: 'claude-opus-4-8',
        betas: [],
      });
      // The legacy sonnet-250k alias resolves to Sonnet 5 (1M native) with no beta.
      expect(sdkModelAndBetas(resolveModelAlias('sonnet-250k'))).toEqual({
        model: 'claude-sonnet-5',
        betas: [],
      });
    });

    it('passes auto/undefined through with no beta', () => {
      expect(sdkModelAndBetas('auto')).toEqual({ model: 'auto', betas: [] });
      expect(sdkModelAndBetas(undefined)).toEqual({ model: undefined, betas: [] });
    });
  });

  describe('interactiveModelArg — CLI --model', () => {
    it('keeps Opus\'s [1m] id (the CLI accepts it)', () => {
      expect(interactiveModelArg(resolveModelAlias('opus'))).toBe('claude-opus-4-8[1m]');
    });

    it('passes Sonnet 5 through unchanged (no marker to strip)', () => {
      expect(interactiveModelArg(resolveModelAlias('sonnet'))).toBe('claude-sonnet-5');
      expect(interactiveModelArg(resolveModelAlias('sonnet-250k'))).toBe('claude-sonnet-5');
    });

    it('strips a directly-pinned Sonnet 4.x [1m] marker (no CLI 1M-beta path)', () => {
      expect(interactiveModelArg('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6');
    });

    it('passes auto/undefined through unchanged', () => {
      expect(interactiveModelArg('auto')).toBe('auto');
      expect(interactiveModelArg(undefined)).toBeUndefined();
    });
  });
});
