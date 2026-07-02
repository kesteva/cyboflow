/**
 * Unit tests for McpQueryHandler.handleCreateSprintBatch (`mcp-create-sprint-batch`)
 * — the mid-run sprint-batch materialization seam of the 'ship' workflow.
 *
 * This handler is the single highest-blast-radius MCP write not otherwise unit
 * tested: it mints a batch + per-task lanes, CAS-stamps workflow_runs.batch_id,
 * and MUST be idempotent + transactional so a crash/resume re-call cannot orphan
 * a second batch or clobber lane status. These tests retire: silent batch
 * double-mint, run-created-task-subset drop, and the substrate-keyed cap bypass.
 *
 * Fixture strategy: tasks + their run-linking entity_events rows are seeded
 * DIRECTLY (createForRun reads the `tasks` table; listRunCreatedTaskIds reads the
 * `entity_events` created-log) — no TaskChangeRouter round-trip needed, which
 * keeps each case fast and hermetic. TaskChangeRouter is intentionally left
 * uninitialized so the fire-and-forget retireRunOwnedIdeas swallow-path (owns no
 * ideas here) is exercised without a live router.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as net from 'net';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { SprintLaneStore, sprintLaneEvents } from '../../sprintLaneStore';
import { TaskChangeRouter } from '../../taskChangeRouter';
import { runStatusEvents } from '../../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Socket double + response helpers
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

// ---------------------------------------------------------------------------
// DB fixture: 006 → 011 → 014 → 015 → 024 → 028 → 042 (entity model + collapsed
// board with approved_at) + 022/023/025 (sprint batches) + a substrate column.
// Mirrors buildTaskDb + buildLaneDb in mcpQueryHandler.test.ts.
// ---------------------------------------------------------------------------

const STAGE_READY = 'stage-board-1-default-6'; // pos 6, "Ready for development", non-terminal

function buildBatchDb(): Database.Database {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '024_archive_in_place.sql',
    '028_idea_attachments.sql',
    '042_collapse_board.sql',
    '022_sprint_batches.sql',
    '023_sprint_lane_step.sql',
    '025_sprint_lane_attempts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  // The handler reads workflow_runs.substrate defensively; seed the column so we
  // can exercise both the 'sdk' default (NULL) and 'interactive' cap branches.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN substrate TEXT');
  return db;
}

/** Seed a workflows + workflow_runs pair (no batch stamp by default). */
function seedRun(
  db: Database.Database,
  opts: { runId: string; status?: string; substrate?: string | null; batchId?: string | null },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, substrate, batch_id)
     VALUES (?, 'wf-1', 1, ?, 'materialize-batch', '{"materialize-batch":"planner"}', ?, ?)`,
  ).run(opts.runId, opts.status ?? 'running', opts.substrate ?? null, opts.batchId ?? null);
}

let seq = 0;
/**
 * Seed a task + its run-linking entity_events 'created' row. `eligible` controls
 * whether createForRun's Q1 filter keeps it (approved_at set + ready stage).
 */
function seedCreatedTask(
  db: Database.Database,
  runId: string,
  taskId: string,
  ref: string,
  eligible: boolean,
): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, approved_at, archived_at)
     VALUES (?, 1, ?, ?, 'board-1-default', ?, ?, NULL)`,
  ).run(taskId, ref, `Task ${ref}`, eligible ? STAGE_READY : 'stage-board-1-default-1', eligible ? '2026-01-01T00:00:00Z' : null);
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES ('task', ?, ?, 'created', 'agent:planner', ?)`,
  ).run(taskId, seq++, runId);
}

/** Seed ONLY a run-linking entity_events row (no tasks row) — for cap tests that
 *  short-circuit before createForRun's eligibility filter. */
function seedCreatedTaskEventOnly(db: Database.Database, runId: string, taskId: string): void {
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES ('task', ?, ?, 'created', 'agent:planner', ?)`,
  ).run(taskId, seq++, runId);
}

