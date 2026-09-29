/**
 * Unit tests for the S0.4 global-agent MCP tool family on McpQueryHandler:
 * resolveGlobalAgentContext, cyboflow_overview / _backlog / _entity / _queue /
 * _workflows / _workflow, and cyboflow_propose_action.
 *
 * Mirrors the migration-backed in-memory DB pattern used by the existing
 * 'read-only backlog listing' / 'mcp-report-finding' blocks in
 * mcpQueryHandler.test.ts (raw migration files applied in numeric order over
 * a hand-rolled `projects` table), extended with:
 *   - 007 (stuck_detected_at) + 010 (questions table) — inserted at their
 *     correct numeric slot BEFORE 011/014, since 010's table-recreation
 *     recipe would otherwise drop columns those migrations add;
 *   - 016 + 034 (review_items + its priority/staged_at/selected columns);
 *   - 071 (agent_threads / agent_thread_events / agent_proposals);
 *   - a hand-rolled `sessions` table (sessions predates the numbered
 *     migrations — it lives in database.ts's inline bootstrap SQL, not a
 *     migration file — so every fixture that needs it rolls its own, same as
 *     the reviewItems.test.ts / migration041.test.ts precedent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpQueryHandler,
  resolveGlobalAgentContext,
  type McpQueryMessage,
  type McpQueryResponse,
} from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter, taskChangeEvents } from '../../taskChangeRouter';
import { ReviewItemRouter, reviewItemChangeEvents } from '../../reviewItemRouter';
import { executeProposal, type ProposalExecutorDeps } from '../../agentThread/proposalExecutor';
import { buildProposalExecutorReviewDeps } from '../../agentThread/proposalExecutorReviewDeps';
import { AgentThreadDbStore } from '../../agentThread/agentThreadDbStore';
import { computeSpecHash } from '../../agentThread/specHash';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type {
  AgentProposal,
  CreateBacklogItemsProposalPayload,
  EditWorkflowPreconditions,
  ReprioritizeBacklogPreconditions,
} from '../../../../../shared/types/agentThread';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/agent-p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/agent-p2');

  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  const apply = (file: string): void => {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  };
  apply('006_cyboflow_schema.sql');
  apply('007_add_stuck_reason.sql');
  apply('010_questions.sql');
  apply('011_workflow_step_tracking.sql');
  apply('014_native_tasks.sql');
  apply('015_entity_model_rebuild.sql');
  apply('016_review_items.sql');
  apply('024_archive_in_place.sql');
  apply('028_idea_attachments.sql');
  apply('034_findings_triage.sql');
  apply('042_collapse_board.sql');
  apply('085_review_item_audience.sql');
  // Migration 049/053 (A/B sandbox tag): selectProjectBacklog's UNION projects
  // experiment_id/experiment_arm unconditionally — same manual ALTER the
  // existing 'read-only backlog listing' fixture applies (mcpQueryHandler.test.ts).
  db.exec('ALTER TABLE ideas ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE epics ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE tasks ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT');
  db.exec('ALTER TABLE ideas ADD COLUMN experiment_arm TEXT');
  db.exec('ALTER TABLE epics ADD COLUMN experiment_arm TEXT');
  db.exec('ALTER TABLE tasks ADD COLUMN experiment_arm TEXT');
  // cyboflow_workflow's baseline_rotation projection needs these two columns.
  apply('054_baseline_rotation.sql');
  apply('057_entity_sort_order.sql');
  apply('059_entity_category.sql');
  apply('074_agent_threads.sql');
  // 130 adds agent_threads.session_runtime, which AgentThreadDbStore SELECTs.
  apply('131_agent_thread_session_runtime.sql');
  // ...and 125, which widens agent_proposals.kind to admit 'create-backlog-items',
  // then 138, which widens it again for 'create-workflow'.
  apply('125_agent_proposal_create_backlog_kind.sql');
  apply('138_agent_proposal_create_workflow_kind.sql');
  // ...and 141, which widens it once more for 'triage-findings'.
  apply('141_agent_proposal_triage_findings_kind.sql');
  apply('142_agent_proposal_start_quick_session_kind.sql');
  // readWorkflowRow / handleAgentWorkflows now SELECT workflows.archived_at.
  apply('079_workflow_archived_at.sql');
  // ...and workflows.tuning_level, which also decides WHICH definition
  // cyboflow_workflow returns and which spec the edit-workflow CAS hashes.
  apply('124_workflow_tuning_level.sql');
  // ...and workflows.runtime_mix + workflow_runs.runtime_mix, which
  // readWorkflowRow's projection now names (migration 128).
  apply('128_workflow_runtime_mix.sql');
  // agent_overrides — cyboflow_agents lists a project's custom agents from it,
  // and the create-workflow propose path checks step bindings against it.
  apply('029_agent_overrides.sql');
  apply('036_agent_override_model.sql');
  apply('038_agent_mcp_access.sql');
  apply('070_agent_override_runtime.sql');
  apply('104_agent_override_provider_model.sql');

  // sessions predates the numbered migrations (database.ts inline bootstrap) —
  // hand-rolled with only the columns cyboflow_overview's SELECT touches.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT,
      archived BOOLEAN DEFAULT 0,
      is_quick BOOLEAN DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

function seedRunFor(
  db: Database.Database,
  runId: string,
  projectId: number,
  opts?: { status?: string; currentStepId?: string | null; workflowName?: string },
): void {
  const workflowId = `wf-${projectId}`;
  db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, ?, '{}')`).run(
    workflowId,
    projectId,
    opts?.workflowName ?? 'sprint',
  );
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    workflowId,
    projectId,
    opts?.status ?? 'running',
    opts?.currentStepId ?? 'plan',
    JSON.stringify({ plan: 'planner' }),
  );
}

function seedSession(
  db: Database.Database,
  id: string,
  projectId: number,
  opts?: { runId?: string | null; status?: string; isQuick?: boolean; archived?: boolean; updatedAt?: string },
): void {
  db.prepare(
    `INSERT INTO sessions (id, name, status, project_id, run_id, archived, is_quick, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    opts?.status ?? 'running',
    projectId,
    opts?.runId ?? null,
    opts?.archived ? 1 : 0,
    opts?.isQuick ? 1 : 0,
    opts?.updatedAt ?? new Date().toISOString(),
  );
}

function seedReviewItem(
  db: Database.Database,
  id: string,
  projectId: number,
  opts?: {
    blocking?: boolean;
    status?: string;
    title?: string;
    kind?: string;
    severity?: string | null;
    source?: string | null;
    body?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_items (id, project_id, kind, status, blocking, title, severity, source, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
  ).run(
    id,
    projectId,
    opts?.kind ?? 'finding',
    opts?.status ?? 'pending',
    opts?.blocking ? 1 : 0,
    opts?.title ?? 'A finding',
    opts?.severity ?? null,
    opts?.source ?? null,
    opts?.body ?? null,
    opts?.createdAt ?? null,
  );
}

function seedQuestionRow(db: Database.Database, id: string, runId: string, status = 'pending'): void {
  db.prepare(`INSERT INTO questions (id, run_id, tool_use_id, questions_json, status) VALUES (?, ?, ?, '[]', ?)`).run(
    id,
    runId,
    id,
    status,
  );
}

/**
 * Append one raw `agent_thread_events` row. Raw INSERT rather than
 * AgentThreadDbStore.appendEvent so a fixture can pin `created_at` — the
 * daysBack window is a SQL predicate on that column, and CURRENT_TIMESTAMP
 * cannot express "two decades ago".
 */
function seedThreadEvent(
  db: Database.Database,
  threadId: string,
  eventType: string,
  payload: unknown,
  createdAt?: string,
): number {
  const payloadJson = JSON.stringify(payload);
  const result =
    createdAt !== undefined
      ? db
          .prepare(
            `INSERT INTO agent_thread_events (thread_id, event_type, payload_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(threadId, eventType, payloadJson, createdAt)
      : db
          .prepare(
            `INSERT INTO agent_thread_events (thread_id, event_type, payload_json) VALUES (?, ?, ?)`,
          )
          .run(threadId, eventType, payloadJson);
  return Number(result.lastInsertRowid);
}

/** The human's typed turn — the synthetic single-text-block shape buildUserTextEvent writes. */
function seedUserTurn(db: Database.Database, threadId: string, text: string, createdAt?: string): number {
  return seedThreadEvent(
    db,
    threadId,
    'user',
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null },
    createdAt,
  );
}

/** An assistant reply carrying one text block. */
function seedAssistantTurn(db: Database.Database, threadId: string, text: string, createdAt?: string): number {
  return seedThreadEvent(
    db,
    threadId,
    'assistant',
    {
      type: 'assistant',
      message: { id: `msg_${text.slice(0, 8)}`, model: 'claude', role: 'assistant', content: [{ type: 'text', text }] },
    },
    createdAt,
  );
}

/** SDK tool_result plumbing — persisted as event_type 'user' but NOT a conversation turn. */
function seedToolPlumbing(db: Database.Database, threadId: string): number {
  return seedThreadEvent(db, threadId, 'user', {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'rows: 12' }] },
  });
}

function seedWorkflowRow(
  db: Database.Database,
  id: string,
  projectId: number,
  name: string,
  definition: WorkflowDefinition,
): void {
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, ?, ?)`).run(
    id,
    projectId,
    name,
    JSON.stringify(definition),
  );
}

