/**
 * Unit tests for classifyVerificationFailure — the §3.1 conservative
 * three-way failure classifier (docs/proposals/verification-setup-flow.md
 * §3.1). PURE module, no DB. Table-driven over the precedence rules
 * (env > deliverable > ambiguous) plus the standalone auditable-evidence
 * invariant: every 'env' verdict carries >=1 evidence entry.
 */
import { describe, it, expect } from 'vitest';
import { classifyVerificationFailure } from '../failureClassifier';
import type { FailureClassifierInputs } from '../failureClassifier';
import type { AgentPreflightResult, PreflightCheckResult } from '../preflight';

/** A passing preflight result — same shape runAgentPreflight would return when every applicable check passed. */
function passingPreflight(...ids: PreflightCheckResult['id'][]): AgentPreflightResult {
  const checks = ids.map((id) => ({ id, ok: true, detail: 'ok' }));
  return { ok: true, checks };
}

/** A preflight result with one specific check failed, the rest passing. */
function preflightWithFailure(
  failedId: PreflightCheckResult['id'],
  detail: string,
  passingIds: PreflightCheckResult['id'][] = [],
): AgentPreflightResult {
  const checks: PreflightCheckResult[] = [
    { id: failedId, ok: false, detail },
    ...passingIds.map((id) => ({ id, ok: true, detail: 'ok' })),
  ];
  return { ok: false, checks };
}

/** Baseline inputs: no preflight, no harness flags, no report — override per case. */
function baseInputs(overrides: Partial<FailureClassifierInputs> = {}): FailureClassifierInputs {
  return {
    preflight: null,
    runnerStatus: 'failed',
    reportOutcome: null,
    provisionMode: null,
    instanceLockContention: false,
    runbookMismatch: false,
    ...overrides,
  };
}

describe('classifyVerificationFailure — env class', () => {
  it('a failed preflight check (node) classifies env with source preflight', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('node', 'node unresolvable: ENOENT') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence).toEqual([{ source: 'preflight', check: 'node', detail: 'node unresolvable: ENOENT' }]);
  });

  it('a failed preflight check (chromium) classifies env with source preflight', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('chromium', 'chromium not resolved (absent)') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence[0]).toEqual({ source: 'preflight', check: 'chromium', detail: 'chromium not resolved (absent)' });
  });

  it('a failed preflight check (mobile-toolchain) classifies env with source preflight (through the generic loop, no classifier change needed)', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('mobile-toolchain', 'mobile toolchain unavailable') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence[0]).toEqual({ source: 'preflight', check: 'mobile-toolchain', detail: 'mobile toolchain unavailable' });
  });

  it('a failed preflight check (driver-cli) classifies env with source preflight', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('driver-cli', 'driver CLI not found') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence[0].source).toBe('preflight');
  });

  it('a failed port-free preflight check classifies env with source port-probe (squatted port)', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('port-free', 'port 29260 is occupied — a connect probe succeeded (squatter)') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence).toEqual([
      { source: 'port-probe', check: 'port-free', detail: 'port 29260 is occupied — a connect probe succeeded (squatter)' },
    ]);
  });

  it('a failed driver-port-free preflight check classifies env with source port-probe', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: preflightWithFailure('driver-port-free', 'port 29261 is occupied') }),
    );
    expect(result.failureClass).toBe('env');
    expect(result.evidence[0].source).toBe('port-probe');
  });

  it('a preflight result with ALL checks passing does NOT classify env (falls through)', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: passingPreflight('node', 'chromium', 'driver-cli', 'port-free', 'driver-port-free') }),
    );
    expect(result.failureClass).not.toBe('env');
  });

  it('multiple failed preflight checks produce one evidence entry EACH (not short-circuited)', () => {
    const preflight: AgentPreflightResult = {
      ok: false,
      checks: [
        { id: 'node', ok: false, detail: 'node gone' },
        { id: 'port-free', ok: false, detail: 'squatted' },
      ],
    };
    const result = classifyVerificationFailure(baseInputs({ preflight }));
    expect(result.failureClass).toBe('env');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.map((e) => e.source)).toEqual(['preflight', 'port-probe']);
  });

  it('instanceLockContention alone (no preflight) classifies env with source instance-lock', () => {
    const result = classifyVerificationFailure(baseInputs({ instanceLockContention: true }));
    expect(result.failureClass).toBe('env');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].source).toBe('instance-lock');
  });

  it('runbookMismatch alone (no preflight) classifies env with source runner', () => {
    const result = classifyVerificationFailure(baseInputs({ runbookMismatch: true }));
    expect(result.failureClass).toBe('env');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].source).toBe('runner');
  });

  it('env takes precedence over a simultaneous snapshot-mode judged fail', () => {
    const result = classifyVerificationFailure(
      baseInputs({
        preflight: preflightWithFailure('port-free', 'squatted'),
        provisionMode: 'snapshot',
        reportOutcome: 'fail',
      }),
    );
    expect(result.failureClass).toBe('env');
  });

  it('every env verdict carries at least one evidence entry (auditable invariant)', () => {
    const cases: FailureClassifierInputs[] = [
      baseInputs({ preflight: preflightWithFailure('node', 'x') }),
      baseInputs({ instanceLockContention: true }),
      baseInputs({ runbookMismatch: true }),
    ];
    for (const inputs of cases) {
      const result = classifyVerificationFailure(inputs);
      expect(result.failureClass).toBe('env');
      expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('classifyVerificationFailure — deliverable class', () => {
  it('snapshot mode + a judged fail outcome classifies deliverable, evidence sourced report', () => {
    const result = classifyVerificationFailure(
      baseInputs({ provisionMode: 'snapshot', reportOutcome: 'fail', runnerStatus: 'failed' }),
    );
    expect(result.failureClass).toBe('deliverable');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].source).toBe('report');
  });

  it('snapshot mode + build_failed is NOT deliverable — falls to ambiguous', () => {
    const result = classifyVerificationFailure(
      baseInputs({ provisionMode: 'snapshot', reportOutcome: 'build_failed' }),
    );
    expect(result.failureClass).toBe('ambiguous');
  });

  it('snapshot mode + launch_failed is NOT deliverable — falls to ambiguous', () => {
    const result = classifyVerificationFailure(
      baseInputs({ provisionMode: 'snapshot', reportOutcome: 'launch_failed' }),
    );
    expect(result.failureClass).toBe('ambiguous');
  });

  it('fallback mode is NEVER deliverable, even with a judged fail outcome', () => {
    const result = classifyVerificationFailure(
      baseInputs({ provisionMode: 'fallback', reportOutcome: 'fail' }),
    );
    expect(result.failureClass).toBe('ambiguous');
  });

  it('fallback mode + build_failed / launch_failed / pass / null all classify ambiguous, never deliverable', () => {
    const outcomes: FailureClassifierInputs['reportOutcome'][] = ['fail', 'build_failed', 'launch_failed', 'pass', null];
    for (const reportOutcome of outcomes) {
      const result = classifyVerificationFailure(baseInputs({ provisionMode: 'fallback', reportOutcome }));
      expect(result.failureClass).not.toBe('deliverable');
    }
  });

  it('null provisionMode + fail outcome is NOT deliverable — falls to ambiguous', () => {
    const result = classifyVerificationFailure(baseInputs({ provisionMode: null, reportOutcome: 'fail' }));
    expect(result.failureClass).toBe('ambiguous');
  });
});

describe('classifyVerificationFailure — ambiguous class (default / fallback)', () => {
  it('preflight-null + a runner timeout, no report classifies ambiguous with a runner evidence entry', () => {
    const result = classifyVerificationFailure(
      baseInputs({ preflight: null, runnerStatus: 'timeout', reportOutcome: null }),
    );
    expect(result.failureClass).toBe('ambiguous');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].source).toBe('runner');
    expect(result.evidence[0].detail).toContain('timeout');
  });

  it('a passing preflight + a model-authored build_failed with no harness corroboration stays ambiguous (remains blocking)', () => {
    const result = classifyVerificationFailure(
      baseInputs({
        preflight: passingPreflight('node', 'chromium', 'driver-cli', 'driver-port-free'),
        provisionMode: 'snapshot',
        reportOutcome: 'build_failed',
        runnerStatus: 'failed',
      }),
    );
    expect(result.failureClass).toBe('ambiguous');
  });

  it('the ambiguous evidence detail names both runnerStatus and reportOutcome', () => {
    const result = classifyVerificationFailure(
      baseInputs({ runnerStatus: 'failed', reportOutcome: 'launch_failed', provisionMode: 'snapshot' }),
    );
    expect(result.failureClass).toBe('ambiguous');
    expect(result.evidence[0].detail).toContain('failed');
    expect(result.evidence[0].detail).toContain('launch_failed');
  });

  it('every ambiguous verdict still carries at least one evidence entry', () => {
    const result = classifyVerificationFailure(baseInputs());
    expect(result.failureClass).toBe('ambiguous');
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
  });
});

