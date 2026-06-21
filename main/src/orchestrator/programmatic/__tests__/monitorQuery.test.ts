import { describe, it, expect, vi, beforeEach } from 'vitest';

// The SDK `query` is mocked so the monitorQuery boundary is unit-testable without a
// real claude binary. Each test installs its own async-generator behavior via the
// shared `queryMock`.
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

/** Build an async generator yielding the given SDK messages, recording options. */
function yieldsMessages(messages: unknown[]): void {
  queryMock.mockImplementation(({ options }: { options: unknown }) => {
    lastOptions = options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  });
}
let lastOptions: unknown;

/**
 * An async iterable whose first `next()` rejects — models the SDK iterator throwing.
 * Hand-built (not a generator) so there is no empty-generator `require-yield` error.
 */
function rejectingIterable(error: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

/**
 * Build a blocking async generator for `queryMock` that completes (without yielding)
 * once its run's abortController fires — models a hung query unblocked by the
 * deadline timer or the caller's abort signal. `onAbort` observes the abort firing.
 * The unreachable trailing `yield` only satisfies the `require-yield` lint rule (an
 * async generator with no `yield` token); it never executes.
 */
function blockUntilAbort(onAbort?: () => void): void {
  queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
    lastOptions = options;
    const ac = options.abortController;
    return (async function* () {
      await new Promise<void>((resolve) =>
        ac.signal.addEventListener(
          'abort',
          () => {
            onAbort?.();
            resolve();
          },
          { once: true },
        ),
      );
      if (false as boolean) yield undefined as never; // unreachable — satisfies require-yield
    })();
  });
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
});

describe('makeSdkStructuredQuery', () => {
  it('returns the structured_output of the successful result', async () => {
    yieldsMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'result', subtype: 'success', structured_output: { decision: 'retry', rationale: 'flaky' } },
    ]);
    const fn = makeSdkStructuredQuery();

    const out = await fn({ prompt: 'p', schema: { type: 'object' }, cwd: '/wt' });

    expect(out).toEqual({ decision: 'retry', rationale: 'flaky' });
  });

  it('passes read-only tools, json_schema outputFormat, cwd, model, and a small maxTurns', async () => {
    yieldsMessages([{ type: 'result', subtype: 'success', structured_output: {} }]);
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
    yieldsMessages([{ type: 'assistant', message: { content: [] } }]);
    const fn = makeSdkStructuredQuery();
    expect(await fn({ prompt: 'p', schema: {}, cwd: '/wt' })).toBeNull();
  });

  it('throws when the SDK iterator throws', async () => {
    queryMock.mockImplementation(() => rejectingIterable(new Error('sdk boom')));
    const fn = makeSdkStructuredQuery();
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow('sdk boom');
  });

  it('aborts and throws on timeout', async () => {
    blockUntilAbort();
    const fn = makeSdkStructuredQuery(undefined, 5);
    await expect(fn({ prompt: 'p', schema: {}, cwd: '/wt' })).rejects.toThrow(/timed out/);
  });

  it('bridges the caller abort signal to the SDK abortController', async () => {
    let observedAbort = false;
    blockUntilAbort(() => {
      observedAbort = true;
    });
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
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }] } },
      { type: 'result', subtype: 'success' },
    ]);
    const fn = makeSdkTextQuery();

    expect(await fn({ prompt: 'p', cwd: '/wt' })).toBe('final answer');
  });

  it("returns '' when there is no assistant message", async () => {
    yieldsMessages([{ type: 'result', subtype: 'success' }]);
    const fn = makeSdkTextQuery();
    expect(await fn({ prompt: 'p', cwd: '/wt' })).toBe('');
  });

  it('uses NO outputFormat and read-only tools', async () => {
    yieldsMessages([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]);
    const fn = makeSdkTextQuery();

    await fn({ prompt: 'p', cwd: '/wt' });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.outputFormat).toBeUndefined();
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('throws when the SDK iterator throws', async () => {
    queryMock.mockImplementation(() => rejectingIterable(new Error('text boom')));
    const fn = makeSdkTextQuery();
    await expect(fn({ prompt: 'p', cwd: '/wt' })).rejects.toThrow('text boom');
  });

  it('aborts and throws on timeout', async () => {
    blockUntilAbort();
    const fn = makeSdkTextQuery(undefined, 5);
    await expect(fn({ prompt: 'p', cwd: '/wt' })).rejects.toThrow(/timed out/);
  });
});