/** The shape mcp-history replies with (camelCase, mirroring mcp-queue's data). */
interface HistoryData {
  turns: Array<{ eventId: number; at: string; role: string; text: string; matched?: boolean }>;
  truncated: boolean;
  nextBeforeId: number | null;
  scanned: number;
}

const CUSTOM_DEFINITION: WorkflowDefinition = {
  id: 'my-flow',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#3b82f6',
      steps: [{ id: 'step-1', name: 'Step 1', agent: 'implement', mcps: [], retries: 0 }],
    },
  ],
};

/** A strict-schema-valid flow binding a builtin, the human gate, and a NEW agent. */
const DOCS_FLOW: WorkflowDefinition = {
  id: 'docs-review',
  phases: [
    {
      id: 'review',
      label: 'Review',
      color: '#3b6dd6',
      steps: [
        { id: 'survey', name: 'Survey', agent: 'implement', mcps: [], retries: 0 },
        { id: 'write', name: 'Write', agent: 'docs-writer', mcps: [], retries: 0 },
        { id: 'approve', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
      ],
    },
  ],
};

const DOCS_WRITER = {
  name: 'Docs Writer',
  description: 'Writes the docs for a change.',
  systemPrompt: 'You write documentation. Return a summary.',
  tools: ['Read', 'Edit'],
};

/** Seed one custom agent row the way AgentOverrideRouter.createCustom would. */
function seedCustomAgent(db: Database.Database, projectId: number, agentKey: string): void {
  db.prepare(
    `INSERT INTO agent_overrides
       (id, project_id, agent_key, base_agent_key, name, role, description, system_prompt, tools_json, enabled_mcps_json, is_custom, version)
     VALUES (?, ?, ?, NULL, ?, NULL, 'A custom agent', 'Do the thing.', '["Read"]', '[]', 1, 1)`,
  ).run(`ago_${agentKey}`, projectId, agentKey, `cyboflow-${agentKey}`);
}

/** Create an entity via the real mcp-create-task handler; returns its id + ref. */
async function createEntity(
  handler: McpQueryHandler,
  runId: string,
  title: string,
  taskType?: 'idea' | 'epic' | 'task',
): Promise<{ id: string; ref: string }> {
  const { socket, writes } = makeSocketDouble();
  await handler.handleMessage(
    {
      type: 'mcp-create-task',
      requestId: `ce-${title}`,
      runId,
      title,
      ...(taskType !== undefined ? { taskType } : {}),
    },
    socket,
  );
  const data = parseLastWrite(writes).data as { task_id: string; ref: string };
  return { id: data.task_id, ref: data.ref };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveGlobalAgentContext', () => {
  it('accepts the agent:<threadId> sentinel form', () => {
    const result = resolveGlobalAgentContext('agent:550e8400-e29b-41d4-a716-446655440000');
    expect(result).toEqual({ ok: true, threadId: '550e8400-e29b-41d4-a716-446655440000' });
  });

  it('rejects a bare workflow_runs-shaped run id', () => {
    expect(resolveGlobalAgentContext('run-abc123')).toEqual({ ok: false, error: 'not_a_global_agent_run' });
  });

  it("rejects the 'orchestrator' health-check sentinel", () => {
    expect(resolveGlobalAgentContext('orchestrator')).toEqual({ ok: false, error: 'not_a_global_agent_run' });
  });

  it("rejects 'agent:' with an empty thread id", () => {
    expect(resolveGlobalAgentContext('agent:')).toEqual({ ok: false, error: 'not_a_global_agent_run' });
  });
});

