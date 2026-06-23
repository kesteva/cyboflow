/**
 * Unit tests for the 'ship' workflow handoff seam: the run-bound MCP tool
 * cyboflow_create_sprint_batch (McpQueryHandler.handleCreateSprintBatch).
 *
 * Ship concatenates planner decomposition with sprint execution in ONE run.
 * At the 'materialize-batch' step the orchestrator calls this tool to mint the
 * sprint batch + per-task lanes from the approved tasks and stamp
 * workflow_runs.batch_id MID-RUN (RunLauncher only stamps it at launch for a
 * seed-task sprint). The handler is IDEMPOTENT and transactional so a
 * crash/resume re-call cannot orphan a second batch or reset lane status.
 *
 * Coverage (per the stage brief):
 *   (a) materialize after N created tasks -> batch_id stamped, N lanes.
 *   (b) double-call -> created:false, no 2nd batch row.
 *   (c) empty -> ship_no_tasks_to_materialize.
 *   (d) crash/resume (batch_id NULL) -> re-mint once.
 *   (e) over-cap -> ship_batch_too_large.
 *   (f) explicit taskIds subset -> only those become lanes.
 *
 * Uses an in-memory better-sqlite3 DB built from the real migration files
 * (mirrors mcpQueryHandler.test.ts's lane suite) + a writes-capturing socket
 * double. SprintLaneStore is a singleton — initialize/reset per test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as net from 'net';
import { McpQueryHandler, type McpQueryResponse } from '../mcpServer/mcpQueryHandler';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { SprintLaneStore, sprintLaneEvents } from '../sprintLaneStore';
import { runStatusEvents } from '../trpc/routers/events';
import { SPRINT_BATCH_MAX_TASKS } from '../../../../shared/types/sprintBatch';
import type { RunStatusChangedEvent } from '../../../../shared/types/cyboflow';

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

/** Build an in-memory DB with the migrations the ship handoff touches. */
function buildShipDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  // Migration 013: workflow_runs.substrate (the cap is substrate-keyed).
  db.exec(readFileSync(join(migDir, '013_workflow_run_substrate.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '023_sprint_lane_step.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '025_sprint_lane_attempts.sql'), 'utf-8'));
  return db;
}

