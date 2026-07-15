import { describe, expect, it, vi } from 'vitest';
import type { EvalStructuredQueryFn } from './evalJudgeQuery';
import { JUDGE_OUTPUT_SCHEMA } from './evalJury';
import { CodexJudge, CodexJurorUnavailableError } from './codexJudge';

describe('CodexJudge', () => {
  it('builds the judge prompt and parses a native structured-output object', async () => {
    const structuredQuery = vi.fn<EvalStructuredQueryFn>(async () => ({
      verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x.ts:1' }],
      findings: [],
    }));
    const judge = new CodexJudge({ structuredQuery, model: 'gpt-5.4' });

    await expect(judge.grade({ diff: 'diff --git a/x.ts b/x.ts\n+ok' })).resolves.toEqual({
      verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x.ts:1' }],
      findings: [],
    });
    expect(structuredQuery).toHaveBeenCalledTimes(1);
    const args = structuredQuery.mock.calls[0][0];
    expect(args.prompt).toContain('Return ONLY the structured object');
    expect(args.schema).toBe(JUDGE_OUTPUT_SCHEMA);
    expect(args.model).toBe('gpt-5.4');
  });

  it('propagates deterministic Codex unavailability', async () => {
    const unavailable = new CodexJurorUnavailableError('logged out', 'logged-out');
    const structuredQuery: EvalStructuredQueryFn = async () => {
      throw unavailable;
    };
    const judge = new CodexJudge({ structuredQuery });

    await expect(judge.grade({ diff: 'diff' })).rejects.toBe(unavailable);
  });
});
