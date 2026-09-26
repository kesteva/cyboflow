/**
 * Unit tests for the historical Codex usage replay (codexUsageReplay.ts,
 * docs/proposals/codex-workflow-efficiency.md §5.2 1d) — the pure half: stored
 * notifications in, run-level historical rows out. Sanitized synthetic ids only.
 */
import { describe, it, expect } from 'vitest';
import {
  replayCodexRunNotifications,
  type CodexReplayNotificationRow,
  type CodexRunReplayInput,
} from '../codexUsageReplay';

const RUN = 'run-1';
const ROOT = 'thread-root';
const T1 = 'turn-1';
const T2 = 'turn-2';

function row(method: string, params: Record<string, unknown>, createdAt = '2026-09-20T10:00:00.000Z'): CodexReplayNotificationRow {
  return { payloadJson: JSON.stringify({ method, params }), createdAt };
}

function spawn(sender: string, turnId: string, receivers: string[], model: string | null): CodexReplayNotificationRow {
  return row('item/completed', {
    threadId: sender,
    turnId,
    item: {
      type: 'collabAgentToolCall',
      id: `call-${receivers.join('-')}`,
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: sender,
      receiverThreadIds: receivers,
      model,
      reasoningEffort: null,
    },
  });
}

function subAgentStarted(threadId: string, turnId: string, agentThreadId: string): CodexReplayNotificationRow {
  return row('item/started', {
    threadId,
    turnId,
    item: { type: 'subAgentActivity', id: `activity-${agentThreadId}`, kind: 'started', agentThreadId },
  });
}

interface Usage {
  input: number;
  cached?: number;
  cacheWrite?: number;
  output: number;
  reasoning?: number;
}

function response(
  threadId: string,
  turnId: string,
  responseId: string,
  usage: Usage | null,
  createdAt?: string,
): CodexReplayNotificationRow {
  return row(
    'rawResponse/completed',
    {
      threadId,
      turnId,
      responseId,
      usage:
        usage === null
          ? null
          : {
              totalTokens: usage.input + usage.output,
              inputTokens: usage.input,
              cachedInputTokens: usage.cached ?? 0,
              cacheWriteInputTokens: usage.cacheWrite ?? 0,
              outputTokens: usage.output,
              reasoningOutputTokens: usage.reasoning ?? 0,
            },
    },
    createdAt,
  );
}

function replay(notifications: CodexReplayNotificationRow[], overrides: Partial<CodexRunReplayInput> = {}) {
  return replayCodexRunNotifications({
    runId: RUN,
    notifications,
    rootThreadIds: new Set([ROOT]),
    liveThreadIds: new Set(),
    rootModel: (rootThreadId) => (rootThreadId === ROOT ? 'root-model' : 'run-model'),
    ...overrides,
  });
}

