/**
 * Invariant tests for the pure shared seam shared/types/visualVerification.ts.
 *
 * Shared has no own vitest harness, so its types are exercised from `main` via a
 * relative import (the same convention substrate/executionModel use). A wrong
 * FALLBACK_CHAINS or BACKEND_CAPABILITIES entry silently mis-routes a request, so
 * these tests pin the referential integrity of the matrix + chains and the
 * type-guard contract — nothing here touches the DB / electron / runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  BACKEND_CAPABILITIES,
  FALLBACK_CHAINS,
  REQUEST_STATUS,
  VERIFICATION_TYPES,
  isVerificationType,
  type VerificationType,
  type VisualBackendId,
} from '../../../../shared/types/visualVerification';

const ALL_BACKENDS: VisualBackendId[] = ['capturePage', 'playwright', 'peekaboo', 'maestro'];

describe('visualVerification shared seam', () => {
  describe('VERIFICATION_TYPES', () => {
    it('lists exactly the five taxonomy members, deduped', () => {
      expect(new Set(VERIFICATION_TYPES).size).toBe(5);
      expect([...VERIFICATION_TYPES].sort()).toEqual(
        [
          'interactive-web-behavior',
          'mobile-flow',
          'native-desktop',
          'responsive-multi-viewport',
          'static-render-snapshot',
        ].sort(),
      );
    });

    it('is a key-for-key match with FALLBACK_CHAINS and BACKEND_CAPABILITIES columns', () => {
      for (const t of VERIFICATION_TYPES) {
        expect(FALLBACK_CHAINS[t]).toBeDefined();
      }
      expect(Object.keys(FALLBACK_CHAINS).sort()).toEqual([...VERIFICATION_TYPES].sort());
    });
  });

  describe('BACKEND_CAPABILITIES', () => {
    it('has a row for every backend id and only valid type columns', () => {
      expect(Object.keys(BACKEND_CAPABILITIES).sort()).toEqual([...ALL_BACKENDS].sort());
      for (const id of ALL_BACKENDS) {
        for (const t of BACKEND_CAPABILITIES[id]) {
          expect(isVerificationType(t)).toBe(true);
        }
        // No duplicate type within a row.
        expect(new Set(BACKEND_CAPABILITIES[id]).size).toBe(BACKEND_CAPABILITIES[id].length);
      }
    });

    it('encodes the waterfall: capturePage cannot interact, only peekaboo does native-desktop, only maestro does mobile-flow', () => {
      expect(BACKEND_CAPABILITIES.capturePage).not.toContain('interactive-web-behavior');
      expect(BACKEND_CAPABILITIES.capturePage).not.toContain('native-desktop');

      const nativeCapable = ALL_BACKENDS.filter((id) =>
        BACKEND_CAPABILITIES[id].includes('native-desktop'),
      );
      expect(nativeCapable).toEqual(['peekaboo']);

      const mobileCapable = ALL_BACKENDS.filter((id) =>
        BACKEND_CAPABILITIES[id].includes('mobile-flow'),
      );
      expect(mobileCapable).toEqual(['maestro']);
    });
  });

  describe('FALLBACK_CHAINS referential integrity', () => {
    it('mirrors the design doc exactly', () => {
      expect(FALLBACK_CHAINS).toEqual({
        'static-render-snapshot': ['capturePage', 'playwright', 'peekaboo'],
        'interactive-web-behavior': ['playwright', 'peekaboo'],
        'responsive-multi-viewport': ['capturePage', 'playwright', 'peekaboo'],
        'native-desktop': ['peekaboo'],
        'mobile-flow': ['maestro'],
      });
    });

    it('lists only real backend ids, with no duplicates, in every chain', () => {
      for (const t of Object.keys(FALLBACK_CHAINS) as VerificationType[]) {
        const chain = FALLBACK_CHAINS[t];
        expect(chain.length).toBeGreaterThan(0);
        expect(new Set(chain).size).toBe(chain.length);
        for (const id of chain) {
          expect(ALL_BACKENDS).toContain(id);
        }
      }
    });

    it('only lists a backend for a type the capability matrix permits (no over-routing)', () => {
      for (const t of Object.keys(FALLBACK_CHAINS) as VerificationType[]) {
        for (const id of FALLBACK_CHAINS[t]) {
          expect(BACKEND_CAPABILITIES[id]).toContain(t);
        }
      }
    });

    it('keeps capturePage out of the interactive chain (it cannot click)', () => {
      expect(FALLBACK_CHAINS['interactive-web-behavior']).not.toContain('capturePage');
    });

    it('routes native-desktop to peekaboo only and mobile-flow to maestro only', () => {
      expect(FALLBACK_CHAINS['native-desktop']).toEqual(['peekaboo']);
      expect(FALLBACK_CHAINS['mobile-flow']).toEqual(['maestro']);
    });

    it('orders web chains cheapest rung first (capturePage before playwright before peekaboo)', () => {
      for (const t of ['static-render-snapshot', 'responsive-multi-viewport'] as const) {
        const chain = FALLBACK_CHAINS[t];
        expect(chain.indexOf('capturePage')).toBeLessThan(chain.indexOf('playwright'));
        expect(chain.indexOf('playwright')).toBeLessThan(chain.indexOf('peekaboo'));
      }
    });
  });

  describe('REQUEST_STATUS', () => {
    it('lists the eight lifecycle states, deduped', () => {
      expect(new Set(REQUEST_STATUS).size).toBe(8);
      expect([...REQUEST_STATUS].sort()).toEqual(
        [
          'failed',
          'leased',
          'low_confidence',
          'passed',
          'queued',
          'running',
          'skipped',
          'timeout',
        ].sort(),
      );
    });
  });

  describe('isVerificationType', () => {
    it('accepts every union member', () => {
      for (const t of VERIFICATION_TYPES) {
        expect(isVerificationType(t)).toBe(true);
      }
    });

    it('rejects non-members, wrong types, and nullish', () => {
      for (const bad of [
        'static',
        'web',
        'desktop',
        '',
        'STATIC-RENDER-SNAPSHOT',
        undefined,
        null,
        0,
        {},
        [],
        true,
      ]) {
        expect(isVerificationType(bad)).toBe(false);
      }
    });
  });
});
