/**
 * Unit tests for evalJudgeQuery — the eval jury's SINGLE `@anthropic-ai/claude-agent-sdk`
 * boundary. Mirrors programmatic/__tests__/monitorQuery.test.ts: the SDK `query`
 * is mocked so the structured-query wrapper is exercised with a canned async
 * generator (no real claude subprocess). These tests pin the paid-Claude safety
 * contract the plan calls out — no hang / no spurious retry on a judge timeout,
 * and a clean abort-signal bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  makeFakeQuery,
  makeRejectingQuery,
  makeBlockUntilAbortQuery,
  sdkAssistantText,
  sdkResultSuccess,
  sdkResultError,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';
import { EvalJudgeMaxTurnsError, EvalJudgeTimeoutError } from '../judgeErrors';

// The SDK `query` is mocked so the evalJudgeQuery boundary is unit-testable
// without a real claude binary. Each test installs its own behavior via the shared
// fakeSdk builders/factories, wired through `install(...)` which captures options.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { makeEvalJudgeQuery, EVAL_JUDGE_TIMEOUT_MS } from '../evalJudgeQuery';

/** Stand-in for the boot-resolved path the wiring site now injects as the factory's first argument. */
const FAKE_CLAUDE_EXECUTABLE_PATH = '/fake/claude';

let lastOptions: unknown;

/** Point the mocked `query()` at a shared fakeSdk `FakeQueryFn`, capturing options. */
function install(fn: FakeQueryFn): void {
  queryMock.mockImplementation((params: FakeQueryParams) => {
    lastOptions = params.options;
    return fn(params);
  });
}

/** Install a straight-line stream of the given SDK messages. */
function yieldsMessages(messages: readonly SDKMessage[]): void {
  install(makeFakeQuery(messages));
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
});