describe('replayCodexRunNotifications', () => {
  it('writes one run-level row per descendant (grandchildren transitively), never the root', () => {
    const result = replay([
      response(ROOT, T1, 'r-root-1', { input: 1000, cached: 800, output: 50 }),
      spawn(ROOT, T1, ['child'], 'child-model'),
      response('child', 'turn-c', 'r-c-1', { input: 500, cached: 300, cacheWrite: 100, output: 20, reasoning: 5 }),
      spawn('child', 'turn-c', ['grandchild'], null),
      response('grandchild', 'turn-g', 'r-g-1', { input: 200, cached: 50, output: 10 }),
      response('child', 'turn-c', 'r-c-2', { input: 600, cached: 550, output: 30 }),
    ]);

    expect(result.hasResponses).toBe(true);
    expect(result.rows.map((r) => r.dedupKey)).toEqual([
      `codex-subagent-run:${RUN}:${ROOT}:${T1}:child`,
      `codex-subagent-run:${RUN}:${ROOT}:${T1}:grandchild`,
    ]);
    const [child, grandchild] = result.rows;
    expect(child.payload).toEqual({
      type: 'subagent_usage',
      provider: 'codex',
      thread_id: 'child',
      parent_thread_id: ROOT,
      invocation_id: null,
      model_inferred: false,
      message: {
        model: 'child-model',
        // uncached input = input − cached − cacheWrite, per response
        usage: {
          input_tokens: 100 + 50,
          output_tokens: 50,
          cache_read_input_tokens: 850,
          cache_creation_input_tokens: 100,
          reasoning_output_tokens: 5,
        },
      },
    });
    // A model-less spawn inherits its nearest ancestor's model, flagged inferred.
    expect(grandchild.payload.parent_thread_id).toBe('child');
    expect(grandchild.payload.model_inferred).toBe(true);
    expect(grandchild.payload.message.model).toBe('child-model');
    expect(grandchild.payload.message.usage.input_tokens).toBe(150);
  });

  it('keys each descendant by the root turn it was spawned in', () => {
    const result = replay([
      spawn(ROOT, T1, ['a'], 'm'),
      response('a', 'turn-a', 'r-a', { input: 10, output: 1 }),
      spawn(ROOT, T2, ['b'], 'm'),
      response('b', 'turn-b', 'r-b', { input: 10, output: 1 }),
    ]);
    expect(result.rows.map((r) => r.dedupKey)).toEqual([
      `codex-subagent-run:${RUN}:${ROOT}:${T1}:a`,
      `codex-subagent-run:${RUN}:${ROOT}:${T2}:b`,
    ]);
  });

  it('registers a subAgentActivity child and takes its model from a later spawn item', () => {
    const result = replay([
      subAgentStarted(ROOT, T1, 'c'),
      response('c', 'turn-c', 'r-c', { input: 10, output: 1 }),
      spawn(ROOT, T1, ['c'], 'late-model'),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload.message.model).toBe('late-model');
    expect(result.rows[0].payload.model_inferred).toBe(false);
  });

  it('a model-less direct child of the root takes the root model, inferred', () => {
    const result = replay([subAgentStarted(ROOT, T1, 'c'), response('c', 'tc', 'r', { input: 10, output: 1 })]);
    expect(result.rows[0].payload.message.model).toBe('root-model');
    expect(result.rows[0].payload.model_inferred).toBe(true);
  });

  it('attributes a response stored before its spawn item', () => {
    const result = replay([response('c', 'tc', 'r', { input: 10, output: 1 }), spawn(ROOT, T1, ['c'], 'm')]);
    expect(result.rows.map((r) => r.dedupKey)).toEqual([`codex-subagent-run:${RUN}:${ROOT}:${T1}:c`]);
  });

  it('counts a repeated responseId once and skips null usage', () => {
    const result = replay([
      spawn(ROOT, T1, ['c'], 'm'),
      response('c', 'tc', 'r-1', { input: 10, output: 1 }),
      response('c', 'tc', 'r-1', { input: 10, output: 1 }),
      response('c', 'tc', 'r-2', null),
    ]);
    expect(result.rows[0].payload.message.usage.input_tokens).toBe(10);
    expect(result.rows[0].payload.message.usage.output_tokens).toBe(1);
  });

  it('sends a never-registered thread to the run-scoped unattributed key', () => {
    const result = replay([
      // Its sender is neither a root nor registered, so the spawn stays pending.
      spawn('orphan-parent', 'tp', ['orphan-child'], 'm'),
      response('orphan-parent', 'tp', 'r-p', { input: 30, output: 3 }),
      response('orphan-child', 'tc', 'r-c', { input: 20, output: 2 }),
    ]);
    expect(result.rows.map((r) => r.dedupKey)).toEqual([
      `codex-unattributed:${RUN}:orphan-parent`,
      `codex-unattributed:${RUN}:orphan-child`,
    ]);
    expect(result.rows[0].payload).toMatchObject({
      parent_thread_id: null,
      invocation_id: null,
      model_inferred: true,
      message: { model: 'run-model' },
    });
  });

  it('never replays a thread a live tracker already wrote', () => {
    const result = replay(
      [spawn(ROOT, T1, ['live', 'old'], 'm'), response('live', 't', 'r-l', { input: 5, output: 1 }), response('old', 't', 'r-o', { input: 5, output: 1 })],
      { liveThreadIds: new Set(['live']) },
    );
    expect(result.rows.map((r) => r.payload.thread_id)).toEqual(['old']);
  });

  it('stamps each row with its thread’s last counted response time', () => {
    const result = replay([
      spawn(ROOT, T1, ['c'], 'm'),
      response('c', 'tc', 'r-1', { input: 1, output: 1 }, '2026-09-20T10:00:00.000Z'),
      response('c', 'tc', 'r-2', { input: 1, output: 1 }, '2026-09-21T09:00:00.000Z'),
    ]);
    expect(result.rows[0].createdAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('reports no responses for a pre-boundary run and writes nothing', () => {
    const result = replay([
      spawn(ROOT, T1, ['c'], 'm'),
      row('thread/tokenUsage/updated', { threadId: 'c', turnId: 'tc', tokenUsage: {} }),
    ]);
    expect(result.hasResponses).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it('ignores malformed rows', () => {
    const result = replay([
      { payloadJson: '{not json', createdAt: '2026-09-20T10:00:00.000Z' },
      { payloadJson: '[]', createdAt: '2026-09-20T10:00:00.000Z' },
      spawn(ROOT, T1, ['c'], 'm'),
      response('c', 'tc', 'r', { input: 1, output: 1 }),
    ]);
    expect(result.rows).toHaveLength(1);
  });
});
