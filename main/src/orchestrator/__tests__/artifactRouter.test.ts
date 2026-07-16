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
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactRouter,
  ArtifactError,
  artifactChangeEvents,
  artifactProjectChannel,
} from '../artifactRouter';
import {
  manifestPathFor,
  snapshotDirFor,
  resolveArtifactCommitDir,
  loadCommittedSnapshot,
} from '../artifactSnapshot';
import { PROTOTYPE_HTML_RELPATH } from '../../../../shared/types/artifacts';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { ArtifactChangedEvent, ScreenshotsArtifactPayload, ArtifactType } from '../../../../shared/types/artifacts';
import { ARTIFACT_RENDER_MODE } from '../../../../shared/types/artifacts';
import type { VerdictV1 } from '../../../../shared/types/visualVerification';

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
    '045_arch_design_atype.sql',
    '060_compound_recommendations_atype.sql',
    '062_approve_ideas_atype.sql',
    '063_per_idea_spec_artifacts.sql',
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

/** Seed a run artifacts dir with a static prototype document (byte-copy source). */
function seedRunArtifacts(root: string, html = '<!doctype html><html><head></head><body>hi</body></html>'): void {
  mkdirSync(join(root, 'prototype'), { recursive: true });
  writeFileSync(join(root, 'prototype', 'index.html'), html, 'utf-8');
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

  it('idea-spec is per-source: same sourceRef enriches (one row), different sourceRef creates a second (IDEA-009)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    // Idea A → row 1.
    const a1 = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'Idea A', sourceRef: 'ide_A', actor: 'orchestrator',
    });
    // Re-derive Idea A with a fresh label → SAME row (enrich), no duplicate.
    const a2 = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'Idea A refreshed', sourceRef: 'ide_A', actor: 'orchestrator',
    });
    expect(a2.artifactId).toBe(a1.artifactId);

    // Idea B → a SECOND idea-spec row in the same run.
    const b1 = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'Idea B', sourceRef: 'ide_B', actor: 'orchestrator',
    });
    expect(b1.artifactId).not.toBe(a1.artifactId);

    const rows = db
      .prepare("SELECT source_ref, label FROM artifacts WHERE run_id = 'run-1' AND atype = 'idea-spec' ORDER BY source_ref")
      .all() as Array<{ source_ref: string; label: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_ref)).toEqual(['ide_A', 'ide_B']);
    expect(rows[0].label).toBe('Idea A refreshed');
  });

  it('a non-per-entity atype (ui-prototype) still enriches one-per-(run,atype) regardless of sourceRef', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    const first = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto', sourceRef: 'ide_A', actor: 'agent:executor',
    });
    // A different sourceRef must NOT create a second ui-prototype — identity is (run,atype).
    const second = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'ui-prototype', label: 'proto v2', sourceRef: 'ide_B', actor: 'agent:executor',
    });
    expect(second.artifactId).toBe(first.artifactId);
    const rows = db.prepare("SELECT * FROM artifacts WHERE run_id = 'run-1' AND atype = 'ui-prototype'").all();
    expect(rows).toHaveLength(1);
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

  it('accepts the approve-ideas atype (IDEA-009 multi-idea approve gate)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'approve-ideas', label: '3 ideas seeded', actor: 'orchestrator',
    });

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown>;
    expect(row).toMatchObject({ run_id: 'run-1', atype: 'approve-ideas', label: '3 ideas seeded', mode: 'template' });
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

  it('accepts every atype in the ArtifactType union — incl. compound-recommendations', async () => {
    // Regression: `compound-recommendations` was added to the union + MCP schema +
    // DB CHECK but omitted from the router's VALID_ATYPES, so this write chokepoint
    // threw `invalid_atype` and the Compound agent fell back to `generic` (the
    // empty-canvas incident). VALID_ATYPES is now derived from the exhaustive
    // ARTIFACT_RENDER_MODE registry, so no union member can be rejected here.
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));

    for (const atype of Object.keys(ARTIFACT_RENDER_MODE) as ArtifactType[]) {
      // Each atype is agent- or orchestrator-reportable; a unique run per atype
      // avoids the UNIQUE(run_id, atype) upsert path so each is a fresh insert.
      const runId = `run-${atype}`;
      seedRun(db, runId);
      await expect(
        router.apply(1, { op: 'create', runId, atype, label: atype, actor: 'orchestrator' }),
        `atype '${atype}' must be accepted by the router`,
      ).resolves.toMatchObject({ artifactId: expect.any(String) });
    }
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

  it('commit snapshots (manifest + bytes) then DELETES the DB row (IDEA-039)', async () => {
    const db = buildDb();
    // Resolve a commit STORE against a PROJECT ROOT (a tmp dir) — NOT the run's
    // worktree — so the snapshot survives teardown. Wire a run-artifacts dir with
    // a real prototype/index.html so the byte copy has a source.
    const projectRoot = mkdtempSync(join(tmpdir(), 'artifact-router-proj-'));
    const runArtifacts = mkdtempSync(join(tmpdir(), 'artifact-router-run-'));
    const storeDir = resolveArtifactCommitDir(projectRoot, '.cyboflow/artifacts');
    try {
      seedRunArtifacts(runArtifacts, '<html><head></head><body>proto</body></html>');
      seedRun(db, 'run-1');
      const router = ArtifactRouter.initialize(
        dbAdapter(db),
        undefined,
        () => storeDir,
        undefined,
        () => runArtifacts,
      );
      const { artifactId } = await router.apply(1, {
        op: 'create',
        runId: 'run-1',
        atype: 'ui-prototype',
        label: 'live preview',
        payloadJson: JSON.stringify({ fileName: PROTOTYPE_HTML_RELPATH }),
        actor: 'agent:executor',
      });

      const events: ArtifactChangedEvent[] = [];
      artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

      await router.apply(1, { op: 'commit', artifactId, actor: 'user' });

      // The DB row is GONE (snapshot succeeded → delete).
      expect(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId)).toBeUndefined();

      // Exactly one 'committed' event (same id, committed=true); NEVER 'deleted'.
      const committedEvents = events.filter((e) => e.action === 'committed');
      expect(committedEvents).toHaveLength(1);
      expect(committedEvents[0].artifactId).toBe(artifactId);
      expect(committedEvents[0].artifact?.committed).toBe(true);
      expect(events.some((e) => e.action === 'deleted')).toBe(false);

      // The v2 manifest + copied bytes exist under <projectRoot>/.cyboflow/artifacts.
      const manifestPath = manifestPathFor(storeDir, 'run-1', 'ui-prototype');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        schemaVersion: number;
        id: string;
        files: string[];
        committedAt: string | null;
      };
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.id).toBe(artifactId);
      expect(manifest.files).toEqual(['prototype/index.html']);
      expect(manifest.committedAt).not.toBeNull();
      expect(
        existsSync(join(snapshotDirFor(storeDir, 'run-1', 'ui-prototype'), 'files', 'prototype', 'index.html')),
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(runArtifacts, { recursive: true, force: true });
    }
  });

  it('a snapshot write failure does NOT fail the commit and KEEPS committed=1 (fail-soft, no delete)', async () => {
    const db = buildDb();
    // Resolve a commit dir that cannot be created: a path *under* a regular FILE,
    // so mkdir -p underneath fails and the snapshot returns null.
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
      // Snapshot failed → the committed=1 row is KEPT (never lost), never deleted.
      const row = db.prepare('SELECT committed FROM artifacts WHERE id = ?').get(artifactId) as {
        committed: number;
      };
      expect(row.committed).toBe(1);
      expect(existsSync(manifestPathFor(unwritableDir, 'run-1', 'generic'))).toBe(false);
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
    const storeDir = mkdtempSync(join(tmpdir(), 'artifact-router-nowt-'));
    try {
      seedRun(db, 'run-1'); // seedRun leaves worktree_path NULL on purpose
      const router = ArtifactRouter.initialize(dbAdapter(db), undefined, () => storeDir);
      const { artifactId } = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'g', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await expect(router.apply(1, { op: 'commit', artifactId, actor: 'user' })).resolves.toMatchObject({ artifactId });
      // Snapshot succeeded (url-only generic → manifest, no bytes) → DB row deleted.
      expect(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId)).toBeUndefined();
      // Manifest written under the store despite the NULL worktree_path.
      expect(existsSync(manifestPathFor(storeDir, 'run-1', 'generic'))).toBe(true);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  // --- S5: accept-as-baseline op (injected committer, no real fs/git) ---------

  /** A minimal-but-complete VerdictV1 carrying a PASS + the given judged/baseline data. */
  function passVerdict(overrides: {
    judgedFileNames: string[];
    baselineKey: string;
  }): VerdictV1 {
    return {
      status: 'pass',
      confidence: 0.95,
      issues: [],
      feedback: 'looks good',
      judgedFileNames: overrides.judgedFileNames,
      baselineUsed: false,
      model: 'test-vlm',
      baselineKey: overrides.baselineKey,
    };
  }

  it('accept-baseline delegates the PNG copy + commit to the injected committer and logs an audit event', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    // You only accept what was verified — a screenshots artifact must exist AND
    // carry a PASS verdict authorizing exactly these fileNames/baselineKey.
    const acceptCalls: Array<{ runId: string; baselineKey: string; fileNames: string[] }> = [];
    const router = ArtifactRouter.initialize(
      dbAdapter(db),
      undefined,
      undefined,
      async ({ runId, baselineKey, fileNames }) => {
        acceptCalls.push({ runId, baselineKey, fileNames });
        return { baselineKey };
      },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png', 'mobile.png'],
      verdict: passVerdict({ judgedFileNames: ['desktop.png', 'mobile.png'], baselineKey: 'home' }),
    };
    const { artifactId } = await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: '2 shots',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });

    const res = await router.acceptAsBaseline(1, {
      op: 'accept-baseline',
      runId: 'run-1',
      baselineKey: 'home',
      fileNames: ['desktop.png', 'mobile.png'],
      actor: 'user',
    });

    expect(res).toEqual({ baselineKey: 'home' });
    // The committer (fake — no real git) got the exact PNGs + key.
    expect(acceptCalls).toHaveLength(1);
    expect(acceptCalls[0]).toMatchObject({
      runId: 'run-1',
      baselineKey: 'home',
      fileNames: ['desktop.png', 'mobile.png'],
    });
    // An audit event was appended under the screenshots artifact (create + accept).
    expect(countEvents(db, artifactId)).toBe(2);
  });

  it('accept-baseline delegates only the requested subset when fewer than all judged fileNames are sent', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const acceptCalls: Array<{ fileNames: string[] }> = [];
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ fileNames, baselineKey }) => {
        acceptCalls.push({ fileNames });
        return { baselineKey };
      },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png', 'mobile.png'],
      verdict: passVerdict({ judgedFileNames: ['desktop.png', 'mobile.png'], baselineKey: 'home' }),
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: '2 shots',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await router.acceptAsBaseline(1, {
      op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png'], actor: 'user',
    });
    expect(acceptCalls).toEqual([{ fileNames: ['desktop.png'] }]);
  });

  it('accept-baseline throws not_found when no committer is wired', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's', actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['a.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accept-baseline rejects a run with no screenshots artifact', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined, async ({ baselineKey }) => ({ baselineKey }),
    );
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['a.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accept-baseline rejects an empty fileNames list', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined, async ({ baselineKey }) => ({ baselineKey }),
    );
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's', actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: [], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'invalid_atype' });
  });

  it('accept-baseline rejects a cross-project run', async () => {
    const db = buildDb();
    seedRunInProject(db, 'run-2', 2);
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined, async ({ baselineKey }) => ({ baselineKey }),
    );
    await router.apply(2, {
      op: 'create', runId: 'run-2', atype: 'screenshots', label: 's', actor: 'orchestrator',
    });
    // Accepting run-2 (project 2) under project 1 must be rejected.
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-2', baselineKey: 'home', fileNames: ['a.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'wrong_project' });
  });

  // --- Server-side accept-baseline verdict validation (trust-boundary fix) ---

  it('accept-baseline rejects when the screenshots artifact carries no verdict', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    const payload: ScreenshotsArtifactPayload = { fileNames: ['desktop.png'] };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  it("accept-baseline rejects a 'failed' verdict", async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png'],
      verdict: { ...passVerdict({ judgedFileNames: ['desktop.png'], baselineKey: 'home' }), status: 'fail' },
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  it("accept-baseline rejects a 'low_confidence' verdict", async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png'],
      verdict: {
        ...passVerdict({ judgedFileNames: ['desktop.png'], baselineKey: 'home' }),
        status: 'low_confidence',
      },
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  it('accept-baseline rejects a baselineKey mismatch between the request and the verdict', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png'],
      verdict: passVerdict({ judgedFileNames: ['desktop.png'], baselineKey: 'home' }),
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        // Client claims a DIFFERENT baseline namespace than the verdict was judged under.
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'other-deliverable', fileNames: ['desktop.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  it('accept-baseline rejects a requested fileName not in the verdict judgedFileNames', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png', 'sneaky.png'],
      verdict: passVerdict({ judgedFileNames: ['desktop.png'], baselineKey: 'home' }),
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        // 'sneaky.png' was captured but never judged by the VLM.
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png', 'sneaky.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  it('accept-baseline rejects a requested fileName that is judged but was never captured for this run', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    let called = false;
    const router = ArtifactRouter.initialize(
      dbAdapter(db), undefined, undefined,
      async ({ baselineKey }) => { called = true; return { baselineKey }; },
    );
    // A tampered/stale verdict claims to have judged a file that was never actually
    // captured into payload.fileNames for this run.
    const payload: ScreenshotsArtifactPayload = {
      fileNames: ['desktop.png'],
      verdict: passVerdict({ judgedFileNames: ['desktop.png', 'phantom.png'], baselineKey: 'home' }),
    };
    await router.apply(1, {
      op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
      payloadJson: JSON.stringify(payload), actor: 'orchestrator',
    });
    await expect(
      router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['phantom.png'], actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'not_verified' });
    expect(called).toBe(false);
  });

  // --- IDEA-039: read-model union, reap, supersede, accept-off-snapshot --------

  /** Wire a router with a real on-disk commit store + run-artifacts dir. */
  function wireLifecycleRouter(db: Database.Database): {
    router: ArtifactRouter;
    storeDir: string;
    runArtifacts: string;
    cleanup: () => void;
  } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'artifact-life-proj-'));
    const runArtifacts = mkdtempSync(join(tmpdir(), 'artifact-life-run-'));
    const storeDir = resolveArtifactCommitDir(projectRoot, '.cyboflow/artifacts');
    const router = ArtifactRouter.initialize(
      dbAdapter(db),
      undefined,
      () => storeDir,
      undefined,
      () => runArtifacts,
    );
    return {
      router,
      storeDir,
      runArtifacts,
      cleanup: () => {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(runArtifacts, { recursive: true, force: true });
      },
    };
  }

  it('listForRun unions DB rows + committed snapshots (DB wins); committed filter true/false/undefined', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const { router, cleanup } = wireLifecycleRouter(db);
    try {
      // Uncommitted DB row (idea-spec) + a committed-then-snapshotted generic.
      await router.apply(1, { op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'idea', actor: 'orchestrator' });
      const gen = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'g', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await router.apply(1, { op: 'commit', artifactId: gen.artifactId, actor: 'user' });
      // The generic DB row is gone; it now lives only as a snapshot.
      expect(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(gen.artifactId)).toBeUndefined();

      const full = await router.listForRun(1, 'run-1');
      expect(full.map((a) => a.atype).sort()).toEqual(['generic', 'idea-spec']);
      expect(full.find((a) => a.atype === 'generic')?.committed).toBe(true);
      expect(full.find((a) => a.atype === 'idea-spec')?.committed).toBe(false);

      const committedOnly = await router.listForRun(1, 'run-1', true);
      expect(committedOnly.map((a) => a.atype)).toEqual(['generic']);

      const uncommittedOnly = await router.listForRun(1, 'run-1', false);
      expect(uncommittedOnly.map((a) => a.atype)).toEqual(['idea-spec']);
    } finally {
      cleanup();
    }
  });

  it('listForRun: a re-report after a committed snapshot supersedes it (DB row wins the identity dedup)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const { router, cleanup } = wireLifecycleRouter(db);
    try {
      const gen = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'v1', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await router.apply(1, { op: 'commit', artifactId: gen.artifactId, actor: 'user' });
      // A revise re-report mints a FRESH committed=0 DB row (same run,atype).
      const revised = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'v2', payloadJson: '{"url":"http://y"}', actor: 'user',
      });
      expect(revised.artifactId).not.toBe(gen.artifactId);

      const list = await router.listForRun(1, 'run-1');
      // One 'generic' entry — the live DB row wins over the committed snapshot.
      expect(list.filter((a) => a.atype === 'generic')).toHaveLength(1);
      const g = list.find((a) => a.atype === 'generic');
      expect(g?.label).toBe('v2');
      expect(g?.committed).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('listForSession unions across the session\'s runs (DB rows + snapshots)', async () => {
    const db = buildDb();
    seedRun(db, 'run-a', 'sess-1');
    seedRun(db, 'run-b', 'sess-1');
    seedRun(db, 'run-other', 'sess-2');
    const { router, cleanup } = wireLifecycleRouter(db);
    try {
      await router.apply(1, { op: 'create', runId: 'run-a', atype: 'idea-spec', label: 'a', actor: 'orchestrator' });
      const g = await router.apply(1, {
        op: 'create', runId: 'run-b', atype: 'generic', label: 'b', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await router.apply(1, { op: 'commit', artifactId: g.artifactId, actor: 'user' });
      await router.apply(1, { op: 'create', runId: 'run-other', atype: 'idea-spec', label: 'other', actor: 'orchestrator' });

      const list = await router.listForSession(1, 'sess-1');
      expect(list.map((a) => a.runId).sort()).toEqual(['run-a', 'run-b']);
      expect(list.find((a) => a.runId === 'run-b')?.committed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('getById resolves a committed artifact from its snapshot after the DB row is deleted', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const { router, cleanup } = wireLifecycleRouter(db);
    try {
      const gen = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'g', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await router.apply(1, { op: 'commit', artifactId: gen.artifactId, actor: 'user' });
      expect(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(gen.artifactId)).toBeUndefined();

      // No runId/atype hints → cannot resolve the snapshot.
      expect(await router.getById(gen.artifactId)).toBeNull();
      // With hints → resolves from the snapshot manifest.
      const a = await router.getById(gen.artifactId, 'run-1', 'generic');
      expect(a?.id).toBe(gen.artifactId);
      expect(a?.committed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('reapForRun deletes committed=0 rows + fs-removes the run subtree; committed snapshots survive', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const { router, storeDir, runArtifacts, cleanup } = wireLifecycleRouter(db);
    try {
      seedRunArtifacts(runArtifacts);
      // One uncommitted + one committed (snapshotted, DB row deleted).
      const ephemeral = await router.apply(1, { op: 'create', runId: 'run-1', atype: 'idea-spec', label: 'idea', actor: 'orchestrator' });
      const gen = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'generic', label: 'g', payloadJson: '{"url":"http://x"}', actor: 'user',
      });
      await router.apply(1, { op: 'commit', artifactId: gen.artifactId, actor: 'user' });

      const events: ArtifactChangedEvent[] = [];
      artifactChangeEvents.on(artifactProjectChannel(1), (e: ArtifactChangedEvent) => events.push(e));

      const { deleted } = await router.reapForRun(1, 'run-1');
      expect(deleted).toEqual([ephemeral.artifactId]);
      expect(events.some((e) => e.action === 'deleted' && e.artifactId === ephemeral.artifactId)).toBe(true);
      // The uncommitted DB row is gone; the run subtree was removed.
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 });
      expect(existsSync(runArtifacts)).toBe(false);
      // The committed snapshot survives the reap (it lives in the project-root store).
      expect(await loadCommittedSnapshot(storeDir, 'run-1', 'generic')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('accept-baseline resolves the verdict off the committed snapshot manifest (DB row deleted)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const projectRoot = mkdtempSync(join(tmpdir(), 'artifact-accept-proj-'));
    const runArtifacts = mkdtempSync(join(tmpdir(), 'artifact-accept-run-'));
    const storeDir = resolveArtifactCommitDir(projectRoot, '.cyboflow/artifacts');
    // The captured PNGs must exist under the run artifacts dir for the byte copy.
    writeFileSync(join(runArtifacts, 'desktop.png'), 'PNG', 'utf-8');
    const acceptCalls: Array<{ baselineKey: string; fileNames: string[] }> = [];
    const router = ArtifactRouter.initialize(
      dbAdapter(db),
      undefined,
      () => storeDir,
      async ({ baselineKey, fileNames }) => { acceptCalls.push({ baselineKey, fileNames }); return { baselineKey }; },
      () => runArtifacts,
    );
    try {
      const payload: ScreenshotsArtifactPayload = {
        fileNames: ['desktop.png'],
        verdict: passVerdict({ judgedFileNames: ['desktop.png'], baselineKey: 'home' }),
      };
      const { artifactId } = await router.apply(1, {
        op: 'create', runId: 'run-1', atype: 'screenshots', label: 's',
        payloadJson: JSON.stringify(payload), actor: 'orchestrator',
      });
      // Commit → DB row deleted, only the snapshot manifest remains.
      await router.apply(1, { op: 'commit', artifactId, actor: 'user' });
      expect(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId)).toBeUndefined();

      const res = await router.acceptAsBaseline(1, {
        op: 'accept-baseline', runId: 'run-1', baselineKey: 'home', fileNames: ['desktop.png'], actor: 'user',
      });
      expect(res).toEqual({ baselineKey: 'home' });
      expect(acceptCalls).toEqual([{ baselineKey: 'home', fileNames: ['desktop.png'] }]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(runArtifacts, { recursive: true, force: true });
    }
  });
});
