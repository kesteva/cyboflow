/**
 * artifactLifecycle tests — session-close pruning of run artifacts.
 *
 * Verifies pruneSessionOnlyArtifacts drops only the UNCOMMITTED artifacts of a
 * session's runs (across multiple runs), keeps committed ones, is a no-op for an
 * unknown session, and is fail-soft.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactRouter } from '../artifactRouter';
import { pruneSessionOnlyArtifacts } from '../artifactLifecycle';
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
    '017_run_seed_idea.sql',
    '029_artifacts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  // workflow_runs.session_id (migration 019) — added directly here; migration 019
  // itself backfills from the Crystal-legacy `sessions` table, which the entity
  // test DBs don't create. We only need the column for the prune query.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  return db;
}

function seedRun(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?)`,
  ).run(runId, sessionId);
}

describe('artifactLifecycle.pruneSessionOnlyArtifacts', () => {
  afterEach(() => ArtifactRouter._resetForTesting());

  it('drops only uncommitted artifacts across a session\'s runs; keeps committed', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'sess-A');
    seedRun(db, 'run-2', 'sess-A');
    seedRun(db, 'run-other', 'sess-B'); // a different session — untouched
    const router = ArtifactRouter.initialize(dbAdapter(db));

    // run-1: two uncommitted; run-2: one committed; run-other (sess-B): one uncommitted.
    const a1 = await router.apply(1, { op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'idea', actor: 'orchestrator' });
    await router.apply(1, { op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto', actor: 'agent:executor' });
    const kept = await router.apply(1, { op: 'create', runId: 'run-2', atype: 'generic', label: 'g', actor: 'user' });
    await router.apply(1, { op: 'commit', artifactId: kept.artifactId, actor: 'user' });
    await router.apply(1, { op: 'create', runId: 'run-other', atype: 'idea-spec', label: 'other', actor: 'orchestrator' });

    const { deleted } = await pruneSessionOnlyArtifacts(dbAdapter(db), 'sess-A');

    expect(deleted).toContain(a1.artifactId);
    expect(deleted).toHaveLength(2); // both run-1 uncommitted
    // run-2 committed survives; sess-B untouched.
    const remaining = db.prepare('SELECT run_id, atype, committed FROM artifacts ORDER BY run_id').all() as Array<{
      run_id: string; atype: string; committed: number;
    }>;
    expect(remaining).toEqual([
      { run_id: 'run-2', atype: 'generic', committed: 1 },
      { run_id: 'run-other', atype: 'idea-spec', committed: 0 },
    ]);
  });

  it('is a no-op for an unknown session', async () => {
    const db = buildDb();
    ArtifactRouter.initialize(dbAdapter(db));
    const { deleted } = await pruneSessionOnlyArtifacts(dbAdapter(db), 'nope');
    expect(deleted).toEqual([]);
  });

  it('is fail-soft when the ArtifactRouter is not initialized', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'sess-A');
    // ArtifactRouter NOT initialized → getInstance() throws inside; prune swallows it.
    const { deleted } = await pruneSessionOnlyArtifacts(dbAdapter(db), 'sess-A');
    expect(deleted).toEqual([]);
  });
});
