/**
 * TaskToolHandlers — the run-bound backlog tool family split out of
 * McpQueryHandler (issue #19). The family's full behaviour is still driven
 * end-to-end through the handler in mcpQueryHandler.test.ts and the
 * taskChangeChokepoint integration test; these tests pin the SEAM instead:
 * the run guard the handler hands over as a closure is what the family
 * consults, and its replies go through the injected `writeResponse`.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import { TaskToolHandlers, type TaskToolContext } from '../handlers/taskToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeCtx(overrides: Partial<TaskToolContext> = {}): { ctx: TaskToolContext; writes: McpQueryResponse[] } {
  const writes: McpQueryResponse[] = [];
  const ctx: TaskToolContext = {
    db: dbAdapter(new Database(':memory:')),
    deps: {},
    writeResponse: (_client, response) => {
      writes.push(response);
    },
    resolveTaskRunContext: (runId) => ({ ok: false, error: `run_not_active:${runId}` }),
    ...overrides,
  };
  return { ctx, writes };
}

const client = {} as net.Socket;

describe('TaskToolHandlers — context seam', () => {
  it('every tool refuses a run the injected guard rejects, with that guard’s error, before touching the db', async () => {
    const resolveTaskRunContext = vi.fn((runId: string) => ({ ok: false as const, error: `run_not_active:${runId}` }));
    const { ctx, writes } = makeCtx({ resolveTaskRunContext });
    const tools = new TaskToolHandlers(ctx);

    await tools.handleCreateTask({ type: 'mcp-create-task', requestId: 'r1', runId: 'run-a', title: 'x' }, client);
    tools.handleListTasks({ type: 'mcp-list-tasks', requestId: 'r2', runId: 'run-b' }, client);
    tools.handleGetTask({ type: 'mcp-get-task', requestId: 'r3', runId: 'run-c', taskId: 'TASK-1' }, client);

    expect(resolveTaskRunContext.mock.calls.map((c) => c[0])).toEqual(['run-a', 'run-b', 'run-c']);
    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r1', ok: false, error: 'run_not_active:run-a' },
      { type: 'mcp-query-response', requestId: 'r2', ok: false, error: 'run_not_active:run-b' },
      { type: 'mcp-query-response', requestId: 'r3', ok: false, error: 'run_not_active:run-c' },
    ]);
  });
});
