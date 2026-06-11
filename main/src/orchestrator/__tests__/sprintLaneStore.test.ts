/**
 * Unit tests for SprintLaneStore — the single write chokepoint for sprint
 * LANES (sprint_batch_tasks rows repurposed by the sprint-orchestrator
 * redesign; migrations 022 + 023).
 *
 * Coverage:
 *  1. createForRun — one txn inserts the sprint_batches row (status 'running',
 *     concurrency 5, integration_branch NULL) + one queued lane per task id
 *     (deduped); empty selection rejected with bad_request.
 *  2. listLanes — insertion order; ref/title resolved fail-soft from the tasks
 *     table (null when no task row exists).
 *  3. updateLane — status/step writes bump updated_at; 'integrated' stamps
 *     integrated_at; returns the joined SprintLaneRow.
 *  4. updateLane rejections — unknown lane (lane_not_found), out-of-vocabulary
 *     step / status / no-field request (bad_request).
 *  5. Event emission — SprintLaneChangedEvent on sprintLaneChannel(runId)
 *     after the write, with an ISO-8601 timestamp.
 *  6. markBatchTerminal — guarded UPDATE: non-terminal only (a second terminal
 *     flip is a no-op).
 *
 * Uses a migration-backed in-memory DB (006 → 011 → 014 → 015 → 022 → 023),
 * mirroring mcpQueryHandler.test.ts's buildTaskDb so the tasks LEFT JOIN is
 * exercised against the real entity schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SprintLaneStore,
  SprintLaneError,
  sprintLaneEvents,
  sprintLaneChannel,
} from '../sprintLaneStore';
import type { SprintLaneChangedEvent } from '../../../../shared/types/sprintBatch';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildLaneDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // The 014 seed is `... FROM projects`, so the projects table MUST exist
  // (with project 1) BEFORE migrations run or no board/stages seed.
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

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '023_sprint_lane_step.sql'), 'utf-8'));
  return db;
}

/** Insert a real tasks row so the lane join resolves ref/title. */
function seedTask(db: Database.Database, id: string, ref: string, title: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-5')`,
  ).run(id, ref, title);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintLaneStore', () => {
  let db: Database.Database;
  let store: SprintLaneStore;

  beforeEach(() => {
    db = buildLaneDb();
    store = SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    db.close();
  });

  // ---------------------------------------------------------------------------
  // createForRun
  // ---------------------------------------------------------------------------

  describe('createForRun', () => {
    it('inserts a running batch (concurrency 5, no integration branch) + one queued lane per task', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);

      const batch = db.prepare('SELECT * FROM sprint_batches WHERE id = ?').get(batchId) as {
        project_id: number;
        substrate: string;
        status: string;
        integration_branch: string | null;
        concurrency: number;
      };
      expect(batch.project_id).toBe(1);
      expect(batch.substrate).toBe('sdk');
      expect(batch.status).toBe('running');
      expect(batch.integration_branch).toBeNull();
      expect(batch.concurrency).toBe(5);

      const lanes = db
        .prepare('SELECT task_id, status, current_step_id FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY id ASC')
        .all(batchId) as Array<{ task_id: string; status: string; current_step_id: string | null }>;
      expect(lanes).toEqual([
        { task_id: 'tsk_a', status: 'queued', current_step_id: null },
        { task_id: 'tsk_b', status: 'queued', current_step_id: null },
      ]);
    });

    it('collapses duplicate task ids (UNIQUE(batch_id, task_id))', () => {
      const { batchId } = store.createForRun(1, 'interactive', ['tsk_a', 'tsk_a', 'tsk_b']);
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM sprint_batch_tasks WHERE batch_id = ?')
        .get(batchId) as { n: number };
      expect(count.n).toBe(2);
    });

    it('rejects an empty selection with bad_request', () => {
      expect(() => store.createForRun(1, 'sdk', [])).toThrowError(SprintLaneError);
      try {
        store.createForRun(1, 'sdk', []);
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // listLanes
  // ---------------------------------------------------------------------------

  describe('listLanes', () => {
    it('returns lanes in insertion order with ref/title joined from tasks (fail-soft null)', () => {
      seedTask(db, 'tsk_a', 'TASK-001', 'First task');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_ghost']);

      const lanes = store.listLanes(batchId);
      expect(lanes).toHaveLength(2);

      expect(lanes[0].batchId).toBe(batchId);
      expect(lanes[0].taskId).toBe('tsk_a');
      expect(lanes[0].status).toBe('queued');
      expect(lanes[0].currentStepId).toBeNull();
      expect(lanes[0].ref).toBe('TASK-001');
      expect(lanes[0].title).toBe('First task');
      expect(typeof lanes[0].updatedAt).toBe('string');

      // No tasks row for tsk_ghost — ref/title resolve fail-soft to null.
      expect(lanes[1].taskId).toBe('tsk_ghost');
      expect(lanes[1].ref).toBeNull();
      expect(lanes[1].title).toBeNull();
    });

    it('returns an empty array for an unknown batch', () => {
      expect(store.listLanes('no-such-batch')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateLane
  // ---------------------------------------------------------------------------

  describe('updateLane', () => {
    it('writes status + current step, bumps updated_at, and returns the joined row', () => {
      seedTask(db, 'tsk_a', 'TASK-001', 'First task');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      const lane = store.updateLane({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        status: 'running',
        currentStepId: 'implement',
      });

      expect(lane.status).toBe('running');
      expect(lane.currentStepId).toBe('implement');
      expect(lane.ref).toBe('TASK-001');
      expect(lane.title).toBe('First task');
      // updated_at is the store's ISO write, not the CURRENT_TIMESTAMP default.
      expect(lane.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const row = db
        .prepare('SELECT status, current_step_id, integrated_at FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, 'tsk_a') as { status: string; current_step_id: string | null; integrated_at: string | null };
      expect(row.status).toBe('running');
      expect(row.current_step_id).toBe('implement');
      expect(row.integrated_at).toBeNull();
    });

    it('a step-only update leaves status untouched; null clears the step', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      const stepped = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'write-tests' });
      expect(stepped.status).toBe('queued');
      expect(stepped.currentStepId).toBe('write-tests');

      const cleared = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: null });
      expect(cleared.currentStepId).toBeNull();
    });

    it("status 'integrated' stamps integrated_at", () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated' });

      const row = db
        .prepare('SELECT status, integrated_at FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, 'tsk_a') as { status: string; integrated_at: string | null };
      expect(row.status).toBe('integrated');
      expect(row.integrated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('rejects an unknown (batch, task) lane with lane_not_found', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      try {
        store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_other', status: 'running' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SprintLaneError);
        expect((err as SprintLaneError).code).toBe('lane_not_found');
      }
    });

    it('rejects an out-of-vocabulary step with bad_request (no write)', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      try {
        store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'deploy' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
      const row = db
        .prepare('SELECT current_step_id FROM sprint_batch_tasks WHERE batch_id = ?')
        .get(batchId) as { current_step_id: string | null };
      expect(row.current_step_id).toBeNull();
    });

    it('rejects an out-of-domain status and a no-field request with bad_request', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      try {
        store.updateLane({
          runId: 'run-1',
          batchId,
          taskId: 'tsk_a',
          status: 'done' as unknown as 'queued',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
      try {
        store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
    });

    it('emits a SprintLaneChangedEvent on sprintLaneChannel(runId) after the write', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      const received: SprintLaneChangedEvent[] = [];
      sprintLaneEvents.on(sprintLaneChannel('run-1'), (evt: SprintLaneChangedEvent) => {
        received.push(evt);
      });

      store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement' });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        status: 'running',
        currentStepId: 'implement',
      });
      expect(received[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('does NOT emit on a rejected write', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      let emitted = 0;
      sprintLaneEvents.on(sprintLaneChannel('run-1'), () => {
        emitted += 1;
      });
      expect(() =>
        store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'deploy' }),
      ).toThrowError(SprintLaneError);
      expect(emitted).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // markBatchTerminal
  // ---------------------------------------------------------------------------

  describe('markBatchTerminal', () => {
    it('flips a running batch to completed and stamps completed_at', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      store.markBatchTerminal(batchId, 'completed');

      const batch = db.prepare('SELECT status, completed_at FROM sprint_batches WHERE id = ?').get(batchId) as {
        status: string;
        completed_at: string | null;
      };
      expect(batch.status).toBe('completed');
      expect(batch.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('is a guarded no-op on an already-terminal batch', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      store.markBatchTerminal(batchId, 'completed');

      // A late 'failed' must NOT overwrite the terminal state.
      store.markBatchTerminal(batchId, 'failed');

      const batch = db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as {
        status: string;
      };
      expect(batch.status).toBe('completed');
    });

    it('flips a running batch to failed', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      store.markBatchTerminal(batchId, 'failed');
      const batch = db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as {
        status: string;
      };
      expect(batch.status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton lifecycle
  // ---------------------------------------------------------------------------

  it('getInstance throws before initialize', () => {
    SprintLaneStore._resetForTesting();
    expect(() => SprintLaneStore.getInstance()).toThrow(/not been initialized/);
  });
});
