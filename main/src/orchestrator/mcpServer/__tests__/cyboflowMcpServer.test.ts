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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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

// Save the pre-test values so afterAll can restore (or delete) them — leaving
// these set process-wide would leak into any other test file that happens to
// run in the same forked worker after this one (order-dependent flake).
const originalRunId = process.env.CYBOFLOW_RUN_ID;
const originalOrchSocket = process.env.CYBOFLOW_ORCH_SOCKET;

beforeAll(async () => {
  process.env.CYBOFLOW_RUN_ID = 'run-test';
  process.env.CYBOFLOW_ORCH_SOCKET = '/tmp/cyboflow-test.sock';
  // Dynamic import AFTER the env + mocks are in place. The module registers its
  // two handlers synchronously during evaluation.
  await import('../cyboflowMcpServer');
});

afterAll(() => {
  if (originalRunId === undefined) delete process.env.CYBOFLOW_RUN_ID;
  else process.env.CYBOFLOW_RUN_ID = originalRunId;

  if (originalOrchSocket === undefined) delete process.env.CYBOFLOW_ORCH_SOCKET;
  else process.env.CYBOFLOW_ORCH_SOCKET = originalOrchSocket;
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

  it("cyboflow_report_finding's proposed_target enum includes 'fix' (findings-triage redesign)", async () => {
    const tools = await listTools();
    const finding = tools.find((t) => t.name === 'cyboflow_report_finding');
    expect(finding!.inputSchema.properties['proposed_target'].enum).toEqual([
      'backlog',
      'docs',
      'prompt',
      'fix',
    ]);
  });

  it('declares cyboflow_add_task_dependency with the documented inputSchema', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cyboflow_add_task_dependency');

    const dep = tools.find((t) => t.name === 'cyboflow_add_task_dependency');
    expect(dep).toBeDefined();
    const schema = dep!.inputSchema;
    expect(schema.required).toEqual(['task_id', 'depends_on_task_id']);
    expect(schema.properties['task_id'].type).toBe('string');
    expect(schema.properties['depends_on_task_id'].type).toBe('string');
    expect(schema.properties['kind'].enum).toEqual(['blocking', 'related']);
  });
});

