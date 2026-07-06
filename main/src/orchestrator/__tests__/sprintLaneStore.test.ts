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
 * Uses a migration-backed in-memory DB (006 → 011 → 014 → 015 → 022 → 023 →
 * 025), mirroring mcpQueryHandler.test.ts's buildTaskDb so the tasks LEFT JOIN
 * is exercised against the real entity schema.
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
  db.exec(readFileSync(join(migDir, '025_sprint_lane_attempts.sql'), 'utf-8'));
  return db;
}

/** Insert a real tasks row so the lane join resolves ref/title. */
function seedTask(db: Database.Database, id: string, ref: string, title: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-5')`,
  ).run(id, ref, title);
}

/**
 * Migration-backed in-memory DB carried all the way to the collapsed board
 * (006 → 011 → 014 → 015 → 022 → 023 → 024 → 025 → 042), so the Q1 eligibility
 * guard's tasks.approved_at / tasks.archived_at columns + the 4-stage board
 * (positions 1/6/9/10) exist. The base buildLaneDb stops at 025 (pre-042), where
 * the guard degrades to permissive — the right substrate for the lane-mechanics
 * tests, which seed synthetic ids.
 */
function buildReadyLaneDb(): Database.Database {
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

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const file of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '022_sprint_batches.sql',
    '023_sprint_lane_step.sql',
    '024_archive_in_place.sql',
    '025_sprint_lane_attempts.sql',
    '042_collapse_board.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  return db;
}

/**
 * Seed a real tasks row on the collapsed board (buildReadyLaneDb). Defaults to
 * an ELIGIBLE task: approved + position 6 ('Ready for development') + not
 * archived. Override `position` / `approved` / `archived` to exercise the guard.
 */