describe('makeEvalJudgeQuery', () => {
  it('returns the structured_output of the successful result', async () => {
    yieldsMessages([
      sdkAssistantText('grepping snapshot'),
      sdkResultSuccess({ structuredOutput: { verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x' }] } }),
    ]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    const out = await fn({ prompt: 'p', schema: { type: 'object' }, cwd: '/wt' });

    expect(out).toEqual({ verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x' }] });
  });

  it('passes JUDGE_ALLOWED_TOOLS, json_schema outputFormat, cwd, model, exe path, and a bounded maxTurns', async () => {
    yieldsMessages([sdkResultSuccess({ structuredOutput: {} })]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await fn({ prompt: 'p', schema: { type: 'object', required: ['verdicts'] }, cwd: '/wt', model: 'opus-x' });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.cwd).toBe('/wt');
    expect(opts.model).toBe('opus-x');
    // Read-only surface — the judge may grep/open the frozen snapshot, never write.
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    // Regression guard (`allowedTools` is AUTO-APPROVAL ONLY): `tools` is what
    // removes Write/Edit/Bash and the user's MCP servers from the model's
    // context. Without it a speculative tool_use spends a turn this query
    // cannot spare. See the option block's comment for the measured numbers.
    expect(opts.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.disallowedTools).toEqual(['mcp__*']);
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    expect(opts.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', required: ['verdicts'] },
    });
    expect(opts.pathToClaudeCodeExecutable).toBe(FAKE_CLAUDE_EXECUTABLE_PATH);
    expect(typeof opts.maxTurns).toBe('number');
    expect((opts.maxTurns as number) > 1).toBe(true);
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('omits cwd and model from the SDK options when not supplied', async () => {
    yieldsMessages([sdkResultSuccess({ structuredOutput: {} })]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await fn({ prompt: 'p', schema: {} });

    const opts = lastOptions as Record<string, unknown>;
    expect('cwd' in opts).toBe(false);
    expect('model' in opts).toBe(false);
  });

  it('returns null when the stream drains with no successful result', async () => {
    yieldsMessages([sdkAssistantText([])]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('returns null when the success result carries no structured_output', async () => {
    yieldsMessages([sdkResultSuccess()]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('throws when the SDK iterator throws', async () => {
    install(makeRejectingQuery(new Error('sdk boom')));
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow('sdk boom');
  });

  it('aborts and throws a timeout error on a custom timeoutMs deadline', async () => {
    // The blockUntilAbort generator RESOLVES (no throw) once aborted; the didTimeOut
    // post-loop guard must still convert that clean drain into a timeout throw — the
    // paid-Claude "no silent empty on a hung binary" contract.
    install(makeBlockUntilAbortQuery());
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH, undefined, 5);
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow(/timed out after 5ms/);
  });

  it('timeout rejects with the TYPED EvalJudgeTimeoutError (worker retry policy branches on it)', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH, undefined, 5);
    await expect(fn({ prompt: 'p', schema: {} })).rejects.toBeInstanceOf(EvalJudgeTimeoutError);
  });

  it('leaves the deadline at the base for a small diff', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH, undefined, 5);
    await expect(fn({ prompt: 'p', schema: {}, diffChars: 1_000 })).rejects.toThrow(
      /timed out after 5ms/,
    );
  });

  it('stretches the deadline for a large diff instead of firing at the base', async () => {
    // The large-diff timeout fix: a juror grading a big diff must not be cut off at
    // the small-diff wall. Fake timers so the stretched deadline is asserted without
    // spending it.
    vi.useFakeTimers();
    try {
      install(makeBlockUntilAbortQuery());
      const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH, undefined, 5);
      // 120k chars => 2 steps of headroom over the 5ms base.
      const p = fn({ prompt: 'p', schema: {}, diffChars: 120_000 }).catch((err) => err as Error);
      let settled = false;
      void p.then(() => {
        settled = true;
      });

      // Well past the BASE deadline; the stretched one has not arrived.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(600_000);
      const err = await p;
      expect(err).toBeInstanceOf(EvalJudgeTimeoutError);
      expect((err as Error).message).toMatch(/timed out after 600005ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws the distinct EvalJudgeMaxTurnsError when the judge exhausts maxTurns without structured output', async () => {
    // Previously this drained to `return null` and masqueraded downstream as
    // "judge sample is not an object" — a parse-shaped error that drew a
    // guaranteed-wasted identical retry.
    yieldsMessages([
      sdkAssistantText('still exploring the worktree'),
      sdkResultError({ subtype: 'error_max_turns' }),
    ]);
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    const p = fn({ prompt: 'p', schema: {}, cwd: '/wt' });
    await expect(p).rejects.toBeInstanceOf(EvalJudgeMaxTurnsError);
    await expect(p).rejects.toThrow(/turn budget/);
  });

  it('bridges the caller AbortSignal onto the SDK abortController', async () => {
    let observedAbort = false;
    install(makeBlockUntilAbortQuery(() => {
      observedAbort = true;
    }));
    const controller = new AbortController();
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    const p = fn({ prompt: 'p', schema: {}, cwd: '/wt', signal: controller.signal }).catch(() => undefined);
    controller.abort();
    await p;
    expect(observedAbort).toBe(true);
  });

  it('aborts immediately when the caller signal is ALREADY aborted before the call', async () => {
    let observedAbort = false;
    install(makeBlockUntilAbortQuery(() => {
      observedAbort = true;
    }));
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    await fn({ prompt: 'p', schema: {}, signal: controller.signal }).catch(() => undefined);
    expect(observedAbort).toBe(true);
  });

  it('cleanup() removes the caller signal listener on the throw path (no leak)', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    install(makeRejectingQuery(new Error('boom')));
    const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await expect(fn({ prompt: 'p', schema: {}, signal: controller.signal })).rejects.toThrow('boom');

    // The finally-block cleanup detaches the 'abort' listener it attached, so a
    // later caller-abort cannot re-fire into a completed query.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('exports the default per-sample deadline as 600_000ms', () => {
    expect(EVAL_JUDGE_TIMEOUT_MS).toBe(600_000);
  });

  it('the factory applies the default deadline when no timeoutMs is passed', async () => {
    vi.useFakeTimers();
    try {
      install(makeBlockUntilAbortQuery());
      const fn = makeEvalJudgeQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
      const p = fn({ prompt: 'p', schema: {} }).catch((err) => err as Error);
      await vi.advanceTimersByTimeAsync(EVAL_JUDGE_TIMEOUT_MS + 1);
      const err = await p;
      expect(err).toBeInstanceOf(EvalJudgeTimeoutError);
      expect((err as Error).message).toMatch(/timed out after 600000ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
