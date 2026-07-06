/**
 * Integration tests for the cyboflow.artifacts tRPC router.
 *
 * Wires the live router through appRouter.createCaller against an in-memory
 * SQLite DB (projects + 006/011/014/015/016/035, so workflow_runs / entity_events
 * / artifacts all exist) and the real ArtifactRouter chokepoint singleton (reset
 * between tests). Focus:
 *   - list         : WHERE construction (with / without the committed filter) +
 *                    ORDER + shapeRow mapping (numeric flags → booleans).
 *   - listBySession: JOINs workflow_runs on session_id — returns artifacts across
 *                    TWO different runs sharing one session, excludes another
 *                    session's run, and shapes rows identically to `list`.
 *   - get   : shaped row / null on miss.
 *   - commit: forwards op='commit', actor='user', optional payloadJson; ArtifactError
 *             codes surface as the mapped TRPCError (esp. already_committed→CONFLICT)
 *             with the `${code}: ${message}` message.
 *   - every db-backed proc throws PRECONDITION_FAILED when ctx.db is unwired.
 *   - onArtifactChanged is scoped to artifactProjectChannel(projectId) and respects abort.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import {
  ArtifactRouter,
  artifactChangeEvents,
  artifactProjectChannel,
} from '../../../artifactRouter';
import type { ArtifactChangedEvent } from '../../../../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// Test DB
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

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
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
  // test DB doesn't create. We only need the column for listBySession's JOIN.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  return db;
}

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

/** Insert a raw artifact row (controls created_at so ORDER is deterministic). */
function insertArtifact(
  db: Database.Database,
  o: {
    id: string;
    runId: string;
    atype?: string;
    label?: string;
    committed?: boolean;
    createdAt: string;
    payloadJson?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO artifacts
       (id, run_id, session_id, atype, label, step_origin, mode, committed, session_only,
        is_new, payload_json, source_ref, created_at, committed_at)
     VALUES (?, ?, NULL, ?, ?, NULL, 'canvas', ?, 1, 1, ?, NULL, ?, NULL)`,
  ).run(
    o.id,
    o.runId,
    o.atype ?? 'generic',
    o.label ?? o.id,
    o.committed ? 1 : 0,
    o.payloadJson ?? null,
    o.createdAt,
  );
}

function buildCaller(withDb = true): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
} {
  const db = buildDb();
  const adapter = dbAdapter(db);
  ArtifactRouter.initialize(adapter);
  const caller = appRouter.createCaller(
    createContext(withDb ? { db: adapter } : {}),
  );
  return { caller, db };
}

afterEach(() => {
  ArtifactRouter._resetForTesting();
  artifactChangeEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('cyboflow.artifacts.list', () => {
  it('returns all of a run’s artifacts oldest-first, shaped via ArtifactRouter.shapeRow', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    insertArtifact(db, {
      id: 'art_b',
      runId: 'run-1',
      atype: 'screenshots',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    insertArtifact(db, {
      id: 'art_a',
      runId: 'run-1',
      atype: 'idea-spec',
      committed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const out = await caller.cyboflow.artifacts.list({ runId: 'run-1' });
    expect(out.map((a) => a.id)).toEqual(['art_a', 'art_b']);
    // shapeRow maps numeric flags to booleans.
    expect(out[0].committed).toBe(true);
    expect(out[0].sessionOnly).toBe(true);
    expect(out[1].committed).toBe(false);
  });

  it('applies the committed filter (true → committed only, false → uncommitted only)', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    insertArtifact(db, {
      id: 'art_committed',
      runId: 'run-1',
      atype: 'idea-spec',
      committed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertArtifact(db, {
      id: 'art_draft',
      runId: 'run-1',
      atype: 'screenshots',
      committed: false,
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(
      (await caller.cyboflow.artifacts.list({ runId: 'run-1', committed: true })).map((a) => a.id),
    ).toEqual(['art_committed']);
    expect(
      (await caller.cyboflow.artifacts.list({ runId: 'run-1', committed: false })).map((a) => a.id),
    ).toEqual(['art_draft']);
  });

  it('throws PRECONDITION_FAILED when ctx.db is unwired', async () => {
    const { caller } = buildCaller(false);
    await expect(caller.cyboflow.artifacts.list({ runId: 'run-1' })).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// listBySession
// ---------------------------------------------------------------------------

describe('cyboflow.artifacts.listBySession', () => {
  it("returns artifacts across TWO different runs sharing one session_id, oldest-first, shapeRow-mapped", async () => {
    const { caller, db } = buildCaller();
    // Two runs (e.g. the '__quick__' chat sentinel + a later flow run) hosted by
    // the SAME session — this is exactly what QuickSessionCenterPane / RunCenterPane
    // need: a session's deliverables regardless of which run produced them.
    seedRunInProject(db, 'run-quick-chat-1', 1, 'sess-shared');
    seedRunInProject(db, 'run-flow-1', 1, 'sess-shared');
    insertArtifact(db, {
      id: 'art_from_chat',
      runId: 'run-quick-chat-1',
      atype: 'generic',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertArtifact(db, {
      id: 'art_from_flow',
      runId: 'run-flow-1',
      atype: 'idea-spec',
      committed: true,
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const out = await caller.cyboflow.artifacts.listBySession({ sessionId: 'sess-shared' });
    expect(out.map((a) => a.id)).toEqual(['art_from_chat', 'art_from_flow']);
    // Same shapeRow mapper as `list` — numeric flags mapped to booleans.
    expect(out[0].committed).toBe(false);
    expect(out[1].committed).toBe(true);
    expect(out[1].runId).toBe('run-flow-1');
  });

  it("excludes another session's run", async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-mine', 1, 'sess-mine');
    seedRunInProject(db, 'run-other', 1, 'sess-other');
    insertArtifact(db, {
      id: 'art_mine',
      runId: 'run-mine',
      atype: 'generic',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertArtifact(db, {
      id: 'art_other',
      runId: 'run-other',
      atype: 'generic',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const out = await caller.cyboflow.artifacts.listBySession({ sessionId: 'sess-mine' });
    expect(out.map((a) => a.id)).toEqual(['art_mine']);
  });

  it('shapes rows identically to `list` (same mapper, same fields)', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1, 'sess-shared');
    insertArtifact(db, {
      id: 'art_x',
      runId: 'run-1',
      atype: 'idea-spec',
      committed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const viaList = await caller.cyboflow.artifacts.list({ runId: 'run-1' });
    const viaSession = await caller.cyboflow.artifacts.listBySession({ sessionId: 'sess-shared' });
    expect(viaSession).toEqual(viaList);
  });

  it('throws PRECONDITION_FAILED when ctx.db is unwired', async () => {
    const { caller } = buildCaller(false);
    await expect(
      caller.cyboflow.artifacts.listBySession({ sessionId: 'sess-1' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof TRPCError && e.code === 'PRECONDITION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('cyboflow.artifacts.get', () => {
  it('returns the shaped artifact by id', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    insertArtifact(db, {
      id: 'art_x',
      runId: 'run-1',
      atype: 'idea-spec',
      label: 'spec',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const got = await caller.cyboflow.artifacts.get({ artifactId: 'art_x' });
    expect(got).not.toBeNull();
    expect(got?.id).toBe('art_x');
    expect(got?.atype).toBe('idea-spec');
    expect(got?.runId).toBe('run-1');
  });

  it('returns null on a missing id', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    expect(await caller.cyboflow.artifacts.get({ artifactId: 'art_missing' })).toBeNull();
  });

  it('throws PRECONDITION_FAILED when ctx.db is unwired', async () => {
    const { caller } = buildCaller(false);
    await expect(caller.cyboflow.artifacts.get({ artifactId: 'art_x' })).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('cyboflow.artifacts.commit', () => {
  it('forwards op=commit / actor=user and persists committed=1 with a committed audit row', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    const { artifactId } = await ArtifactRouter.getInstance().apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'generic',
      label: 'draft',
      actor: 'agent:x',
    });

    const res = await caller.cyboflow.artifacts.commit({ projectId: 1, artifactId });
    expect(res).toEqual({ artifactId });

    const row = db.prepare('SELECT committed, session_only FROM artifacts WHERE id = ?').get(
      artifactId,
    ) as { committed: number; session_only: number };
    expect(row.committed).toBe(1);
    expect(row.session_only).toBe(0);

    const audit = db
      .prepare(
        "SELECT actor, kind FROM entity_events WHERE entity_type='artifact' AND entity_id=? AND kind='committed'",
      )
      .get(artifactId) as { actor: string; kind: string } | undefined;
    expect(audit?.actor).toBe('user');
  });

  it('forwards an optional payloadJson through the chokepoint', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    const { artifactId } = await ArtifactRouter.getInstance().apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'generic',
      label: 'draft',
      actor: 'agent:x',
    });

    await caller.cyboflow.artifacts.commit({
      projectId: 1,
      artifactId,
      payloadJson: '{"url":"http://x"}',
    });

    const row = db.prepare('SELECT payload_json FROM artifacts WHERE id = ?').get(artifactId) as {
      payload_json: string | null;
    };
    expect(row.payload_json).toBe('{"url":"http://x"}');
  });

  it('re-committing surfaces already_committed as a CONFLICT with the `code: message` shape', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    const { artifactId } = await ArtifactRouter.getInstance().apply(1, {
      op: 'create',
      runId: 'run-1',
      atype: 'generic',
      label: 'draft',
      actor: 'agent:x',
    });
    await caller.cyboflow.artifacts.commit({ projectId: 1, artifactId });

    await expect(
      caller.cyboflow.artifacts.commit({ projectId: 1, artifactId }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof TRPCError &&
        e.code === 'CONFLICT' &&
        e.message.startsWith('already_committed: '),
    );
  });

  it('maps a missing artifact to NOT_FOUND (not_found)', async () => {
    const { caller, db } = buildCaller();
    seedRunInProject(db, 'run-1', 1);
    await expect(
      caller.cyboflow.artifacts.commit({ projectId: 1, artifactId: 'art_missing' }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof TRPCError && e.code === 'NOT_FOUND' && e.message.startsWith('not_found: '),
    );
  });

  it('maps a cross-project commit to NOT_FOUND (wrong_project)', async () => {
    const { caller, db } = buildCaller();
    // Artifact owned by project 2's run, committed via project 1's queue.
    seedRunInProject(db, 'run-2', 2);
    const { artifactId } = await ArtifactRouter.getInstance().apply(2, {
      op: 'create',
      runId: 'run-2',
      atype: 'generic',
      label: 'draft',
      actor: 'agent:x',
    });

    await expect(
      caller.cyboflow.artifacts.commit({ projectId: 1, artifactId }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof TRPCError &&
        e.code === 'NOT_FOUND' &&
        e.message.startsWith('wrong_project: '),
    );
  });
});

// ---------------------------------------------------------------------------
// onArtifactChanged
// ---------------------------------------------------------------------------

describe('cyboflow.artifacts.onArtifactChanged', () => {
  it('yields only events on the requested project’s channel, then detaches on abort', async () => {
    const { caller } = buildCaller();
    const subscription = (await caller.cyboflow.artifacts.onArtifactChanged({
      projectId: 1,
    })) as AsyncIterable<ArtifactChangedEvent>;

    const mkEvent = (projectId: number): ArtifactChangedEvent => ({
      projectId,
      runId: 'run-1',
      sessionId: null,
      artifactId: `art_${projectId}`,
      atype: 'generic',
      action: 'created',
      artifact: null,
    });

    const resultPromise = (async () => {
      for await (const ev of subscription) return ev;
      return undefined;
    })();

    setImmediate(() => {
      // Emit on a DIFFERENT project's channel first — must be ignored.
      artifactChangeEvents.emit(artifactProjectChannel(2), mkEvent(2));
      artifactChangeEvents.emit(artifactProjectChannel(1), mkEvent(1));
    });

    const received = await resultPromise;
    expect(received?.projectId).toBe(1);
    expect(received?.artifactId).toBe('art_1');
    // Listener for project 1's channel torn down after the generator returns.
    expect(artifactChangeEvents.listenerCount(artifactProjectChannel(1))).toBe(0);
  });
});
