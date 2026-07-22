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
} from '../../../../../shared/types/visualVerification';

const VALID_TASK = {
  version: 1,
  summary: 'Check the login form renders',
  behaviors: [{ id: 'b1', description: 'Login form renders', expected: 'Form is visible on screen' }],
};

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

  it('rejects a non-positive timeoutMs', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, timeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('timeoutMs: expected positive finite number');
  });

  it('tolerates unknown extra keys', () => {
    const result = parseVerificationTaskV1({ ...VALID_TASK, somethingElse: 'ignored' });
    expect(result.ok).toBe(true);
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
});
