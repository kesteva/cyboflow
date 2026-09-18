/**
 * parseVerificationTaskV1 / normalizeVerificationReportV1 — the §5.1/§5.4
 * hand-rolled runtime validators (shared/types/visualVerification.ts). Pins
 * the accept/reject boundary for the composed task and the agent's structured
 * report, including the outcome-coercion rule (§5.4 validation paragraph).
 */
import { describe, it, expect } from 'vitest';
import {
  parseVerificationTaskV1,
  normalizeVerificationReportV1,
  deriveLegacyInputFromTask,
  isAttestationSpec,
  resolveTaskModality,
  ATTESTATION_KINDS,
  DEFAULT_MOBILE_PRODUCT_GLOB,
  type VerificationTaskV1,
  type AttestationSpec,
} from '../../../../../shared/types/visualVerification';

const VALID_TASK = {
  version: 1,
  summary: 'Check the login form renders',
  behaviors: [{ id: 'b1', description: 'Login form renders', expected: 'Form is visible on screen' }],
};

// One instance of every AttestationSpec kind (§7.1) — shared by
// parseVerificationTaskV1's round-trip tests and the isAttestationSpec guard
// tests below.
const ATTESTATION_SPECS: AttestationSpec[] = [
  { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
  { kind: 'dom-marker', selector: '[data-verify-nonce]' },
  { kind: 'cdp-token', expression: 'window.__CYBOFLOW_BUILD_TOKEN__', expected: 'abc123' },
  { kind: 'window-identity', titlePattern: 'MyApp — dev', app: 'MyApp' },
  { kind: 'bundle-identity', bundleId: 'com.example.demo' },
  { kind: 'file-identity' },
];

describe('parseVerificationTaskV1', () => {
  it('accepts a minimal valid task', () => {
    const result = parseVerificationTaskV1(VALID_TASK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toEqual(VALID_TASK);
    }
  });

  it('accepts an empty behaviors array (the degenerate-intent task)', () => {
    const result = parseVerificationTaskV1({ version: 1, summary: 'Bare intent', behaviors: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.behaviors).toEqual([]);
    }
  });

  it('accepts a full task with build/serve/target/viewports/timeoutMs/taskRef', () => {
    const full = {
      version: 1,
      taskRef: 'TASK-008',
      summary: 'Full task',
      build: ['pnpm install', 'pnpm build'],
      serve: { cmd: 'pnpm start --port ${PORT}', readyWhen: { urlPath: '/health', timeoutMs: 5000 } },
      target: { url: 'http://localhost:3000' },
      behaviors: [
        { id: 'b1', description: 'Renders', steps: ['navigate to /'], expected: 'Home page shows' },
      ],
      viewports: [{ width: 1280, height: 720, label: 'desktop' }],
      timeoutMs: 600000,
    };
    const result = parseVerificationTaskV1(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toEqual(full);
    }
  });

  it('rejects a non-object root', () => {
    const result = parseVerificationTaskV1('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^root:/);
  });

  it('rejects version !== 1', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^version:/);
  });

  it('rejects an empty summary', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, summary: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^summary:/);
  });

  it('rejects a non-array behaviors', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, behaviors: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^behaviors:/);
  });

  it('rejects a behavior missing expected', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      behaviors: [{ id: 'b1', description: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('behaviors[0].expected: expected non-empty string');
  });

  it('rejects duplicate behavior ids', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      behaviors: [
        { id: 'b1', description: 'x', expected: 'y' },
        { id: 'b1', description: 'x2', expected: 'y2' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate behavior id "b1"/);
  });

  it('rejects a bad viewport (non-positive width)', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, viewports: [{ width: 0, height: 720 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('viewports[0].width: expected positive finite number');
  });

  it('rejects a bad viewport (non-finite height)', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      viewports: [{ width: 800, height: Number.POSITIVE_INFINITY }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('viewports[0].height: expected positive finite number');
  });

  it('rejects a serve block missing cmd', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, serve: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('serve.cmd: expected non-empty string');
  });

  it('accepts and round-trips serve.attach: "cdp" (CDP-attach app target)', () => {
    const task = {
      ...VALID_TASK,
      serve: {
        cmd: './my-electron-app --remote-debugging-port=${PORT}',
        readyWhen: { timeoutMs: 30000 },
        attach: 'cdp',
      },
    };
    const result = parseVerificationTaskV1(task);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.serve?.attach).toBe('cdp');
      expect(result.task).toEqual(task);
    }
  });

  it('rejects a serve.attach value other than "cdp"', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      serve: { cmd: 'pnpm start', attach: 'tcp' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^serve\.attach:/);
  });

  it('leaves serve.attach absent when omitted (classic web serve)', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, serve: { cmd: 'pnpm dev --port ${PORT}' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.serve).toEqual({ cmd: 'pnpm dev --port ${PORT}' });
      expect('attach' in (result.task.serve ?? {})).toBe(false);
    }
  });

  it('rejects a non-positive timeoutMs', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, timeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('timeoutMs: expected positive finite number');
  });

  it('tolerates unknown extra keys', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, somethingElse: 'ignored' });
    expect(result.ok).toBe(true);
  });

  // --- Modality-roster widening (§4/§7.1): modality, attestation, requiresDrive ---

  it('accepts and round-trips each VerificationModality member', () => {
    for (const modality of ['web', 'cdp-app', 'native-screen', 'mobile'] as const) {
      const result = parseVerificationTaskV1({ ...VALID_TASK, modality });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.task.modality).toBe(modality);
    }
  });

  it('rejects an invalid modality', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, modality: 'desktop' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^modality:/);
  });

  it('leaves modality absent when omitted', () => {
    const result = parseVerificationTaskV1(VALID_TASK);
    expect(result.ok).toBe(true);
    if (result.ok) expect('modality' in result.task).toBe(false);
  });

  it.each(ATTESTATION_SPECS)('accepts and round-trips attestation kind "$kind"', (attestation) => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, attestation });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.attestation).toEqual(attestation);
  });

  it('rejects an unrecognized attestation kind', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      attestation: { kind: 'magic-word', word: 'xyzzy' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^attestation:/);
  });

  it('rejects an attestation missing its kind-specific required field', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      attestation: { kind: 'http-endpoint' }, // missing urlPath
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^attestation:/);
  });

  it('rejects a non-object attestation', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, attestation: 'trust me' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^attestation:/);
  });

  it('accepts and round-trips a behavior with requiresDrive: true', () => {
    const task = {
      ...VALID_TASK,
      behaviors: [
        { id: 'b1', description: 'Click the button', expected: 'Modal opens', requiresDrive: true },
      ],
    };
    const result = parseVerificationTaskV1(task);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.behaviors[0].requiresDrive).toBe(true);
  });

  it('leaves requiresDrive absent on a behavior when omitted', () => {
    const result = parseVerificationTaskV1(VALID_TASK);
    expect(result.ok).toBe(true);
    if (result.ok) expect('requiresDrive' in result.task.behaviors[0]).toBe(false);
  });

  it('rejects a non-boolean requiresDrive', () => {
    const result = parseVerificationTaskV1({
      ...VALID_TASK,
      behaviors: [{ id: 'b1', description: 'x', expected: 'y', requiresDrive: 'yes' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('behaviors[0].requiresDrive: expected boolean');
  });
});

describe('parseVerificationTaskV1 — the mobile app block', () => {
  const APP = { platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 'Demo' } as const;

  it('round-trips an app block, with and without productGlob', () => {
    const bare = parseVerificationTaskV1({ ...VALID_TASK, app: APP });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.task.app).toEqual(APP);

    const globbed = parseVerificationTaskV1({
      ...VALID_TASK,
      app: { ...APP, productGlob: DEFAULT_MOBILE_PRODUCT_GLOB },
    });
    expect(globbed.ok).toBe(true);
    if (globbed.ok) {
      expect(globbed.task.app?.productGlob).toBe(DEFAULT_MOBILE_PRODUCT_GLOB);
      expect(DEFAULT_MOBILE_PRODUCT_GLOB).toBe('Build/Products/*-iphonesimulator/*.app');
    }
  });

  it('drops unknown extra keys from the app block (rebuilt, not cast)', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, app: { ...APP, xcodeMcp: true } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.app).toEqual(APP);
  });

  it('rejects a bad platform', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, app: { ...APP, platform: 'android' } });
    expect(result).toEqual({ ok: false, error: "app.platform: expected the string 'ios-simulator'" });
  });

  it('rejects a non-object app, and empty bundleId / scheme, path-named', () => {
    expect(parseVerificationTaskV1({ ...VALID_TASK, app: [] })).toEqual({
      ok: false,
      error: 'app: expected an object',
    });
    expect(parseVerificationTaskV1({ ...VALID_TASK, app: { ...APP, bundleId: '' } })).toEqual({
      ok: false,
      error: 'app.bundleId: expected non-empty string',
    });
    expect(parseVerificationTaskV1({ ...VALID_TASK, app: { ...APP, scheme: '   ' } })).toEqual({
      ok: false,
      error: 'app.scheme: expected non-empty string',
    });
  });

  it('rejects a productGlob that escapes the private DerivedData directory', () => {
    for (const bad of ['/Users/me/Demo.app', '~/Demo.app', '../Demo.app', 'a/../../b.app', '']) {
      expect(parseVerificationTaskV1({ ...VALID_TASK, app: { ...APP, productGlob: bad } })).toEqual({
        ok: false,
        error:
          "app.productGlob: expected a non-empty relative path (no leading '/', no '~', no '..' segment)",
      });
    }
  });

  it('leaves serve.attach a literal cdp (the app block did not widen it)', () => {
    expect(
      parseVerificationTaskV1({ ...VALID_TASK, serve: { cmd: 'x', attach: 'simctl' } }),
    ).toEqual({ ok: false, error: "serve.attach: expected the string 'cdp' when present" });
  });
});

