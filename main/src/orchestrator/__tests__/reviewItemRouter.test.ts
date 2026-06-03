/**
 * Unit tests for ReviewItemRouter — the unified review-inbox write chokepoint
 * (review_items, migration 016).
 *
 * Covered:
 *  - create path for all 4 kinds (finding/permission/decision/human_task); each
 *    mints an 'rvw_' id + inserts status='pending' + logs a 'created'
 *    entity_events row keyed (entity_type='review_item', entity_id).
 *  - per-kind payload validation: a payload whose discriminant != kind is rejected.
 *  - soft entity link validation: entityType/entityId must be set together.
 *  - triage: resolve + dismiss set status/resolved_by/resolution + write a delta
 *    event; re-triaging a terminal item is rejected (invalid_status).
 *  - blocking boolean round-trips (0/1 <-> boolean) on the emitted item.
 *  - concurrent writes serialize per project (the PQueue is concurrency=1).
 *  - FK cascade: deleting the project removes its review items.
 *  - reviewItemChangeEvents emits on 'review-project-<id>'; the emitted item
 *    carries kind/status/blocking/payload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReviewItemRouter,
  reviewItemChangeEvents,
  reviewItemProjectChannel,
} from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import type { ReviewItemChangedEvent } from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016.
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
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

/** Count the entity_events rows for a review item. */
function eventCount(db: Database.Database, reviewItemId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'review_item' AND entity_id = ?")
      .get(reviewItemId) as { n: number }
  ).n;
}

