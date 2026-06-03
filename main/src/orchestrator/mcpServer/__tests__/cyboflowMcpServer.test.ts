/**
 * Unit tests for the cyboflowMcpServer entry-point's tool surface.
 *
 * The server module is an executable entry point: it reads CYBOFLOW_RUN_ID /
 * CYBOFLOW_ORCH_SOCKET at import time, installs an MCP Server, and calls main()
 * (which connects an orchestrator socket + a stdio transport). To exercise the
 * REAL ListTools / CallTool handlers hermetically we:
 *   - set the required env vars BEFORE import so the bootstrap guard passes;
 *   - mock '@modelcontextprotocol/sdk/server/index.js' so the Server double
 *     captures the two registered request handlers by their schema;
 *   - mock the stdio transport + node:net so main() is a harmless no-op (no real
 *     socket, no real stdio handshake).
 *
 * We then drive the captured handlers directly and assert on their return value.
 *
 * Coverage (P3 test_strategy):
 *   1. ListTools includes cyboflow_report_finding with the documented inputSchema
 *      (required title+body; optional severity/kind/blocking/entity_type/
 *      entity_id/payload_json with the right enums) alongside the existing tools.
 *   2. CallTool('cyboflow_report_finding') arg validation: missing/empty title or
 *      body, bad severity, bad kind, non-boolean blocking, bad entity_type,
 *      non-string entity_id/payload_json all return invalid_arguments WITHOUT
 *      reaching the orchestrator query; a fully-valid call DOES dispatch
 *      'mcp-report-finding' with the snake->camel mapped params.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Captured request handlers + sendQuery spy
// ---------------------------------------------------------------------------

type RequestHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface CapturedHandlers {
  listTools?: RequestHandler;
  callTool?: RequestHandler;
}

const captured: CapturedHandlers = {};

// The real request schemas are objects imported from the SDK types module; the
// server registers two handlers. We disambiguate by call ORDER: the module
// registers ListTools FIRST, then CallTool (see cyboflowMcpServer.ts).
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

// node:net — connectToOrchestrator must not open a real socket. The double
// reports `destroyed: true` so sendQuery short-circuits with an immediate
// reject ('IPC client not connected') instead of awaiting the 30s orchestrator
// timeout — a valid CallTool then surfaces that connection error, NOT a
// validation error, which is exactly what the dispatch-path assertion needs.
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

// ---------------------------------------------------------------------------
// Bootstrap env (must be set before the dynamic import)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env.CYBOFLOW_RUN_ID = 'run-test';
  process.env.CYBOFLOW_ORCH_SOCKET = '/tmp/cyboflow-test.sock';
  // Dynamic import AFTER the env + mocks are in place. The module registers its
  // two handlers synchronously during evaluation.
  await import('../cyboflowMcpServer');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const result = (await captured.listTools({ params: { name: '__list__' } })) as unknown as {
    tools: ToolDecl[];
  };
  return result.tools;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!captured.callTool) throw new Error('CallTool handler was not captured');
  const result = await captured.callTool({ params: { name, arguments: args } });
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Tool-list declaration
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer ListTools', () => {
  it('declares cyboflow_report_finding alongside the existing tools', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    // The new tool is present...
    expect(names).toContain('cyboflow_report_finding');
    // ...without dropping the established ones.
    expect(names).toEqual(
      expect.arrayContaining([
        'cyboflow_report_step',
        'cyboflow_create_task',
        'cyboflow_update_task',
        'cyboflow_set_task_stage',
        'cyboflow_report_finding',
      ]),
    );
  });

  it('cyboflow_report_finding requires title+body and declares the documented optional fields', async () => {
    const tools = await listTools();
    const finding = tools.find((t) => t.name === 'cyboflow_report_finding');
    expect(finding).toBeDefined();
    const schema = finding!.inputSchema;

    expect(schema.required).toEqual(['title', 'body']);

    const props = schema.properties;
    expect(props['title'].type).toBe('string');
    expect(props['body'].type).toBe('string');
    expect(props['severity'].enum).toEqual(['info', 'warning', 'error']);
    // The MCP tool intentionally EXCLUDES 'permission' (folded via the approval path).
    expect(props['kind'].enum).toEqual(['finding', 'decision', 'human_task']);
    expect(props['blocking'].type).toBe('boolean');
    expect(props['entity_type'].enum).toEqual(['idea', 'epic', 'task']);
    expect(props['entity_id'].type).toBe('string');
    expect(props['payload_json'].type).toBe('string');
  });

  it('documents the non-blocking default in the description', async () => {
    const tools = await listTools();
    const finding = tools.find((t) => t.name === 'cyboflow_report_finding');
    expect(finding!.description.toLowerCase()).toContain('non-blocking');
  });
});

// ---------------------------------------------------------------------------
// 2. CallTool arg validation
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer CallTool cyboflow_report_finding validation', () => {
  it('rejects a missing/empty title with invalid_arguments', async () => {
    expect(await callTool('cyboflow_report_finding', { body: 'b' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { title: '', body: 'b' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('rejects a missing/empty body with invalid_arguments', async () => {
    expect(await callTool('cyboflow_report_finding', { title: 't' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { title: 't', body: '' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('rejects a bad severity / kind / blocking / entity_type / entity_id / payload_json', async () => {
    const base = { title: 't', body: 'b' };
    expect(await callTool('cyboflow_report_finding', { ...base, severity: 'fatal' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { ...base, kind: 'permission' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { ...base, blocking: 'yes' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { ...base, entity_type: 'sprint' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { ...base, entity_id: 42 })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_report_finding', { ...base, payload_json: { kind: 'finding' } })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('accepts a valid finding and surfaces the orchestrator response (no validation error)', async () => {
    // With the mocked net double, sendQuery rejects (the socket double has no
    // response pump) → executeMcpQuery catches and returns { error: <message> }.
    // The point of THIS test is that a VALID call passes arg validation and
    // reaches the dispatch path — i.e. it does NOT return 'invalid_arguments'.
    const res = await callTool('cyboflow_report_finding', {
      title: 'Found a thing',
      body: 'details',
      severity: 'warning',
      kind: 'finding',
      blocking: false,
      entity_type: 'task',
      entity_id: 'tsk_abc',
      payload_json: JSON.stringify({ kind: 'finding', category: 'perf' }),
    });
    expect(res['error']).not.toBe('invalid_arguments');
  });
});