describe('resolveTaskModality', () => {
  const appTask: Pick<VerificationTaskV1, 'serve' | 'app'> = {
    app: { platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 'Demo' },
  };

  it('keeps every pre-existing row unchanged', () => {
    expect(resolveTaskModality('native-desktop', null)).toBe('native-screen');
    expect(resolveTaskModality('mobile-flow', null)).toBe('mobile');
    expect(resolveTaskModality('static-render-snapshot', null)).toBe('web');
    expect(resolveTaskModality('interactive-web-behavior', { serve: { cmd: 'x' } })).toBe('web');
    expect(resolveTaskModality('interactive-web-behavior', { serve: { cmd: 'x', attach: 'cdp' } })).toBe(
      'cdp-app',
    );
    expect(resolveTaskModality('responsive-multi-viewport', { serve: { cmd: 'x', attach: 'cdp' } })).toBe(
      'cdp-app',
    );
  });

  it('resolves an app-shaped task to mobile whatever web-shaped type was requested', () => {
    expect(resolveTaskModality('static-render-snapshot', appTask)).toBe('mobile');
    expect(resolveTaskModality('interactive-web-behavior', appTask)).toBe('mobile');
    expect(resolveTaskModality('mobile-flow', appTask)).toBe('mobile');
  });

  it('checks the app arm AFTER the type rules and BEFORE the attach rule', () => {
    // native-desktop wins over an app block (type rule first)...
    expect(resolveTaskModality('native-desktop', appTask)).toBe('native-screen');
    // ...and an app block wins over a cdp attach (app arm before the attach rule).
    expect(
      resolveTaskModality('static-render-snapshot', { ...appTask, serve: { cmd: 'x', attach: 'cdp' } }),
    ).toBe('mobile');
  });
});

