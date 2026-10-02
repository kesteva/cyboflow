/**
 * Invariant tests for the pure shared seam shared/types/visualVerification.ts.
 *
 * Shared has no own vitest harness, so its types are exercised from `main` via a
 * relative import (the same convention substrate/executionModel use). These
 * tests pin the taxonomy rosters and the type-guard contract — nothing here
 * touches the DB / electron / runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  REQUEST_STATUS,
  VERIFICATION_TYPES,
  VERIFICATION_MODALITIES,
  VISUAL_VERIFY_DEFAULTS,
  DEFAULT_MOBILE_SIM_SLOTS,
  DEFAULT_MOBILE_DEADLINE_FLOOR_MS,
  isVerificationType,
  isVerificationModality,
  resolveTaskModality,
  type VerifyProbeId,
  type VerifyConfigFile,
  type VerificationRequestRow,
} from '../../../../shared/types/visualVerification';

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

  describe('the request-row + verify.json shapes compose only existing union members', () => {
    it('type-checks a verify.json document and a request row', () => {
      const config: VerifyConfigFile = {
        enabled: true,
        defaultType: 'interactive-web-behavior',
      };
      const row: VerificationRequestRow = {
        id: 'r1',
        run_id: 'run1',
        project_id: 1,
        status: 'queued',
        verify_type: 'static-render-snapshot',
        deliverable_json: '{}',
        chain_json: '[]',
        current_backend: null,
        attempt: 0,
        verdict_json: null,
        error_message: null,
        enqueued_at: '2026-01-01T00:00:00.000Z',
        leased_at: null,
        ended_at: null,
        task_json: null,
        report_json: null,
        delivery_state: null,
        snapshot_sha: null,
        enqueue_key: null,
      };

      expect(isVerificationType(config.defaultType)).toBe(true);
      expect(isVerificationType(row.verify_type)).toBe(true);
    });
  });

  describe('the mobile modality widening (iOS Simulator — xcodebuild + simctl)', () => {
  it('keeps the four-member modality roster and its guard in step', () => {
    expect([...VERIFICATION_MODALITIES]).toEqual(['web', 'cdp-app', 'native-screen', 'mobile']);
    for (const m of VERIFICATION_MODALITIES) {
      expect(isVerificationModality(m)).toBe(true);
    }
    expect(isVerificationModality('ios-simulator')).toBe(false);
  });

  it('resolves an app-shaped task to mobile without widening the type space', () => {
    expect(
      resolveTaskModality('static-render-snapshot', {
        app: { platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 'Demo' },
      }),
    ).toBe('mobile');
    // The VerificationType taxonomy is untouched by the modality widening.
    expect(new Set(VERIFICATION_TYPES).size).toBe(5);
  });

  it('adds the mobile-simulator probe row to VerifyProbeId', () => {
    const rows: VerifyProbeId[] = [
      'browser-driving',
      'screen-recording',
      'accessibility',
      'mobile-simulator',
    ];
    expect(rows).toHaveLength(4);
  });

  it('floors the mobile config members without disturbing the existing defaults', () => {
    expect(VISUAL_VERIFY_DEFAULTS.mobileSimSlots).toBe(DEFAULT_MOBILE_SIM_SLOTS);
    expect(DEFAULT_MOBILE_SIM_SLOTS).toBe(1);
    expect(VISUAL_VERIFY_DEFAULTS.mobileSimDeviceType).toBe('');
    expect(VISUAL_VERIFY_DEFAULTS.mobileSimRuntime).toBe('');
    expect(VISUAL_VERIFY_DEFAULTS.mobileDeadlineFloorMs).toBe(DEFAULT_MOBILE_DEADLINE_FLOOR_MS);
    expect(DEFAULT_MOBILE_DEADLINE_FLOOR_MS).toBe(900_000);
    // Pre-existing floors unchanged.
    expect(VISUAL_VERIFY_DEFAULTS.enabled).toBe(false);
    expect(VISUAL_VERIFY_DEFAULTS.agentSlots).toBe(2);
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
