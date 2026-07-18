/**
 * Scope-gate tests for cyboflowMcpServer.ts's S0.4 CYBOFLOW_MCP_SCOPE branch —
 * the CYBOFLOW_MCP_SCOPE=global-agent direction. The complementary
 * default/unset direction lives in cyboflowMcpServer.test.ts (that file's
 * beforeAll never sets the env var).
 *
 * A SEPARATE file is required (not an extra describe block in the existing
 * file): CYBOFLOW_MCP_SCOPE is read ONCE at module-init time
 * (IS_GLOBAL_AGENT_SCOPE is a module-scope const), so it must be set BEFORE
 * the dynamic `await import('../cyboflowMcpServer')` — and vitest gives each
 * test FILE its own fresh module registry, so a second file importing the
 * same path re-evaluates the module against this file's env vars.
 *
 * Mocking strategy mirrors cyboflowMcpServer.test.ts exactly (Server double
 * captures ListTools/CallTool handlers; node:net returns a `destroyed: true`
 * socket so a dispatched call short-circuits with 'IPC client not connected'
 * instead of hitting the real 30s orchestrator timeout — proof the call
 * reached the query layer rather than being rejected as unknown/invalid).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type RequestHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface CapturedHandlers {
  listTools?: RequestHandler;
  callTool?: RequestHandler;
}

const captured: CapturedHandlers = {};
let setRequestHandlerCallCount = 0;

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  return {
    Server: class {
      setRequestHandler(_schema: unknown, handler: RequestHandler): void {
        if (setRequestHandlerCallCount === 0) captured.listTools = handler;
        else captured.callTool = handler;
        setRequestHandlerCallCount += 1;
      }
      async connect(): Promise<void> {
        // no-op — never reaches a real stdio handshake in tests
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('net', () => {
  return {
    createConnection: () => ({
      on: () => undefined,
      write: () => true,
      end: () => undefined,
      destroyed: true,
    }),
  };
});

const originalRunId = process.env.CYBOFLOW_RUN_ID;
const originalOrchSocket = process.env.CYBOFLOW_ORCH_SOCKET;
const originalMcpScope = process.env.CYBOFLOW_MCP_SCOPE;

beforeAll(async () => {
  process.env.CYBOFLOW_RUN_ID = 'agent:thread-test';
  process.env.CYBOFLOW_ORCH_SOCKET = '/tmp/cyboflow-agent-test.sock';
  process.env.CYBOFLOW_MCP_SCOPE = 'global-agent';
  await import('../cyboflowMcpServer');
});

afterAll(() => {
  if (originalRunId === undefined) delete process.env.CYBOFLOW_RUN_ID;
  else process.env.CYBOFLOW_RUN_ID = originalRunId;

  if (originalOrchSocket === undefined) delete process.env.CYBOFLOW_ORCH_SOCKET;
  else process.env.CYBOFLOW_ORCH_SOCKET = originalOrchSocket;

  if (originalMcpScope === undefined) delete process.env.CYBOFLOW_MCP_SCOPE;
  else process.env.CYBOFLOW_MCP_SCOPE = originalMcpScope;
});

interface ToolDecl {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
    required: string[];
  };
}

async function listTools(): Promise<ToolDecl[]> {
  if (!captured.listTools) throw new Error('ListTools handler was not captured');
  const result = (await captured.listTools({ params: { name: '__list__' } })) as unknown as { tools: ToolDecl[] };
  return result.tools;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!captured.callTool) throw new Error('CallTool handler was not captured');
  const result = await captured.callTool({ params: { name, arguments: args } });
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('cyboflowMcpServer ListTools (CYBOFLOW_MCP_SCOPE=global-agent)', () => {
  it('advertises EXACTLY the 7-tool global-agent family — no run-scoped tool leaks in', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'cyboflow_backlog',
        'cyboflow_entity',
        'cyboflow_overview',
        'cyboflow_propose_action',
        'cyboflow_queue',
        'cyboflow_workflow',
        'cyboflow_workflows',
      ].sort(),
    );
  });

  it("cyboflow_propose_action's description states the promptable contract (never executes; human must confirm)", async () => {
    const tools = await listTools();
    const propose = tools.find((t) => t.name === 'cyboflow_propose_action');
    expect(propose).toBeDefined();
    const description = propose!.description.toLowerCase();
    expect(description).toContain('never executes');
    expect(description).toContain('confirm');
    expect(description).toContain('stop');
  });

  it('cyboflow_workflow requires workflow_id and cyboflow_entity requires task_id', async () => {
    const tools = await listTools();
    expect(tools.find((t) => t.name === 'cyboflow_workflow')!.inputSchema.required).toEqual(['workflow_id']);
    expect(tools.find((t) => t.name === 'cyboflow_entity')!.inputSchema.required).toEqual(['task_id']);
    expect(tools.find((t) => t.name === 'cyboflow_propose_action')!.inputSchema.required).toEqual(['payload_json']);
  });
});

describe('cyboflowMcpServer CallTool (CYBOFLOW_MCP_SCOPE=global-agent)', () => {
  it('rejects a run-scoped tool name as unknown (never dispatched)', async () => {
    await expect(captured.callTool!({ params: { name: 'cyboflow_get_run', arguments: { run_id: 'x' } } })).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it('dispatches cyboflow_overview with no arguments (reaches the query layer, not a validation error)', async () => {
    const result = await callTool('cyboflow_overview', {});
    // destroyed:true short-circuits sendQuery before validation would ever
    // matter — this proves dispatch happened (not 'unknown tool' / 'invalid_arguments').
    expect(result.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_entity rejects a missing task_id without dispatching', async () => {
    expect(await callTool('cyboflow_entity', {})).toMatchObject({ error: 'invalid_arguments' });
  });

  it('cyboflow_propose_action rejects a missing payload_json without dispatching, and dispatches a valid call', async () => {
    expect(await callTool('cyboflow_propose_action', {})).toMatchObject({ error: 'invalid_arguments' });

    const valid = await callTool('cyboflow_propose_action', { payload_json: '{"kind":"launch-run"}' });
    expect(valid.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_backlog maps snake_case args to camelCase query params', async () => {
    const result = await callTool('cyboflow_backlog', { project_id: 7, include_done: true });
    // Dispatch reached the IPC layer (not a validation rejection) — the actual
    // param-mapping assertion belongs to mcpQueryHandler's own tests
    // (mcpAgentTools.test.ts), which drive McpQueryHandler directly.
    expect(result.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_backlog rejects a malformed task_type', async () => {
    expect(await callTool('cyboflow_backlog', { task_type: 'not-a-real-type' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });
});