describe('ReviewItemRouter (unified review inbox)', () => {
  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    reviewItemChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // create — all 4 kinds
  // -------------------------------------------------------------------------

  it.each(['finding', 'permission', 'decision', 'human_task'] as const)(
    'creates a %s review item (rvw_ id, status=pending, created entity_event)',
    async (kind) => {
      const db = buildDb();
      const router = ReviewItemRouter.initialize(dbAdapter(db));

      const { reviewItemId, event } = await router.applyReviewItem(1, {
        op: 'create',
        actor: 'agent:executor',
        kind,
        title: `A ${kind}`,
      });

      expect(reviewItemId.startsWith('rvw_')).toBe(true);
      const row = db.prepare('SELECT kind, status, blocking, title FROM review_items WHERE id = ?').get(reviewItemId) as {
        kind: string;
        status: string;
        blocking: number;
        title: string;
      };
      expect(row.kind).toBe(kind);
      expect(row.status).toBe('pending');
      expect(row.blocking).toBe(0);
      expect(row.title).toBe(`A ${kind}`);

      const ev = db.prepare('SELECT seq, actor, kind, entity_type FROM entity_events WHERE id = ?').get(event.id) as {
        seq: number;
        actor: string;
        kind: string;
        entity_type: string;
      };
      expect(ev.seq).toBe(1);
      expect(ev.actor).toBe('agent:executor');
      expect(ev.kind).toBe('created');
      expect(ev.entity_type).toBe('review_item');
    },
  );

  it('blocking + severity + source + run link round-trip on create', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = ReviewItemRouter.initialize(dbAdapter(db));

    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'orchestrator',
      kind: 'permission',
      title: 'Bash approval',
      blocking: true,
      severity: 'warning',
      source: 'approval',
      runId: 'run-1',
    });

    const row = db
      .prepare('SELECT blocking, severity, source, run_id FROM review_items WHERE id = ?')
      .get(reviewItemId) as { blocking: number; severity: string; source: string; run_id: string };
    expect(row.blocking).toBe(1);
    expect(row.severity).toBe('warning');
    expect(row.source).toBe('approval');
    expect(row.run_id).toBe('run-1');
  });

  // -------------------------------------------------------------------------
  // per-kind payload + entity-link validation
  // -------------------------------------------------------------------------

  it('stores a matching per-kind payload as JSON and parses it back on the emitted item', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));

    const events: ReviewItemChangedEvent[] = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => events.push(e));

    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'N+1 query',
      severity: 'warning',
      payload: { kind: 'finding', category: 'perf', suggestedFix: 'batch the reads' },
    });

    const stored = db.prepare('SELECT payload_json FROM review_items WHERE id = ?').get(reviewItemId) as {
      payload_json: string;
    };
    expect(JSON.parse(stored.payload_json)).toEqual({
      kind: 'finding',
      category: 'perf',
      suggestedFix: 'batch the reads',
    });

    expect(events).toHaveLength(1);
    expect(events[0].item.payload).toEqual({ kind: 'finding', category: 'perf', suggestedFix: 'batch the reads' });
  });

  it('rejects a payload whose discriminant does not match the item kind', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    await expect(
      router.applyReviewItem(1, {
        op: 'create',
        actor: 'user',
        kind: 'finding',
        title: 'Mismatch',
        // a decision payload on a finding item
        payload: { kind: 'decision', gate: 'approve-plan' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects a half-specified entity link (entityType without entityId, and vice versa)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    await expect(
      router.applyReviewItem(1, { op: 'create', actor: 'user', kind: 'finding', title: 'X', entityType: 'task' }),
    ).rejects.toMatchObject({ code: 'invalid_entity' });
    await expect(
      router.applyReviewItem(1, { op: 'create', actor: 'user', kind: 'finding', title: 'X', entityId: 'tsk_1' }),
    ).rejects.toMatchObject({ code: 'invalid_entity' });
  });

  it('accepts a fully-specified soft entity link (no hard FK)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'About a task',
      entityType: 'task',
      entityId: 'tsk_dangling', // intentionally non-existent — soft link
    });
    const row = db.prepare('SELECT entity_type, entity_id FROM review_items WHERE id = ?').get(reviewItemId) as {
      entity_type: string;
      entity_id: string;
    };
    expect(row.entity_type).toBe('task');
    expect(row.entity_id).toBe('tsk_dangling');
  });

  // -------------------------------------------------------------------------
  // triage: resolve / dismiss / status transitions
  // -------------------------------------------------------------------------

  it('resolve sets status=resolved + resolved_by + resolution and writes a delta event', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'T',
    });

    await router.applyReviewItem(1, {
      op: 'resolve',
      actor: 'user',
      reviewItemId,
      resolution: 'fixed inline',
    });

    const row = db
      .prepare('SELECT status, resolved_by, resolution FROM review_items WHERE id = ?')
      .get(reviewItemId) as { status: string; resolved_by: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolved_by).toBe('user');
    expect(row.resolution).toBe('fixed inline');
    expect(eventCount(db, reviewItemId)).toBe(2); // created + resolved

    const lastEvent = db
      .prepare(
        "SELECT kind, changes_json FROM entity_events WHERE entity_type = 'review_item' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(reviewItemId) as { kind: string; changes_json: string };
    expect(lastEvent.kind).toBe('resolved');
    const deltas = JSON.parse(lastEvent.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
    expect(deltas.find((d) => d.field === 'status')).toEqual({ field: 'status', from: 'pending', to: 'resolved' });
  });

  it('dismiss sets status=dismissed', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'Cruft',
    });
    await router.applyReviewItem(1, { op: 'dismiss', actor: 'user', reviewItemId });
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(reviewItemId) as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('re-triaging a terminal item is rejected with invalid_status', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'T',
    });
    await router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId });
    await expect(
      router.applyReviewItem(1, { op: 'dismiss', actor: 'user', reviewItemId }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
    await expect(
      router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
  });

  it('triaging an unknown item is rejected with not_found', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    await expect(
      router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId: 'rvw_nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // -------------------------------------------------------------------------
  // per-project queue + concurrency
  // -------------------------------------------------------------------------

  it('serializes concurrent creates per project (queue concurrency=1) and mints distinct ids', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        router.applyReviewItem(1, { op: 'create', actor: 'user', kind: 'finding', title: `f${i}` }),
      ),
    );
    const ids = new Set(results.map((r) => r.reviewItemId));
    expect(ids.size).toBe(8);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE project_id = 1').get() as { n: number }).n;
    expect(count).toBe(8);
  });

  it('keeps per-project queues independent', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const a = await router.applyReviewItem(1, { op: 'create', actor: 'user', kind: 'finding', title: 'p1' });
    const b = await router.applyReviewItem(2, { op: 'create', actor: 'user', kind: 'finding', title: 'p2' });
    expect((db.prepare('SELECT project_id FROM review_items WHERE id = ?').get(a.reviewItemId) as { project_id: number }).project_id).toBe(1);
    expect((db.prepare('SELECT project_id FROM review_items WHERE id = ?').get(b.reviewItemId) as { project_id: number }).project_id).toBe(2);
    // distinct queue instances
    expect(router._queueForProject(1)).not.toBe(router._queueForProject(2));
  });

  // -------------------------------------------------------------------------
  // FK cascade
  // -------------------------------------------------------------------------

  it('FK cascade: deleting the project removes its review items', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, { op: 'create', actor: 'user', kind: 'finding', title: 'T' });
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    const row = db.prepare('SELECT id FROM review_items WHERE id = ?').get(reviewItemId);
    expect(row).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // emit
  // -------------------------------------------------------------------------

  it('emits ReviewItemChangedEvent (created then resolved) carrying the shaped item', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));

    const events: ReviewItemChangedEvent[] = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => events.push(e));

    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'decision',
      title: 'Approve plan?',
      blocking: true,
      payload: { kind: 'decision', gate: 'approve-plan', summary: 'ship it' },
    });
    await router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId, resolution: 'approved' });

    expect(events.map((e) => e.action)).toEqual(['created', 'resolved']);
    expect(events[0].item.kind).toBe('decision');
    expect(events[0].item.blocking).toBe(true);
    expect(events[0].item.payload).toEqual({ kind: 'decision', gate: 'approve-plan', summary: 'ship it' });
    expect(events[0].reviewItemId).toBe(reviewItemId);
    expect(events[1].item.status).toBe('resolved');
    expect(events[1].item.resolution).toBe('approved');
  });
});

// Compile-time smoke: ReviewItemRouter satisfies a DatabaseLike-injected constructor.
const _typecheck = (db: DatabaseLike): ReviewItemRouter => new ReviewItemRouter(db);
void _typecheck;
