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
 *  - a commit/update scheduled on the WRONG project (artifact owned by another
 *    project's run) is rejected with 'wrong_project'; a commit routed via the
 *    artifact's TRUE project emits on that project's channel.
 *  - a true no-op (re-derive / update with no changed field) writes NO audit row
 *    AND emits NOTHING.
 *  - the payload_json delta reflects the real before/after (null/present/cleared),
 *    not a constant sentinel.
 *  - emitChange stamps event.sessionId from the run's workflow_runs.session_id
 *    (null for a legacy/parentless run, the run's parent session id otherwise).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactRouter,
  ArtifactError,
  artifactChangeEvents,
  artifactProjectChannel,
} from '../artifactRouter';
import { snapshotPathFor, resolveArtifactCommitDir } from '../artifactSnapshot';
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj2', '/tmp/p2');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '035_artifacts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  // workflow_runs.session_id (migration 019) — added directly here; migration 019
  // itself backfills from the Crystal-legacy `sessions` table, which this entity
  // test DB doesn't create. We only need the column so emitChange's session_id
  // resolution (`SELECT session_id FROM workflow_runs WHERE id = ?`) has
  // something to select.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  return db;
}

function seedRun(db: Database.Database, runId: string, sessionId: string | null = null): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?)`,
  ).run(runId, sessionId);
}

/** Seed a workflow + run under an arbitrary project (for cross-project tests). */
function seedRunInProject(
  db: Database.Database,
  runId: string,
  projectId: number,
  sessionId: string | null = null,
): void {
  const wfId = `wf-p${projectId}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'planner', '{}')`,
  ).run(wfId, projectId);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
     VALUES (?, ?, ?, 'running', 'default', ?)`,
  ).run(runId, wfId, projectId, sessionId);
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
    // seedRun leaves session_id NULL (a legacy/parentless run) — emitChange must
    // resolve that as null, not throw or omit the field.
    expect(events[0].sessionId).toBeNull();
  });

  it('emitted events carry sessionId resolved from the run\'s workflow_runs.session_id', async () => {
    const db = buildDb();
    seedRun(db, 'run-with-session', 'sess-parent-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    const events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

    await router.apply(1, {
      op: 'create',
      runId: 'run-with-session',
      atype: 'idea-spec',
      label: 'IDEA-018 · wizard',
      actor: 'agent:idea-extractor',
    });

    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe('run-with-session');
    expect(events[0].sessionId).toBe('sess-parent-1');
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

    // The label change logged a delta (created + updated = 2). A re-derive with an
    // UNCHANGED label must NOT spam a no-op event (stays at 2).
    expect(countEvents(db, first.artifactId)).toBe(2);
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'decomposed-stories', label: '3 epics · re-derived', actor: 'orchestrator',
    });
    expect(countEvents(db, first.artifactId)).toBe(2);
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

  it('rejects a commit scheduled on the WRONG project (artifact owned by another project)', async () => {
    const db = buildDb();
    // run-2 lives in project 2; mint an artifact for it via project 2's queue.
    seedRunInProject(db, 'run-2', 2);
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(2, {
      op: 'create', runId: 'run-2', atype: 'idea-spec', label: 'foreign', actor: 'orchestrator',
    });

    // An agent in project 1 tries to commit project 2's artifact by id.
    const p1Events: ArtifactChangedEvent[] = [];
    const p2Events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => p1Events.push(e));
    artifactChangeEvents.on(artifactProjectChannel(2), (e: ArtifactChangedEvent) => p2Events.push(e));

    await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).rejects.toMatchObject({
      code: 'wrong_project',
    });
    // No write, no emit on either channel; the row stays uncommitted.
    expect(p1Events).toHaveLength(0);
    expect(p2Events).toHaveLength(0);
    const row = db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as { committed: number };
    expect(row.committed).toBe(0);

    // The same update routed via the TRUE project (2) succeeds and emits on channel 2.
    await router.apply(2, { op: 'update', artifactId, label: 'renamed', actor: 'user' });
    expect(p1Events).toHaveLength(0);
    expect(p2Events.some((e) => e.action === 'updated' && e.artifactId === artifactId)).toBe(true);
  });

  it('a true no-op update writes NO audit row and emits NOTHING', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'generic', label: 'g', actor: 'user',
    });
    expect(countEvents(db, artifactId)).toBe(1); // created

    const events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

    // No-op: same label, is_new unchanged, no payload key supplied.
    await router.apply(1, { op: 'update', artifactId, label: 'g', actor: 'user' });
    expect(countEvents(db, artifactId)).toBe(1); // still just 'created'
    expect(events).toHaveLength(0); // no emit on a true no-op
  });

  it('a true no-op re-derive (create with unchanged fields) writes NO audit row and emits NOTHING', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'decomposed-stories', label: 'same', actor: 'orchestrator',
    });
    expect(countEvents(db, artifactId)).toBe(1); // created

    const events: ArtifactChangedEvent[] = [];
    artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'decomposed-stories', label: 'same', actor: 'orchestrator',
    });
    expect(countEvents(db, artifactId)).toBe(1); // no no-op audit row
    expect(events).toHaveLength(0); // no no-op emit
  });

  it('the payload_json delta reflects the real before/after (null -> present -> cleared)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto', actor: 'agent:executor',
    });

    const lastDelta = (field: string): { from: unknown; to: unknown } | undefined => {
      const row = db
        .prepare(
          "SELECT changes_json FROM entity_events WHERE entity_type = 'artifact' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(artifactId) as { changes_json: string } | undefined;
      if (!row) return undefined;
      const deltas = JSON.parse(row.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
      return deltas.find((d) => d.field === field);
    };

    // null -> present
    await router.apply(1, { op: 'update', artifactId, payloadJson: '{"url":"http://x"}', actor: 'agent:executor' });
    expect(lastDelta('payload_json')).toMatchObject({ from: null, to: 'present' });

    // present -> cleared
    await router.apply(1, { op: 'update', artifactId, payloadJson: null, actor: 'agent:executor' });
    expect(lastDelta('payload_json')).toMatchObject({ from: 'present', to: 'cleared' });
  });

  it('commit writes an on-disk durability snapshot in the resolved commit dir (FEATURE #3)', async () => {
    const db = buildDb();
    // The resolver resolves a RELATIVE configured dir against a PROJECT ROOT (a
    // tmp dir here) — NOT the run's worktree — so the manifest survives teardown.
    const projectRoot = mkdtempSync(join(tmpdir(), 'artifact-router-proj-'));
    const commitDir = resolveArtifactCommitDir(projectRoot, '.cyboflow/artifacts');
    try {
      seedRun(db, 'run-1');
      const router = ArtifactRouter.initialize(dbAdapter(db), undefined, () => commitDir);
      const { artifactId } = await router.apply(1, {
        op: 'create',
        runId: 'run-1',
        atype: 'ui-prototype',
        label: 'live preview',
        payloadJson: '{"url":"http://localhost:8081"}',
        actor: 'agent:executor',
      });

      await router.apply(1, { op: 'commit', artifactId, actor: 'user' });

      // The DB row is committed.
      const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown>;
      expect(row.committed).toBe(1);

      // And a manifest exists on disk (under <projectRoot>/.cyboflow/artifacts).
      const manifestPath = snapshotPathFor(commitDir, { id: artifactId, atype: 'ui-prototype' });
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        schemaVersion: number;
        id: string;
        runId: string;
        atype: string;
        label: string;
        mode: string;
        sourceRef: string | null;
        payloadJson: unknown;
        committedAt: string | null;
      };
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        id: artifactId,
        runId: 'run-1',
        atype: 'ui-prototype',
        label: 'live preview',
        mode: 'canvas',
        sourceRef: null,
      });
      expect(manifest.payloadJson).toEqual({ url: 'http://localhost:8081' });
      expect(manifest.committedAt).not.toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('a snapshot write failure does NOT fail the commit (row stays committed=1, fail-soft)', async () => {
    const db = buildDb();
    // Resolve a commit dir that cannot be created: a path *under* a regular FILE,
    // so mkdir -p underneath fails.
    const base = mkdtempSync(join(tmpdir(), 'artifact-router-bad-'));
    const fileAsRoot = join(base, 'regular-file');
    writeFileSync(fileAsRoot, 'x', 'utf-8');
    const unwritableDir = join(fileAsRoot, 'nested');
    try {
      seedRun(db, 'run-1');
      const router = ArtifactRouter.initialize(dbAdapter(db), undefined, () => unwritableDir);
      const { artifactId } = await router.apply(1, {
        op: 'create',
        runId: 'run-1',
        atype: 'generic',
        label: 'canvas',
        payloadJson: '{"url":"http://x"}',
        actor: 'agent:executor',
      });

      // Commit must succeed despite the disk write being impossible.
      await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).resolves.toMatchObject({
        artifactId,
      });
      const row = db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as {
        committed: number;
      };
      expect(row.committed).toBe(1);
      // No manifest was written.
      expect(existsSync(snapshotPathFor(unwritableDir, { id: artifactId, atype: 'generic' }))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('skips the snapshot (commit still succeeds) when no commit-dir resolver is wired', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    // No third arg → resolveCommitDir is undefined → maybeSnapshot is a no-op.
    const router = ArtifactRouter.initialize(dbAdapter(db));
    const { artifactId } = await router.apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'generic',
      label: 'canvas',
      payloadJson: '{"url":"http://x"}',
      actor: 'agent:executor',
    });
    await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).resolves.toMatchObject({
      artifactId,
    });
    expect((db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as { committed: number }).committed).toBe(1);
  });

  it('skips the snapshot (commit still succeeds) when the resolver returns null', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db), undefined, () => null);
    const { artifactId } = await router.apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'generic',
      label: 'canvas',
      payloadJson: '{"url":"http://x"}',
      actor: 'agent:executor',
    });
    await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).resolves.toMatchObject({
      artifactId,
    });
    expect((db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as { committed: number }).committed).toBe(1);
  });

  it('snapshots independently of worktree_path: a NULL-worktree run still writes the manifest (FU3 fix)', async () => {
    // The FU3 fix moved snapshot resolution off the run's worktree onto the
    // injected commit-dir resolver. Proving the manifest is written even when
    // workflow_runs.worktree_path is NULL is exactly what guarantees the snapshot
    // survives the worktree being torn down on Dismiss — the bug this fixed.
    const db = buildDb();
    const commitDir = mkdtempSync(join(tmpdir(), 'artifact-router-nowt-'));
    try {
      seedRun(db, 'run-1'); // seedRun leaves worktree_path NULL on purpose
      const router = ArtifactRouter.initialize(dbAdapter(db), undefined, () => commitDir);
      const { artifactId } = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'g', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).resolves.toMatchObject({ artifactId });
      const row = db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as { committed: number };
      expect(row.committed).toBe(1);
      // Manifest written under the resolver's dir despite the NULL worktree_path.
      expect(existsSync(snapshotPathFor(commitDir, { id: artifactId, atype: 'generic' }))).toBe(true);
    } finally {
      rmSync(commitDir, { recursive: true, force: true });
    }
  });
});