function batchIdOf(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT batch_id AS b FROM workflow_runs WHERE id = ?').get(runId) as { b: string | null } | undefined;
  return row?.b ?? null;
}
function batchCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sprint_batches').get() as { n: number }).n;
}
function laneTaskIds(db: Database.Database, batchId: string): string[] {
  return (db.prepare('SELECT task_id AS t FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY task_id').all(batchId) as Array<{ t: string }>).map((r) => r.t);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpQueryHandler.handleCreateSprintBatch', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    seq = 0;
    db = buildBatchDb();
    SprintLaneStore.initialize(dbAdapter(db));
    // Leave TaskChangeRouter UNINITIALIZED — retireRunOwnedIdeas' getInstance()
    // throw is swallowed (best-effort), proving retire failure never fails the reply.
    TaskChangeRouter._resetForTesting();
    handler = new McpQueryHandler(dbAdapter(db));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    runStatusEvents.removeAllListeners();
    db.close();
  });

  it('happy path: mints batch + one lane per created task, CAS-stamps batch_id, emits run-status changed', async () => {
    seedRun(db, { runId: 'run-1' });
    seedCreatedTask(db, 'run-1', 'tsk_a', 'TASK-001', true);
    seedCreatedTask(db, 'run-1', 'tsk_b', 'TASK-002', true);

    const emitted: RunStatusChangedEvent[] = [];
    runStatusEvents.on('changed', (e: RunStatusChangedEvent) => emitted.push(e));

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, socket);

    expect(writes[writes.length - 1].endsWith('\n')).toBe(true);
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    const data = res.data as { batch_id: string; created: boolean };
    expect(data.created).toBe(true);
    expect(typeof data.batch_id).toBe('string');

    // CAS stamp landed on the run row, and both lanes exist.
    expect(batchIdOf(db, 'run-1')).toBe(data.batch_id);
    expect(laneTaskIds(db, data.batch_id)).toEqual(['tsk_a', 'tsk_b']);

    // The swimlane-mount signal fired once for this run, re-asserting 'running'.
    expect(emitted).toEqual([{ runId: 'run-1', status: 'running' }]);
  });

  it('is idempotent: a second call returns the existing batchId with created:false and mints no second batch', async () => {
    seedRun(db, { runId: 'run-1' });
    seedCreatedTask(db, 'run-1', 'tsk_a', 'TASK-001', true);

    const first = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, first.socket);
    const firstBatch = (parseLastWrite(first.writes).data as { batch_id: string }).batch_id;
    expect(batchCount(db)).toBe(1);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-2', runId: 'run-1' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    const data = res.data as { batch_id: string; created: boolean };
    expect(data.created).toBe(false);
    expect(data.batch_id).toBe(firstBatch);
    // No second batch minted — the idempotency read short-circuited before createForRun.
    expect(batchCount(db)).toBe(1);
  });

  it('explicit taskIds subset intersects against run-created tasks — a foreign id is dropped', async () => {
    seedRun(db, { runId: 'run-1' });
    seedCreatedTask(db, 'run-1', 'tsk_a', 'TASK-001', true);
    seedCreatedTask(db, 'run-1', 'tsk_b', 'TASK-002', true);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1', taskIds: ['tsk_a', 'tsk_not_mine'] },
      socket,
    );

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    const batchId = (res.data as { batch_id: string }).batch_id;
    // Only the run-created 'tsk_a' materialized; the foreign id AND the un-selected
    // 'tsk_b' are excluded.
    expect(laneTaskIds(db, batchId)).toEqual(['tsk_a']);
  });

  it('omitted taskIds materializes ALL run-created tasks', async () => {
    seedRun(db, { runId: 'run-1' });
    seedCreatedTask(db, 'run-1', 'tsk_a', 'TASK-001', true);
    seedCreatedTask(db, 'run-1', 'tsk_b', 'TASK-002', true);
    seedCreatedTask(db, 'run-1', 'tsk_c', 'TASK-003', true);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, socket);

    const batchId = (parseLastWrite(writes).data as { batch_id: string }).batch_id;
    expect(laneTaskIds(db, batchId)).toEqual(['tsk_a', 'tsk_b', 'tsk_c']);
  });

  it('empty resolvable set → ship_no_tasks_to_materialize with NO write', async () => {
    seedRun(db, { runId: 'run-1' }); // run created NO tasks

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ship_no_tasks_to_materialize');
    // No batch minted, no stamp.
    expect(batchCount(db)).toBe(0);
    expect(batchIdOf(db, 'run-1')).toBeNull();
  });

  it('over-cap under the sdk default → ship_batch_too_large (16 > SPRINT_BATCH_MAX_TASKS.sdk = 15)', async () => {
    seedRun(db, { runId: 'run-1', substrate: null }); // null substrate → 'sdk' default
    for (let i = 0; i < 16; i++) seedCreatedTaskEventOnly(db, 'run-1', `t${i}`);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ship_batch_too_large');
    expect(batchCount(db)).toBe(0);
    expect(batchIdOf(db, 'run-1')).toBeNull();
  });

  it('cap is substrate-keyed: 11 created tasks trip the interactive cap (10) but NOT the sdk cap (15)', async () => {
    // interactive: 11 > 10 → ship_batch_too_large (cap fires before eligibility).
    seedRun(db, { runId: 'run-int', substrate: 'interactive' });
    for (let i = 0; i < 11; i++) seedCreatedTaskEventOnly(db, 'run-int', `i${i}`);
    const intSock = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-int', runId: 'run-int' }, intSock.socket);
    expect(parseLastWrite(intSock.writes).error).toBe('ship_batch_too_large');

    // sdk (default): 11 <= 15 → cap PASSES; these event-only ids have no eligible
    // tasks rows, so createForRun's Q1 filter empties the set → 'bad_request' — a
    // DIFFERENT rejection, proving the sdk cap did not trip at 11.
    seedRun(db, { runId: 'run-sdk', substrate: 'sdk' });
    for (let i = 0; i < 11; i++) seedCreatedTaskEventOnly(db, 'run-sdk', `s${i}`);
    const sdkSock = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-sdk', runId: 'run-sdk' }, sdkSock.socket);
    const sdkRes = parseLastWrite(sdkSock.writes);
    expect(sdkRes.ok).toBe(false);
    expect(sdkRes.error).not.toBe('ship_batch_too_large');
    expect(sdkRes.error).toBe('bad_request');
  });

  it('a createForRun throw (all tasks ineligible) rolls back: no batch minted, no orphan stamp', async () => {
    seedRun(db, { runId: 'run-1' });
    // Created but INELIGIBLE (approved_at NULL, stage pos 1) → passes empty/cap
    // guards but createForRun's Q1 filter drops all → SprintLaneError('bad_request').
    seedCreatedTask(db, 'run-1', 'tsk_a', 'TASK-001', false);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-1' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('bad_request');
    // The transaction rolled back — no batch row and the stamp is still NULL.
    expect(batchCount(db)).toBe(0);
    expect(batchIdOf(db, 'run-1')).toBeNull();
  });

  it('rejects the orchestrator sentinel run before any write (task_write_requires_real_run)', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'orchestrator' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('task_write_requires_real_run');
    expect(batchCount(db)).toBe(0);
  });

  it('rejects a terminal run (run_not_active) with no write', async () => {
    seedRun(db, { runId: 'run-done', status: 'completed' });
    seedCreatedTask(db, 'run-done', 'tsk_a', 'TASK-001', true);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-create-sprint-batch', requestId: 'b-1', runId: 'run-done' }, socket);

    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('run_not_active');
    expect(batchCount(db)).toBe(0);
  });
});