/** Seed a ship workflow + workflow_run pair, optionally pre-stamped with batch_id. */
function seedShipRun(
  db: Database.Database,
  opts: { runId: string; batchId?: string | null; status?: string; substrate?: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-ship', 1, 'ship', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, substrate, batch_id)
     VALUES (?, 'wf-ship', 1, ?, 'materialize-batch', '{"materialize-batch":"implement"}', ?, ?)`,
  ).run(opts.runId, opts.status ?? 'running', opts.substrate ?? 'sdk', opts.batchId ?? null);
}

/** Insert a task row + a run-created entity_event so listRunCreatedTaskIds sees it. */
function seedCreatedTask(db: Database.Database, opts: { runId: string; taskId: string; ref: string; seq: number }): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-5')`,
  ).run(opts.taskId, opts.ref, `Task ${opts.ref}`);
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES ('task', ?, ?, 'created', 'agent:tasks', ?)`,
  ).run(opts.taskId, opts.seq, opts.runId);
}

/** Count batch rows + lane rows for a run's stamped batch. */
function laneCount(db: Database.Database, batchId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sprint_batch_tasks WHERE batch_id = ?')
    .get(batchId) as { n: number };
  return row.n;
}

function batchRowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sprint_batches').get() as { n: number }).n;
}

function readBatchId(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?').get(runId) as
    | { batchId: string | null }
    | undefined;
  return row?.batchId ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow_create_sprint_batch (ship handoff seam)', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    db = buildShipDb();
    SprintLaneStore.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    runStatusEvents.removeAllListeners();
    db.close();
  });

  // (a) materialize after N tasks created -> batch_id stamped, N lanes.
  it('materializes all run-created tasks: stamps batch_id and creates one lane per task', async () => {
    seedShipRun(db, { runId: 'run-a' });
    seedCreatedTask(db, { runId: 'run-a', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });
    seedCreatedTask(db, { runId: 'run-a', taskId: 'tsk_2', ref: 'TASK-002', seq: 1 });
    seedCreatedTask(db, { runId: 'run-a', taskId: 'tsk_3', ref: 'TASK-003', seq: 1 });

    // Capture the run-row-changed signal (drives activeRunsStore re-fetch).
    const emitted: RunStatusChangedEvent[] = [];
    runStatusEvents.on('changed', (e: RunStatusChangedEvent) => emitted.push(e));

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-a', runId: 'run-a' }, socket);

    expect(writes[writes.length - 1].endsWith('\n')).toBe(true);
    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { batch_id: string; created: boolean };
    expect(data.created).toBe(true);
    expect(typeof data.batch_id).toBe('string');

    // batch_id stamped on the run + one lane per created task.
    expect(readBatchId(db, 'run-a')).toBe(data.batch_id);
    expect(batchRowCount(db)).toBe(1);
    expect(laneCount(db, data.batch_id)).toBe(3);

    // The run-row-changed signal fired (status re-asserted as running).
    expect(emitted).toEqual([{ runId: 'run-a', status: 'running' }]);
  });

  // (b) double-call -> created:false, no 2nd batch row.
  it('is idempotent: a second call returns created:false and does NOT mint a second batch', async () => {
    seedShipRun(db, { runId: 'run-b' });
    seedCreatedTask(db, { runId: 'run-b', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });
    seedCreatedTask(db, { runId: 'run-b', taskId: 'tsk_2', ref: 'TASK-002', seq: 1 });

    const first = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-b1', runId: 'run-b' }, first.socket);
    const firstResp = parseLastWrite(first.writes);
    expect(firstResp.ok).toBe(true);
    const firstBatchId = (firstResp.data as { batch_id: string; created: boolean }).batch_id;
    expect((firstResp.data as { created: boolean }).created).toBe(true);

    const emitted: RunStatusChangedEvent[] = [];
    runStatusEvents.on('changed', (e: RunStatusChangedEvent) => emitted.push(e));

    const second = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-b2', runId: 'run-b' }, second.socket);
    const secondResp = parseLastWrite(second.writes);
    expect(secondResp.ok).toBe(true);
    const secondData = secondResp.data as { batch_id: string; created: boolean };
    expect(secondData.created).toBe(false);
    expect(secondData.batch_id).toBe(firstBatchId);

    // No second batch minted; lanes unchanged.
    expect(batchRowCount(db)).toBe(1);
    expect(laneCount(db, firstBatchId)).toBe(2);
    // No re-render signal on the idempotent no-op.
    expect(emitted).toEqual([]);
  });

  // (c) empty -> ship_no_tasks_to_materialize.
  it('rejects with ship_no_tasks_to_materialize when the run created no tasks', async () => {
    seedShipRun(db, { runId: 'run-c' });

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-c', runId: 'run-c' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('ship_no_tasks_to_materialize');
    // No batch row, batch_id still NULL.
    expect(batchRowCount(db)).toBe(0);
    expect(readBatchId(db, 'run-c')).toBeNull();
  });

  it('rejects an explicit subset of only non-created ids with ship_no_tasks_to_materialize', async () => {
    seedShipRun(db, { runId: 'run-c2' });
    seedCreatedTask(db, { runId: 'run-c2', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-sprint-batch', requestId: 'cb-c2', runId: 'run-c2', taskIds: ['tsk_other', 'tsk_nope'] },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('ship_no_tasks_to_materialize');
    expect(batchRowCount(db)).toBe(0);
    expect(readBatchId(db, 'run-c2')).toBeNull();
  });

  // (d) crash/resume (batch_id NULL) -> re-mint once.
  it('crash/resume: a run left with NULL batch_id re-mints exactly one batch', async () => {
    // Simulate a crash AFTER tasks were created but BEFORE the batch was minted
    // (batch_id still NULL — RunLauncher never stamps it for an idea-seeded run).
    seedShipRun(db, { runId: 'run-d', batchId: null });
    seedCreatedTask(db, { runId: 'run-d', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });
    seedCreatedTask(db, { runId: 'run-d', taskId: 'tsk_2', ref: 'TASK-002', seq: 1 });

    expect(readBatchId(db, 'run-d')).toBeNull();

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-d', runId: 'run-d' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { batch_id: string; created: boolean };
    expect(data.created).toBe(true);
    expect(readBatchId(db, 'run-d')).toBe(data.batch_id);
    expect(batchRowCount(db)).toBe(1);
    expect(laneCount(db, data.batch_id)).toBe(2);
  });

  // (e) over-cap -> ship_batch_too_large.
  it('rejects with ship_batch_too_large when the task count exceeds the substrate cap', async () => {
    seedShipRun(db, { runId: 'run-e', substrate: 'sdk' });
    const overCap = SPRINT_BATCH_MAX_TASKS.sdk + 1;
    for (let i = 0; i < overCap; i++) {
      seedCreatedTask(db, { runId: 'run-e', taskId: `tsk_${i}`, ref: `TASK-${100 + i}`, seq: 1 });
    }

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-e', runId: 'run-e' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('ship_batch_too_large');
    // Nothing minted, batch_id still NULL.
    expect(batchRowCount(db)).toBe(0);
    expect(readBatchId(db, 'run-e')).toBeNull();
  });

  // (f) explicit taskIds subset -> only those become lanes.
  it('materializes ONLY the approved subset when explicit taskIds are passed', async () => {
    seedShipRun(db, { runId: 'run-f' });
    seedCreatedTask(db, { runId: 'run-f', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });
    seedCreatedTask(db, { runId: 'run-f', taskId: 'tsk_2', ref: 'TASK-002', seq: 1 });
    seedCreatedTask(db, { runId: 'run-f', taskId: 'tsk_3', ref: 'TASK-003', seq: 1 });

    const { socket, writes } = makeSocketDouble();
    // Approve only 2 of the 3 created tasks; pass an unknown id too (must be dropped).
    await handler.handleMessage(
      { type: 'mcp-create-sprint-batch', requestId: 'cb-f', runId: 'run-f', taskIds: ['tsk_1', 'tsk_3', 'tsk_unknown'] },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { batch_id: string; created: boolean };
    expect(data.created).toBe(true);

    // Exactly the 2 approved+created tasks have lanes (the unknown id was dropped).
    expect(laneCount(db, data.batch_id)).toBe(2);
    const laneTaskIds = (
      db.prepare('SELECT task_id FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY task_id').all(data.batch_id) as Array<{
        task_id: string;
      }>
    ).map((r) => r.task_id);
    expect(laneTaskIds).toEqual(['tsk_1', 'tsk_3']);
  });

  // Run-context guards (parity with the other run-bound writes).
  it("rejects the 'orchestrator' sentinel runId before any DB touch", async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-g', runId: 'orchestrator' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('task_write_requires_real_run');
  });

  it('rejects a terminal run with run_not_active (no batch minted)', async () => {
    seedShipRun(db, { runId: 'run-done', status: 'completed' });
    seedCreatedTask(db, { runId: 'run-done', taskId: 'tsk_1', ref: 'TASK-001', seq: 1 });

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-h', runId: 'run-done' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_not_active');
    expect(batchRowCount(db)).toBe(0);
  });

  it('rejects a missing run with run_not_found', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'cb-i', runId: 'no-such-run' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_not_found');
  });
});
