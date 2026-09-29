/**
 * AgentOverviewWidgetHandlers — the global agent's backlog reads + custom-view
 * widget tools, split out of McpQueryHandler (issue #19). The family's full
 * behaviour is still driven end-to-end through the handler in
 * mcpQueryHandler.test.ts; these tests pin the SEAM instead: replies go
 * through the injected `writeResponse`, and the global-agent scope check runs
 * inside the family before any read.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import {
  AgentOverviewWidgetHandlers,
  type AgentOverviewWidgetContext,
} from '../handlers/agentOverviewWidgetHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

const client = {} as net.Socket;

describe('AgentOverviewWidgetHandlers — context seam', () => {
  it('a caller outside the global-agent scope is refused through the injected writer, for every read', () => {
    const writes: McpQueryResponse[] = [];
    const ctx: AgentOverviewWidgetContext = {
      db: dbAdapter(new Database(':memory:')),
      deps: {},
      writeResponse: (_client, response) => {
        writes.push(response);
      },
    };
    const tools = new AgentOverviewWidgetHandlers(ctx);

    tools.handleAgentOverview({ type: 'mcp-overview', requestId: 'r1', runId: 'not-the-agent' }, client);
    tools.handleAgentBacklog({ type: 'mcp-backlog', requestId: 'r2', runId: 'not-the-agent' }, client);
    tools.handleAgentEntity({ type: 'mcp-entity', requestId: 'r3', runId: 'not-the-agent', taskId: 'TASK-1' }, client);

    expect(writes.map((w) => w.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(writes.map((w) => (w.ok ? 'ok' : w.error))).toEqual(['not_a_global_agent_run', 'not_a_global_agent_run', 'not_a_global_agent_run']);
  });
});
