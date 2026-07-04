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
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

// The SDK `query` is mocked so the evalJudgeQuery boundary is unit-testable
// without a real claude binary. Each test installs its own behavior via the shared
// fakeSdk builders/factories, wired through `install(...)` which captures options.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('../../../services/panels/claude/claudeExecutablePath', () => ({
  resolveClaudeExecutablePath: () => '/fake/claude',
}));

import { makeEvalJudgeQuery, EVAL_JUDGE_TIMEOUT_MS } from '../evalJudgeQuery';

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
    const fn = makeEvalJudgeQuery();

    const out = await fn({ prompt: 'p', schema: { type: 'object' }, cwd: '/wt' });

    expect(out).toEqual({ verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x' }] });
  });

  it('passes JUDGE_ALLOWED_TOOLS, json_schema outputFormat, cwd, model, exe path, and a bounded maxTurns', async () => {
    yieldsMessages([sdkResultSuccess({ structuredOutput: {} })]);
    const fn = makeEvalJudgeQuery();

    await fn({ prompt: 'p', schema: { type: 'object', required: ['verdicts'] }, cwd: '/wt', model: 'opus-x' });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.cwd).toBe('/wt');
    expect(opts.model).toBe('opus-x');
    // Read-only surface — the judge may grep/open the frozen snapshot, never write.
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', required: ['verdicts'] },
    });
    expect(opts.pathToClaudeCodeExecutable).toBe('/fake/claude');
    expect(typeof opts.maxTurns).toBe('number');
    expect((opts.maxTurns as number) > 1).toBe(true);
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('omits cwd and model from the SDK options when not supplied', async () => {
    yieldsMessages([sdkResultSuccess({ structuredOutput: {} })]);
    const fn = makeEvalJudgeQuery();

    await fn({ prompt: 'p', schema: {} });

    const opts = lastOptions as Record<string, unknown>;
    expect('cwd' in opts).toBe(false);
    expect('model' in opts).toBe(false);
  });

  it('returns null when the stream drains with no successful result', async () => {
    yieldsMessages([sdkAssistantText([])]);
    const fn = makeEvalJudgeQuery();
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('returns null when the success result carries no structured_output', async () => {
    yieldsMessages([sdkResultSuccess()]);
    const fn = makeEvalJudgeQuery();
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('throws when the SDK iterator throws', async () => {
    install(makeRejectingQuery(new Error('sdk boom')));
    const fn = makeEvalJudgeQuery();
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow('sdk boom');
  });

  it('aborts and throws a timeout error on a custom timeoutMs deadline', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makeEvalJudgeQuery(undefined, 5);
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow(/timed out after 5ms/);
  });

  it('surfaces the timeout message even when the timed-out generator resolves without throwing', async () => {
    // The blockUntilAbort generator RESOLVES (no throw) once aborted; the didTimeOut
    // post-loop guard must still convert that clean drain into a timeout throw — the
    // paid-Claude "no silent empty on a hung binary" contract.
    install(makeBlockUntilAbortQuery());
    const fn = makeEvalJudgeQuery(undefined, 5);
    await expect(fn({ prompt: 'p', schema: {} })).rejects.toThrow(/timed out/);
  });

  it('bridges the caller AbortSignal onto the SDK abortController', async () => {
    let observedAbort = false;
    install(makeBlockUntilAbortQuery(() => {
      observedAbort = true;
    }));
    const controller = new AbortController();
    const fn = makeEvalJudgeQuery();
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
    const fn = makeEvalJudgeQuery();
    await fn({ prompt: 'p', schema: {}, signal: controller.signal }).catch(() => undefined);
    expect(observedAbort).toBe(true);
  });

  it('cleanup() removes the caller signal listener on the throw path (no leak)', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    install(makeRejectingQuery(new Error('boom')));
    const fn = makeEvalJudgeQuery();

    await expect(fn({ prompt: 'p', schema: {}, signal: controller.signal })).rejects.toThrow('boom');

    // The finally-block cleanup detaches the 'abort' listener it attached, so a
    // later caller-abort cannot re-fire into a completed query.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('exports the default per-sample deadline as 180_000ms', () => {
    expect(EVAL_JUDGE_TIMEOUT_MS).toBe(180_000);
  });
});
