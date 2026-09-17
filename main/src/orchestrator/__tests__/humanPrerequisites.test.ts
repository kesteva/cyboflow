/**
 * surfaceHumanPrerequisites (migration 137) — turning a freshly-minted sprint
 * batch's HUMAN prerequisites into standing review-queue items.
 *
 * The invariants that matter:
 *  - one NON-BLOCKING `human_task` item per human prerequisite, entity-linked
 *    to that task, naming the batch tasks waiting on it;
 *  - IDEMPOTENT on `source = 'human-task:<id>'`, ACROSS batches — a second
 *    sprint depending on the same human work must not mint a second to-do;
 *  - skips an archived human task and one at a TERMINAL stage (the work is
 *    finished or abandoned; re-raising it is noise);
 *  - ignores `related` edges (advisory — nobody is waiting) and agent
 *    prerequisites (a sprint lane handles those);
 *  - fail-soft: one item that cannot be written does not stop the others.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfaceHumanPrerequisites } from '../humanPrerequisites';
import { ReviewItemRouter } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '024_archive_in_place.sql',
    '034_findings_triage.sql',
    '085_review_item_audience.sql',
    '059_entity_category.sql',
    '137_task_executor.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

function stageId(position: number): string {
  return `stage-board-1-default-${position}`;
}

afterEach(() => {
  ReviewItemRouter._resetForTesting();
});

function seedTask(
  db: Database.Database,
  opts: {
    id: string;
    ref: string;
    title?: string;
    executor?: 'agent' | 'human';
    position?: number;
    archived?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, executor, archived_at)
     VALUES (?, 1, ?, ?, 'board-1-default', ?, ?, ?)`,
  ).run(
    opts.id,
    opts.ref,
    opts.title ?? `Title ${opts.ref}`,
    stageId(opts.position ?? 6),
    opts.executor ?? 'agent',
    opts.archived ? '2026-01-01T00:00:00.000Z' : null,
  );
}

function addEdge(
  db: Database.Database,
  taskId: string,
  dependsOn: string,
  kind: 'blocking' | 'related' = 'blocking',
): void {
  db.prepare(
    'INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)',
  ).run(taskId, dependsOn, kind);
}

interface ReviewRow {
  id: string;
  kind: string;
  blocking: number;
  title: string;
  body: string;
  source: string;
  entity_type: string;
  entity_id: string;
}

function reviewRows(db: Database.Database): ReviewRow[] {
  return db
    .prepare('SELECT id, kind, blocking, title, body, source, entity_type, entity_id FROM review_items')
    .all() as ReviewRow[];
}

/** A terminal stage on the seeded default board — the Done/Won't-do end. */
function terminalPosition(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT position FROM board_stages WHERE board_id = 'board-1-default' AND is_terminal = 1 ORDER BY position ASC LIMIT 1",
    )
    .get() as { position: number } | undefined;
  return row?.position ?? 9;
}

