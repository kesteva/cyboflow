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
      {
        name: 'cyboflow_create_task',
        description:
          'Create a backlog idea/epic/task for THIS run\'s project. The task is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single write chokepoint, and appears on the board.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title (required)' },
            task_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: "Optional task type; defaults to 'idea'" },
            summary: { type: 'string', description: 'Optional longer description' },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: "Optional priority; defaults to 'P2'" },
            repo: { type: 'string', description: 'Optional repo identifier' },
            parent_epic_id: { type: 'string', description: 'Optional parent epic id' },
            board_id: { type: 'string', description: 'Optional board id; defaults to the project default board' },
            initial_stage_id: { type: 'string', description: "Optional initial stage id; defaults to the board's first idea stage" },
          },
          required: ['title'],
        },
      },
      {
        name: 'cyboflow_update_task',
        description:
          'Update editable fields of an existing task. Re-parenting via parent_epic_id is only valid for type=\'task\' (otherwise rejected with error invalid_parent); a stale expected_version is rejected with error concurrency.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task id to update (required)' },
            title: { type: 'string', description: 'Optional new title' },
            summary: { type: 'string', description: 'Optional new summary' },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'Optional new priority' },
            repo: { type: 'string', description: 'Optional new repo identifier' },
            parent_epic_id: { type: 'string', description: 'Optional parent epic id (re-parent)' },
            expected_version: { type: 'number', description: 'Optional expected version for optimistic concurrency' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cyboflow_set_task_stage',
        description:
          'Move a task to a planning/terminal stage. Execution stages are orchestrator-derived and will be rejected (error forbidden_stage); a task with active runs will be rejected (error active_runs).',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task id to move (required)' },
            stage_id: { type: 'string', description: 'The target stage id (required)' },
            expected_version: { type: 'number', description: 'Optional expected version for optimistic concurrency' },
          },
          required: ['task_id', 'stage_id'],
        },
      },
      {
        name: 'cyboflow_add_task_dependency',
        description:
          'Record a task->task dependency edge for THIS run\'s project. task_id is the BLOCKED task; depends_on_task_id is the PREREQUISITE that must finish first. Routes through the single write chokepoint. Both must be real TASKS in this project (rejected with error invalid_dependency otherwise); a self-edge is rejected (invalid_dependency); an edge that would create a cycle among blocking edges is rejected (error dependency_cycle); re-adding an existing edge is an idempotent no-op. Default kind=\'blocking\' participates in sprint ordering; kind=\'related\' is advisory metadata only.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The BLOCKED task id (required)' },
            depends_on_task_id: { type: 'string', description: 'The PREREQUISITE task id that must finish first (required)' },
            kind: { type: 'string', enum: ['blocking', 'related'], description: "Optional edge kind; defaults to 'blocking'" },
          },
          required: ['task_id', 'depends_on_task_id'],
        },
      },
      {
        name: 'cyboflow_update_sprint_task',
        description:
          "Report per-task progress for THIS sprint run's task lanes (the structured per-task progress rail). The lane is run-bound: the batch is derived from CYBOFLOW_RUN_ID's workflow_runs.batch_id (a run launched without a sprint task batch is rejected with error sprint_lane_requires_batch_run). At least one of status / current_step is required. status='integrated' means the task is complete AND committed in the session worktree. This does NOT move the task on the board (board stages are orchestrator-derived) and does NOT pause the run.",
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task id whose lane to update (required; must be in this sprint batch)' },
            status: {
              type: 'string',
              enum: ['queued', 'running', 'integrated', 'failed', 'blocked'],
              description: "Optional new lane status; 'integrated' = task complete + committed in the session worktree",
            },
            current_step: {
              type: 'string',
              enum: ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify'],
              description: 'Optional per-task lane step the executing subagent is on',
            },
            attempt: {
              type: 'number',
              description: '1-based attempt counter; report when re-delegating implement after a verify failure',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cyboflow_report_finding',
        description:
          'Report a NON-BLOCKING observation, decision, or human action item into THIS project\'s unified review queue (the human-attention inbox). The item is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single review-item chokepoint, and surfaces in the review queue. By default findings are NON-BLOCKING (the run is never paused, status is unchanged, the user is not interrupted); set blocking:true only for items that should gate run resume. This is OBSERVATIONAL — contrast with the PreToolUse approval gate.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short headline for the item (required)' },
            body: { type: 'string', description: 'Markdown detail / context for the item (required)' },
            severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Optional severity; only meaningful for findings' },
            kind: { type: 'string', enum: ['finding', 'decision', 'human_task'], description: "Optional item kind; defaults to 'finding'" },
            blocking: { type: 'boolean', description: 'Optional — whether this item gates run resume; defaults to false (non-blocking)' },
            entity_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: 'Optional soft entity link type (must be paired with entity_id)' },
            entity_id: { type: 'string', description: 'Optional soft entity link id (must be paired with entity_type)' },
            payload_json: { type: 'string', description: 'Optional per-kind payload JSON; its discriminant must equal kind' },
          },
          required: ['title', 'body'],
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

    case 'cyboflow_create_task': {
      const args = (request.params.arguments ?? {}) as {
        title?: unknown;
        task_type?: unknown;
        summary?: unknown;
        priority?: unknown;
        repo?: unknown;
        parent_epic_id?: unknown;
        board_id?: unknown;
        initial_stage_id?: unknown;
      };
      const { title, task_type, summary, priority, repo, parent_epic_id, board_id, initial_stage_id } = args;
      if (typeof title !== 'string' || title.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string' }),
            },
          ],
        };
      }
      if (task_type !== undefined && task_type !== 'idea' && task_type !== 'epic' && task_type !== 'task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "task_type: 'idea' | 'epic' | 'task' (optional)" }),
            },
          ],
        };
      }
      if (summary !== undefined && typeof summary !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'summary: string (optional)' }),
            },
          ],
        };
      }
      if (priority !== undefined && priority !== 'P0' && priority !== 'P1' && priority !== 'P2') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "priority: 'P0' | 'P1' | 'P2' (optional)" }),
            },
          ],
        };
      }
      if (repo !== undefined && typeof repo !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'repo: string (optional)' }),
            },
          ],
        };
      }
      if (parent_epic_id !== undefined && typeof parent_epic_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'parent_epic_id: string (optional)' }),
            },
          ],
        };
      }
      if (board_id !== undefined && typeof board_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'board_id: string (optional)' }),
            },
          ],
        };
      }
      if (initial_stage_id !== undefined && typeof initial_stage_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'initial_stage_id: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { title };
      if (task_type !== undefined) queryParams['taskType'] = task_type;
      if (summary !== undefined) queryParams['summary'] = summary;
      if (priority !== undefined) queryParams['priority'] = priority;
      if (repo !== undefined) queryParams['repo'] = repo;
      if (parent_epic_id !== undefined) queryParams['parentEpicId'] = parent_epic_id;
      if (board_id !== undefined) queryParams['boardId'] = board_id;
      if (initial_stage_id !== undefined) queryParams['initialStageId'] = initial_stage_id;
      return executeMcpQuery('mcp-create-task', queryParams);
    }

    case 'cyboflow_update_task': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        title?: unknown;
        summary?: unknown;
        priority?: unknown;
        repo?: unknown;
        parent_epic_id?: unknown;
        expected_version?: unknown;
      };
      const { task_id, title, summary, priority, repo, parent_epic_id, expected_version } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }),
            },
          ],
        };
      }
      if (title !== undefined && typeof title !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string (optional)' }),
            },
          ],
        };
      }
      if (summary !== undefined && typeof summary !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'summary: string (optional)' }),
            },
          ],
        };
      }
      if (priority !== undefined && priority !== 'P0' && priority !== 'P1' && priority !== 'P2') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "priority: 'P0' | 'P1' | 'P2' (optional)" }),
            },
          ],
        };
      }
      if (repo !== undefined && typeof repo !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'repo: string (optional)' }),
            },
          ],
        };
      }
      if (parent_epic_id !== undefined && typeof parent_epic_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'parent_epic_id: string (optional)' }),
            },
          ],
        };
      }
      if (expected_version !== undefined && typeof expected_version !== 'number') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'expected_version: number (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id };
      if (title !== undefined) queryParams['title'] = title;
      if (summary !== undefined) queryParams['summary'] = summary;
      if (priority !== undefined) queryParams['priority'] = priority;
      if (repo !== undefined) queryParams['repo'] = repo;
      if (parent_epic_id !== undefined) queryParams['parentEpicId'] = parent_epic_id;
      if (expected_version !== undefined) queryParams['expectedVersion'] = expected_version;
      return executeMcpQuery('mcp-update-task', queryParams);
    }

    case 'cyboflow_set_task_stage': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        stage_id?: unknown;
        expected_version?: unknown;
      };
      const { task_id, stage_id, expected_version } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }),
            },
          ],
        };
      }
      if (typeof stage_id !== 'string' || stage_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'stage_id: string' }),
            },
          ],
        };
      }
      if (expected_version !== undefined && typeof expected_version !== 'number') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'expected_version: number (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id, stageId: stage_id };
      if (expected_version !== undefined) queryParams['expectedVersion'] = expected_version;
      return executeMcpQuery('mcp-set-task-stage', queryParams);
    }

    case 'cyboflow_add_task_dependency': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        depends_on_task_id?: unknown;
        kind?: unknown;
      };
      const { task_id, depends_on_task_id, kind } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }) },
          ],
        };
      }
      if (typeof depends_on_task_id !== 'string' || depends_on_task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'depends_on_task_id: string' }),
            },
          ],
        };
      }
      if (kind !== undefined && kind !== 'blocking' && kind !== 'related') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "kind: 'blocking' | 'related' (optional)" }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id, dependsOnTaskId: depends_on_task_id };
      if (kind !== undefined) queryParams['dependencyKind'] = kind;
      return executeMcpQuery('mcp-add-task-dependency', queryParams);
    }

    case 'cyboflow_update_sprint_task': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        status?: unknown;
        current_step?: unknown;
        attempt?: unknown;
      };
      const { task_id, status, current_step, attempt } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }) },
          ],
        };
      }
      if (
        status !== undefined &&
        status !== 'queued' &&
        status !== 'running' &&
        status !== 'integrated' &&
        status !== 'failed' &&
        status !== 'blocked'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: "status: 'queued' | 'running' | 'integrated' | 'failed' | 'blocked' (optional)",
              }),
            },
          ],
        };
      }
      if (
        current_step !== undefined &&
        current_step !== 'implement' &&
        current_step !== 'write-tests' &&
        current_step !== 'code-review' &&
        current_step !== 'task-verify' &&
        current_step !== 'visual-verify'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected:
                  "current_step: 'implement' | 'write-tests' | 'code-review' | 'task-verify' | 'visual-verify' (optional)",
              }),
            },
          ],
        };
      }
      if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'attempt: integer >= 1 (optional)' }),
            },
          ],
        };
      }
      if (status === undefined && current_step === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: 'at least one of status / current_step',
              }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id };
      if (status !== undefined) queryParams['status'] = status;
      if (current_step !== undefined) queryParams['currentStepId'] = current_step;
      if (attempt !== undefined) queryParams['attempt'] = attempt;
      return executeMcpQuery('mcp-update-sprint-task', queryParams);
    }

    case 'cyboflow_report_finding': {
      const args = (request.params.arguments ?? {}) as {
        title?: unknown;
        body?: unknown;
        severity?: unknown;
        kind?: unknown;
        blocking?: unknown;
        entity_type?: unknown;
        entity_id?: unknown;
        payload_json?: unknown;
      };
      const { title, body, severity, kind, blocking, entity_type, entity_id, payload_json } = args;
      if (typeof title !== 'string' || title.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string' }) },
          ],
        };
      }
      if (typeof body !== 'string' || body.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'body: string' }) },
          ],
        };
      }
      if (severity !== undefined && severity !== 'info' && severity !== 'warning' && severity !== 'error') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "severity: 'info' | 'warning' | 'error' (optional)" }),
            },
          ],
        };
      }
      if (kind !== undefined && kind !== 'finding' && kind !== 'decision' && kind !== 'human_task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "kind: 'finding' | 'decision' | 'human_task' (optional)" }),
            },
          ],
        };
      }
      if (blocking !== undefined && typeof blocking !== 'boolean') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'blocking: boolean (optional)' }),
            },
          ],
        };
      }
      if (entity_type !== undefined && entity_type !== 'idea' && entity_type !== 'epic' && entity_type !== 'task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "entity_type: 'idea' | 'epic' | 'task' (optional)" }),
            },
          ],
        };
      }
      if (entity_id !== undefined && typeof entity_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'entity_id: string (optional)' }),
            },
          ],
        };
      }
      if (payload_json !== undefined && typeof payload_json !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'payload_json: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { title, body };
      if (severity !== undefined) queryParams['severity'] = severity;
      if (kind !== undefined) queryParams['kind'] = kind;
      if (blocking !== undefined) queryParams['blocking'] = blocking;
      if (entity_type !== undefined) queryParams['entityType'] = entity_type;
      if (entity_id !== undefined) queryParams['entityId'] = entity_id;
      if (payload_json !== undefined) queryParams['payloadJson'] = payload_json;
      return executeMcpQuery('mcp-report-finding', queryParams);
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