describe('classifyVerificationFailure — precedence ordering', () => {
  it('env > deliverable > ambiguous holds even when multiple rules could apply', () => {
    // Both env evidence AND a judged snapshot fail present — env wins.
    const envAndDeliverable = classifyVerificationFailure(
      baseInputs({
        instanceLockContention: true,
        provisionMode: 'snapshot',
        reportOutcome: 'fail',
      }),
    );
    expect(envAndDeliverable.failureClass).toBe('env');

    // No env evidence, judged snapshot fail present — deliverable wins over ambiguous.
    const deliverableOnly = classifyVerificationFailure(
      baseInputs({ provisionMode: 'snapshot', reportOutcome: 'fail' }),
    );
    expect(deliverableOnly.failureClass).toBe('deliverable');
  });
});

// The runbook-optional widening (F6): the two new report outcomes are
// MODEL-AUTHORED, so neither may reach 'env' from the report alone (only harness
// evidence does), and neither is a judged 'fail', so neither is 'deliverable'.
describe('classifyVerificationFailure — the unverifiable / wrong_environment outcomes', () => {
  for (const reportOutcome of ['unverifiable', 'wrong_environment'] as const) {
    it(`${reportOutcome} with no harness evidence classifies ambiguous, never env or deliverable`, () => {
      for (const provisionMode of ['snapshot', 'fallback', null] as const) {
        const result = classifyVerificationFailure(baseInputs({ reportOutcome, provisionMode }));
        expect(result.failureClass).toBe('ambiguous');
        expect(result.evidence[0]?.source).toBe('runner');
        expect(result.evidence[0]?.detail).toContain(reportOutcome);
      }
    });

    it(`${reportOutcome} still yields to real harness env evidence`, () => {
      const result = classifyVerificationFailure(
        baseInputs({ reportOutcome, provisionMode: 'snapshot', instanceLockContention: true }),
      );
      expect(result.failureClass).toBe('env');
      expect(result.evidence.every((e) => e.source !== 'report')).toBe(true);
    });
  }
});