function seedReadyTask(
  db: Database.Database,
  id: string,
  ref: string,
  title: string,
  opts: { position?: number; approved?: boolean; archived?: boolean } = {},
): void {
  const position = opts.position ?? 6;
  const approved = opts.approved ?? true;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, approved_at, archived_at)
     VALUES (?, 1, ?, ?, 'board-1-default', ?, ?, ?)`,
  ).run(
    id,
    ref,
    title,
    `stage-board-1-default-${position}`,
    approved ? now : null,
    opts.archived ? now : null,
  );
}

/** Insert a task_dependencies edge (both endpoints must be real tasks rows — FK). */
function seedDependency(
  db: Database.Database,
  taskId: string,
  dependsOnTaskId: string,
  kind: 'blocking' | 'related' = 'blocking',
): void {
  db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)').run(
    taskId,
    dependsOnTaskId,
    kind,
  );
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
  // createForRun — Q1 sprint-eligibility guard (collapsed-board schema)
  //
  // Runs against buildReadyLaneDb (through migration 042) so the guard is LIVE:
  // only approved, non-archived tasks at a ready-or-later, non-terminal stage
  // seed lanes. The base buildLaneDb (pre-042) degrades the guard to permissive,
  // which is why the lane-mechanics tests above still seed synthetic ids.
  // ---------------------------------------------------------------------------

  describe('createForRun — Q1 eligibility guard', () => {
    let rdb: Database.Database;
    let rstore: SprintLaneStore;

    beforeEach(() => {
      rdb = buildReadyLaneDb();
      rstore = SprintLaneStore.initialize(dbAdapter(rdb));
    });

    afterEach(() => {
      rdb.close();
    });

    function laneTaskIds(batchId: string): string[] {
      return (
        rdb
          .prepare('SELECT task_id FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY id ASC')
          .all(batchId) as Array<{ task_id: string }>
      ).map((r) => r.task_id);
    }

    it('includes an approved position-6 task and excludes a PENDING (approved_at NULL) task', () => {
      seedReadyTask(rdb, 'tsk_ready', 'TASK-001', 'Ready', { position: 6, approved: true });
      seedReadyTask(rdb, 'tsk_pending', 'TASK-002', 'Pending', { position: 6, approved: false });

      const { batchId } = rstore.createForRun(1, 'sdk', ['tsk_ready', 'tsk_pending']);

      // Only the approved, ready task seeded a lane; the pending one was dropped.
      expect(laneTaskIds(batchId)).toEqual(['tsk_ready']);
    });

    it('excludes archived, done-terminal, and below-position-6 tasks', () => {
      seedReadyTask(rdb, 'tsk_ready', 'TASK-001', 'Ready', { position: 6 });
      seedReadyTask(rdb, 'tsk_archived', 'TASK-002', 'Archived', { position: 6, archived: true });
      seedReadyTask(rdb, 'tsk_done', 'TASK-003', 'Done', { position: 9 }); // terminal 'Done'
      seedReadyTask(rdb, 'tsk_wontdo', 'TASK-004', "Won't do", { position: 10 }); // terminal
      seedReadyTask(rdb, 'tsk_idea', 'TASK-005', 'On the Idea column', { position: 1 }); // < 6

      const { batchId } = rstore.createForRun(1, 'sdk', [
        'tsk_ready',
        'tsk_archived',
        'tsk_done',
        'tsk_wontdo',
        'tsk_idea',
      ]);

      expect(laneTaskIds(batchId)).toEqual(['tsk_ready']);
    });

    it('rejects candidates that ALL fail eligibility with no_eligible_tasks + a why message', () => {
      seedReadyTask(rdb, 'tsk_pending', 'TASK-001', 'Pending', { approved: false });
      try {
        rstore.createForRun(1, 'sdk', ['tsk_pending']);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SprintLaneError);
        // Distinct code (not the generic bad_request) so the MCP seam can map it to
        // 'ship_no_tasks_to_materialize' with a reason.
        expect((err as SprintLaneError).code).toBe('no_eligible_tasks');
        expect((err as SprintLaneError).message).toMatch(/1 candidate task\(s\) exist but none are sprint-eligible/);
        expect((err as SprintLaneError).message).toMatch(/approve-plan gate/);
      }
      // No batch or lanes were written.
      expect(rdb.prepare('SELECT COUNT(*) AS n FROM sprint_batches').get()).toEqual({ n: 0 });
      expect(rdb.prepare('SELECT COUNT(*) AS n FROM sprint_batch_tasks').get()).toEqual({ n: 0 });
    });

    it('still rejects a truly EMPTY selection with bad_request (not no_eligible_tasks)', () => {
      try {
        rstore.createForRun(1, 'sdk', []);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
    });

    it('drops a candidate id with no tasks row (inner JOIN)', () => {
      seedReadyTask(rdb, 'tsk_ready', 'TASK-001', 'Ready');
      const { batchId } = rstore.createForRun(1, 'sdk', ['tsk_ready', 'tsk_ghost']);
      expect(laneTaskIds(batchId)).toEqual(['tsk_ready']);
    });

    it('filterEligibleTaskIds preserves input order and collapses duplicates', () => {
      seedReadyTask(rdb, 'tsk_a', 'TASK-001', 'A');
      seedReadyTask(rdb, 'tsk_b', 'TASK-002', 'B', { approved: false });
      seedReadyTask(rdb, 'tsk_c', 'TASK-003', 'C');
      expect(rstore.filterEligibleTaskIds(1, ['tsk_c', 'tsk_b', 'tsk_a', 'tsk_c'])).toEqual([
        'tsk_c',
        'tsk_a',
      ]);
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

      // Fresh lanes: first pass, no in-batch blockers.
      expect(lanes[0].attempts).toBe(0);
      expect(lanes[0].blockedByRefs).toEqual([]);
    });

    it('returns an empty array for an unknown batch', () => {
      expect(store.listLanes('no-such-batch')).toEqual([]);
    });

    it('reports an un-integrated in-batch blocking prereq via its display ref', () => {
      seedTask(db, 'tsk_pre', 'TASK-001', 'Prereq');
      seedTask(db, 'tsk_dep', 'TASK-002', 'Dependent');
      seedDependency(db, 'tsk_dep', 'tsk_pre');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_pre', 'tsk_dep']);

      const lanes = store.listLanes(batchId);
      expect(lanes.find((l) => l.taskId === 'tsk_pre')!.blockedByRefs).toEqual([]);
      expect(lanes.find((l) => l.taskId === 'tsk_dep')!.blockedByRefs).toEqual(['TASK-001']);
    });

    it("drops a prereq from blockedByRefs once its lane is 'integrated'", () => {
      seedTask(db, 'tsk_pre', 'TASK-001', 'Prereq');
      seedTask(db, 'tsk_dep', 'TASK-002', 'Dependent');
      seedDependency(db, 'tsk_dep', 'tsk_pre');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_pre', 'tsk_dep']);

      store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_pre', status: 'integrated' });

      const lanes = store.listLanes(batchId);
      expect(lanes.find((l) => l.taskId === 'tsk_dep')!.blockedByRefs).toEqual([]);
    });

    it('ignores a blocking dependency whose prereq has no lane in this batch', () => {
      seedTask(db, 'tsk_out', 'TASK-009', 'Outside the batch');
      seedTask(db, 'tsk_dep', 'TASK-002', 'Dependent');
      seedDependency(db, 'tsk_dep', 'tsk_out');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_dep']);

      expect(store.listLanes(batchId)[0].blockedByRefs).toEqual([]);
    });

    it("ignores kind='related' edges (advisory metadata, never gating)", () => {
      seedTask(db, 'tsk_rel', 'TASK-003', 'Related only');
      seedTask(db, 'tsk_pre', 'TASK-001', 'Prereq');
      seedTask(db, 'tsk_dep', 'TASK-002', 'Dependent');
      seedDependency(db, 'tsk_dep', 'tsk_rel', 'related');
      seedDependency(db, 'tsk_dep', 'tsk_pre');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_rel', 'tsk_pre', 'tsk_dep']);

      const lanes = store.listLanes(batchId);
      // 'related' is advisory metadata — it never gates the lane.
      expect(lanes.find((l) => l.taskId === 'tsk_dep')!.blockedByRefs).toEqual(['TASK-001']);
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

    it('resolves the lane by display ref (TASK-001) — agents pass refs, not opaque ids', () => {
      seedTask(db, 'tsk_a', 'TASK-001', 'First task');
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      // The agent only sees the display ref in the seeded sprint-task block.
      const lane = store.updateLane({
        runId: 'run-1',
        batchId,
        taskId: 'TASK-001',
        status: 'running',
        currentStepId: 'implement',
      });

      // It resolved to the opaque id and wrote the lane.
      expect(lane.taskId).toBe('tsk_a');
      expect(lane.status).toBe('running');
      expect(lane.ref).toBe('TASK-001');
      const row = db
        .prepare('SELECT status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, 'tsk_a') as { status: string };
      expect(row.status).toBe('running');
    });

    it('still resolves by opaque id when the tasks row is absent (no join requirement)', () => {
      // No seedTask for tsk_a — the opaque-id path must not require a tasks row.
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      const lane = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running' });
      expect(lane.taskId).toBe('tsk_a');
      expect(lane.status).toBe('running');
    });

    it('a step-only update leaves status untouched; null clears the step', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      const stepped = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'write-tests' });
      expect(stepped.status).toBe('queued');
      expect(stepped.currentStepId).toBe('write-tests');

      const cleared = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: null });
      expect(cleared.currentStepId).toBeNull();
    });

    it('writes attempt verbatim onto the attempts column and returns it on the row', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);

      const lane = store.updateLane({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        currentStepId: 'implement',
        attempt: 2,
      });
      expect(lane.attempts).toBe(2);

      const row = db
        .prepare('SELECT attempts FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, 'tsk_a') as { attempts: number };
      expect(row.attempts).toBe(2);

      // An attempt-less follow-up write leaves the counter untouched.
      const next = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'task-verify' });
      expect(next.attempts).toBe(2);
    });

    it('rejects a non-integer or < 1 attempt with bad_request (no write)', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      for (const attempt of [0, -1, 1.5]) {
        try {
          store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', attempt });
          expect.unreachable('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(SprintLaneError);
          expect((err as SprintLaneError).code).toBe('bad_request');
        }
      }
      const row = db
        .prepare('SELECT attempts FROM sprint_batch_tasks WHERE batch_id = ?')
        .get(batchId) as { attempts: number };
      expect(row.attempts).toBe(0);
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

    it('accepts a caller-supplied allowedStepIds value (in-set step writes; out-of-set rejected)', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      const allowedStepIds = ['design', 'build', 'ship'] as const;

      // An id inside the custom vocabulary writes even though it is NOT a
      // SPRINT_LANE_STEP_IDS member.
      const lane = store.updateLane({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        currentStepId: 'build',
        allowedStepIds,
      });
      expect(lane.currentStepId).toBe('build');

      // An id outside the custom vocabulary is rejected (no write).
      try {
        store.updateLane({
          runId: 'run-1',
          batchId,
          taskId: 'tsk_a',
          currentStepId: 'deploy',
          allowedStepIds,
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
      const row = db
        .prepare('SELECT current_step_id FROM sprint_batch_tasks WHERE batch_id = ?')
        .get(batchId) as { current_step_id: string | null };
      // Last successful write stands; the rejected 'deploy' did not land.
      expect(row.current_step_id).toBe('build');
    });

    it('rejects a SPRINT_LANE_STEP_IDS step when a custom allowedStepIds excludes it', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      try {
        store.updateLane({
          runId: 'run-1',
          batchId,
          taskId: 'tsk_a',
          // 'implement' is a real sprint lane step, but absent from this vocabulary.
          currentStepId: 'implement',
          allowedStepIds: ['design', 'build'],
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as SprintLaneError).code).toBe('bad_request');
      }
    });

    it('with no allowedStepIds still enforces SPRINT_LANE_STEP_IDS (orchestrated parity)', () => {
      const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
      // A SPRINT_LANE_STEP_IDS member still writes.
      const ok = store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'implement' });
      expect(ok.currentStepId).toBe('implement');
      // A non-member is still rejected (default vocabulary unchanged).
      try {
        store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'build' });
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

      store.updateLane({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        status: 'running',
        currentStepId: 'implement',
        attempt: 2,
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        runId: 'run-1',
        batchId,
        taskId: 'tsk_a',
        status: 'running',
        currentStepId: 'implement',
        attempts: 2,
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