describe('McpQueryHandler global-agent tool family', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;
  let store: AgentThreadDbStore;

  beforeEach(() => {
    db = buildDb();
    TaskChangeRouter.initialize(dbAdapter(db));
    store = new AgentThreadDbStore(dbAdapter(db));
    store.createThread({ id: 'thread-1' });
    handler = new McpQueryHandler(dbAdapter(db), undefined, { agentThreadStore: store });
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // Run-scoped resolvers keep rejecting the agent: sentinel (no code change
  // needed there — this is the OTHER direction of the two-way contract).
  // -------------------------------------------------------------------------

  describe('run-scoped resolvers reject the agent:<threadId> sentinel', () => {
    it('resolveTaskRunContext (via mcp-list-tasks) treats it as an unknown run', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-list-tasks', requestId: 'r1', runId: 'agent:thread-1' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('run_not_found');
    });

    it('resolveReviewItemRunContext (via mcp-report-finding) treats it as an unknown run', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'r1', runId: 'agent:thread-1', title: 'x', body: 'y' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('run_not_found');
    });
  });

  // -------------------------------------------------------------------------
  // Every global-agent handler rejects a non-agent runId the same way — spot
  // checked once per tool via mcp-overview + mcp-propose-action (representative
  // of the read family and the write tool); the others share the identical
  // resolveGlobalAgentContext guard as their FIRST statement.
  // -------------------------------------------------------------------------

  describe('scope guard: a non-agent runId is rejected before any DB read', () => {
    it('mcp-overview rejects a bare run id', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-overview', requestId: 'r1', runId: 'run-abc' }, socket);
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });

    it('mcp-propose-action rejects a bare run id', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r1', runId: 'run-abc', payloadJson: '{}' },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_overview
  // -------------------------------------------------------------------------

  describe('mcp-overview', () => {
    it('digests sessions + runs + blocked-gate/question counts per project', async () => {
      seedRunFor(db, 'run-1', 1, { currentStepId: 'implement' });
      seedSession(db, 'sess-1', 1, { runId: 'run-1', status: 'running' });
      seedSession(db, 'sess-2', 2, { runId: null, status: 'pending', isQuick: true });
      seedReviewItem(db, 'ri-1', 1, { blocking: true, status: 'pending' });
      seedReviewItem(db, 'ri-2', 1, { blocking: false, status: 'pending' }); // non-blocking, excluded from the count
      seedQuestionRow(db, 'q-1', 'run-1', 'pending');

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-overview', requestId: 'r1', runId: 'agent:thread-1' }, socket);
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as {
        projects: Array<{
          project_id: number;
          project_name: string;
          sessions: Array<Record<string, unknown>>;
          blocked_gates_count: number;
          pending_questions_count: number;
        }>;
      };
      expect(data.projects).toHaveLength(2);

      const p1 = data.projects.find((p) => p.project_id === 1)!;
      expect(p1.project_name).toBe('Proj One');
      expect(p1.blocked_gates_count).toBe(1);
      expect(p1.pending_questions_count).toBe(1);
      expect(p1.sessions).toHaveLength(1);
      expect(p1.sessions[0]).toMatchObject({
        session_id: 'sess-1',
        status: 'running',
        is_quick: false,
        run: { run_id: 'run-1', workflow_name: 'sprint', status: 'running', current_step_id: 'implement' },
      });

      const p2 = data.projects.find((p) => p.project_id === 2)!;
      expect(p2.blocked_gates_count).toBe(0);
      expect(p2.pending_questions_count).toBe(0);
      expect(p2.sessions).toHaveLength(1);
      expect(p2.sessions[0]).toMatchObject({ session_id: 'sess-2', is_quick: true, run: null });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_backlog
  // -------------------------------------------------------------------------

  describe('mcp-backlog', () => {
    it('merges every project by default and narrows to one project via projectId', async () => {
      seedRunFor(db, 'run-p1', 1);
      seedRunFor(db, 'run-p2', 2);
      await createEntity(handler, 'run-p1', 'Task in project 1', 'task');
      await createEntity(handler, 'run-p2', 'Task in project 2', 'task');

      const all = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-backlog', requestId: 'r1', runId: 'agent:thread-1' }, all.socket);
      const allRes = parseLastWrite(all.writes);
      expect(allRes.ok).toBe(true);
      const allData = allRes.data as { tasks: Array<{ project_id: number }>; total: number };
      expect(allData.total).toBe(2);
      expect(allData.tasks.map((t) => t.project_id).sort()).toEqual([1, 2]);

      const scoped = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-backlog', requestId: 'r2', runId: 'agent:thread-1', projectId: 1 },
        scoped.socket,
      );
      const scopedData = parseLastWrite(scoped.writes).data as { tasks: Array<{ project_id: number }>; total: number };
      expect(scopedData.total).toBe(1);
      expect(scopedData.tasks[0].project_id).toBe(1);
    });

    it('rejects a non-agent runId', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-backlog', requestId: 'r1', runId: 'run-abc' }, socket);
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_entity
  // -------------------------------------------------------------------------

  describe('mcp-entity', () => {
    it('resolves by opaque id, and by ref with an explicit projectId disambiguator', async () => {
      seedRunFor(db, 'run-p1', 1);
      const idea = await createEntity(handler, 'run-p1', 'An idea');

      const byId = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-entity', requestId: 'r1', runId: 'agent:thread-1', taskId: idea.id },
        byId.socket,
      );
      const byIdData = parseLastWrite(byId.writes).data as { task: Record<string, unknown> };
      expect(byIdData.task['id']).toBe(idea.id);
      expect(byIdData.task['project_id']).toBe(1);
      expect(byIdData.task).toHaveProperty('attachments'); // ideas carry the attachments key

      const byRef = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-entity', requestId: 'r2', runId: 'agent:thread-1', taskId: idea.ref, projectId: 1 },
        byRef.socket,
      );
      const byRefData = parseLastWrite(byRef.writes).data as { task: Record<string, unknown> };
      expect(byRefData.task['id']).toBe(idea.id);
    });

    it('resolves a ref cross-project when projectId is omitted', async () => {
      seedRunFor(db, 'run-p2', 2);
      const idea = await createEntity(handler, 'run-p2', 'Cross-project idea');

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-entity', requestId: 'r1', runId: 'agent:thread-1', taskId: idea.ref },
        socket,
      );
      const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
      expect(data.task['id']).toBe(idea.id);
    });

    it('returns not_found for an unknown ref', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-entity', requestId: 'r1', runId: 'agent:thread-1', taskId: 'TASK-999' },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_queue
  // -------------------------------------------------------------------------

  describe('mcp-queue', () => {
    type QueueData = {
      items: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      truncated: boolean;
      nextOffset?: number;
    };
    async function queue(args: Partial<Extract<McpQueryMessage, { type: 'mcp-queue' }>>): Promise<McpQueryResponse> {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-queue', requestId: 'r', runId: 'agent:thread-1', ...args } as McpQueryMessage,
        socket,
      );
      return parseLastWrite(writes);
    }

    it('defaults to pending items only; include_resolved surfaces resolved ones too', async () => {
      seedReviewItem(db, 'ri-pending', 1, { status: 'pending', title: 'Pending finding' });
      seedReviewItem(db, 'ri-resolved', 1, { status: 'resolved', title: 'Resolved finding' });

      const pendingData = (await queue({})).data as QueueData;
      expect(pendingData.total).toBe(1);
      expect(pendingData.items[0].id).toBe('ri-pending');

      const bothData = (await queue({ includeResolved: true })).data as QueueData;
      expect(bothData.total).toBe(2);
    });

    it('rejects a non-agent runId', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-queue', requestId: 'r1', runId: 'run-abc' }, socket);
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });

    it('returns COMPACT rows by default (no body / payload) and the full shape with includeBody', async () => {
      seedReviewItem(db, 'ri-1', 1, { title: 'Compact me', severity: 'error', source: 'agent:eval', body: 'a very long body' });

      const compact = (await queue({})).data as QueueData;
      expect(compact.items).toHaveLength(1);
      expect(compact.items[0]).toEqual({
        id: 'ri-1',
        project_id: 1,
        run_id: null,
        kind: 'finding',
        status: 'pending',
        blocking: false,
        severity: 'error',
        source: 'agent:eval',
        title: 'Compact me',
        entity_type: null,
        entity_id: null,
        staged_at: null,
        selected: false,
        created_at: expect.any(String),
      });
      expect(compact.items[0]).not.toHaveProperty('body');
      expect(compact.items[0]).not.toHaveProperty('payload');

      const full = (await queue({ includeBody: true })).data as QueueData;
      expect(full.items[0]).toMatchObject({ id: 'ri-1', body: 'a very long body', payload: null });
    });

    it('pages with limit/offset, reporting total, truncated and nextOffset', async () => {
      for (let i = 0; i < 7; i++) {
        seedReviewItem(db, `ri-${i}`, 1, { title: `F${i}`, createdAt: `2026-09-0${i + 1}T00:00:00.000Z` });
      }
      const page1 = (await queue({ limit: 3 })).data as QueueData;
      expect(page1).toMatchObject({ total: 7, limit: 3, offset: 0, truncated: true, nextOffset: 3 });
      expect(page1.items.map((i) => i.id)).toEqual(['ri-0', 'ri-1', 'ri-2']);

      const page2 = (await queue({ limit: 3, offset: page1.nextOffset })).data as QueueData;
      expect(page2).toMatchObject({ total: 7, offset: 3, truncated: true, nextOffset: 6 });
      expect(page2.items.map((i) => i.id)).toEqual(['ri-3', 'ri-4', 'ri-5']);

      const page3 = (await queue({ limit: 3, offset: page2.nextOffset })).data as QueueData;
      expect(page3).toMatchObject({ total: 7, offset: 6, truncated: false });
      expect(page3).not.toHaveProperty('nextOffset');
      expect(page3.items.map((i) => i.id)).toEqual(['ri-6']);
    });

    it('clamps limit to the 250 ceiling and defaults it to 100', async () => {
      seedReviewItem(db, 'ri-1', 1);
      expect(((await queue({ limit: 9999 })).data as QueueData).limit).toBe(250);
      expect(((await queue({})).data as QueueData).limit).toBe(100);
      expect(((await queue({ limit: 0 })).data as QueueData).limit).toBe(1);
    });

    it('filters by kind, severity list, source prefix and a created_at window', async () => {
      seedReviewItem(db, 'ri-err', 1, { severity: 'error', source: 'agent:eval', createdAt: '2026-08-11T00:00:00.000Z' });
      seedReviewItem(db, 'ri-warn', 1, { severity: 'warning', source: 'visual-verify:1', createdAt: '2026-09-01T00:00:00.000Z' });
      seedReviewItem(db, 'ri-info', 1, { severity: 'info', source: 'build-break-group:x', createdAt: '2026-09-15T00:00:00.000Z' });
      seedReviewItem(db, 'ri-decision', 1, { kind: 'decision', source: 'gate:approve-idea', createdAt: '2026-09-16T00:00:00.000Z' });

      const ids = async (args: Parameters<typeof queue>[0]): Promise<string[]> =>
        ((await queue(args)).data as QueueData).items.map((i) => String(i.id));

      expect(await ids({ kind: 'decision' })).toEqual(['ri-decision']);
      expect(await ids({ severity: ['error'] })).toEqual(['ri-err']);
      expect(await ids({ severity: ['error', 'warning'] })).toEqual(['ri-err', 'ri-warn']);
      expect(await ids({ sourcePrefix: 'agent:eval' })).toEqual(['ri-err']);
      expect(await ids({ sourcePrefix: 'visual-verify' })).toEqual(['ri-warn']);
      expect(await ids({ createdAfter: '2026-09-01T00:00:00.000Z' })).toEqual(['ri-warn', 'ri-info', 'ri-decision']);
      expect(await ids({ createdBefore: '2026-09-01T00:00:00.000Z' })).toEqual(['ri-err']);
      expect(await ids({ createdAfter: '2026-09-01T00:00:00.000Z', createdBefore: '2026-09-16T00:00:00.000Z' })).toEqual([
        'ri-warn',
        'ri-info',
      ]);
      // A LIKE wildcard in the prefix is matched literally, not as a wildcard.
      expect(await ids({ sourcePrefix: 'agent:%' })).toEqual([]);
      // `total` reflects the filtered set, not the whole inbox.
      expect(((await queue({ severity: ['error'] })).data as QueueData).total).toBe(1);
    });

    it('rejects an unknown kind or severity up front', async () => {
      expect(await queue({ kind: 'bogus' })).toMatchObject({ ok: false, error: 'invalid_kind' });
      expect(await queue({ severity: ['fatal'] })).toMatchObject({ ok: false, error: 'invalid_severity' });
      expect(await queue({ severity: [] })).toMatchObject({ ok: false, error: 'invalid_severity' });
    });

    it('summary_only returns tallies only, over the same filters', async () => {
      seedReviewItem(db, 'ri-1', 1, { severity: 'error', source: 'agent:eval' });
      seedReviewItem(db, 'ri-2', 1, { severity: 'error', source: 'agent:eval' });
      seedReviewItem(db, 'ri-3', 1, { severity: 'info', source: 'visual-verify:1' });
      seedReviewItem(db, 'ri-4', 2, { severity: 'warning', source: 'agent:eval' });
      seedReviewItem(db, 'ri-5', 1, { status: 'resolved', severity: 'error', source: 'agent:eval' });

      const res = await queue({ projectId: 1, summaryOnly: true });
      expect(res.ok).toBe(true);
      const data = res.data as { total: number; summary: Array<Record<string, unknown>> };
      expect(data).not.toHaveProperty('items');
      expect(data.total).toBe(3);
      expect(data.summary).toEqual([
        { kind: 'finding', status: 'pending', severity: 'error', source: 'agent:eval', count: 2 },
        { kind: 'finding', status: 'pending', severity: 'info', source: 'visual-verify:1', count: 1 },
      ]);

      const withResolved = (await queue({ projectId: 1, summaryOnly: true, includeResolved: true })).data as {
        total: number;
        summary: Array<{ status: string; count: number }>;
      };
      expect(withResolved.total).toBe(4);
      expect(withResolved.summary.find((r) => r.status === 'resolved')).toMatchObject({ count: 1 });
    });

    it('keeps a 456-row inbox in ONE call under the ~100KB cap (the Margin Letter shape)', async () => {
      for (let i = 0; i < 456; i++) {
        seedReviewItem(db, `rvw_${String(i).padStart(4, '0')}`, 1, {
          title: `Finding number ${i} with a reasonably long title about something in the code`,
          severity: i % 11 === 0 ? 'error' : i % 3 === 0 ? 'warning' : 'info',
          source: i % 2 === 0 ? 'build-break-group:abc' : 'agent:eval',
          body: 'x'.repeat(700),
        });
      }
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-queue', requestId: 'r', runId: 'agent:thread-1', projectId: 1 }, socket);
      const res = parseLastWrite(writes);
      const data = res.data as QueueData;
      expect(data.total).toBe(456);
      expect(data.items).toHaveLength(100);
      expect(data.truncated).toBe(true);
      expect(writes[writes.length - 1].length).toBeLessThan(100_000);

      // The largest page the clamp allows also stays under the cap.
      const maxPage = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-queue', requestId: 'r', runId: 'agent:thread-1', projectId: 1, limit: 999 },
        maxPage.socket,
      );
      expect((parseLastWrite(maxPage.writes).data as QueueData).items).toHaveLength(250);
      expect(maxPage.writes[maxPage.writes.length - 1].length).toBeLessThan(100_000);
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_agents
  // -------------------------------------------------------------------------

  describe('mcp-agents', () => {
    it('lists every builtin key plus the project\'s custom agents, with the gate + tool vocabulary', async () => {
      seedCustomAgent(db, 1, 'docs-writer');
      seedCustomAgent(db, 2, 'other-project-agent');

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-agents', requestId: 'r1', runId: 'agent:thread-1', projectId: 1 }, socket);
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as {
        agents: Array<{ agent_key: string; source: string; tools: string[] }>;
        human_gate_agent: string;
        tool_vocabulary: string[];
      };
      const byKey = new Map(data.agents.map((a) => [a.agent_key, a]));
      expect(byKey.get('implement')).toMatchObject({ source: 'builtin' });
      expect(byKey.get('docs-writer')).toMatchObject({ source: 'custom', tools: ['Read'] });
      // Custom agents are project-scoped — another project's never leaks in.
      expect(byKey.has('other-project-agent')).toBe(false);
      expect(data.human_gate_agent).toBe('human');
      expect(data.tool_vocabulary).toContain('Bash');
    });

    it('rejects an unknown project and a run-scoped runId', async () => {
      const unknown = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-agents', requestId: 'r1', runId: 'agent:thread-1', projectId: 4242 }, unknown.socket);
      expect(parseLastWrite(unknown.writes)).toMatchObject({ ok: false, error: 'project_not_found' });

      const runScoped = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-agents', requestId: 'r2', runId: 'run-1', projectId: 1 }, runScoped.socket);
      expect(parseLastWrite(runScoped.writes).ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_workflows / cyboflow_workflow
  // -------------------------------------------------------------------------

  describe('mcp-workflows', () => {
    it('lists every project by default and narrows via projectId', async () => {
      seedWorkflowRow(db, 'wf-p1', 1, 'flow-one', CUSTOM_DEFINITION);
      seedWorkflowRow(db, 'wf-p2', 2, 'flow-two', CUSTOM_DEFINITION);

      const all = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-workflows', requestId: 'r1', runId: 'agent:thread-1' }, all.socket);
      const allData = parseLastWrite(all.writes).data as { workflows: Array<{ id: string }> };
      expect(allData.workflows.map((w) => w.id).sort()).toEqual(['wf-p1', 'wf-p2']);

      const scoped = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-workflows', requestId: 'r2', runId: 'agent:thread-1', projectId: 1 },
        scoped.socket,
      );
      const scopedData = parseLastWrite(scoped.writes).data as { workflows: Array<{ id: string }> };
      expect(scopedData.workflows.map((w) => w.id)).toEqual(['wf-p1']);
    });

    it('rejects a non-agent runId', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-workflows', requestId: 'r1', runId: 'run-abc' }, socket);
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });

    it('the underlying SELECT tolerates an archived row (migration 078 archived_at column) without throwing, and the list hides it by default', async () => {
      // readWorkflowRow / handleAgentWorkflows's SQL now projects
      // workflows.archived_at (migration 078) — this asserts the SELECT
      // still succeeds once a row actually carries a non-NULL stamp (a schema
      // drift / typo'd column name would throw a SQLITE_ERROR here), and that
      // handleAgentWorkflows now hides archived rows by default, mirroring
      // tRPC workflows.list's default-HIDE policy.
      seedWorkflowRow(db, 'wf-p1', 1, 'flow-one', CUSTOM_DEFINITION);
      seedWorkflowRow(db, 'wf-p2', 1, 'flow-two', CUSTOM_DEFINITION);
      db.prepare("UPDATE workflows SET archived_at = datetime('now') WHERE id = 'wf-p1'").run();

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-workflows', requestId: 'r1', runId: 'agent:thread-1' }, socket);
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { workflows: Array<{ id: string }> };
      expect(data.workflows.map((w) => w.id)).not.toContain('wf-p1');
      expect(data.workflows.map((w) => w.id)).toContain('wf-p2');
    });

    it('projects archived_at into the compact workflow wire shape', async () => {
      seedWorkflowRow(db, 'wf-p1', 1, 'flow-one', CUSTOM_DEFINITION);

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-workflow', requestId: 'r1', runId: 'agent:thread-1', workflowId: 'wf-p1' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { workflow: { id: string; archived_at: string | null } };
      expect(data.workflow.archived_at).toBeNull();
    });
  });

  describe('mcp-workflow', () => {
    it('returns the effective definition plus a server-computed spec_hash', async () => {
      seedWorkflowRow(db, 'wf-p1', 1, 'flow-one', CUSTOM_DEFINITION);

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-workflow', requestId: 'r1', runId: 'agent:thread-1', workflowId: 'wf-p1' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { workflow: { id: string }; definition: WorkflowDefinition; spec_hash: string };
      expect(data.workflow.id).toBe('wf-p1');
      expect(data.definition).toEqual(CUSTOM_DEFINITION);
      expect(data.spec_hash).toBe(computeSpecHash(CUSTOM_DEFINITION));
    });

    it('returns not_found for an unknown workflow id', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-workflow', requestId: 'r1', runId: 'agent:thread-1', workflowId: 'nope' },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_found' });
    });

    it('still resolves an archived workflow by id (readWorkflowRow SELECTs archived_at; no archived guard on this read path)', async () => {
      seedWorkflowRow(db, 'wf-p1', 1, 'flow-one', CUSTOM_DEFINITION);
      db.prepare("UPDATE workflows SET archived_at = datetime('now') WHERE id = 'wf-p1'").run();

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-workflow', requestId: 'r1', runId: 'agent:thread-1', workflowId: 'wf-p1' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { workflow: { id: string }; definition: WorkflowDefinition };
      expect(data.workflow.id).toBe('wf-p1');
      expect(data.definition).toEqual(CUSTOM_DEFINITION);
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_propose_action
  // -------------------------------------------------------------------------

  describe('mcp-propose-action', () => {
    it('launch-run: inserts a proposal row with null preconditions + a proposal-created event', async () => {
      const payload = { kind: 'launch-run', projectId: 1, workflowName: 'sprint', taskIds: ['tsk_1'] };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      expect(typeof proposalId).toBe('string');

      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.kind).toBe('launch-run');
      expect(proposal.preconditions).toBeNull();
      expect(proposal.status).toBe('proposed');

      const events = store.listEvents('thread-1');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('proposal-created');
      expect(JSON.parse(events[0].payloadJson)).toEqual({ proposalId, kind: 'launch-run' });
    });

    it('launch-run: resolves a CUSTOM flow by name or id, stamping id/name/scope; rejects an unknown one by name (TASK-294)', async () => {
      // A custom sprint clone (definition.id stays 'sprint') + another custom flow, both
      // project-scoped (this fixture's workflows table predates nullable project_id;
      // the global-scope stamp is pinned in prepareProposal.test.ts).
      seedWorkflowRow(db, 'wf-global-custom-e253eb7b', 1, 'dash', { ...CUSTOM_DEFINITION, id: 'sprint' });
      seedWorkflowRow(db, 'wf-p1-docs', 1, 'docs-review', CUSTOM_DEFINITION);

      const propose = async (payload: Record<string, unknown>): Promise<McpQueryResponse> => {
        const { socket, writes } = makeSocketDouble();
        await handler.handleMessage(
          { type: 'mcp-propose-action', requestId: 'r', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
          socket,
        );
        return parseLastWrite(writes);
      };

      const byName = await propose({ kind: 'launch-run', projectId: 1, workflowName: 'dash', taskIds: ['tsk_1'] });
      expect(byName.ok).toBe(true);
      expect(store.getProposal((byName.data as { proposalId: string }).proposalId)?.payload).toEqual({
        kind: 'launch-run',
        projectId: 1,
        workflowName: 'dash',
        workflowId: 'wf-global-custom-e253eb7b',
        workflowScope: 'project',
        taskIds: ['tsk_1'],
      });

      const byId = await propose({ kind: 'launch-run', projectId: 1, workflowId: 'wf-p1-docs' });
      expect(byId.ok).toBe(true);
      expect(store.getProposal((byId.data as { proposalId: string }).proposalId)?.payload).toMatchObject({
        workflowName: 'docs-review',
        workflowId: 'wf-p1-docs',
        workflowScope: 'project',
      });

      expect(await propose({ kind: 'launch-run', projectId: 1, workflowName: 'nope' })).toMatchObject({
        ok: false,
        error: 'unknown_workflow:nope',
      });
      // Another project's scoped flow is invisible here.
      expect(await propose({ kind: 'launch-run', projectId: 2, workflowId: 'wf-p1-docs' })).toMatchObject({
        ok: false,
        error: 'unknown_workflow:wf-p1-docs',
      });
    });

    it('triage-findings: propose validates each id; Confirm dismisses 3 + stages 2 through ReviewItemRouter, and cyboflow_queue reflects it (TASK-292)', async () => {
      for (const id of ['rvw_1', 'rvw_2', 'rvw_3', 'rvw_4', 'rvw_5']) seedReviewItem(db, id, 1, { title: `Finding ${id}` });
      seedReviewItem(db, 'rvw_other', 2, { title: 'Other project' });
      seedReviewItem(db, 'rvw_done', 1, { status: 'resolved' });
      seedReviewItem(db, 'rvw_gate', 1, { kind: 'decision' });

      const propose = async (payload: Record<string, unknown>): Promise<McpQueryResponse> => {
        const { socket, writes } = makeSocketDouble();
        await handler.handleMessage(
          { type: 'mcp-propose-action', requestId: 'r', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
          socket,
        );
        return parseLastWrite(writes);
      };
      const triage = (items: unknown[]) => propose({ kind: 'triage-findings', projectId: 1, items });

      // Propose-time rejections, each named.
      expect(await triage([{ reviewItemId: 'rvw_other', op: 'dismiss' }])).toMatchObject({ ok: false, error: 'review_item_not_found:rvw_other' });
      expect(await triage([{ reviewItemId: 'rvw_done', op: 'dismiss' }])).toMatchObject({ ok: false, error: 'review_item_not_pending:rvw_done' });
      expect(await triage([{ reviewItemId: 'rvw_gate', op: 'resolve' }])).toMatchObject({ ok: false, error: 'review_item_not_finding:rvw_gate' });
      expect(await triage([{ reviewItemId: 'rvw_1', op: 'set-selected', selected: false }])).toMatchObject({
        ok: false,
        error: 'review_item_not_staged:rvw_1',
      });

      const res = await triage([
        { reviewItemId: 'rvw_1', op: 'dismiss', resolution: 'noise' },
        { reviewItemId: 'rvw_2', op: 'dismiss' },
        { reviewItemId: 'rvw_3', op: 'dismiss' },
        { reviewItemId: 'rvw_4', op: 'set-selected', selected: true },
        { reviewItemId: 'rvw_5', op: 'approve' },
      ]);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.kind).toBe('triage-findings');
      expect(proposal.preconditions).toBeNull();
      // Titles were stamped from the rows.
      expect(proposal.payload.kind === 'triage-findings' && proposal.payload.items[0].title).toBe('Finding rvw_1');

      // Someone resolves rvw_3 from the queue between propose and confirm.
      const router = ReviewItemRouter.initialize(dbAdapter(db));
      await router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId: 'rvw_3' });

      // Confirm: the real executor over the real chokepoint (the other deps are unused here).
      const unused = (): never => {
        throw new Error('unexpected dep call');
      };
      const deps: ProposalExecutorDeps = {
        store,
        newIdempotencyKey: () => 'key-1',
        createQuickSession: unused,
        startQuickSession: unused,
        deliverQuickSessionBrief: unused,
        launchRun: unused,
        cancelRun: unused,
        dismissSession: unused,
        runExists: unused,
        applyTaskChange: unused,
        readTaskFields: unused,
        createBacklogItem: unused,
        runInTransaction: <T>(fn: () => T): T => fn(),
        readEffectiveWorkflowSpec: unused,
        applyWorkflowSpec: unused,
        createCustomAgent: unused,
        deleteCustomAgent: unused,
        createWorkflow: unused,
        findWorkflowIdByName: unused,
        customAgentExists: unused,
        ...buildProposalExecutorReviewDeps({ reviewItemRouter: router, db: dbAdapter(db) }),
      };
      const outcome = await executeProposal(deps, proposalId);
      expect(outcome.ok && outcome.status).toBe('executed');
      expect(outcome.ok && outcome.result).toMatchObject({ kind: 'triage-findings', applied: 4, skipped: 1 });
      expect(outcome.ok && outcome.result.kind === 'triage-findings' && outcome.result.items[2]).toEqual({
        reviewItemId: 'rvw_3',
        op: 'dismiss',
        ok: false,
        skipped: 'already resolved',
      });

      // One entity_events delta per chokepoint write (rvw_4 = approve + select).
      const deltas = db
        .prepare(`SELECT entity_id AS id, COUNT(*) AS n FROM entity_events WHERE entity_type = 'review_item' GROUP BY entity_id`)
        .all() as Array<{ id: string; n: number }>;
      expect(Object.fromEntries(deltas.map((d) => [d.id, d.n]))).toMatchObject({ rvw_1: 1, rvw_2: 1, rvw_4: 2, rvw_5: 1 });
      expect(db.prepare('SELECT resolution, resolved_by FROM review_items WHERE id = ?').get('rvw_1')).toEqual({ resolution: 'noise', resolved_by: 'user' });

      // cyboflow_queue reflects it: the dismissed ones are gone from the pending inbox,
      // the staged ones are READY (staged_at set) — and rvw_4 is already ticked as a seed.
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-queue', requestId: 'q', runId: 'agent:thread-1', projectId: 1, kind: 'finding' }, socket);
      const queue = parseLastWrite(writes).data as { items: Array<Record<string, unknown>>; total: number };
      expect(queue.total).toBe(2);
      expect(queue.items.map((i) => [i.id, i.staged_at !== null, i.selected])).toEqual([
        ['rvw_4', true, true],
        ['rvw_5', true, false],
      ]);
      // ...and the staged-but-unselected one is selectable as a Compound seed.
      await router.applyReviewItem(1, { op: 'set-selected', actor: 'user', reviewItemIds: ['rvw_5'], selected: true });
      expect(db.prepare('SELECT selected FROM review_items WHERE id = ?').get('rvw_5')).toEqual({ selected: 1 });

      ReviewItemRouter._resetForTesting();
      reviewItemChangeEvents.removeAllListeners();
    });

    it('start-quick-session: propose stores the card with a slugged name and rejects bad input by name (TASK-295)', async () => {
      const propose = async (payload: Record<string, unknown>): Promise<McpQueryResponse> => {
        const { socket, writes } = makeSocketDouble();
        await handler.handleMessage(
          { type: 'mcp-propose-action', requestId: 'r', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
          socket,
        );
        return parseLastWrite(writes);
      };

      expect(await propose({ kind: 'start-quick-session', projectId: 1, brief: '' })).toMatchObject({ ok: false, error: 'invalid_payload' });
      expect(await propose({ kind: 'start-quick-session', projectId: 99, brief: 'x' })).toMatchObject({ ok: false, error: 'project_not_found' });
      expect(await propose({ kind: 'start-quick-session', projectId: 1, brief: 'x'.repeat(8193) })).toMatchObject({ ok: false, error: 'brief_too_long' });
      expect(await propose({ kind: 'start-quick-session', projectId: 1, brief: 'x', name: '!!!' })).toMatchObject({ ok: false, error: 'invalid_name' });

      const res = await propose({
        kind: 'start-quick-session',
        projectId: 1,
        brief: 'Look at findings rvw_1 and rvw_2 in main/src/foo.ts and propose fixes.',
        name: 'Findings Sweep',
        substrate: 'interactive',
        inPlace: true,
      });
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.kind).toBe('start-quick-session');
      expect(proposal.preconditions).toBeNull();
      expect(proposal.payload).toEqual({
        kind: 'start-quick-session',
        projectId: 1,
        brief: 'Look at findings rvw_1 and rvw_2 in main/src/foo.ts and propose fixes.',
        name: 'findings-sweep',
        substrate: 'interactive',
        inPlace: true,
      });
    });

    it('open-session: accepts a discriminated navigation payload with null preconditions', async () => {
      seedRunFor(db, 'run-xyz', 1);
      const payload = { kind: 'open-session', navigation: { target: 'run', runId: 'run-xyz' } };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const { proposalId } = parseLastWrite(writes).data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      // The stored navigation is ENRICHED with the run's server-resolved
      // projectId — see the dedicated enrichment tests below for the full
      // contract (both arms + the caller-supplied-bogus-projectId overwrite).
      expect(proposal.payload).toEqual({
        kind: 'open-session',
        navigation: { target: 'run', runId: 'run-xyz', projectId: 1 },
      });
      expect(proposal.preconditions).toBeNull();
    });

    it("open-session: enriches a 'run' target with the run's server-resolved projectId, overwriting any caller-supplied projectId", async () => {
      seedRunFor(db, 'run-enrich', 2);
      const payload = {
        kind: 'open-session',
        navigation: { target: 'run', runId: 'run-enrich', projectId: 999 }, // bogus — must be overwritten
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.payload).toEqual({
        kind: 'open-session',
        navigation: { target: 'run', runId: 'run-enrich', projectId: 2 },
      });
    });

    it("open-session: enriches a 'quick-session' target with the session's server-resolved projectId, overwriting any caller-supplied projectId", async () => {
      seedSession(db, 'sess-enrich', 2, { runId: 'run-under-sess', isQuick: true });
      const payload = {
        kind: 'open-session',
        navigation: {
          target: 'quick-session',
          sessionId: 'sess-enrich',
          runId: 'run-under-sess',
          projectId: 999, // bogus — must be overwritten
        },
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.payload).toEqual({
        kind: 'open-session',
        navigation: {
          target: 'quick-session',
          sessionId: 'sess-enrich',
          runId: 'run-under-sess',
          projectId: 2,
        },
      });
    });

    it("open-session: enriches an IDLE 'quick-session' target (no runId) with its projectId", async () => {
      seedSession(db, 'sess-idle', 1, { isQuick: true });
      const payload = { kind: 'open-session', navigation: { target: 'quick-session', sessionId: 'sess-idle' } };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.payload).toEqual({
        kind: 'open-session',
        navigation: { target: 'quick-session', sessionId: 'sess-idle', projectId: 1 },
      });
    });

    it("open-session: rejects a 'run' target whose runId does not exist with run_not_found", async () => {
      const payload = { kind: 'open-session', navigation: { target: 'run', runId: 'run-does-not-exist' } };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'run_not_found' });
    });

    it("open-session: rejects a 'quick-session' target whose sessionId does not exist with session_not_found", async () => {
      const payload = {
        kind: 'open-session',
        navigation: { target: 'quick-session', sessionId: 'sess-does-not-exist' },
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'session_not_found' });
    });

    it('edit-workflow: captures a server-computed spec_hash even when the caller supplies a bogus one', async () => {
      seedWorkflowRow(db, 'wf-edit-1', 1, 'flow-one', CUSTOM_DEFINITION);
      const expectedHash = computeSpecHash(CUSTOM_DEFINITION);

      const payload = {
        kind: 'edit-workflow',
        workflowId: 'wf-edit-1',
        definitionJson: JSON.stringify({ ...CUSTOM_DEFINITION, id: 'my-flow-edited' }),
        summary: 'rename the flow',
        // Not a real field on EditWorkflowProposalPayload — a hostile/confused
        // caller trying to smuggle a precondition through the payload. The
        // parser only copies the documented fields, so this is silently
        // dropped; the assertion below proves the STORED precondition is the
        // real server-computed hash, not this value, either way.
        specHash: 'bogus-deadbeef-should-be-ignored',
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      const preconditions = proposal.preconditions as EditWorkflowPreconditions;
      expect(preconditions.kind).toBe('edit-workflow');
      expect(preconditions.specHash).toBe(expectedHash);
      expect(preconditions.specHash).not.toBe('bogus-deadbeef-should-be-ignored');
    });

    it('edit-workflow: returns workflow_not_found for an unknown workflowId', async () => {
      const payload = { kind: 'edit-workflow', workflowId: 'nope', definitionJson: JSON.stringify(CUSTOM_DEFINITION) };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'workflow_not_found' });
    });

    it('reprioritize-backlog: captures each task\'s CURRENT version as expectedVersions', async () => {
      seedRunFor(db, 'run-p1', 1);
      const task = await createEntity(handler, 'run-p1', 'A task', 'task');

      const payload = {
        kind: 'reprioritize-backlog',
        projectId: 1,
        items: [{ taskId: task.id, priority: 'P0' }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      const preconditions = proposal.preconditions as ReprioritizeBacklogPreconditions;
      expect(preconditions.kind).toBe('reprioritize-backlog');
      expect(preconditions.expectedVersions).toEqual({ [task.id]: 1 });
    });

    it('reprioritize-backlog: returns task_not_found:<id> for an unknown taskId', async () => {
      const payload = {
        kind: 'reprioritize-backlog',
        projectId: 1,
        items: [{ taskId: 'tsk_does_not_exist', priority: 'P0' }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'task_not_found:tsk_does_not_exist' });
    });

    it('create-backlog-items: stores the batch with null preconditions', async () => {
      const payload = {
        kind: 'create-backlog-items',
        projectId: 1,
        items: [
          { taskType: 'idea', title: 'A fresh idea', body: 'Some spec', priority: 'P1' },
          { taskType: 'task', title: 'A fresh task' },
        ],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.kind).toBe('create-backlog-items');
      expect(proposal.preconditions).toBeNull();
      expect(proposal.payload).toEqual(payload);
    });

    it('create-backlog-items: NORMALIZES an originatingIdeaId display ref to its opaque id', async () => {
      seedRunFor(db, 'run-create-1', 1);
      const idea = await createEntity(handler, 'run-create-1', 'Parent idea', 'idea');

      const payload = {
        kind: 'create-backlog-items',
        projectId: 1,
        // Passed as the DISPLAY REF — the handler must resolve it, so the
        // executor's chokepoint call never sees a ref it cannot link.
        items: [{ taskType: 'task', title: 'Child task', originatingIdeaId: idea.ref }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      const stored = proposal.payload as CreateBacklogItemsProposalPayload;
      expect(stored.items[0].originatingIdeaId).toBe(idea.id);
      expect(stored.items[0].originatingIdeaId).not.toBe(idea.ref);
    });

    it('create-backlog-items: rejects an originatingIdeaId that does not resolve', async () => {
      const payload = {
        kind: 'create-backlog-items',
        projectId: 1,
        items: [{ taskType: 'task', title: 'Orphan', originatingIdeaId: 'IDEA-999' }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({
        ok: false,
        error: 'originating_idea_not_found:IDEA-999',
      });
    });

    it('create-backlog-items: rejects a parentEpicId that resolves to a NON-epic entity', async () => {
      seedRunFor(db, 'run-create-2', 1);
      const idea = await createEntity(handler, 'run-create-2', 'Not an epic', 'idea');

      const payload = {
        kind: 'create-backlog-items',
        projectId: 1,
        items: [{ taskType: 'task', title: 'Mis-parented', parentEpicId: idea.id }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: `parent_epic_not_found:${idea.id}` });
    });

    it('create-backlog-items: rejects an unknown projectId with project_not_found', async () => {
      const payload = {
        kind: 'create-backlog-items',
        projectId: 4242,
        items: [{ taskType: 'task', title: 'Nowhere' }],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify(payload),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'project_not_found' });
    });

    it('create-workflow: stores the flow + agents with null preconditions, trimming the name', async () => {
      const payload = {
        kind: 'create-workflow',
        projectId: 1,
        name: ' Docs Review ',
        definitionJson: JSON.stringify(DOCS_FLOW),
        agents: [DOCS_WRITER],
        summary: 'A docs-review flow',
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r1', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res).toMatchObject({ ok: true });
      const { proposalId } = res.data as { proposalId: string };
      const proposal = store.getProposal(proposalId) as AgentProposal;
      expect(proposal.kind).toBe('create-workflow');
      expect(proposal.preconditions).toBeNull();
      expect(proposal.payload).toEqual({ ...payload, name: 'Docs Review' });
      // Proposing NEVER mints anything — the flow and agent land only on Confirm.
      expect(db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE name = 'Docs Review'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_overrides').get()).toEqual({ n: 0 });
    });

    it('create-workflow: rejects a step bound to nothing, but accepts an EXISTING custom agent of the project', async () => {
      const payload = { kind: 'create-workflow', projectId: 1, name: 'Docs Review', definitionJson: JSON.stringify(DOCS_FLOW) };
      const first = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r1', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
        first.socket,
      );
      expect(parseLastWrite(first.writes)).toMatchObject({ ok: false, error: 'unknown_step_agent:docs-writer' });

      seedCustomAgent(db, 1, 'docs-writer');
      const second = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r2', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
        second.socket,
      );
      expect(parseLastWrite(second.writes).ok).toBe(true);
    });

    it('create-workflow: rejects a name a project or global flow already uses', async () => {
      seedWorkflowRow(db, 'wf-taken', 1, 'Docs Review', CUSTOM_DEFINITION);
      const payload = {
        kind: 'create-workflow',
        projectId: 1,
        name: 'Docs Review',
        definitionJson: JSON.stringify(DOCS_FLOW),
        agents: [DOCS_WRITER],
      };
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r1', runId: 'agent:thread-1', payloadJson: JSON.stringify(payload) },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'workflow_name_taken' });
    });

    it('create-backlog-items: rejects an unknown taskType / empty title / empty batch with invalid_payload', async () => {
      for (const items of [
        [{ taskType: 'epicc', title: 'Typo type' }],
        [{ taskType: 'task', title: '   ' }],
        [],
      ]) {
        const { socket, writes } = makeSocketDouble();
        await handler.handleMessage(
          {
            type: 'mcp-propose-action',
            requestId: 'r1',
            runId: 'agent:thread-1',
            payloadJson: JSON.stringify({ kind: 'create-backlog-items', projectId: 1, items }),
          },
          socket,
        );
        expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'invalid_payload' });
      }
    });

    it('create-backlog-items: rejects a batch over the 20-item ceiling with invalid_payload', async () => {
      const items = Array.from({ length: 21 }, (_, i) => ({ taskType: 'task', title: `T${i}` }));
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify({ kind: 'create-backlog-items', projectId: 1, items }),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'invalid_payload' });
    });

    it('rejects malformed JSON with invalid_json', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-propose-action', requestId: 'r1', runId: 'agent:thread-1', payloadJson: '{not json' },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'invalid_json' });
    });

    it('rejects an unrecognized kind with invalid_payload', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify({ kind: 'delete-everything' }),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'invalid_payload' });
    });

    it('rejects a payload missing a required field for its kind', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          // launch-run requires projectId + workflowName — both missing.
          payloadJson: JSON.stringify({ kind: 'launch-run' }),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'invalid_payload' });
    });

    it('returns agent_thread_store_unavailable when the dep is not injected', async () => {
      const noStoreHandler = new McpQueryHandler(dbAdapter(db)); // no deps
      const { socket, writes } = makeSocketDouble();
      await noStoreHandler.handleMessage(
        {
          type: 'mcp-propose-action',
          requestId: 'r1',
          runId: 'agent:thread-1',
          payloadJson: JSON.stringify({ kind: 'launch-run', projectId: 1, workflowName: 'sprint' }),
        },
        socket,
      );
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'agent_thread_store_unavailable' });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_history (mcp-history) — the assistant's long-term memory over its
  // own agent_thread_events rows. The two contracts worth guarding hardest are
  // THREAD SCOPING (another thread's turns must be unreachable) and the
  // skip-plumbing rule (SDK tool_result 'user' events are not conversation).
  // -------------------------------------------------------------------------

  describe('mcp-history', () => {
    /** Ask for history as thread-1 unless a different runId is given. */
    async function history(
      params: Partial<Omit<Extract<McpQueryMessage, { type: 'mcp-history' }>, 'type' | 'requestId'>> = {},
    ): Promise<McpQueryResponse> {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-history', requestId: 'h1', runId: 'agent:thread-1', ...params },
        socket,
      );
      return parseLastWrite(writes);
    }

    function historyData(res: McpQueryResponse): HistoryData {
      expect(res.ok).toBe(true);
      return res.data as HistoryData;
    }

    beforeEach(() => {
      store.createThread({ id: 'thread-2' });
    });

    it('rejects a non-agent runId before any DB read', async () => {
      expect(await history({ runId: 'run-abc' })).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
    });

    it('browse mode returns user + assistant turns newest-first, skipping tool plumbing', async () => {
      seedUserTurn(db, 'thread-1', 'what shipped last week?');
      seedAssistantTurn(db, 'thread-1', 'we shipped 0.2.5');
      seedToolPlumbing(db, 'thread-1');
      seedUserTurn(db, 'thread-1', 'and the week before?');

      const data = historyData(await history());
      expect(data.turns.map((t) => t.text)).toEqual([
        'and the week before?',
        'we shipped 0.2.5',
        'what shipped last week?',
      ]);
      expect(data.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
      // Browse mode is not a search — no turn is flagged as a match.
      expect(data.turns.every((t) => t.matched === undefined)).toBe(true);
      // The tool_result row was examined (it counts toward scanned) but decoded
      // to nothing, so it never reaches the caller.
      expect(data.scanned).toBe(4);
      expect(data.truncated).toBe(false);
      expect(data.nextBeforeId).toBeNull();
      expect(data.turns[0].at.length).toBeGreaterThan(0);
    });

    it('decodes the provider-neutral agent_user / agent_assistant rows too', async () => {
      seedThreadEvent(db, 'thread-1', 'agent_user', {
        type: 'agent_message',
        role: 'user',
        content: [{ type: 'text', text: 'from another provider' }],
      });
      seedThreadEvent(db, 'thread-1', 'agent_assistant', {
        type: 'agent_message',
        role: 'assistant',
        id: 'am1',
        model: 'gpt',
        content: [{ type: 'text', text: 'answered by another provider' }],
      });

      const data = historyData(await history());
      expect(data.turns.map((t) => [t.role, t.text])).toEqual([
        ['assistant', 'answered by another provider'],
        ['user', 'from another provider'],
      ]);
    });

    it('search mode matches an assistant turn case-insensitively and excerpts around the first occurrence', async () => {
      seedUserTurn(db, 'thread-1', 'nothing relevant here');
      const long = `${'a'.repeat(2000)}NOTARIZATION broke again${'b'.repeat(2000)}`;
      seedAssistantTurn(db, 'thread-1', long);

      const data = historyData(await history({ query: 'notarization broke' }));
      expect(data.turns).toHaveLength(1);
      const [turn] = data.turns;
      expect(turn.role).toBe('assistant');
      expect(turn.matched).toBe(true);
      expect(turn.text).toContain('NOTARIZATION broke again');
      // Both ends were clipped, so both carry the ellipsis marker, and the
      // excerpt is a window — not the whole 4KB turn.
      expect(turn.text.startsWith('…')).toBe(true);
      expect(turn.text.endsWith('…')).toBe(true);
      expect(turn.text.length).toBeLessThan(long.length);
    });

    it('search mode returns an empty turns array (ok:true) when nothing matches', async () => {
      seedUserTurn(db, 'thread-1', 'hello there');
      const data = historyData(await history({ query: 'no-such-phrase' }));
      expect(data.turns).toEqual([]);
      expect(data.truncated).toBe(false);
      expect(data.nextBeforeId).toBeNull();
      expect(data.scanned).toBe(1);
    });

    it('role narrows the result to one side of the conversation', async () => {
      seedUserTurn(db, 'thread-1', 'user says one');
      seedAssistantTurn(db, 'thread-1', 'assistant says one');
      seedUserTurn(db, 'thread-1', 'user says two');

      const users = historyData(await history({ role: 'user' }));
      expect(users.turns.map((t) => t.text)).toEqual(['user says two', 'user says one']);

      const assistants = historyData(await history({ role: 'assistant' }));
      expect(assistants.turns.map((t) => t.text)).toEqual(['assistant says one']);
    });

    it('pages with beforeId: nextBeforeId round-trips without re-emitting or skipping a turn', async () => {
      for (let i = 1; i <= 5; i++) seedUserTurn(db, 'thread-1', `turn ${i}`);

      const page1 = historyData(await history({ limit: 2 }));
      expect(page1.turns.map((t) => t.text)).toEqual(['turn 5', 'turn 4']);
      expect(page1.truncated).toBe(true);
      expect(page1.nextBeforeId).toBe(page1.turns[page1.turns.length - 1].eventId);

      const page2 = historyData(await history({ limit: 2, beforeId: page1.nextBeforeId! }));
      expect(page2.turns.map((t) => t.text)).toEqual(['turn 3', 'turn 2']);
      expect(page2.truncated).toBe(true);

      const page3 = historyData(await history({ limit: 2, beforeId: page2.nextBeforeId! }));
      expect(page3.turns.map((t) => t.text)).toEqual(['turn 1']);
      expect(page3.truncated).toBe(false);
      expect(page3.nextBeforeId).toBeNull();
    });

    it('a page that lands EXACTLY on the last turn is complete, not truncated', async () => {
      // 4 turns, limit 2: page 2 consumes the remainder exactly. The walk
      // peeks past the filled page before answering, so an even division never
      // costs the caller a wasted empty follow-up call.
      for (let i = 1; i <= 4; i++) seedUserTurn(db, 'thread-1', `turn ${i}`);

      const page1 = historyData(await history({ limit: 2 }));
      expect(page1.turns.map((t) => t.text)).toEqual(['turn 4', 'turn 3']);
      expect(page1.truncated).toBe(true);

      const page2 = historyData(await history({ limit: 2, beforeId: page1.nextBeforeId! }));
      expect(page2.turns.map((t) => t.text)).toEqual(['turn 2', 'turn 1']);
      expect(page2.truncated).toBe(false);
      expect(page2.nextBeforeId).toBeNull();

      // Same holds when the whole transcript fits one page exactly.
      const exact = historyData(await history({ limit: 4 }));
      expect(exact.turns).toHaveLength(4);
      expect(exact.truncated).toBe(false);
      expect(exact.nextBeforeId).toBeNull();
    });

    it('clamps limit to 50 and defaults to 20', async () => {
      for (let i = 1; i <= 60; i++) seedUserTurn(db, 'thread-1', `turn ${i}`);

      expect(historyData(await history({ limit: 999 })).turns).toHaveLength(50);
      expect(historyData(await history()).turns).toHaveLength(20);
      expect(historyData(await history({ limit: 3 })).turns).toHaveLength(3);
    });

    it('daysBack drops turns older than the window', async () => {
      seedUserTurn(db, 'thread-1', 'ancient history', '2000-01-01 00:00:00');
      seedUserTurn(db, 'thread-1', 'recent history');

      const windowed = historyData(await history({ daysBack: 7 }));
      expect(windowed.turns.map((t) => t.text)).toEqual(['recent history']);

      const unwindowed = historyData(await history());
      expect(unwindowed.turns).toHaveLength(2);
    });

    it('clamps a huge daysBack to the whole table instead of silently returning nothing', async () => {
      // Unclamped, datetime('now', '-1000000000 days') is NULL in SQLite and
      // `created_at >= NULL` filters out EVERY row — the assistant would read
      // that as "no memory of it". Clamped (~100 years) it means "everything".
      seedUserTurn(db, 'thread-1', 'ancient history', '2000-01-01 00:00:00');
      seedUserTurn(db, 'thread-1', 'recent history');

      const data = historyData(await history({ daysBack: 1_000_000_000 }));
      expect(data.turns.map((t) => t.text)).toEqual(['recent history', 'ancient history']);
    });

    it('NEVER returns another thread\'s turns', async () => {
      seedUserTurn(db, 'thread-2', 'a secret from another thread');
      seedAssistantTurn(db, 'thread-2', 'another thread reply');
      seedUserTurn(db, 'thread-1', 'my own turn');

      const browse = historyData(await history());
      expect(browse.turns.map((t) => t.text)).toEqual(['my own turn']);

      const searched = historyData(await history({ query: 'thread' }));
      expect(searched.turns).toEqual([]);
      // Only thread-1's single row was ever examined.
      expect(searched.scanned).toBe(1);
    });

    it('treats the query as a LITERAL substring, never a regex (ReDoS-proof by construction)', async () => {
      // '[unclosed' would throw as a regex and '^(a+)+b$' would be a
      // catastrophic-backtracking bomb; as literals both are just text.
      seedUserTurn(db, 'thread-1', 'the [unclosed bracket case');
      seedUserTurn(db, 'thread-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX');

      const literal = historyData(await history({ query: '[unclosed' }));
      expect(literal.turns.map((t) => t.text)).toEqual(['the [unclosed bracket case']);
      expect(literal.turns[0].matched).toBe(true);

      // The classic ReDoS pattern returns instantly with no match — it is
      // compared as characters, not compiled.
      const bomb = historyData(await history({ query: '^(a+)+b$' }));
      expect(bomb.turns).toEqual([]);
    });

    it('rejects a malformed role / non-positive numeric argument', async () => {
      const badRole = await history({ role: 'nobody' as unknown as 'user' });
      expect(badRole.ok).toBe(false);
      expect(badRole.error).toMatch(/^invalid_arguments: role/);

      for (const bad of [{ limit: 0 }, { limit: -5 }, { daysBack: 0 }, { beforeId: Number.NaN }]) {
        const res = await history(bad);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/^invalid_arguments: (limit|daysBack|beforeId)/);
      }
    });

    it('treats an empty query as browse mode rather than a match-everything regex', async () => {
      seedUserTurn(db, 'thread-1', 'plain turn');
      const data = historyData(await history({ query: '' }));
      expect(data.turns.map((t) => t.text)).toEqual(['plain turn']);
      expect(data.turns[0].matched).toBeUndefined();
    });

    it('stops on the ~100KB payload ceiling before the limit, and resumes without skipping a turn', async () => {
      // Per-turn text is clipped to ~700 CHARS, so the byte ceiling only binds
      // on wide characters: 700 CJK chars are ~2.1KB of UTF-8 each, and 50 of
      // those overshoot 100KB — the guard must stop short of the limit.
      const wide = '漢'.repeat(900);
      for (let i = 1; i <= 60; i++) seedUserTurn(db, 'thread-1', `${i} ${wide}`);

      const data = historyData(await history({ limit: 50 }));
      expect(data.truncated).toBe(true);
      expect(data.turns.length).toBeGreaterThan(0);
      expect(data.turns.length).toBeLessThan(50);
      // The ceiling bounds the SUM OF TURNS; the array's own commas/brackets
      // add a byte per turn on top, hence the small slack here.
      expect(Buffer.byteLength(JSON.stringify(data.turns), 'utf8')).toBeLessThan(101_000);
      expect(data.nextBeforeId).not.toBeNull();

      // The rejected row is re-offered by the continuation cursor: no turn is
      // lost between the pages, and none is emitted twice.
      const resumed = historyData(await history({ limit: 50, beforeId: data.nextBeforeId! }));
      const seen = [...data.turns, ...resumed.turns].map((t) => t.eventId);
      expect(new Set(seen).size).toBe(seen.length);
      expect(Math.min(...seen)).toBe(Math.max(...seen) - seen.length + 1); // contiguous ids
    });
  });
});
