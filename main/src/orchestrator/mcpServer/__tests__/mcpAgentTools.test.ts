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
import { McpQueryHandler, resolveGlobalAgentContext, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter, taskChangeEvents } from '../../taskChangeRouter';
import { AgentThreadDbStore } from '../../agentThread/agentThreadDbStore';
import { computeSpecHash } from '../../agentThread/specHash';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type {
  AgentProposal,
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
  // readWorkflowRow / handleAgentWorkflows now SELECT workflows.archived_at.
  apply('079_workflow_archived_at.sql');

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
  opts?: { blocking?: boolean; status?: string; title?: string },
): void {
  db.prepare(
    `INSERT INTO review_items (id, project_id, kind, status, blocking, title) VALUES (?, ?, 'finding', ?, ?, ?)`,
  ).run(id, projectId, opts?.status ?? 'pending', opts?.blocking ? 1 : 0, opts?.title ?? 'A finding');
}

function seedQuestionRow(db: Database.Database, id: string, runId: string, status = 'pending'): void {
  db.prepare(`INSERT INTO questions (id, run_id, tool_use_id, questions_json, status) VALUES (?, ?, ?, '[]', ?)`).run(
    id,
    runId,
    id,
    status,
  );
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
    it('defaults to pending items only; include_resolved surfaces resolved ones too', async () => {
      seedReviewItem(db, 'ri-pending', 1, { status: 'pending', title: 'Pending finding' });
      seedReviewItem(db, 'ri-resolved', 1, { status: 'resolved', title: 'Resolved finding' });

      const pendingOnly = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-queue', requestId: 'r1', runId: 'agent:thread-1' }, pendingOnly.socket);
      const pendingData = parseLastWrite(pendingOnly.writes).data as { items: Array<{ id: string }>; total: number };
      expect(pendingData.total).toBe(1);
      expect(pendingData.items[0].id).toBe('ri-pending');

      const both = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-queue', requestId: 'r2', runId: 'agent:thread-1', includeResolved: true },
        both.socket,
      );
      const bothData = parseLastWrite(both.writes).data as { items: Array<{ id: string }>; total: number };
      expect(bothData.total).toBe(2);
    });

    it('rejects a non-agent runId', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-queue', requestId: 'r1', runId: 'run-abc' }, socket);
      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'not_a_global_agent_run' });
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
});