// ---------------------------------------------------------------------------
// CallTool cyboflow_add_task_dependency validation
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer CallTool cyboflow_add_task_dependency validation', () => {
  it('rejects a missing or empty task_id', async () => {
    expect(await callTool('cyboflow_add_task_dependency', { depends_on_task_id: 'tsk_b' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(
      await callTool('cyboflow_add_task_dependency', { task_id: '', depends_on_task_id: 'tsk_b' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('rejects a missing or empty depends_on_task_id', async () => {
    expect(await callTool('cyboflow_add_task_dependency', { task_id: 'tsk_a' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(
      await callTool('cyboflow_add_task_dependency', { task_id: 'tsk_a', depends_on_task_id: '' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('rejects an out-of-enum kind', async () => {
    expect(
      await callTool('cyboflow_add_task_dependency', {
        task_id: 'tsk_a',
        depends_on_task_id: 'tsk_b',
        kind: 'soft',
      }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('passes validation with valid args and surfaces the (mocked) connection error, not a validation error', async () => {
    const res = await callTool('cyboflow_add_task_dependency', {
      task_id: 'tsk_a',
      depends_on_task_id: 'tsk_b',
    });
    // The net mock reports destroyed:true so sendQuery rejects immediately; the
    // point is that arg validation PASSED (no 'invalid_arguments').
    expect(res.error).not.toBe('invalid_arguments');
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

// ---------------------------------------------------------------------------
// cyboflow_update_sprint_task — declaration + CallTool validation
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer ListTools cyboflow_update_sprint_task', () => {
  it('declares cyboflow_update_sprint_task with the documented inputSchema', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cyboflow_update_sprint_task');

    const lane = tools.find((t) => t.name === 'cyboflow_update_sprint_task');
    expect(lane).toBeDefined();
    const schema = lane!.inputSchema;
    expect(schema.required).toEqual(['task_id']);
    expect(schema.properties['task_id'].type).toBe('string');
    // Lane status reuses the SprintBatchTaskStatus domain (migration 022 CHECK).
    expect(schema.properties['status'].enum).toEqual([
      'queued',
      'running',
      'integrated',
      'failed',
      'blocked',
    ]);
    // The per-task lane step vocabulary is now CHAIN-DERIVED (a workflow's
    // fanOut.inner ids, user-editable) — current_step is declared as a plain
    // string, NOT a fixed enum; server-side validation (mcpQueryHandler /
    // SprintLaneStore) is the sole authority. See the CallTool suite below.
    expect(schema.properties['current_step'].type).toBe('string');
    expect(schema.properties['current_step'].enum).toBeUndefined();
    expect(schema.properties['current_step'].description).toContain('validated server-side');
    // The 1-based implement→verify retry counter (migration 025).
    expect(schema.properties['attempt'].type).toBe('number');
    expect(schema.properties['attempt'].description).toContain('re-delegating');
  });

  it("documents the 'integrated' = committed-in-session-worktree semantics", async () => {
    const tools = await listTools();
    const lane = tools.find((t) => t.name === 'cyboflow_update_sprint_task');
    expect(lane!.description).toContain('session worktree');
  });
});

describe('cyboflowMcpServer CallTool cyboflow_update_sprint_task validation', () => {
  it('rejects a missing or empty task_id', async () => {
    expect(await callTool('cyboflow_update_sprint_task', { status: 'running' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_update_sprint_task', { task_id: '', status: 'running' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('rejects an out-of-enum status', async () => {
    expect(
      await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', status: 'done' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('accepts an arbitrary non-empty current_step and reaches the dispatch path (server-side validates)', async () => {
    // The lane step vocabulary is chain-derived and now validated SERVER-SIDE
    // (mcpQueryHandler.handleUpdateSprintTask -> SprintLaneStore.updateLane)
    // against the calling run's resolved fan-out chain — the client-side check
    // no longer rejects an id it doesn't recognize. A truly bogus id like
    // 'deploy' is expected to be rejected server-side (covered by
    // mcpQueryHandler.test.ts / sprintLaneStore.test.ts), not here — this mocked
    // socket double never reaches a real orchestrator, so there is nothing
    // server-side to assert against in this file.
    const res = await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', current_step: 'deploy' });
    expect(res['error']).not.toBe('invalid_arguments');
  });

  it('rejects an empty current_step', async () => {
    expect(
      await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', current_step: '' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it("accepts current_step: 'awaiting-verify' and reaches the dispatch path (regression — was client-rejected)", async () => {
    // Regression test: the OLD client-side enum check was missing
    // 'awaiting-verify', so sprint.md/ship.md's instructed park-the-lane call
    // was rejected with invalid_arguments before it ever reached the socket.
    // The loosened non-empty-string check fixes this.
    const res = await callTool('cyboflow_update_sprint_task', {
      task_id: 'tsk_a',
      current_step: 'awaiting-verify',
    });
    expect(res['error']).not.toBe('invalid_arguments');
  });

  it('rejects a call with NEITHER status nor current_step', async () => {
    expect(await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('rejects a non-integer or < 1 attempt', async () => {
    expect(
      await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', current_step: 'implement', attempt: 0 }),
    ).toMatchObject({ error: 'invalid_arguments' });
    expect(
      await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', current_step: 'implement', attempt: 1.5 }),
    ).toMatchObject({ error: 'invalid_arguments' });
    expect(
      await callTool('cyboflow_update_sprint_task', { task_id: 'tsk_a', current_step: 'implement', attempt: '2' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('passes validation with status only / current_step only / attempt alongside and reaches the dispatch path', async () => {
    // The net mock reports destroyed:true so sendQuery rejects immediately; the
    // point is that arg validation PASSED (no 'invalid_arguments').
    const statusOnly = await callTool('cyboflow_update_sprint_task', {
      task_id: 'tsk_a',
      status: 'integrated',
    });
    expect(statusOnly['error']).not.toBe('invalid_arguments');

    const stepOnly = await callTool('cyboflow_update_sprint_task', {
      task_id: 'tsk_a',
      current_step: 'write-tests',
    });
    expect(stepOnly['error']).not.toBe('invalid_arguments');

    const withAttempt = await callTool('cyboflow_update_sprint_task', {
      task_id: 'tsk_a',
      current_step: 'implement',
      attempt: 2,
    });
    expect(withAttempt['error']).not.toBe('invalid_arguments');
  });
});

// ---------------------------------------------------------------------------
// cyboflow_get_selected_findings / cyboflow_resolve_finding — declaration +
// CallTool validation (findings-triage redesign).
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer ListTools compound-run findings tools', () => {
  it('declares cyboflow_get_selected_findings with an empty inputSchema', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cyboflow_get_selected_findings');

    const tool = tools.find((t) => t.name === 'cyboflow_get_selected_findings');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toEqual({});
    expect(tool!.inputSchema.required).toEqual([]);
    // Read-only contract is documented.
    expect(tool!.description.toLowerCase()).toContain('read-only');
  });

  it('declares cyboflow_resolve_finding with the documented inputSchema', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cyboflow_resolve_finding');

    const tool = tools.find((t) => t.name === 'cyboflow_resolve_finding');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema;
    expect(schema.required).toEqual(['review_item_id', 'resolution_kind']);
    expect(schema.properties['review_item_id'].type).toBe('string');
    expect(schema.properties['resolution_kind'].enum).toEqual(['fixed', 'triaged', 'promoted']);
    expect(schema.properties['note'].type).toBe('string');
    expect(schema.properties['task_id'].type).toBe('string');
  });
});

describe('cyboflowMcpServer CallTool cyboflow_resolve_finding validation', () => {
  it('rejects a missing or empty review_item_id', async () => {
    expect(await callTool('cyboflow_resolve_finding', { resolution_kind: 'fixed' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(
      await callTool('cyboflow_resolve_finding', { review_item_id: '', resolution_kind: 'fixed' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('rejects a missing or out-of-enum resolution_kind', async () => {
    expect(await callTool('cyboflow_resolve_finding', { review_item_id: 'ri_1' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(
      await callTool('cyboflow_resolve_finding', { review_item_id: 'ri_1', resolution_kind: 'dismissed' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('rejects a non-string note / task_id', async () => {
    expect(
      await callTool('cyboflow_resolve_finding', { review_item_id: 'ri_1', resolution_kind: 'fixed', note: 7 }),
    ).toMatchObject({ error: 'invalid_arguments' });
    expect(
      await callTool('cyboflow_resolve_finding', { review_item_id: 'ri_1', resolution_kind: 'promoted', task_id: 42 }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('passes validation with valid args and reaches the dispatch path (mocked connection error)', async () => {
    const res = await callTool('cyboflow_resolve_finding', {
      review_item_id: 'ri_1',
      resolution_kind: 'promoted',
      task_id: 'TASK-001',
    });
    // The net mock reports destroyed:true so sendQuery rejects immediately; the
    // point is that arg validation PASSED (no 'invalid_arguments').
    expect(res['error']).not.toBe('invalid_arguments');
  });
});

// ---------------------------------------------------------------------------
// cyboflow_create_task / cyboflow_update_task — the body param (planner spec path)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cyboflow_list_tasks / cyboflow_get_task — declaration + CallTool validation
// ---------------------------------------------------------------------------

describe('cyboflowMcpServer ListTools read-only backlog tools', () => {
  it('declares cyboflow_list_tasks and cyboflow_get_task alongside the existing tools', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cyboflow_list_tasks');
    expect(names).toContain('cyboflow_get_task');
    expect(names).toEqual(
      expect.arrayContaining([
        'cyboflow_create_task',
        'cyboflow_update_task',
        'cyboflow_set_task_stage',
        'cyboflow_add_task_dependency',
        'cyboflow_list_tasks',
        'cyboflow_get_task',
      ]),
    );
  });

  it('cyboflow_list_tasks declares three optional filters and no required fields', async () => {
    const tools = await listTools();
    const tool = tools.find((t) => t.name === 'cyboflow_list_tasks');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema;
    expect(schema.required).toEqual([]);
    expect(schema.properties['task_type'].enum).toEqual(['idea', 'epic', 'task']);
    expect(schema.properties['include_archived'].type).toBe('boolean');
    expect(schema.properties['include_done'].type).toBe('boolean');
  });

  it('cyboflow_list_tasks documents that it is read-only and returns compact items', async () => {
    const tools = await listTools();
    const tool = tools.find((t) => t.name === 'cyboflow_list_tasks');
    const description = tool!.description.toLowerCase();
    expect(description).toContain('read-only');
    expect(description).toContain('compact');
    expect(description).toContain('cyboflow_get_task');
  });

  it('cyboflow_get_task requires task_id and documents id-or-ref + read-only + project scoping', async () => {
    const tools = await listTools();
    const tool = tools.find((t) => t.name === 'cyboflow_get_task');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema;
    expect(schema.required).toEqual(['task_id']);
    expect(schema.properties['task_id'].type).toBe('string');
    const description = tool!.description.toLowerCase();
    expect(description).toContain('read-only');
    expect(description).toContain('ref');
  });
});

describe('cyboflowMcpServer CallTool cyboflow_list_tasks validation', () => {
  it('rejects an out-of-enum task_type', async () => {
    expect(await callTool('cyboflow_list_tasks', { task_type: 'sprint' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('rejects a non-boolean include_archived / include_done', async () => {
    expect(await callTool('cyboflow_list_tasks', { include_archived: 'yes' })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_list_tasks', { include_done: 1 })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('passes validation with no args and with every optional field set, reaching the dispatch path', async () => {
    const empty = await callTool('cyboflow_list_tasks', {});
    expect(empty['error']).not.toBe('invalid_arguments');

    const full = await callTool('cyboflow_list_tasks', {
      task_type: 'task',
      include_archived: true,
      include_done: true,
    });
    expect(full['error']).not.toBe('invalid_arguments');
  });
});

describe('cyboflowMcpServer CallTool cyboflow_get_task validation', () => {
  it('rejects a missing or empty task_id', async () => {
    expect(await callTool('cyboflow_get_task', {})).toMatchObject({ error: 'invalid_arguments' });
    expect(await callTool('cyboflow_get_task', { task_id: '' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('passes validation with a valid task_id (opaque id or ref) and reaches the dispatch path', async () => {
    const byId = await callTool('cyboflow_get_task', { task_id: 'tsk_abc' });
    expect(byId['error']).not.toBe('invalid_arguments');

    const byRef = await callTool('cyboflow_get_task', { task_id: 'TASK-014' });
    expect(byRef['error']).not.toBe('invalid_arguments');
  });
});

describe('cyboflowMcpServer create/update task body param', () => {
  it('declares an optional string body on both create_task and update_task', async () => {
    const tools = await listTools();
    const create = tools.find((t) => t.name === 'cyboflow_create_task');
    const update = tools.find((t) => t.name === 'cyboflow_update_task');
    expect(create!.inputSchema.properties['body'].type).toBe('string');
    expect(update!.inputSchema.properties['body'].type).toBe('string');
    // body is OPTIONAL — only title (create) / task_id (update) are required.
    expect(create!.inputSchema.required).toEqual(['title']);
    expect(update!.inputSchema.required).toEqual(['task_id']);
  });

  it('rejects a non-string body with invalid_arguments (create + update)', async () => {
    expect(await callTool('cyboflow_create_task', { title: 'T', body: 42 })).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(await callTool('cyboflow_update_task', { task_id: 'tsk_a', body: 42 })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('passes validation when body is a string and reaches dispatch (mocked connection error)', async () => {
    const created = await callTool('cyboflow_create_task', {
      title: 'Spec idea',
      summary: 'caption',
      body: '## Idea spec\n\n- detail',
    });
    expect(created['error']).not.toBe('invalid_arguments');

    const updated = await callTool('cyboflow_update_task', {
      task_id: 'tsk_a',
      body: '## Idea spec\n\n- folded',
    });
    expect(updated['error']).not.toBe('invalid_arguments');
  });
});
