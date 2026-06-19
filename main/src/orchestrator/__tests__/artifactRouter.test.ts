/**
 * Unit tests for ArtifactRouter — the run-scoped artifacts write chokepoint
 * (artifacts table, migration 029).
 *
 * Covered:
 *  - create mints an 'art_' id, inserts the row, logs a 'created' entity_events
 *    row keyed (entity_type='artifact'), and emits on 'artifact-project-<id>'.
 *  - create is idempotent per (run, atype): a second create UPSERTS (no duplicate)
 *    and re-uses the row id.
 *  - update enriches label/payload/new-dot + logs an 'updated' delta.
 *  - commit flips committed/session_only/committed_at; re-committing is rejected
 *    (already_committed).
 *  - pruneSessionOnly drops uncommitted artifacts for the given runs, keeps
 *    committed ones, and emits a 'deleted' event per drop.
 *  - invalid atype / unknown run are rejected; FK cascade removes a run's rows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactRouter,
  ArtifactError,
  artifactChangeEvents,
  artifactProjectChannel,
} from '../artifactRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { ArtifactChangedEvent } from '../../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 029.
// ---------------------------------------------------------------------------

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
    '029_artifacts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
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

function countEvents(db: Database.Database, artifactId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'artifact' AND entity_id = ?")
    .get(artifactId) as { n: number };
  return row.n;
}

describe('ArtifactRouter', () => {
  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
  });

  it('create mints an art_ id, inserts the row, logs a created event, and emits', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    const events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

    const { artifactId } = await router.apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'idea-spec',
      label: 'IDEA-018 · wizard',
      actor: 'agent:idea-extractor',
    });

    expect(artifactId).toMatch(/^art_[0-9a-f]{24}$/);
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown>;
    expect(row).toMatchObject({ run_id: 'run-1', atype: 'idea-spec', label: 'IDEA-018 · wizard', mode: 'template' });
    // Defaults: session-only, not committed, new.
    expect(row.committed).toBe(0);
    expect(row.session_only).toBe(1);
    expect(row.is_new).toBe(1);
    expect(countEvents(db, artifactId)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: 1, runId: 'run-1', action: 'created', atype: 'idea-spec' });
    expect(events[0].artifact?.committed).toBe(false);
  });

  it('create is idempotent per (run, atype) — upserts, no duplicate row', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    const first = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'decomposed-stories', label: '2 epics', actor: 'orchestrator',
    });
    const second = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'decomposed-stories', label: '3 epics · re-derived', actor: 'orchestrator',
    });

    expect(second.artifactId).toBe(first.artifactId);
    const rows = db.prepare("SELECT * FROM artifacts WHERE run_id = 'run-1' AND atype = 'decomposed-stories'").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { label: string }).label).toBe('3 epics · re-derived');
  });

  it('update enriches an existing artifact', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto', actor: 'agent:executor',
    });

    await router.apply(1, { op: 'update', artifactId, payloadJson: '{"url":"http://localhost:8081"}', isNew: false, actor: 'agent:executor' });

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown>;
    expect(row.payload_json).toBe('{"url":"http://localhost:8081"}');
    expect(row.is_new).toBe(0);
    expect(countEvents(db, artifactId)).toBe(2); // created + updated
  });

  it('commit flips committed/session_only/committed_at and rejects re-commit', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: '4 shots', actor: 'agent:visual-verifier',
    });

    await router.apply(1, { op: 'commit', artifactId, actor: 'user' });
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown>;
    expect(row.committed).toBe(1);
    expect(row.session_only).toBe(0);
    expect(row.committed_at).not.toBeNull();

    await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).rejects.toMatchObject({
      code: 'already_committed',
    });
  });

  it('pruneSessionOnly drops uncommitted artifacts for the runs but keeps committed', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const ephemeral = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto', actor: 'agent:executor',
    });
    const kept = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'idea', actor: 'orchestrator',
    });
    await router.apply(1, { op: 'commit', artifactId: kept.artifactId, actor: 'user' });

    const events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

    const { deleted } = await router.pruneSessionOnly(1, ['run-1']);
    expect(deleted).toEqual([ephemeral.artifactId]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 1 });
    expect(events.some((e) => e.action === 'deleted' && e.artifactId === ephemeral.artifactId)).toBe(true);
  });

  it('rejects an invalid atype and an unknown run', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    await expect(
      // @ts-expect-error — intentionally invalid atype
      router.apply(1, { op: 'create', runId: 'run-1', atype: 'bogus', label: 'x', actor: 'user' }),
    ).rejects.toBeInstanceOf(ArtifactError);

    await expect(
      router.apply(1, { op: 'create', runId: 'nope', atype: 'generic', label: 'x', actor: 'user' }),
    ).rejects.toMatchObject({ code: 'run_not_found' });
  });

  it('FK cascade removes a run\'s artifacts when the run is deleted', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    await router.apply(1, { op: 'create', runId: 'run-1', atype: 'generic', label: 'g', actor: 'user' });

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('run-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 });
  });
});
