import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  makeFakeQuery,
  makeRejectingQuery,
  makeThenRejectQuery,
  makeBlockUntilAbortQuery,
  sdkAssistantText,
  sdkResultSuccess,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

// The SDK `query` is mocked so the monitorQuery boundary is unit-testable without a
// real claude binary. Each test installs its own behavior via the shared fakeSdk
// builders/factories, wired through `install(...)` which also captures `lastOptions`.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('../../../services/panels/claude/claudeExecutablePath', () => ({
  resolveClaudeExecutablePath: () => '/fake/claude',
}));

import {
  makeSdkStructuredQuery,
  makeSdkTextQuery,
  SUPERVISOR_QUERY_TIMEOUT_MS,
} from '../monitorQuery';

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

describe('makeSdkStructuredQuery', () => {
  it('returns the structured_output of the successful result', async () => {
    yieldsMessages([
      sdkAssistantText('thinking'),
      sdkResultSuccess({ structuredOutput: { decision: 'retry', rationale: 'flaky' } }),
    ]);
    const fn = makeSdkStructuredQuery();

    const out = await fn({ prompt: 'p', schema: { type: 'object' }, cwd: '/wt' });

    expect(out).toEqual({ decision: 'retry', rationale: 'flaky' });
  });

  it('passes read-only tools, json_schema outputFormat, cwd, model, and a small maxTurns', async () => {
    yieldsMessages([sdkResultSuccess({ structuredOutput: {} })]);
    const fn = makeSdkStructuredQuery();

    await fn({ prompt: 'p', schema: { type: 'object' }, cwd: '/wt', model: 'opus' });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.cwd).toBe('/wt');
    expect(opts.model).toBe('opus');
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    expect(opts.pathToClaudeCodeExecutable).toBe('/fake/claude');
    expect(typeof opts.maxTurns).toBe('number');
    expect((opts.maxTurns as number) > 1).toBe(true);
  });

  it('returns null when no successful result is drained', async () => {
    yieldsMessages([sdkAssistantText([])]);
    const fn = makeSdkStructuredQuery();
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('throws when the SDK iterator throws', async () => {
    install(makeRejectingQuery(new Error('sdk boom')));
    const fn = makeSdkStructuredQuery();
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow('sdk boom');
  });

  it('aborts and throws on timeout', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makeSdkStructuredQuery(undefined, 5);
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow(/timed out/);
  });

  it('bridges the caller abort signal to the SDK abortController', async () => {
    let observedAbort = false;
    install(makeBlockUntilAbortQuery(() => {
      observedAbort = true;
    }));
    const controller = new AbortController();
    const fn = makeSdkStructuredQuery();
    const p = fn({ prompt: 'p', schema: {}, cwd: '/wt', signal: controller.signal });
    controller.abort();
    // The caller's abort must be bridged to the SDK's abortController (which ends the
    // in-flight query). The fake generator resolves cleanly on abort → null result;
    // the assertion is that the bridge fired, not a specific resolve/reject outcome.
    await p;
    expect(observedAbort).toBe(true);
  });

  it('defaults the timeout to SUPERVISOR_QUERY_TIMEOUT_MS', () => {
    expect(SUPERVISOR_QUERY_TIMEOUT_MS).toBe(120_000);
  });
});

describe('makeSdkTextQuery', () => {
  it('returns the concatenated text of the last assistant message', async () => {
    yieldsMessages([
      sdkAssistantText('first'),
      sdkAssistantText(['final ', 'answer']),
      sdkResultSuccess(),
    ]);
    const fn = makeSdkTextQuery();

    expect(await fn({ prompt: 'p', cwd: '/wt' })).toBe('final answer');
  });

  it("returns '' when there is no assistant message", async () => {
    yieldsMessages([sdkResultSuccess()]);
    const fn = makeSdkTextQuery();
    expect(await fn({ prompt: 'p', cwd: '/wt' })).toBe('');
  });

  it('uses NO outputFormat and read-only tools', async () => {
    yieldsMessages([sdkAssistantText('hi')]);
    const fn = makeSdkTextQuery();

    await fn({ prompt: 'p', cwd: '/wt' });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.outputFormat).toBeUndefined();
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('throws when the SDK iterator throws BEFORE the monitor speaks (no partial to show)', async () => {
    install(makeRejectingQuery(new Error('text boom')));
    const fn = makeSdkTextQuery();
    await expect(fn({ prompt: 'p', cwd: '/wt' })).rejects.toThrow('text boom');
  });

  it('returns the partial answer when the SDK throws AFTER the monitor spoke (e.g. error_max_turns)', async () => {
    // The smoke-2026-06-22 failure: the monitor produced an answer, then the SDK
    // threw error_max_turns. Graceful degradation surfaces the partial answer the
    // user can use instead of a bare apology (the brain only apologizes on a true
    // empty/throw). Higher MONITOR_MAX_TURNS makes this rare; this is the backstop.
    install(
      makeThenRejectQuery(
        [sdkAssistantText('partial state summary')],
        new Error('Claude Code returned an error result: Reached maximum number of turns (24)'),
      ),
    );
    const fn = makeSdkTextQuery();
    expect(await fn({ prompt: 'p', cwd: '/wt' })).toBe('partial state summary');
  });

  it('aborts and throws on timeout', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makeSdkTextQuery(undefined, 5);
    await expect(fn({ prompt: 'p', cwd: '/wt' })).rejects.toThrow(/timed out/);
  });
});
