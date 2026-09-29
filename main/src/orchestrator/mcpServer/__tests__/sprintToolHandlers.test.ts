/**
 * SprintToolHandlers — the sprint tool family split out of McpQueryHandler
 * (issue #19). The family's full behaviour is still driven end-to-end through
 * the handler in mcpQueryHandler.test.ts, shipHandoff.test.ts and the
 * sprintBatchChokepoint integration test; these tests pin the SEAM instead:
 * both tools consult the run guard the handler hands over as a closure, and
 * replies go through the injected `writeResponse`.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import { SprintToolHandlers, type SprintToolContext } from '../handlers/sprintToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

const client = {} as net.Socket;

describe('SprintToolHandlers — context seam', () => {
  it('update-sprint-task and create-sprint-batch refuse a run the injected guard rejects, with its error', () => {
    const writes: McpQueryResponse[] = [];
    const resolveTaskRunContext = vi.fn((runId: string) => ({ ok: false as const, error: `run_not_active:${runId}` }));
    const ctx: SprintToolContext = {
      db: dbAdapter(new Database(':memory:')),
      deps: {},
      writeResponse: (_client, response) => {
        writes.push(response);
      },
      resolveTaskRunContext,
    };
    const tools = new SprintToolHandlers(ctx);

    tools.handleUpdateSprintTask(
      { type: 'mcp-update-sprint-task', requestId: 'r1', runId: 'run-a', taskId: 'TASK-1', status: 'running' },
      client,
    );
    tools.handleCreateSprintBatch({ type: 'mcp-create-sprint-batch', requestId: 'r2', runId: 'run-b' }, client);

    expect(resolveTaskRunContext.mock.calls.map((c) => c[0])).toEqual(['run-a', 'run-b']);
    expect(writes.map((w) => ({ requestId: w.requestId, ok: w.ok, error: w.error }))).toEqual([
      { requestId: 'r1', ok: false, error: 'run_not_active:run-a' },
      { requestId: 'r2', ok: false, error: 'run_not_active:run-b' },
    ]);
  });
});
