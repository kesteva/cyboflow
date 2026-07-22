/**
 * migration 077: in-artifact feedback on spec/architecture documents
 * (feedback_batches / feedback_comments, IDEA-033).
 *
 * Applies the chain 006 -> 011 -> 014 -> 015 -> 016 -> 077 against an
 * in-memory SQLite instance (mirrors reviewItemRouter.test.ts's buildDb —
 * feedback_batches/feedback_comments FK to workflow_runs, which 006 creates).
 * Proves: expected columns on both tables, the atype/status CHECK
 * constraints, the lookup indexes, and FK cascade from a workflow_runs
 * delete removing both a run's batches and comments.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(__dirname, '..', 'migrations');

const THROUGH_016 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
];

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
  for (const f of [...THROUGH_016, '077_artifact_feedback.sql']) {
    db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  }
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

function insertBatch(
  db: Database.Database,
  id: string,
  overrides: Partial<{ runId: string; atype: string; sourceRef: string; round: number; status: string }> = {},
): void {
  db.prepare(
    `INSERT INTO feedback_batches (id, project_id, run_id, atype, source_ref, round, status)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.runId ?? 'run-1',
    overrides.atype ?? 'idea-spec',
    overrides.sourceRef ?? 'idea-1',
    overrides.round ?? 1,
    overrides.status ?? 'pending',
  );
}

function insertComment(
  db: Database.Database,
  id: string,
  overrides: Partial<{ runId: string; atype: string; sourceRef: string; status: string; batchId: string | null }> = {},
): void {
  db.prepare(
    `INSERT INTO feedback_comments (id, project_id, run_id, atype, source_ref, batch_id, anchor_json, body, status)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.runId ?? 'run-1',
    overrides.atype ?? 'idea-spec',
    overrides.sourceRef ?? 'idea-1',
    overrides.batchId ?? null,
    JSON.stringify({ quote: 'q', occurrence: 0, bodyHash: 'ab12cd34' }),
    'a comment',
    overrides.status ?? 'draft',
  );
}

describe('migration 077: feedback_batches / feedback_comments', () => {
  it('creates the expected columns on both tables', () => {
    const db = buildDb();

    const batchColumns = (db.prepare('PRAGMA table_info(feedback_batches)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(batchColumns).toEqual([
      'id',
      'project_id',
      'run_id',
      'atype',
      'source_ref',
      'round',
      'status',
      'error',
      'created_at',
      'applied_at',
    ]);

    const commentColumns = (
      db.prepare('PRAGMA table_info(feedback_comments)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(commentColumns).toEqual([
      'id',
      'project_id',
      'run_id',
      'atype',
      'source_ref',
      'batch_id',
      'anchor_json',
      'body',
      'status',
      'created_at',
      'updated_at',
      'sent_at',
      'addressed_at',
    ]);

    db.close();
  });

  it('defaults a fresh batch to status=pending and a fresh comment to status=draft', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertBatch(db, 'b1');
    insertComment(db, 'c1');

    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get('b1') as { status: string };
    expect(batch.status).toBe('pending');
    const comment = db.prepare('SELECT status FROM feedback_comments WHERE id = ?').get('c1') as { status: string };
    expect(comment.status).toBe('draft');

    db.close();
  });

  it('rejects a batch with an unknown atype', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertBatch(db, 'b1', { atype: 'bogus' })).toThrow(/CHECK/i);
    db.close();
  });

  it('rejects a batch with an unknown status', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertBatch(db, 'b1', { status: 'bogus' })).toThrow(/CHECK/i);
    db.close();
  });

  it('rejects a comment with an unknown atype', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertComment(db, 'c1', { atype: 'bogus' })).toThrow(/CHECK/i);
    db.close();
  });

  it('rejects a comment with an unknown status', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertComment(db, 'c1', { status: 'bogus' })).toThrow(/CHECK/i);
    db.close();
  });

  it('creates the lookup indexes on both tables', () => {
    const db = buildDb();
    const batchIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_feedback_batches_doc');
    expect(batchIndex).toEqual({ name: 'idx_feedback_batches_doc' });

    const commentIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_feedback_comments_doc');
    expect(commentIndex).toEqual({ name: 'idx_feedback_comments_doc' });

    db.close();
  });

  it('cascades both batches and comments when their run is deleted', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertBatch(db, 'b1');
    insertComment(db, 'c1', { batchId: 'b1', status: 'sent' });

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('run-1');

    const batchCount = (db.prepare('SELECT COUNT(*) AS n FROM feedback_batches').get() as { n: number }).n;
    const commentCount = (db.prepare('SELECT COUNT(*) AS n FROM feedback_comments').get() as { n: number }).n;
    expect(batchCount).toBe(0);
    expect(commentCount).toBe(0);

    db.close();
  });

  it('a comment survives its batch being deleted (ON DELETE SET NULL)', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertBatch(db, 'b1');
    insertComment(db, 'c1', { batchId: 'b1', status: 'sent' });

    db.prepare('DELETE FROM feedback_batches WHERE id = ?').run('b1');

    const comment = db.prepare('SELECT batch_id FROM feedback_comments WHERE id = ?').get('c1') as {
      batch_id: string | null;
    };
    expect(comment.batch_id).toBeNull();

    db.close();
  });

  it('is idempotent when the whole migration is replayed', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertBatch(db, 'b1');
    insertComment(db, 'c1');

    expect(() => db.exec(readFileSync(join(MIG_DIR, '077_artifact_feedback.sql'), 'utf-8'))).not.toThrow();

    const batchCount = (db.prepare('SELECT COUNT(*) AS n FROM feedback_batches').get() as { n: number }).n;
    expect(batchCount).toBe(1);

    db.close();
  });
});
