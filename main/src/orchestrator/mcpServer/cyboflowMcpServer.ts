#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

const pendingRequests = new Map<string, ResponseResolver>();
let requestCounter = 0;
let ipcClient: net.Socket | null = null;

function connectToOrchestrator(): net.Socket {
  const socket = net.createConnection(socketPath as string);

  socket.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    // The socket may batch multiple newline-delimited JSON messages
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        const rid = msg['requestId'];
        if (typeof rid === 'string' && pendingRequests.has(rid)) {
          const resolve = pendingRequests.get(rid)!;
          pendingRequests.delete(rid);
          resolve(msg);
        }
      } catch (err) {
        console.error('[Cyboflow MCP] Failed to parse IPC response:', err, 'raw:', trimmed);
      }
    }
  });

  socket.on('error', (err: Error) => {
    console.error('[Cyboflow MCP] IPC socket error:', err.message);
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
    pendingRequests.set(requestId, resolve);
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
        description: 'List all pending approval requests for the current run',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_get_run',
        description: 'Get details about a specific run',
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'The run ID to retrieve' },
          },
          required: ['run_id'],
        },
      },
      {
        name: 'cyboflow_submit_checkpoint',
        description: 'Submit a checkpoint for the current run',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Checkpoint label' },
            note: { type: 'string', description: 'Optional note for this checkpoint' },
          },
          required: ['label'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Stub — TASK-453 replaces this with real implementations
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: 'not_implemented', tool: request.params.name }),
      },
    ],
  };
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
