#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Env-var bootstrap — must happen before anything else
// ---------------------------------------------------------------------------

const runId = process.env.CYBOFLOW_RUN_ID;
const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;

if (!runId || !socketPath) {
  process.stderr.write(
    `[Cyboflow MCP] Fatal: required env vars missing.\n` +
      `  CYBOFLOW_RUN_ID=${runId ?? '(unset)'}\n` +
      `  CYBOFLOW_ORCH_SOCKET=${socketPath ?? '(unset)'}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Crash-isolation handlers (install early so they cover all subsequent code)
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  console.error('[Cyboflow MCP] Uncaught:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Cyboflow MCP] Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Orchestrator IPC socket
// ---------------------------------------------------------------------------

type ResponseResolver = (response: unknown) => void;
type ResponseRejecter = (reason: Error) => void;

interface PendingRequest {
  resolve: ResponseResolver;
  reject: ResponseRejecter;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;
let ipcClient: net.Socket | null = null;

// Module-scope narrowed constant — the env-var guard above ensures this is
// always a string by the time we reach this point.
const SOCKET_PATH: string = socketPath;

function rejectAllPending(reason: Error): void {
  for (const { reject } of pendingRequests.values()) {
    reject(reason);
  }
  pendingRequests.clear();
}

function connectToOrchestrator(): net.Socket {
  const socket = net.createConnection(SOCKET_PATH);

  // Rolling receive buffer — stream sockets can split a JSON message across
  // multiple 'data' events, or batch messages without a trailing newline in
  // the first chunk.  We retain any incomplete tail for the next event.
  let recvBuffer = '';

  socket.on('data', (buf: Buffer) => {
    recvBuffer += buf.toString('utf8');
    let nl: number;
    while ((nl = recvBuffer.indexOf('\n')) !== -1) {
      const line = recvBuffer.slice(0, nl).trim();
      recvBuffer = recvBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const rid = msg['requestId'];
        if (typeof rid === 'string' && pendingRequests.has(rid)) {
          const pending = pendingRequests.get(rid)!;
          pendingRequests.delete(rid);
          pending.resolve(msg);
        }
      } catch (err) {
        console.error('[Cyboflow MCP] Failed to parse IPC response:', err, 'raw:', line);
      }
    }
  });

  socket.on('error', (err: Error) => {
    console.error('[Cyboflow MCP] IPC socket error:', err.message);
    // Belt-and-suspenders: reject any callers that are waiting, in case
    // 'close' is not emitted (or is delayed) after 'error'.
    rejectAllPending(err);
  });

  socket.on('close', () => { console.error('[Cyboflow MCP] IPC socket closed — exiting'); process.exit(0); });

  return socket;
}

function sendQuery(type: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!ipcClient || ipcClient.destroyed) {
      reject(new Error('[Cyboflow MCP] IPC client not connected'));
      return;
    }
    const requestId = `req-${++requestCounter}-${Date.now()}`;

    // 30-second timeout — removes the pending entry to prevent memory leaks
    const timer = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('orchestrator_timeout')); }, 30_000);

    pendingRequests.set(requestId, {
      resolve: (response: unknown) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (reason: Error) => {
        clearTimeout(timer);
        reject(reason);
      },
    });

    const payload = JSON.stringify({ type, requestId, runId, ...params });
    ipcClient.write(payload + '\n');
  });
}

// Expose for use in TASK-453 tool implementations
export { sendQuery };

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'cyboflow', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'cyboflow_list_pending_approvals',
        description:
          'Return the cross-run review queue: all approvals currently pending across every running workflow in this Cyboflow workspace. Read-only.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_get_run',
        description:
          "Fetch a workflow run's state (status, workflow name, timestamps, last 10 events) by ID. Read-only.",
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'The workflow_runs.id to fetch' },
          },
          required: ['run_id'],
        },
      },
      {
        name: 'cyboflow_submit_checkpoint',
        description:
          'Record a checkpoint marker for the current run. This is an observational marker only — it does not change run status, approve anything, or notify the user.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short identifier for the checkpoint' },
            note: { type: 'string', description: 'Optional longer description' },
          },
          required: ['label'],
        },
      },
      {
        name: 'cyboflow_report_step',
        description:
          'Report the current workflow phase/step for the current run by its step id. This is an OBSERVATIONAL signal that drives the Workflow Progress panel only — it does NOT pause the run, change run status, approve anything, or notify the user (contrast with the PreToolUse approval gate). The run is bound from CYBOFLOW_RUN_ID, so there is no run_id argument.',
        inputSchema: {
          type: 'object',
          properties: {
            step_id: { type: 'string', description: "The workflow step id to mark as current (must exist in this run's workflow definition)" },
            status: { type: 'string', enum: ['running', 'done'], description: "Optional step status; defaults to 'running'" },
          },
          required: ['step_id'],
        },
      },
    ],
  };
});

async function executeMcpQuery(
  type: string,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const queryPromise = sendQuery(type, params);
    const response = await queryPromise;
    if (
      typeof response !== 'object' ||
      response === null ||
      !('ok' in response) ||
      typeof (response as { ok: unknown }).ok !== 'boolean'
    ) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_orchestrator_response' }) }] };
    }
    type OkResponse = { ok: boolean; data?: unknown; error?: string };
    const resp = response as OkResponse;
    if (!resp.ok) {
      const errorText = typeof resp.error === 'string' && resp.error.length > 0
        ? resp.error
        : 'orchestrator_error';
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorText }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'cyboflow_list_pending_approvals': {
      return executeMcpQuery('mcp-list-pending-approvals', {});
    }

    case 'cyboflow_get_run': {
      const args = (request.params.arguments ?? {}) as { run_id?: unknown };
      const { run_id } = args;
      if (typeof run_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'run_id: string' }),
            },
          ],
        };
      }
      return executeMcpQuery('mcp-get-run', { targetRunId: run_id });
    }

    case 'cyboflow_submit_checkpoint': {
      const args = (request.params.arguments ?? {}) as { label?: unknown; note?: unknown };
      const { label, note } = args;
      if (typeof label !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'label: string' }),
            },
          ],
        };
      }
      if (note !== undefined && typeof note !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'note: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { label };
      if (note !== undefined) queryParams['note'] = note;
      return executeMcpQuery('mcp-submit-checkpoint', queryParams);
    }

    case 'cyboflow_report_step': {
      const args = (request.params.arguments ?? {}) as { step_id?: unknown; status?: unknown };
      const { step_id, status } = args;
      if (typeof step_id !== 'string' || step_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'step_id: string' }),
            },
          ],
        };
      }
      if (status !== undefined && status !== 'running' && status !== 'done') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "status: 'running' | 'done' (optional)" }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { stepId: step_id };
      if (status !== undefined) queryParams['status'] = status;
      return executeMcpQuery('mcp-report-step', queryParams);
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// ---------------------------------------------------------------------------
// Signal handlers (must reference ipcClient, installed after bootstrap)
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  if (ipcClient) ipcClient.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (ipcClient) ipcClient.end();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    ipcClient = connectToOrchestrator();

    // Give the socket time to establish before the MCP handshake begins
    await new Promise<void>((r) => setTimeout(r, 100));

    await server.connect(new StdioServerTransport());
  } catch (err) {
    console.error('[Cyboflow MCP] Fatal error in main:', err);
    process.exit(1);
  }
}

main();