describe('isAttestationSpec', () => {
  it.each(ATTESTATION_SPECS)('accepts a valid "$kind" spec', (spec) => {
    expect(isAttestationSpec(spec)).toBe(true);
  });

  it('rejects an unrecognized kind', () => {
    expect(isAttestationSpec({ kind: 'magic-word' })).toBe(false);
  });

  it('lists exactly the six kinds, and ATTESTATION_KINDS matches the fixtures', () => {
    expect([...ATTESTATION_KINDS].sort()).toEqual(ATTESTATION_SPECS.map((a) => a.kind).sort());
    expect(new Set(ATTESTATION_KINDS).size).toBe(6);
  });

  it('accepts bundle-identity with a bundleId and nothing else required', () => {
    expect(isAttestationSpec({ kind: 'bundle-identity', bundleId: 'com.example.demo' })).toBe(true);
    // The type carries NO markerPath / path field; an extra key is tolerated on
    // the wire (open shape) and does not change the verdict either way.
    expect(
      isAttestationSpec({ kind: 'bundle-identity', bundleId: 'com.example.demo', markerPath: '/x' }),
    ).toBe(true);
    expect(isAttestationSpec({ kind: 'bundle-identity' })).toBe(false);
    expect(isAttestationSpec({ kind: 'bundle-identity', bundleId: '  ' })).toBe(false);
    expect(isAttestationSpec({ kind: 'bundle-identity', bundleId: 42 })).toBe(false);
  });

  it('rejects a window-identity with no app to scope it to', () => {
    // peekaboo has no host-wide window listing, and a match against ANY window
    // on the machine would not be an identity check — so an app-less spec is
    // not weaker evidence, it is an unrunnable probe.
    expect(isAttestationSpec({ kind: 'window-identity', titlePattern: 'MyApp' })).toBe(false);
    expect(isAttestationSpec({ kind: 'window-identity', titlePattern: 'MyApp', app: '' })).toBe(false);
    expect(isAttestationSpec({ kind: 'window-identity', titlePattern: 'MyApp', app: 'MyApp' })).toBe(
      true,
    );
  });

  it('rejects a kind-specific field with the wrong type', () => {
    expect(isAttestationSpec({ kind: 'http-endpoint', urlPath: 123 })).toBe(false);
  });

  it('rejects a non-object value', () => {
    expect(isAttestationSpec('nope')).toBe(false);
    expect(isAttestationSpec(null)).toBe(false);
    expect(isAttestationSpec(['array'])).toBe(false);
  });

  it('tolerates unknown extra keys', () => {
    expect(isAttestationSpec({ kind: 'file-identity', extra: 'ignored' })).toBe(true);
  });
});

