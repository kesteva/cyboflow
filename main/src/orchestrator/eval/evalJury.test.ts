/**
 * Unit tests for the pluggable jury: the defensive structured-output parser, the
 * deterministic prompt builder / diff truncation, and ClaudeJudge driven by a FAKE
 * EvalStructuredQueryFn (no SDK). These guard the "parse defensively; one malformed
 * sample is retryable" contract and pin that the rubric text is embedded in the
 * prompt (which feeds prompt_hash upstream).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseJudgeSample,
  buildJudgePrompt,
  truncateDiff,
  ClaudeJudge,
  JUDGE_OUTPUT_SCHEMA,
  MAX_DIFF_CHARS,
  DEFAULT_JUDGE_MODEL_ALIAS,
} from './evalJury';
import type { EvalStructuredQueryFn } from './evalJudgeQuery';

describe('parseJudgeSample (defensive)', () => {
  it('parses a well-formed sample', () => {
    const raw = {
      verdicts: [
        { id: 'COR-1', verdict: 'PASS', evidence: 'traced ok' },
        { id: 'SEC-2', verdict: 'FAIL', evidence: 'interpolated value' },
      ],
      findings: [
        { title: 'SQLi', severity: 'error', dimension: 'security', catastrophic: true },
      ],
    };
    const sample = parseJudgeSample(raw);
    expect(sample.verdicts).toHaveLength(2);
    expect(sample.verdicts[1]).toEqual({ id: 'SEC-2', verdict: 'FAIL', evidence: 'interpolated value' });
    expect(sample.findings[0].severity).toBe('error');
    expect(sample.findings[0].catastrophic).toBe(true);
    expect(sample.findings[0].netNew).toBe(true); // defaults true
  });

  it('normalizes near-miss verdict tokens and drops unparseable ones', () => {
    const raw = {
      verdicts: [
        { id: 'COR-1', verdict: 'passed', evidence: '' },
        { id: 'COR-2', verdict: 'not applicable', evidence: '' },
        { id: 'COR-3', verdict: 'N/A', evidence: '' },
        { id: 'COR-4', verdict: 'no', evidence: '' },
        { id: 'COR-5', verdict: 'garbage', evidence: '' }, // dropped
        { id: 'COR-6' }, // no verdict -> dropped
      ],
    };
    const sample = parseJudgeSample(raw);
    const byId = Object.fromEntries(sample.verdicts.map((v) => [v.id, v.verdict]));
    expect(byId['COR-1']).toBe('PASS');
    expect(byId['COR-2']).toBe('NOT_APPLICABLE');
    expect(byId['COR-3']).toBe('NOT_APPLICABLE');
    expect(byId['COR-4']).toBe('FAIL');
    expect(byId['COR-5']).toBeUndefined();
    expect(byId['COR-6']).toBeUndefined();
  });

  it('dedups repeated sub-check ids (first wins)', () => {
    const raw = {
      verdicts: [
        { id: 'COR-1', verdict: 'PASS', evidence: 'a' },
        { id: 'COR-1', verdict: 'FAIL', evidence: 'b' },
      ],
    };
    const sample = parseJudgeSample(raw);
    expect(sample.verdicts).toHaveLength(1);
    expect(sample.verdicts[0].verdict).toBe('PASS');
  });

  it('throws on a non-object', () => {
    expect(() => parseJudgeSample(null)).toThrow();
    expect(() => parseJudgeSample('nope')).toThrow();
  });

  it('throws when zero valid verdicts survive (malformed sample)', () => {
    expect(() => parseJudgeSample({ verdicts: [] })).toThrow(/zero valid verdicts/);
    expect(() => parseJudgeSample({ verdicts: [{ id: 'X', verdict: 'bad' }] })).toThrow();
  });

  it('salvages a sample with valid verdicts but garbage findings', () => {
    const raw = {
      verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: '' }],
      findings: [{ severity: 'error' }, 'not-an-object', { title: '   ' }],
    };
    const sample = parseJudgeSample(raw);
    expect(sample.verdicts).toHaveLength(1);
    expect(sample.findings).toHaveLength(0); // all findings unusable, dropped
  });
});

describe('truncateDiff', () => {
  it('passes through a small diff untouched', () => {
    const { text, truncated } = truncateDiff('small diff');
    expect(text).toBe('small diff');
    expect(truncated).toBe(false);
  });

  it('deterministically truncates a large diff with a note', () => {
    const big = 'x'.repeat(MAX_DIFF_CHARS + 5000);
    const a = truncateDiff(big);
    const b = truncateDiff(big);
    expect(a.truncated).toBe(true);
    expect(a.text).toBe(b.text); // deterministic
    expect(a.text).toContain('diff truncated');
    expect(a.text.startsWith('x'.repeat(1000))).toBe(true);
  });
});

describe('buildJudgePrompt', () => {
  it('embeds the rubric, the diff, and the gate results', () => {
    const prompt = buildJudgePrompt({
      diff: 'DIFF_MARKER_HUNK',
      gateResults: { test: 'fail' },
    });
    expect(prompt).toContain('RUBRIC v1.1');
    expect(prompt).toContain('COR-1');
    expect(prompt).toContain('DIFF_MARKER_HUNK');
    expect(prompt).toContain('GATE RESULTS');
    expect(prompt).toContain('test=fail');
  });

  it('notes absent gate results as not-a-failure', () => {
    const prompt = buildJudgePrompt({ diff: 'd', gateResults: null });
    expect(prompt).toContain('none available');
    expect(prompt).toContain('absent != failed');
  });

  it('is a pure function of its inputs', () => {
    const input = { diff: 'd', gateResults: { build: 'pass' as const } };
    expect(buildJudgePrompt(input)).toBe(buildJudgePrompt(input));
  });
});

describe('ClaudeJudge', () => {
  it('resolves the default Opus model id', () => {
    const judge = new ClaudeJudge({ structuredQuery: vi.fn() });
    expect(DEFAULT_JUDGE_MODEL_ALIAS).toBe('opus');
    expect(judge.resolvedModel).toBe('claude-opus-4-8[1m]');
  });

  it('calls the injected query fn with the schema + cwd + model, returns the parsed sample', async () => {
    const fake: EvalStructuredQueryFn = vi.fn(async () => ({
      verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: '' }],
    }));
    const judge = new ClaudeJudge({ structuredQuery: fake });
    const sample = await judge.grade({ diff: 'd', gateResults: null, cwd: '/wt' });
    expect(sample.verdicts[0].id).toBe('COR-1');
    expect(fake).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: JUDGE_OUTPUT_SCHEMA,
        cwd: '/wt',
        model: 'claude-opus-4-8[1m]',
      }),
    );
  });

  it('propagates a throw from a malformed structured output (worker retries)', async () => {
    const fake: EvalStructuredQueryFn = vi.fn(async () => ({ verdicts: [] }));
    const judge = new ClaudeJudge({ structuredQuery: fake });
    await expect(judge.grade({ diff: 'd', gateResults: null })).rejects.toThrow();
  });
});
