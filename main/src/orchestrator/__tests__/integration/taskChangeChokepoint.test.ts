/**
 * Tier-2 chokepoint integration — native task writes through the REAL
 * TaskChangeRouter over a full-migration-chain DB.
 *
 * Scenario 1 (entity write + stage move): cyboflow_create_task then
 * cyboflow_set_task_stage. Asserts the chokepoint wrote the `tasks` row and its
 * `entity_events` deltas (created → stageMoved), and that the stage actually
 * changed via a fresh SELECT.
 *
 * Scenario 3 (Q1 plan-gate): a plan-gated planner run's created tasks land
 * PENDING (approved_at NULL = backend-invisible + sprint-ineligible) until the
 * orchestrator reveal (approved toggle) stamps them visible; the DECLINE path
 * runs the run-created-entities sweep (deleteRunCreatedEntities) and hard-deletes
 * the still-pending drafts.
 *
 * The content-driven artifact mint hook (handleEntityWrite) is stubbed — it is a
 * fire-and-forget side effect, not the chokepoint under test, and stubbing it
 * removes a post-close async race. Everything below the MCP handler is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { McpQueryHandler } from '../../mcpServer/mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter, taskChangeEvents, taskProjectChannel } from '../../taskChangeRouter';
import type { TaskChangedEvent } from '../../../../../shared/types/tasks';
import {
  createIntegrationDb,
  seedWorkflowRun,
  stageId,
  makeSocketDouble,
  parseLastWrite,
  type IntegrationDb,
} from './integrationHarness';

vi.mock('../../autoMintArtifacts', () => ({
  handleEntityWrite: vi.fn(() => Promise.resolve()),
  handleRunStart: vi.fn(() => Promise.resolve()),
  handleStepCompletion: vi.fn(() => Promise.resolve()),
}));

interface EntityEventRow {
  kind: string;
  actor: string;
  changes_json: string | null;
}

function entityEvents(db: Database.Database, taskId: string): EntityEventRow[] {
  return db
    .prepare(
      "SELECT kind, actor, changes_json FROM entity_events WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq ASC",
    )
    .all(taskId) as EntityEventRow[];
}

describe('Tier-2 chokepoint — task create + stage move (TaskChangeRouter)', () => {
  let fixture: IntegrationDb;
  let handler: McpQueryHandler;

  beforeEach(() => {
    fixture = createIntegrationDb();
    TaskChangeRouter.initialize(dbAdapter(fixture.db));
    handler = new McpQueryHandler(dbAdapter(fixture.db));
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
    fixture.cleanup();
  });

  it('creates a TASK then moves its stage — the tasks row + entity_events reflect both writes', async () => {
    const { db } = fixture;
    seedWorkflowRun(db, {
      runId: 'run-1',
      workflowName: 'sprint', // NOT plan-gated → the created task is visible (approved_at = now)
      currentStepId: 'plan',
      stepsSnapshot: { plan: 'planner' },
    });

    // ── create ────────────────────────────────────────────────────────────
    const created = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-task', requestId: 'ct-1', runId: 'run-1', taskType: 'task', title: 'Ship the widget' },
      created.socket,
    );

    const createRes = parseLastWrite(created.writes);
    expect(createRes.ok).toBe(true);
    const createData = createRes.data as { task_id: string; ref?: string; type?: string; stage_id?: string; version?: number };
    const taskId = createData.task_id;
    expect(createData.ref).toBe('TASK-001');
    expect(createData.type).toBe('task');
    expect(createData.stage_id).toBe(stageId(6)); // tasks default to "Ready for development"
    expect(createData.version).toBe(1);

    // The row lives in `tasks` (table identity is the discriminator) — visible.
    const row = db
      .prepare('SELECT ref, stage_id, version, approved_at FROM tasks WHERE id = ?')
      .get(taskId) as { ref: string; stage_id: string; version: number; approved_at: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.ref).toBe('TASK-001');
    expect(row!.stage_id).toBe(stageId(6));
    expect(row!.approved_at).not.toBeNull(); // non-plan-gated create → visible

    // A single 'created' entity_events row attributed to the agent actor.
    const afterCreate = entityEvents(db, taskId);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0].kind).toBe('created');
    expect(afterCreate[0].actor).toBe('agent:planner');

    // ── stage move ────────────────────────────────────────────────────────
    const moved = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-set-task-stage', requestId: 'ss-1', runId: 'run-1', taskId, stageId: stageId(9) },
      moved.socket,
    );

    const moveRes = parseLastWrite(moved.writes);
    expect(moveRes.ok).toBe(true);
    const moveData = moveRes.data as { task_id: string; stage_id?: string; version?: number };
    expect(moveData.task_id).toBe(taskId);
    expect(moveData.stage_id).toBe(stageId(9));
    expect(moveData.version).toBe(2); // create → 1, stage move → 2

    // FRESH SELECT proves the stage actually changed on disk.
    const afterMove = db
      .prepare('SELECT stage_id, version FROM tasks WHERE id = ?')
      .get(taskId) as { stage_id: string; version: number };
    expect(afterMove.stage_id).toBe(stageId(9));
    expect(afterMove.version).toBe(2);

    // A second entity_events row records the stage delta 6 → 9.
    const allEvents = entityEvents(db, taskId);
    expect(allEvents).toHaveLength(2);
    expect(allEvents[1].kind).toBe('stageMoved');
    const deltas = JSON.parse(allEvents[1].changes_json ?? '[]') as Array<{ field: string; from: unknown; to: unknown }>;
    const stageDelta = deltas.find((d) => d.field === 'stage_id');
    expect(stageDelta).toEqual({ field: 'stage_id', from: stageId(6), to: stageId(9) });
  });
});

describe('Tier-2 chokepoint — Q1 plan-gate (pending → reveal / decline-sweep)', () => {
  let fixture: IntegrationDb;
  let handler: McpQueryHandler;

  beforeEach(() => {
    fixture = createIntegrationDb();
    TaskChangeRouter.initialize(dbAdapter(fixture.db));
    handler = new McpQueryHandler(dbAdapter(fixture.db));
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
    fixture.cleanup();
  });

  /** Create a plan-gated TASK via the chokepoint and return its opaque id. */
  async function createPendingTask(runId: string, title: string): Promise<string> {
    const s = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-task', requestId: `ct-${title}`, runId, taskType: 'task', title },
      s.socket,
    );
    const res = parseLastWrite(s.writes);
    expect(res.ok).toBe(true);
    return (res.data as { task_id: string }).task_id;
  }

  it('planner-created tasks land PENDING (approved_at NULL) and an orchestrator reveal makes them visible', async () => {
    const { db } = fixture;
    // Plan-gated: workflow name 'planner' + a steps snapshot carrying the
    // approve-plan gate id (the PRIMARY plan-gated signal).
    seedWorkflowRun(db, {
      runId: 'run-plan',
      workflowName: 'planner',
      currentStepId: 'tasks',
      stepsSnapshot: { context: 'planner', 'approve-plan': 'planner', tasks: 'planner' },
    });

    const t1 = await createPendingTask('run-plan', 'Pending A');
    const t2 = await createPendingTask('run-plan', 'Pending B');

    // Both drafts are PENDING → approved_at NULL (backend-invisible + sprint-ineligible).
    for (const id of [t1, t2]) {
      const r = db.prepare('SELECT approved_at FROM tasks WHERE id = ?').get(id) as { approved_at: string | null };
      expect(r.approved_at).toBeNull();
    }

    // Reveal ONE draft through the chokepoint's orchestrator-only `approved`
    // toggle (the exact per-entity core the approve-plan gate's reveal runs).
    // The router's post-commit broadcast fires on the per-project channel with
    // action 'updated' (emitChange → broadcast), NOT a generic 'changed' event.
    const revealed: Array<{ taskId: string; action: string }> = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => {
      revealed.push({ taskId: e.taskId, action: e.action });
    });
    await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      taskId: t1,
      approved: true,
      runId: 'run-plan',
    });

    // t1 is now visible; t2 stays pending.
    const r1 = db.prepare('SELECT approved_at, version FROM tasks WHERE id = ?').get(t1) as { approved_at: string | null; version: number };
    const r2 = db.prepare('SELECT approved_at FROM tasks WHERE id = ?').get(t2) as { approved_at: string | null };
    expect(r1.approved_at).not.toBeNull();
    expect(r1.version).toBe(2); // create → 1, reveal → 2
    expect(r2.approved_at).toBeNull();

    // The reveal broadcast fired for the revealed task (action 'updated').
    expect(revealed.some((e) => e.taskId === t1 && e.action === 'updated')).toBe(true);
  });

  it('declining an unapproved plan-gated run sweeps its still-pending drafts (deleteRunCreatedEntities)', async () => {
    const { db } = fixture;
    seedWorkflowRun(db, {
      runId: 'run-reject',
      workflowName: 'planner',
      currentStepId: 'tasks',
      stepsSnapshot: { 'approve-plan': 'planner', tasks: 'planner' },
    });

    const t1 = await createPendingTask('run-reject', 'Doomed A');
    const t2 = await createPendingTask('run-reject', 'Doomed B');
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 2 });

    // Each sweep delete routes through applyDelete, which fires a post-commit
    // 'deleted' broadcast on the per-project channel (the read-model signal the
    // board reacts to). Capture them to prove the sweep emitted, not raw-DELETEd.
    const deletedBroadcasts: string[] = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => {
      if (e.action === 'deleted') deletedBroadcasts.push(e.taskId);
    });

    // The decline/teardown path: plan_approved_at is still NULL, the run is
    // plan-gated, and both drafts are pending → the sweep hard-deletes them.
    await TaskChangeRouter.getInstance().deleteRunCreatedEntities(1, 'run-reject');

    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(t1)).toBeUndefined();
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(t2)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });

    // A 'deleted' broadcast fired for each swept draft. (applyDelete DELETEs the
    // entity's entity_events rows in the same txn — it does NOT mint a 'deleted'
    // event row — so the deltas are asserted via the in-memory broadcast, and the
    // now-empty entity_events table confirms the rows were reaped.)
    expect(new Set(deletedBroadcasts)).toEqual(new Set([t1, t2]));
    const remainingEvents = db
      .prepare("SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'task' AND entity_id IN (?, ?)")
      .get(t1, t2) as { n: number };
    expect(remainingEvents.n).toBe(0);
  });

  it('an APPROVED (revealed) draft survives the sweep — gate 2 (plan_approved_at) spares it', async () => {
    const { db } = fixture;
    seedWorkflowRun(db, {
      runId: 'run-mixed',
      workflowName: 'planner',
      currentStepId: 'tasks',
      stepsSnapshot: { 'approve-plan': 'planner', tasks: 'planner' },
    });
    const kept = await createPendingTask('run-mixed', 'Kept');

    // Reveal it, then stamp the run approved (mirrors the approve-plan gate).
    await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'orchestrator',
      entityType: 'task',
      taskId: kept,
      approved: true,
      runId: 'run-mixed',
    });
    db.prepare('UPDATE workflow_runs SET plan_approved_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', 'run-mixed');

    await TaskChangeRouter.getInstance().deleteRunCreatedEntities(1, 'run-mixed');

    // gate 2 short-circuits (plan_approved_at NOT NULL) → the revealed task lives.
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(kept)).toBeDefined();
  });
});
