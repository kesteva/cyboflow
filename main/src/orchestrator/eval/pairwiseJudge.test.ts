/**
 * Unit tests for the pairwise judge prompt-build + defensive parse (no SDK). Pins
 * the output schema shape, the positionAFirst → Solution 1/2 mapping, seed-context
 * inclusion, diff truncation, and the defensive parser's normalization/throw
 * contract. Also exercises ClaudePairwiseJudge against a fake structured-query fn.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PAIRWISE_OUTPUT_SCHEMA,
  buildPairwisePrompt,
  parsePairwiseSample,
  computePairwisePromptHash,
  ClaudePairwiseJudge,
} from './pairwiseJudge';
import { MAX_DIFF_CHARS } from './evalJury';

describe('PAIRWISE_OUTPUT_SCHEMA', () => {
  it('requires preference/confidence/rationale with the enum preference', () => {
    expect(PAIRWISE_OUTPUT_SCHEMA.type).toBe('object');
    const props = PAIRWISE_OUTPUT_SCHEMA.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(PAIRWISE_OUTPUT_SCHEMA.required).toEqual(['preference', 'confidence', 'rationale']);
    expect(props.preference.enum).toEqual(['1', '2', 'tie']);
    expect(props.confidence.type).toBe('number');
    expect(props.rationale.type).toBe('string');
  });
});

describe('buildPairwisePrompt', () => {
  it('positionAFirst=true maps arm A to Solution 1 and arm B to Solution 2', () => {
    const p = buildPairwisePrompt({ diffA: 'AAA-DIFF', diffB: 'BBB-DIFF', positionAFirst: true });
    const s1 = p.indexOf('SOLUTION 1');
    const s2 = p.indexOf('SOLUTION 2');
    expect(p.indexOf('AAA-DIFF')).toBeGreaterThan(s1);
    expect(p.indexOf('AAA-DIFF')).toBeLessThan(s2);
    expect(p.indexOf('BBB-DIFF')).toBeGreaterThan(s2);
  });

  it('positionAFirst=false swaps: arm B is Solution 1', () => {
    const p = buildPairwisePrompt({ diffA: 'AAA-DIFF', diffB: 'BBB-DIFF', positionAFirst: false });
    const s1 = p.indexOf('SOLUTION 1');
    const s2 = p.indexOf('SOLUTION 2');
    expect(p.indexOf('BBB-DIFF')).toBeGreaterThan(s1);
    expect(p.indexOf('BBB-DIFF')).toBeLessThan(s2);
    expect(p.indexOf('AAA-DIFF')).toBeGreaterThan(s2);
  });

  it('includes the seed context (task goal) when present', () => {
    const p = buildPairwisePrompt({
      diffA: 'a',
      diffB: 'b',
      positionAFirst: true,
      seedContext: 'BUILD-THE-WIDGET',
    });
    expect(p).toContain('TASK GOAL');
    expect(p).toContain('BUILD-THE-WIDGET');
  });

  it('omits the task-goal block when seed context is empty/whitespace', () => {
    const p = buildPairwisePrompt({ diffA: 'a', diffB: 'b', positionAFirst: true, seedContext: '   ' });
    expect(p).not.toContain('TASK GOAL');
  });

  it('truncates an over-long diff via the shared truncateDiff', () => {
    const huge = 'x'.repeat(MAX_DIFF_CHARS + 50);
    const p = buildPairwisePrompt({ diffA: huge, diffB: 'b', positionAFirst: true });
    expect(p).toContain('diff truncated at');
    expect(p).toContain('TRUNCATED');
  });
});

describe('parsePairwiseSample', () => {
  it('passes through a well-formed sample', () => {
    expect(parsePairwiseSample({ preference: '1', confidence: 0.8, rationale: 'x' })).toEqual({
      preference: '1',
      confidence: 0.8,
      rationale: 'x',
    });
  });

  it("normalizes 'A' / 'first' → '1' and 'B' / 'second' → '2'", () => {
    expect(parsePairwiseSample({ preference: 'A', confidence: 0.5, rationale: 'r' }).preference).toBe('1');
    expect(parsePairwiseSample({ preference: 'first', confidence: 0.5, rationale: 'r' }).preference).toBe('1');
    expect(parsePairwiseSample({ preference: 'B', confidence: 0.5, rationale: 'r' }).preference).toBe('2');
    expect(parsePairwiseSample({ preference: 'second', confidence: 0.5, rationale: 'r' }).preference).toBe('2');
  });

  it("normalizes tie-ish tokens → 'tie'", () => {
    expect(parsePairwiseSample({ preference: 'draw', confidence: 0.1, rationale: 'r' }).preference).toBe('tie');
    expect(parsePairwiseSample({ preference: 'neither', confidence: 0.1, rationale: 'r' }).preference).toBe('tie');
  });

  it('clamps confidence to [0,1] and defaults a non-number to 0.5', () => {
    expect(parsePairwiseSample({ preference: '1', confidence: 2, rationale: 'r' }).confidence).toBe(1);
    expect(parsePairwiseSample({ preference: '1', confidence: -3, rationale: 'r' }).confidence).toBe(0);
    expect(parsePairwiseSample({ preference: '1', confidence: 'hi', rationale: 'r' }).confidence).toBe(0.5);
  });

  it('throws on a non-object', () => {
    expect(() => parsePairwiseSample(null)).toThrow();
    expect(() => parsePairwiseSample('nope')).toThrow();
  });

  it('throws on an unrecognized preference token', () => {
    expect(() => parsePairwiseSample({ preference: 'maybe', confidence: 0.5, rationale: 'r' })).toThrow();
  });

  it('throws on a missing/non-string rationale', () => {
    expect(() => parsePairwiseSample({ preference: '1', confidence: 0.5 })).toThrow();
  });
});

describe('computePairwisePromptHash', () => {
  it('is deterministic', () => {
    expect(computePairwisePromptHash()).toBe(computePairwisePromptHash());
    expect(computePairwisePromptHash()).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('ClaudePairwiseJudge', () => {
  it('builds a prompt, calls the structured query, and parses the result', async () => {
    const structuredQuery = vi.fn(async (_args: { prompt: string; schema: unknown }) => ({
      preference: 'A',
      confidence: 0.7,
      rationale: 'A wins',
    }));
    const judge = new ClaudePairwiseJudge({ structuredQuery });
    const out = await judge.grade({ diffA: 'da', diffB: 'db', positionAFirst: true });
    expect(out).toEqual({ preference: '1', confidence: 0.7, rationale: 'A wins' });
    expect(structuredQuery).toHaveBeenCalledOnce();
    const arg = structuredQuery.mock.calls[0][0];
    expect(arg.prompt).toContain('SOLUTION 1');
    expect(arg.schema).toBe(PAIRWISE_OUTPUT_SCHEMA);
  });

  it('propagates a malformed structured result as a throw (worker drops it)', async () => {
    const structuredQuery = vi.fn(async () => ({ garbage: true }));
    const judge = new ClaudePairwiseJudge({ structuredQuery });
    await expect(judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: false })).rejects.toThrow();
  });
});
