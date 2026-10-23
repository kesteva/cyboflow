#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as net from 'net';
import { readOrchToken } from '../orchAuthToken';
import { ASSISTANT_REFERENCE } from '../agentThread/assistantReference';
import { startParentWatchdog, resolveWatchdogIntervalMs } from './parentWatchdog';
import { declarationsForScope, findTool, type McpToolScope } from './toolRegistry';

// ---------------------------------------------------------------------------
// Env-var bootstrap — must happen before anything else
// ---------------------------------------------------------------------------

const runId = process.env.CYBOFLOW_RUN_ID;
const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;
/**
 * This process's bearer token for `runId`, minted by the orchestrator and
 * handed over in the spawn env (orchAuthToken.ts). Every frame carries it: the
 * server refuses to bind a self-declared runId without it.
 *
 * Deliberately NOT part of the fatal env check above — the socket server logs
 * the refusal and closes the connection, which surfaces as a clear IPC failure,
 * and a hard exit here would take down a session over a value the server may
 * not even be enforcing (see CYBOFLOW_DISABLE_ORCH_SOCK_AUTH).
 */
const orchToken = readOrchToken();

if (!runId || !socketPath) {
  process.stderr.write(
    `[Cyboflow MCP] Fatal: required env vars missing.\n` +
      `  CYBOFLOW_RUN_ID=${runId ?? '(unset)'}\n` +
      `  CYBOFLOW_ORCH_SOCKET=${socketPath ?? '(unset)'}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scope gate (S0.4 / global agent)
//
// CYBOFLOW_MCP_SCOPE=global-agent restricts this subprocess to the read +
// propose-action tool family (toolRegistry/globalAgentTools.ts) — none of the
// run-scoped tools are listed or callable. Unset/any other value keeps the
// EXISTING tool list with ZERO behavior change, and the agent family is not
// exposed. Set only by the agent spawn's MCP entry (AgentThreadService,
// later task) — a run-scoped session spawn never sets this env var. The
// subprocess is single-scope-bound for its whole lifetime (mirrors `runId`
// being a closed-over module const), so one module-init branch is sufficient
// — no per-call gating needed.
// ---------------------------------------------------------------------------
const IS_GLOBAL_AGENT_SCOPE = process.env.CYBOFLOW_MCP_SCOPE === 'global-agent';

// ---------------------------------------------------------------------------
// Design scope (Design Mode v0 / docs/ideas/design-mode.md)
//
// CYBOFLOW_MCP_SCOPE=design restricts this subprocess to the minimal
// design-session tool family (toolRegistry/designTools.ts): get the linked idea, update
// the design-spec draft, and report the ui-prototype artifact — none of the
// run-scoped tools (board/backlog/sprint/etc.) are listed OR callable, and a
// direct CallTool for one throws 'Unknown tool' (design-mode.md: scope is
// enforced by direct-invocation rejection, not merely by ListTools omission).
// Set only by an SDK design-session spawn's MCP entry (claudeCodeManager's
// mcpScope:'design'); a run-scoped session never sets it. Single-scope-bound
// for the subprocess lifetime, so one module-init branch suffices.
// ---------------------------------------------------------------------------
const IS_DESIGN_SCOPE = process.env.CYBOFLOW_MCP_SCOPE === 'design';

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

  // The orchestrator went away (app quit / crash). This is a SECOND, coarser
  // tether than the spawner-death path below: this socket is APP-GLOBAL, so it
  // closes when the Electron main process dies, not when this server's `claude`
  // spawner does. It is kept because it is still correct — a server with no
  // orchestrator can do nothing useful — but it must never again be mistaken
  // for a per-run lifetime bound. See docs/archive/mcp-orphan-reaper-plan.md §2.
  //
  // LOAD-BEARING INVARIANT: a server whose spawner has died is provably useless
  // because MCP requests arrive ONLY via stdin — this socket carries only
  // server-initiated request/reply traffic (see sendQuery), never unsolicited
  // orchestrator-pushed messages. If anyone adds a push channel here
  // (cancellation, config reload, a question-gate answer path), that invariant
  // breaks and the shutdown policy below has to be revisited.
  socket.on('close', () => { shutdown('IPC socket closed'); });

  return socket;
}

function sendQuery(
  type: string,
  params: Record<string, unknown>,
  timeoutMs: number | null = 30_000,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!ipcClient || ipcClient.destroyed) {
      reject(new Error('[Cyboflow MCP] IPC client not connected'));
      return;
    }
    const requestId = `req-${++requestCounter}-${Date.now()}`;

    // timeoutMs null = wait forever. Safe only because this process exits when
    // its SPAWNER dies (stdin EOF / the ppid watchdog — see the shutdown block
    // near the bottom of this file), which bounds a pending entry by the run.
    //
    // It is NOT made safe by the IPC socket closing, which is what this comment
    // used to claim. CYBOFLOW_ORCH_SOCKET is app-global: it outlives every run
    // in the app's lifetime, so tethering to it is exactly what leaked 40
    // orphaned servers in a single uptime. Do not restore that reasoning.
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('orchestrator_timeout')); }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (response: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(response);
      },
      reject: (reason: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(reason);
      },
    });

    // `token` is spread LAST so a params key can never shadow it.
    const payload = JSON.stringify({
      type,
      requestId,
      runId,
      ...params,
      ...(orchToken !== undefined ? { token: orchToken } : {}),
    });
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

// ---------------------------------------------------------------------------
// Tool surface
//
// Every `cyboflow_*` tool — its name, description, argument schema, argument
// validation and socket envelope — lives in ONE entry in
// ./toolRegistry. The two handlers below DERIVE from that registry rather
// than restating it: ListTools maps the scope's entries to declarations, and
// CallTool looks one up and runs its `prepare`. There is deliberately no
// per-tool code in this file any more.
//
// The scope is fixed for the subprocess's lifetime (single-scope-bound, like
// `runId`), so it is resolved once here rather than per call.
// ---------------------------------------------------------------------------
const ACTIVE_SCOPE: McpToolScope = IS_DESIGN_SCOPE
  ? 'design'
  : IS_GLOBAL_AGENT_SCOPE
    ? 'global-agent'
    : 'run';

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: declarationsForScope(ACTIVE_SCOPE),
}));

async function executeMcpQuery(
  type: string,
  params: Record<string, unknown>,
  timeoutMs?: number | null,
): Promise<CallToolResult> {
  try {
    const queryPromise = sendQuery(type, params, timeoutMs);
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

/**
 * Uniform invalid-arguments CallToolResult. Used by the workflow/variant config
 * cases below to keep their arg-validation terse (the earlier cases inline the
 * same shape).
 */
function invalidArgs(expected: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected }) }] };
}

// ---------------------------------------------------------------------------
// Locally-served tools
//
// A registry entry with `envelope: null` is answered inside this subprocess
// instead of being forwarded. Only cyboflow_reference qualifies: its content is
// a compiled-in module, so there is nothing to fetch over the socket. The
// registry cannot hold this table itself — ASSISTANT_REFERENCE is content, not
// schema, and pulling it in would put it in every importer of the registry.
//
// The pairing is a ratchet invariant: every `envelope: null` entry must have a
// key here and vice versa (toolRegistry.ratchet.test.ts).
// ---------------------------------------------------------------------------
const LOCAL_TOOLS: Record<string, (params: Record<string, unknown>) => CallToolResult> = {
  cyboflow_reference: (params) => {
    const topic = typeof params['topic'] === 'string' ? params['topic'] : undefined;
    const validKeys = Object.keys(ASSISTANT_REFERENCE);
    if (topic === undefined || topic.length === 0) {
      // No topic → table of contents (key + title + one-liner per topic).
      const toc = validKeys.map((key) => ({
        topic: key,
        title: ASSISTANT_REFERENCE[key].title,
        oneLiner: ASSISTANT_REFERENCE[key].oneLiner,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ topics: toc }) }] };
    }
    const entry = ASSISTANT_REFERENCE[topic];
    if (!entry) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_topic', validTopics: validKeys }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ topic, title: entry.title, body: entry.body }) }] };
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Scope is enforced by LOOKUP, not by a filter: a tool the active scope does
  // not advertise is not merely unlisted, it throws here on direct invocation
  // (design-mode.md's acceptance, and the same guarantee for the global-agent
  // family).
  const tool = findTool(ACTIVE_SCOPE, request.params.name);
  if (tool === undefined) throw new Error(`Unknown tool: ${request.params.name}`);

  const prepared = tool.prepare(request.params.arguments ?? {});
  if (!prepared.ok) return invalidArgs(prepared.expected);

  if (tool.envelope === null) {
    const serve = LOCAL_TOOLS[tool.name];
    if (serve === undefined) throw new Error(`No local handler for ${tool.name}`);
    return serve(prepared.params);
  }
  return executeMcpQuery(tool.envelope, prepared.params, tool.timeoutMs);
});

// ---------------------------------------------------------------------------
// Shutdown + spawner-death detection
//
// INSTALLED AT MODULE SCOPE ON PURPOSE — never inside main(). 'end' is emitted
// exactly once; a listener attached after `await server.connect()` misses an
// already-emitted 'end' forever, which recreates the very orphan class this
// exists to prevent. Module scope is always safe because no I/O event is
// delivered before the event loop starts, so nothing can be missed here.
// See docs/archive/mcp-orphan-reaper-plan.md §5.
// ---------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Idempotent shutdown. 'close' follows 'end' on a readable stream, so this
 * double-fires by construction; `process.exit` on the first call preempts the
 * second today, but the guard is what keeps that true if any async cleanup
 * (buffer flush, socket end-wait) is ever added below.
 */
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[Cyboflow MCP] ${reason} — exiting`);
  if (ipcClient) ipcClient.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// FAST PATH: the spawner closing its end of the pipe. Fires in milliseconds
// rather than up to one watchdog interval, but is not a guarantee — the MCP
// SDK's StdioServerTransport.close() pauses stdin when it was the sole 'data'
// listener, after which EOF is never observed, and 'end' only fires at all once
// something has put stdin in flowing mode (the transport's own 'data' listener
// does this, so the pre-connect window is covered by the watchdog below, not by
// this). Attaching 'end'/'close' neither resumes nor consumes the stream, so it
// cannot perturb the transport's own reads.
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));

// GUARANTEE: poll for reparent-to-launchd. See parentWatchdog.ts for why ppid is
// the primary signal and stdin EOF the optimization, not the reverse.
startParentWatchdog({
  intervalMs: resolveWatchdogIntervalMs(),
  onOrphaned: (reason) => shutdown(reason),
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