describe('surfaceHumanPrerequisites', () => {
  it('mints one non-blocking human_task item per human prerequisite, linked to that task', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_h', ref: 'TASK-009', title: 'Buy the domain', executor: 'human' });
    addEdge(db, 'tsk_a', 'tsk_h');

    const created = await surfaceHumanPrerequisites(dbAdapter(db), router, {
      projectId: 1,
      batchId: 'batch-1',
      taskIds: ['tsk_a'],
    });

    expect(created).toBe(1);
    const rows = reviewRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('human_task');
    expect(rows[0].blocking).toBe(0);
    expect(rows[0].title).toBe('Human work: TASK-009 Buy the domain');
    expect(rows[0].source).toBe('human-task:tsk_h');
    expect(rows[0].entity_type).toBe('task');
    expect(rows[0].entity_id).toBe('tsk_h');
    expect(rows[0].body).toContain('TASK-001 depends on this work.');
    expect(rows[0].body).toContain('The sprint continues without waiting');
    db.close();
  });

  it('lists EVERY dependent of one human task in a single item', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_b', ref: 'TASK-002' });
    seedTask(db, { id: 'tsk_h', ref: 'TASK-009', executor: 'human' });
    addEdge(db, 'tsk_a', 'tsk_h');
    addEdge(db, 'tsk_b', 'tsk_h');

    await surfaceHumanPrerequisites(dbAdapter(db), router, {
      projectId: 1,
      batchId: 'batch-1',
      taskIds: ['tsk_a', 'tsk_b'],
    });

    const rows = reviewRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('2 sprint tasks depend on this work: TASK-001, TASK-002.');
    db.close();
  });

  it('is IDEMPOTENT across batches — a second sprint on the same human work mints nothing', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_b', ref: 'TASK-002' });
    seedTask(db, { id: 'tsk_h', ref: 'TASK-009', executor: 'human' });
    addEdge(db, 'tsk_a', 'tsk_h');
    addEdge(db, 'tsk_b', 'tsk_h');

    const first = await surfaceHumanPrerequisites(dbAdapter(db), router, {
      projectId: 1,
      batchId: 'batch-1',
      taskIds: ['tsk_a'],
    });
    const second = await surfaceHumanPrerequisites(dbAdapter(db), router, {
      projectId: 1,
      batchId: 'batch-2',
      taskIds: ['tsk_b'],
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(reviewRows(db)).toHaveLength(1);
    db.close();
  });

  it('SKIPS a human prerequisite at a terminal stage (the work is already finished)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, {
      id: 'tsk_h',
      ref: 'TASK-009',
      executor: 'human',
      position: terminalPosition(db),
    });
    addEdge(db, 'tsk_a', 'tsk_h');

    const created = await surfaceHumanPrerequisites(dbAdapter(db), router, {
      projectId: 1,
      batchId: 'batch-1',
      taskIds: ['tsk_a'],
    });

    expect(created).toBe(0);
    expect(reviewRows(db)).toHaveLength(0);
    db.close();
  });

  it('SKIPS an archived human prerequisite', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_h', ref: 'TASK-009', executor: 'human', archived: true });
    addEdge(db, 'tsk_a', 'tsk_h');

    expect(
      await surfaceHumanPrerequisites(dbAdapter(db), router, {
        projectId: 1,
        batchId: 'batch-1',
        taskIds: ['tsk_a'],
      }),
    ).toBe(0);
    expect(reviewRows(db)).toHaveLength(0);
    db.close();
  });

  it('ignores AGENT prerequisites and RELATED edges', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_agent', ref: 'TASK-002' });
    seedTask(db, { id: 'tsk_h', ref: 'TASK-009', executor: 'human' });
    addEdge(db, 'tsk_a', 'tsk_agent'); // agent prereq — a lane handles it
    addEdge(db, 'tsk_a', 'tsk_h', 'related'); // advisory — nobody is waiting

    expect(
      await surfaceHumanPrerequisites(dbAdapter(db), router, {
        projectId: 1,
        batchId: 'batch-1',
        taskIds: ['tsk_a'],
      }),
    ).toBe(0);
    expect(reviewRows(db)).toHaveLength(0);
    db.close();
  });

  it('is a no-op for an empty batch and for a batch with no human prerequisites', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });

    expect(
      await surfaceHumanPrerequisites(dbAdapter(db), router, {
        projectId: 1,
        batchId: 'b',
        taskIds: [],
      }),
    ).toBe(0);
    expect(
      await surfaceHumanPrerequisites(dbAdapter(db), router, {
        projectId: 1,
        batchId: 'b',
        taskIds: ['tsk_a'],
      }),
    ).toBe(0);
    db.close();
  });

  it('fail-soft: one item that cannot be written does not stop the others', async () => {
    const db = buildDb();
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    seedTask(db, { id: 'tsk_h1', ref: 'TASK-008', executor: 'human' });
    seedTask(db, { id: 'tsk_h2', ref: 'TASK-009', executor: 'human' });
    addEdge(db, 'tsk_a', 'tsk_h1');
    addEdge(db, 'tsk_a', 'tsk_h2');

    const real = ReviewItemRouter.initialize(dbAdapter(db));
    const createIfNoPending: typeof real.createIfNoPending = vi
      .fn(real.createIfNoPending.bind(real))
      .mockRejectedValueOnce(new Error('disk on fire'));

    const created = await surfaceHumanPrerequisites(
      dbAdapter(db),
      { createIfNoPending },
      { projectId: 1, batchId: 'batch-1', taskIds: ['tsk_a'] },
    );

    expect(createIfNoPending).toHaveBeenCalledTimes(2);
    expect(created).toBe(1);
    expect(reviewRows(db)).toHaveLength(1);
    db.close();
  });

  it('degrades to a no-op on a pre-137 schema rather than throwing', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedTask(db, { id: 'tsk_a', ref: 'TASK-001' });
    // Simulate the column being absent by pointing the scan at a table without it.
    db.exec('ALTER TABLE tasks RENAME COLUMN executor TO executor_gone');

    await expect(
      surfaceHumanPrerequisites(dbAdapter(db), router, {
        projectId: 1,
        batchId: 'batch-1',
        taskIds: ['tsk_a'],
      }),
    ).resolves.toBe(0);
    db.close();
  });
});
