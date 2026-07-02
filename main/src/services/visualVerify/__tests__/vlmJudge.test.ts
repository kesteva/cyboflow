/**
 * VlmJudge (Rung 4) unit tests.
 *
 * The injected `runQuery` seam is MOCKED — no network call is ever made. These
 * tests cover VerdictV1 parsing/normalization, the confidence-threshold demotion
 * to low_confidence, the fail-soft behavior on a query error / unparseable
 * output, and the no-readable-images guard. A tiny real PNG is written to a temp
 * dir so the image-assembly path (readFile → base64 block) executes for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JUDGE_MODEL,
  VlmJudgeImpl,
  normalizeConfidence,
  type VisionQueryFn,
} from '../vlmJudge';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cvv-judge-'));
  await writeFile(join(dir, 'default.png'), ONE_PX_PNG);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseArgs() {
  return {
    intent: 'the button is centered and blue',
    artifactsDir: dir,
    fileNames: ['default.png'],
    type: 'static-render-snapshot' as const,
  };
}

describe('VlmJudgeImpl', () => {
  it('parses a high-confidence pass verdict and fills in deterministic fields', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'pass',
      confidence: 0.92,
      feedback: 'looks great',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('pass');
    expect(v.confidence).toBeCloseTo(0.92);
    expect(v.feedback).toBe('looks great');
    expect(v.judgedFileNames).toEqual(['default.png']);
    expect(v.baselineUsed).toBe(false);
    expect(v.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(runQuery).toHaveBeenCalledOnce();
  });

  it('parses a fail verdict with issues', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'fail',
      confidence: 0.88,
      feedback: 'button is red',
      issues: [
        { severity: 'high', description: 'wrong color', fileName: 'default.png' },
        { severity: 'low', description: 'minor padding' },
        { severity: 'bogus', description: 'dropped — bad severity' },
      ],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('fail');
    expect(v.issues).toEqual([
      { severity: 'high', description: 'wrong color', fileName: 'default.png' },
      { severity: 'low', description: 'minor padding' },
    ]);
  });

  it('demotes a pass below the confidence threshold to low_confidence', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'pass',
      confidence: 0.5,
      feedback: 'not sure',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('low_confidence');
    expect(v.confidence).toBeCloseTo(0.5);
  });

  it('demotes a fail below the threshold to low_confidence too', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'fail',
      confidence: 0.4,
      feedback: 'maybe broken',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('low_confidence');
  });

  it('normalizes a 0..100 confidence into 0..1', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'pass',
      confidence: 90,
      feedback: 'ok',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('pass');
    expect(v.confidence).toBeCloseTo(0.9);
  });

  // REGRESSION: on the OLD normalization (raw > 1 ⇒ raw/100) a fail reported on a
  // 0–10 scale (confidence 9) collapsed to 0.09 < 0.7 and was WRONGLY demoted to
  // low_confidence — a clear fail became advance-with-advisory (integrates). The
  // piecewise mapping treats 9 as a 0–10 scale → 0.9, so the fail stays a fail.
  it('keeps a fail with a 0..10-scale confidence (9) a genuine fail, not low_confidence', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'fail',
      confidence: 9,
      feedback: 'button missing',
      issues: [{ severity: 'high', description: 'CTA absent' }],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('fail');
    expect(v.confidence).toBeCloseTo(0.9);
  });

  // REGRESSION: a slightly-out-of-range float (1.2 — the case the code comment
  // anticipates) collapsed to 0.012 on the old code; now it clamps to 1.0.
  it('clamps a slightly-out-of-range confidence (1.2) up to a genuine pass', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'pass',
      confidence: 1.2,
      feedback: 'looks right',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery, confidenceThreshold: 0.7 });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('pass');
    expect(v.confidence).toBe(1);
  });

  it('fails SOFT to low_confidence when the query throws (never fabricates a verdict)', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const judge = new VlmJudgeImpl({ runQuery });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('low_confidence');
    expect(v.confidence).toBe(0);
    expect(v.feedback).toMatch(/visual judge call failed: boom/);
    expect(v.judgedFileNames).toEqual(['default.png']);
  });

  it('returns low_confidence when the model output is unparseable', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({ nonsense: true }));
    const judge = new VlmJudgeImpl({ runQuery });
    const v = await judge.judge(baseArgs(), new AbortController().signal);
    expect(v.status).toBe('low_confidence');
    expect(v.feedback).toMatch(/no parseable verdict/i);
  });

  it('returns low_confidence (and does NOT call the model) when no images are readable', async () => {
    const runQuery: VisionQueryFn = vi.fn(async () => ({
      status: 'pass',
      confidence: 1,
      feedback: '',
      issues: [],
    }));
    const judge = new VlmJudgeImpl({ runQuery });
    const v = await judge.judge(
      { ...baseArgs(), fileNames: ['does-not-exist.png'] },
      new AbortController().signal,
    );
    expect(v.status).toBe('low_confidence');
    expect(v.feedback).toMatch(/could not read screenshots/i);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns low_confidence immediately when the signal is already aborted', async () => {
    const runQuery: VisionQueryFn = vi.fn();
    const judge = new VlmJudgeImpl({ runQuery });
    const ac = new AbortController();
    ac.abort();
    const v = await judge.judge(baseArgs(), ac.signal);
    expect(v.status).toBe('low_confidence');
    expect(v.feedback).toMatch(/aborted/i);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('records baselineUsed when a baselinePath is provided', async () => {
    const baseline = join(dir, 'baseline.png');
    await writeFile(baseline, ONE_PX_PNG);
    let receivedSchemaKeys: string[] = [];
    const runQuery: VisionQueryFn = vi.fn(async ({ schema }) => {
      receivedSchemaKeys = Object.keys((schema as { properties: object }).properties);
      return { status: 'pass', confidence: 0.95, feedback: 'matches', issues: [] };
    });
    const judge = new VlmJudgeImpl({ runQuery });
    const v = await judge.judge(
      { ...baseArgs(), baselinePath: baseline },
      new AbortController().signal,
    );
    expect(v.baselineUsed).toBe(true);
    expect(v.status).toBe('pass');
    // sanity: the schema we enforce carries the verdict fields
    expect(receivedSchemaKeys).toEqual(
      expect.arrayContaining(['status', 'confidence', 'feedback', 'issues']),
    );
  });
});

describe('normalizeConfidence', () => {
  it('passes through an already-fractional value', () => {
    expect(normalizeConfidence(0.85)).toBeCloseTo(0.85);
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(1)).toBe(1);
  });

  it('clamps a slightly-out-of-range float (1,2] to 1.0', () => {
    expect(normalizeConfidence(1.2)).toBe(1);
    expect(normalizeConfidence(2)).toBe(1);
  });

  it('rescales a 0..10 scale (2,10] by /10', () => {
    expect(normalizeConfidence(9)).toBeCloseTo(0.9);
    expect(normalizeConfidence(2.5)).toBeCloseTo(0.25);
  });

  it('rescales a percentage (10,100] by /100', () => {
    expect(normalizeConfidence(85)).toBeCloseTo(0.85);
    expect(normalizeConfidence(100)).toBe(1);
  });

  it('floors negatives to 0', () => {
    expect(normalizeConfidence(-0.3)).toBe(0);
  });

  it('clamps nonsensically large values to 1.0', () => {
    expect(normalizeConfidence(250)).toBe(1);
  });

  it('returns a conservative in-range value for non-finite input', () => {
    expect(normalizeConfidence(Number.NaN)).toBe(0);
    expect(normalizeConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeConfidence(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