describe('normalizeVerificationReportV1', () => {
  const EXPECTED_IDS = ['b1', 'b2'];

  const VALID_REPORT = {
    version: 1,
    behaviors: [
      { id: 'b1', result: 'pass', evidence: { screenshots: ['s1.png'], notes: 'looks right' } },
    ],
    screenshots: [{ fileName: 's1.png', caption: 'home page' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'All good.',
    issues: [],
  };

  it('accepts a valid pass report', () => {
    const result = normalizeVerificationReportV1(VALID_REPORT, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coerced).toBe(false);
      expect(result.report.outcome).toBe('pass');
    }
  });

  it('coerces outcome to fail when any behavior failed but outcome says pass', () => {
    const report = {
      ...VALID_REPORT,
      behaviors: [
        { id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'broken' } },
      ],
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(true);
    }
  });

  it('does not set coerced when outcome already matches a failed behavior', () => {
    const report = {
      ...VALID_REPORT,
      outcome: 'fail',
      behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'broken' } }],
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('fail');
      expect(result.coerced).toBe(false);
    }
  });

  it('rejects an unknown behavior id', () => {
    const report = {
      ...VALID_REPORT,
      behaviors: [{ id: 'unknown-id', result: 'pass', evidence: { screenshots: [], notes: '' } }],
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown behavior id "unknown-id"/);
  });

  it('allows a report that covers only a subset of expected behavior ids', () => {
    // b2 is expected but not reported — that is the runner's concern, not this validator's.
    const result = normalizeVerificationReportV1(VALID_REPORT, EXPECTED_IDS);
    expect(result.ok).toBe(true);
  });

  it('requires buildLogExcerpt when outcome is build_failed', () => {
    const report = { ...VALID_REPORT, outcome: 'build_failed', behaviors: [] };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^buildLogExcerpt:/);
  });

  it('requires buildLogExcerpt when outcome is launch_failed', () => {
    const report = { ...VALID_REPORT, outcome: 'launch_failed', behaviors: [] };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^buildLogExcerpt:/);
  });

  it('accepts build_failed with a buildLogExcerpt', () => {
    const report = {
      ...VALID_REPORT,
      outcome: 'build_failed',
      behaviors: [],
      buildLogExcerpt: 'npm ERR! build failed',
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.outcome).toBe('build_failed');
      expect(result.report.buildLogExcerpt).toBe('npm ERR! build failed');
    }
  });

  it('clamps confidence to [0,1] without setting coerced', () => {
    const over = normalizeVerificationReportV1({ ...VALID_REPORT, confidence: 1.5 }, EXPECTED_IDS);
    expect(over.ok).toBe(true);
    if (over.ok) {
      expect(over.report.confidence).toBe(1);
      expect(over.coerced).toBe(false);
    }

    const under = normalizeVerificationReportV1({ ...VALID_REPORT, confidence: -0.5 }, EXPECTED_IDS);
    expect(under.ok).toBe(true);
    if (under.ok) {
      expect(under.report.confidence).toBe(0);
      expect(under.coerced).toBe(false);
    }
  });

  it('validates the issues shape (reused VerdictV1 issue shape)', () => {
    const report = {
      ...VALID_REPORT,
      issues: [{ severity: 'high', description: 'broken layout', fileName: 's1.png' }],
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.issues).toEqual([
        { severity: 'high', description: 'broken layout', fileName: 's1.png' },
      ]);
    }
  });

  it('rejects an invalid issue severity', () => {
    const report = {
      ...VALID_REPORT,
      issues: [{ severity: 'critical', description: 'broken layout' }],
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^issues\[0\]\.severity:/);
  });

  it('rejects a non-object root', () => {
    const result = normalizeVerificationReportV1('nope', EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^root:/);
  });

  it('rejects an invalid outcome', () => {
    const result = normalizeVerificationReportV1({ ...VALID_REPORT, outcome: 'maybe' }, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^outcome:/);
  });

  // --- Modality-roster widening (§4/§7.1): the attestation ECHO field ---
  // (a human-display-only copy the runner never trusts as proof — see the
  // VerificationReportV1.attestation doc).

  it('accepts a report with no attestation echo (pre-widening shape)', () => {
    const result = normalizeVerificationReportV1(VALID_REPORT, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) expect('attestation' in result.report).toBe(false);
  });

  it('accepts and round-trips a valid attestation echo', () => {
    const report = {
      ...VALID_REPORT,
      attestation: { verified: true, kind: 'cdp-token', detail: 'Runtime.evaluate matched build token' },
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.attestation).toEqual({
        verified: true,
        kind: 'cdp-token',
        detail: 'Runtime.evaluate matched build token',
      });
    }
  });

  it('accepts a false-verified attestation echo (the agent believed the channel failed)', () => {
    const report = {
      ...VALID_REPORT,
      attestation: { verified: false, kind: 'window-identity', detail: 'title did not match' },
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.attestation?.verified).toBe(false);
  });

  it('rejects an attestation echo with a non-boolean verified', () => {
    const report = {
      ...VALID_REPORT,
      attestation: { verified: 'yes', kind: 'cdp-token', detail: 'x' },
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('attestation.verified: expected boolean');
  });

  it('rejects an attestation echo with an unrecognized kind', () => {
    const report = {
      ...VALID_REPORT,
      attestation: { verified: true, kind: 'vibes', detail: 'x' },
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^attestation\.kind:/);
  });

  it('rejects an attestation echo with a non-string detail', () => {
    const report = {
      ...VALID_REPORT,
      attestation: { verified: true, kind: 'cdp-token', detail: 42 },
    };
    const result = normalizeVerificationReportV1(report, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('attestation.detail: expected string');
  });

  it('rejects a non-object attestation echo', () => {
    const result = normalizeVerificationReportV1({ ...VALID_REPORT, attestation: 'trust me' }, EXPECTED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('attestation: expected an object');
  });
});

describe('deriveLegacyInputFromTask', () => {
  const MINIMAL_TASK: VerificationTaskV1 = {
    version: 1,
    summary: 'Check the login form renders',
    behaviors: [],
  };

  it('maps summary to intent and omits absent optional fields', () => {
    const input = deriveLegacyInputFromTask(MINIMAL_TASK);
    expect(input).toEqual({ intent: 'Check the login form renders' });
    expect('url' in input).toBe(false);
    expect('htmlPath' in input).toBe(false);
    expect('viewports' in input).toBe(false);
    expect('taskRef' in input).toBe(false);
  });

  it('derives url/htmlPath from task.target', () => {
    const task: VerificationTaskV1 = {
      ...MINIMAL_TASK,
      target: { url: 'http://localhost:3000', htmlPath: '/tmp/out/index.html' },
    };
    const input = deriveLegacyInputFromTask(task);
    expect(input.url).toBe('http://localhost:3000');
    expect(input.htmlPath).toBe('/tmp/out/index.html');
  });

  it('derives viewports from the task', () => {
    const task: VerificationTaskV1 = {
      ...MINIMAL_TASK,
      viewports: [{ width: 1280, height: 720, label: 'desktop' }],
    };
    const input = deriveLegacyInputFromTask(task);
    expect(input.viewports).toEqual([{ width: 1280, height: 720, label: 'desktop' }]);
  });

  it('taskRef precedence: task.taskRef wins over the explicit arg', () => {
    const task: VerificationTaskV1 = { ...MINIMAL_TASK, taskRef: 'TASK-008' };
    const input = deriveLegacyInputFromTask(task, 'TASK-999');
    expect(input.taskRef).toBe('TASK-008');
  });

  it('falls back to the explicit arg when task.taskRef is absent', () => {
    const input = deriveLegacyInputFromTask(MINIMAL_TASK, 'TASK-999');
    expect(input.taskRef).toBe('TASK-999');
  });

  it('omits taskRef entirely when neither the task nor the arg carries one', () => {
    const input = deriveLegacyInputFromTask(MINIMAL_TASK);
    expect('taskRef' in input).toBe(false);
  });

  it('is pure — never mutates the input task', () => {
    const task: VerificationTaskV1 = { ...MINIMAL_TASK, target: { url: 'http://localhost:3000' } };
    const snapshot = JSON.parse(JSON.stringify(task));
    deriveLegacyInputFromTask(task, 'TASK-1');
    expect(task).toEqual(snapshot);
  });
});
