/**
 * Unit tests for executionModelResolver — the single resolution point for the
 * orchestrated-vs-programmatic execution-model axis.
 *
 * Mirrors the substrateResolver test discipline: every level is exercised with
 * an explicit `env` so the suite never reads or mutates the real process
 * environment, plus the one hard binding rule (interactive ⇒ orchestrated)
 * which is the architectural invariant keeping "PTY stays orchestrator-driven"
 * true by construction.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveExecutionModel,
  EXECUTION_MODEL_ENV_VAR,
} from '../executionModelResolver';
import {
  isExecutionModel,
  isExecutionModelAvailable,
  DEFAULT_EXECUTION_MODEL,
} from '../../../../shared/types/executionModel';

/** An empty env so a test never accidentally inherits CYBOFLOW_EXECUTION_MODEL. */
const NO_ENV: NodeJS.ProcessEnv = {};

describe('resolveExecutionModel', () => {
  describe('zero-behavior-change floor', () => {
    it("floors to 'orchestrated' on an SDK run with no override at any level", () => {
      expect(resolveExecutionModel({ substrate: 'sdk', env: NO_ENV })).toBe('orchestrated');
      expect(DEFAULT_EXECUTION_MODEL).toBe('orchestrated');
    });

    it("floors to 'orchestrated' on an interactive run with no override", () => {
      expect(resolveExecutionModel({ substrate: 'interactive', env: NO_ENV })).toBe('orchestrated');
    });
  });

  describe('interactive hard-pin (outranks every override level)', () => {
    it("pins 'orchestrated' even when the explicit per-run request is 'programmatic'", () => {
      expect(
        resolveExecutionModel({
          substrate: 'interactive',
          requestedExecutionModel: 'programmatic',
          env: NO_ENV,
        }),
      ).toBe('orchestrated');
    });

    it("pins 'orchestrated' even when every override level says 'programmatic'", () => {
      expect(
        resolveExecutionModel({
          substrate: 'interactive',
          requestedExecutionModel: 'programmatic',
          frontmatterExecutionModel: 'programmatic',
          projectConfigExecutionModel: 'programmatic',
          globalDefaultExecutionModel: 'programmatic',
          env: { [EXECUTION_MODEL_ENV_VAR]: 'programmatic' },
        }),
      ).toBe('orchestrated');
    });
  });

  describe('SDK override ladder', () => {
    it("honors an explicit per-run request of 'programmatic'", () => {
      expect(
        resolveExecutionModel({ substrate: 'sdk', requestedExecutionModel: 'programmatic', env: NO_ENV }),
      ).toBe('programmatic');
    });

    it("honors the env level (CYBOFLOW_EXECUTION_MODEL) of 'programmatic'", () => {
      expect(
        resolveExecutionModel({ substrate: 'sdk', env: { [EXECUTION_MODEL_ENV_VAR]: 'programmatic' } }),
      ).toBe('programmatic');
    });

    it('lets a higher level beat a lower one (requested beats global beats env)', () => {
      // requested 'orchestrated' wins over a 'programmatic' global + env.
      expect(
        resolveExecutionModel({
          substrate: 'sdk',
          requestedExecutionModel: 'orchestrated',
          globalDefaultExecutionModel: 'programmatic',
          env: { [EXECUTION_MODEL_ENV_VAR]: 'programmatic' },
        }),
      ).toBe('orchestrated');

      // with no request, the global beats the env.
      expect(
        resolveExecutionModel({
          substrate: 'sdk',
          globalDefaultExecutionModel: 'orchestrated',
          env: { [EXECUTION_MODEL_ENV_VAR]: 'programmatic' },
        }),
      ).toBe('orchestrated');
    });

    it('skips unrecognized values (fail-soft) and falls through to the next level', () => {
      expect(
        resolveExecutionModel({
          substrate: 'sdk',
          requestedExecutionModel: 'nonsense',
          frontmatterExecutionModel: '',
          globalDefaultExecutionModel: null,
          env: { [EXECUTION_MODEL_ENV_VAR]: 'programmatic' },
        }),
      ).toBe('programmatic');
    });

    it('floors to orchestrated when every candidate is unrecognized', () => {
      expect(
        resolveExecutionModel({
          substrate: 'sdk',
          requestedExecutionModel: 'bogus',
          env: { [EXECUTION_MODEL_ENV_VAR]: 'also-bogus' },
        }),
      ).toBe('orchestrated');
    });
  });
});

describe('isExecutionModel', () => {
  it('accepts only the two union members', () => {
    expect(isExecutionModel('orchestrated')).toBe(true);
    expect(isExecutionModel('programmatic')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const v of ['', 'sdk', 'interactive', 'auto', null, undefined, 0, {}]) {
      expect(isExecutionModel(v)).toBe(false);
    }
  });
});

describe('isExecutionModelAvailable', () => {
  it("allows 'programmatic' only on the SDK substrate", () => {
    expect(isExecutionModelAvailable('programmatic', 'sdk')).toBe(true);
    expect(isExecutionModelAvailable('programmatic', 'interactive')).toBe(false);
  });

  it("allows 'orchestrated' on both substrates", () => {
    expect(isExecutionModelAvailable('orchestrated', 'sdk')).toBe(true);
    expect(isExecutionModelAvailable('orchestrated', 'interactive')).toBe(true);
  });
});
