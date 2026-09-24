/**
 * normalizeVerificationReportV1 — the runbook-optional report-contract widening
 * (docs/proposals/runbook-optional-verification.md, "Report-contract widening
 * (F6)" + A3/A4/A5). Pins the accept/reject boundary for the two new outcomes
 * (`unverifiable`, `wrong_environment`), the optional `recipeJson`, and both
 * outcome COERCION rules — above all A4's "fail with no failing behavior", the
 * `6626c0d` case where a report whose every behavior was `not_testable` looped
 * implement back on working code.
 *
 * The pre-widening accept/reject boundary lives in verificationTaskSchemas.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeVerificationReportV1,
  isVerificationReportOutcome,
  ATTESTATION_KINDS,
  UNVERIFIABLE_COERCION_NOTE,
  VERIFICATION_MODALITIES,
  VERIFICATION_REPORT_OUTCOMES,
} from '../../../../../shared/types/visualVerification';

const EXPECTED_IDS = ['b1', 'b2'];

function behavior(id: string, result: 'pass' | 'fail' | 'not_testable'): Record<string, unknown> {
  return { id, result, evidence: { screenshots: [], notes: `${id} ${result}` } };
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    behaviors: [behavior('b1', 'pass')],
    screenshots: [],
    outcome: 'pass',
    confidence: 0.8,
    feedback: 'agent feedback',
    issues: [],
    ...over,
  };
}

const MOBILE_APP = { platform: 'ios-simulator', bundleId: 'com.example.distractodo', scheme: 'Distractodo' };

describe('VERIFICATION_REPORT_OUTCOMES', () => {
  it('lists the four pre-widening outcomes plus unverifiable and wrong_environment', () => {
    expect([...VERIFICATION_REPORT_OUTCOMES]).toEqual([
      'pass',
      'fail',
      'build_failed',
      'launch_failed',
      'unverifiable',
      'wrong_environment',
    ]);
  });

  it('isVerificationReportOutcome accepts exactly the listed members', () => {
    for (const outcome of VERIFICATION_REPORT_OUTCOMES) expect(isVerificationReportOutcome(outcome)).toBe(true);
    expect(isVerificationReportOutcome('maybe')).toBe(false);
    expect(isVerificationReportOutcome(null)).toBe(false);
    expect(isVerificationReportOutcome(undefined)).toBe(false);
  });

  it('the normalizer names every accepted outcome when it rejects one', () => {
    const result = normalizeVerificationReportV1(report({ outcome: 'maybe' }), EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const outcome of VERIFICATION_REPORT_OUTCOMES) expect(result.error).toContain(`'${outcome}'`);
    }
  });
});

describe("normalizeVerificationReportV1 — outcome 'unverifiable'", () => {
  it('accepts it with a diagnosis and carries the diagnosis through', () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'unverifiable',
        behaviors: [behavior('b1', 'not_testable')],
        diagnosis: 'the app picks its data dir from HOME and cannot be confined to VERIFY_DATA_DIR',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('unverifiable');
      expect(result.report.diagnosis).toBe(
        'the app picks its data dir from HOME and cannot be confined to VERIFY_DATA_DIR',
      );
      expect(result.coerced).toBe(false);
    }
  });

  it('rejects it without a diagnosis', () => {
    const result = normalizeVerificationReportV1(report({ outcome: 'unverifiable', behaviors: [] }), EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^diagnosis: required non-empty string/);
  });

  it('rejects a whitespace-only or non-string diagnosis', () => {
    for (const diagnosis of ['   ', 42, null]) {
      const result = normalizeVerificationReportV1(
        report({ outcome: 'unverifiable', behaviors: [], diagnosis }),
        EXPECTED_IDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^diagnosis:/);
    }
  });

  it('coerces to fail when a behavior failed — a defect it saw is not "could not exercise"', () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'unverifiable',
        behaviors: [behavior('b1', 'fail'), behavior('b2', 'not_testable')],
        diagnosis: 'could not reach the settings screen',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(true);
      // The agent's words still ride along for the human reading the verdict.
      expect(result.report.diagnosis).toBe('could not reach the settings screen');
    }
  });
});

describe("normalizeVerificationReportV1 — outcome 'wrong_environment'", () => {
  it('accepts a mobile mismatch with an app and carries both through', () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'wrong_environment',
        behaviors: [],
        neededModality: 'mobile',
        app: { ...MOBILE_APP, productGlob: 'Build/Products/Debug-iphonesimulator/Distractodo.app' },
        diagnosis: 'project.yml declares an iOS application target; this run was stamped web',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('wrong_environment');
      expect(result.report.neededModality).toBe('mobile');
      expect(result.report.app).toEqual({
        ...MOBILE_APP,
        productGlob: 'Build/Products/Debug-iphonesimulator/Distractodo.app',
      });
      expect(result.report.diagnosis).toMatch(/iOS application target/);
      expect(result.coerced).toBe(false);
    }
  });

  it('accepts every VerificationModality as neededModality (the native-screen restriction is the runner\'s)', () => {
    for (const neededModality of VERIFICATION_MODALITIES) {
      const result = normalizeVerificationReportV1(
        report({ outcome: 'wrong_environment', behaviors: [], neededModality, diagnosis: 'wrong surface' }),
        EXPECTED_IDS,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.neededModality).toBe(neededModality);
        expect('app' in result.report).toBe(false);
      }
    }
  });

  it('rejects a missing or unknown neededModality', () => {
    for (const neededModality of [undefined, 'ios', null]) {
      const result = normalizeVerificationReportV1(
        report({ outcome: 'wrong_environment', behaviors: [], neededModality, diagnosis: 'wrong surface' }),
        EXPECTED_IDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^neededModality: expected one of web\|cdp-app\|native-screen\|mobile/);
    }
  });

  it('rejects it without a diagnosis', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'wrong_environment', behaviors: [], neededModality: 'web' }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^diagnosis: required non-empty string/);
  });

  it('validates app with the MobileAppSpec validator, naming the offending path', () => {
    const wrongPlatform = normalizeVerificationReportV1(
      report({
        outcome: 'wrong_environment',
        behaviors: [],
        neededModality: 'mobile',
        app: { ...MOBILE_APP, platform: 'android-emulator' },
        diagnosis: 'x',
      }),
      EXPECTED_IDS,
    );
    expect(wrongPlatform.ok).toBe(false);
    if (!wrongPlatform.ok) expect(wrongPlatform.error).toMatch(/^app\.platform:/);

    const escapingGlob = normalizeVerificationReportV1(
      report({
        outcome: 'wrong_environment',
        behaviors: [],
        neededModality: 'mobile',
        app: { ...MOBILE_APP, productGlob: '../elsewhere/*.app' },
        diagnosis: 'x',
      }),
      EXPECTED_IDS,
    );
    expect(escapingGlob.ok).toBe(false);
    if (!escapingGlob.ok) expect(escapingGlob.error).toMatch(/^app\.productGlob:/);
  });

  it('is never coerced, even with every behavior not_testable (it goes to re-dispatch, not a verdict)', () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'wrong_environment',
        behaviors: [behavior('b1', 'not_testable')],
        neededModality: 'cdp-app',
        diagnosis: 'the deliverable is an Electron app',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('wrong_environment');
      expect(result.coerced).toBe(false);
    }
  });
});

describe('normalizeVerificationReportV1 — the mismatch-only fields on other outcomes', () => {
  it('drops neededModality / app on a non-mismatch outcome without validating them', () => {
    const result = normalizeVerificationReportV1(
      report({ neededModality: 'bogus', app: { platform: 'nope' } }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('pass');
      expect('neededModality' in result.report).toBe(false);
      expect('app' in result.report).toBe(false);
    }
  });

  it('carries an optional diagnosis string on any outcome, and rejects a non-string one', () => {
    const carried = normalizeVerificationReportV1(report({ diagnosis: 'observed with a cold cache' }), EXPECTED_IDS);
    expect(carried.ok).toBe(true);
    if (carried.ok) expect(carried.report.diagnosis).toBe('observed with a cold cache');

    const rejected = normalizeVerificationReportV1(report({ diagnosis: 7 }), EXPECTED_IDS);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBe('diagnosis: expected string');
  });

  it('never carries an agent-supplied provenance block (harness-owned, attached after normalization)', () => {
    const result = normalizeVerificationReportV1(
      report({ provenance: { executionMode: 'pinned' } }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect('provenance' in result.report).toBe(false);
  });
});

describe('normalizeVerificationReportV1 — recipeJson (A5, type-check only)', () => {
  it('carries a recipeJson string verbatim, without parsing it', () => {
    // Deliberately NOT valid JSON: the harness validates the recipe itself, and
    // only from a passed explore run — a bad recipe must not void a verdict.
    const result = normalizeVerificationReportV1(report({ recipeJson: '{"build": [' }), EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.recipeJson).toBe('{"build": [');
  });

  it('omits it when absent', () => {
    const result = normalizeVerificationReportV1(report(), EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) expect('recipeJson' in result.report).toBe(false);
  });

  it('rejects a non-string recipeJson', () => {
    const result = normalizeVerificationReportV1(report({ recipeJson: { build: [] } }), EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('recipeJson: expected string');
  });
});

describe('normalizeVerificationReportV1 — A4 coercion: fail with no failing behavior', () => {
  it('coerces fail → unverifiable when every expected behavior was reported not_testable', () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'fail',
        behaviors: [behavior('b1', 'not_testable'), behavior('b2', 'not_testable')],
        feedback: 'the simulator never finished booting',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('unverifiable');
      expect(result.coerced).toBe(true);
      expect(result.report.diagnosis).toBe(
        `${UNVERIFIABLE_COERCION_NOTE}. Agent: the simulator never finished booting`,
      );
      // The per-behavior verdict is untouched — coercion changes the outcome only.
      expect(result.report.behaviors.map((b) => b.result)).toEqual(['not_testable', 'not_testable']);
    }
  });

  it('counts an UNCOVERED expected behavior as not_testable', () => {
    const partial = normalizeVerificationReportV1(
      report({ outcome: 'fail', behaviors: [behavior('b1', 'not_testable')] }),
      EXPECTED_IDS,
    );
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.report.outcome).toBe('unverifiable');

    const none = normalizeVerificationReportV1(report({ outcome: 'fail', behaviors: [] }), EXPECTED_IDS);
    expect(none.ok).toBe(true);
    if (none.ok) {
      expect(none.report.outcome).toBe('unverifiable');
      expect(none.coerced).toBe(true);
    }
  });

  it('keeps fail when any behavior failed', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'fail', behaviors: [behavior('b1', 'fail'), behavior('b2', 'not_testable')] }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(false);
      expect('diagnosis' in result.report).toBe(false);
    }
  });

  it('keeps fail when a behavior was exercised and passed (not every expected behavior is not_testable)', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'fail', behaviors: [behavior('b1', 'pass'), behavior('b2', 'not_testable')] }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(false);
    }
  });

  it('keeps fail on a zero-behavior task (intent-only, bootstrap and setup proofs)', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'fail', behaviors: [], feedback: 'the page renders a 500' }),
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(false);
    }
  });

  it("prefers the agent's own diagnosis over its feedback when it wrote one", () => {
    const result = normalizeVerificationReportV1(
      report({
        outcome: 'fail',
        behaviors: [behavior('b1', 'not_testable')],
        diagnosis: 'no leased simulator',
        feedback: 'generic feedback',
      }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.diagnosis).toBe(`${UNVERIFIABLE_COERCION_NOTE}. Agent: no leased simulator`);
  });

  it('writes the harness note alone when the agent left no words at all', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'fail', behaviors: [behavior('b1', 'not_testable')], feedback: '  ' }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.diagnosis).toBe(UNVERIFIABLE_COERCION_NOTE);
  });

  it('never touches build_failed / launch_failed (unchanged in both modes, F10)', () => {
    for (const outcome of ['build_failed', 'launch_failed']) {
      const result = normalizeVerificationReportV1(
        report({ outcome, behaviors: [], buildLogExcerpt: 'error: no such module' }),
        EXPECTED_IDS,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.outcome).toBe(outcome);
        expect(result.coerced).toBe(false);
      }
    }
  });
});

describe('normalizeVerificationReportV1 — no rule ever upgrades a verdict', () => {
  it('leaves a pass whose behaviors were all not_testable as pass (the runner caps it)', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'pass', behaviors: [behavior('b1', 'not_testable'), behavior('b2', 'not_testable')] }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('pass');
      expect(result.coerced).toBe(false);
    }
  });

  it('still coerces pass → fail when a behavior failed (the pre-widening rule)', () => {
    const result = normalizeVerificationReportV1(
      report({ outcome: 'pass', behaviors: [behavior('b1', 'fail')] }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(true);
    }
  });
});

describe('normalizeVerificationReportV1 — attestation kind error names every kind', () => {
  it('lists bundle-identity alongside the rest', () => {
    const result = normalizeVerificationReportV1(
      report({ attestation: { verified: true, kind: 'vibes', detail: 'x' } }),
      EXPECTED_IDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const kind of ATTESTATION_KINDS) expect(result.error).toContain(kind);
    }
  });
});
