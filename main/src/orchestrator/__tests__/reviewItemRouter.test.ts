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
 *  - findings-triage ops (migration 034): mutate (re-tag without clobbering
 *    siblings + re-prioritize, untriaged-only, rejects staged/non-finding),
 *    approve (untriaged → ready, sets staged_at WITHOUT selecting, rejects
 *    non-pending/already-staged), set-selected (batch toggle, only staged
 *    findings selectable, one event per id, orchestrator close-out path).
 *  - exhaustive-switch dispatch: a new op does NOT fall through to runTriage.
 *  - shapeRow normalizes selected 0/1 → boolean + surfaces priority/staged_at.
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
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 034.
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
  // 034 adds the finding-triage columns (priority/staged_at/selected) the
  // mutate/approve/set-selected ops read + write.
  db.exec(readFileSync(join(migDir, '034_findings_triage.sql'), 'utf-8'));
  return db;
}

/** Create a finding and return its minted id (DRY helper for triage tests). */
async function createFinding(
  router: ReviewItemRouter,
  opts: {
    projectId?: number;
    title?: string;
    actor?: 'user' | 'orchestrator' | `agent:${string}` | 'linear';
    payload?: { kind: 'finding'; category?: string; suggestedFix?: string; proposedTarget?: 'backlog' | 'docs' | 'prompt' | 'fix' };
  } = {},
): Promise<string> {
  const { reviewItemId } = await router.applyReviewItem(opts.projectId ?? 1, {
    op: 'create',
    actor: opts.actor ?? 'agent:executor',
    kind: 'finding',
    title: opts.title ?? 'A finding',
    payload: opts.payload ?? null,
  });
  return reviewItemId;
}

/** Read the finding-triage columns off a row. */
function triageCols(
  db: Database.Database,
  reviewItemId: string,
): { status: string; priority: string | null; staged_at: string | null; selected: number; payload_json: string | null } {
  return db
    .prepare('SELECT status, priority, staged_at, selected, payload_json FROM review_items WHERE id = ?')
    .get(reviewItemId) as {
    status: string;
    priority: string | null;
    staged_at: string | null;
    selected: number;
    payload_json: string | null;
  };
}

/** Read the last (highest-seq) entity_events row for a review item. */
function lastEntityEvent(
  db: Database.Database,
  reviewItemId: string,
): { kind: string; actor: string; changes_json: string } {
  return db
    .prepare(
      "SELECT kind, actor, changes_json FROM entity_events WHERE entity_type = 'review_item' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(reviewItemId) as { kind: string; actor: string; changes_json: string };
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
  // mutate — re-tag / re-prioritize (applied-not-consumed, untriaged-only)
  // -------------------------------------------------------------------------

  it('mutate re-tags a finding (sets payload.proposedTarget incl "fix") without clobbering siblings', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router, {
      payload: { kind: 'finding', category: 'perf', suggestedFix: 'batch the reads' },
    });

    await router.applyReviewItem(1, {
      op: 'mutate',
      actor: 'user',
      reviewItemId,
      proposedTarget: 'fix',
    });

    const cols = triageCols(db, reviewItemId);
    expect(cols.status).toBe('pending'); // applied-not-consumed
    expect(cols.staged_at).toBeNull();
    const payload = JSON.parse(cols.payload_json ?? '{}') as {
      kind: string;
      category?: string;
      suggestedFix?: string;
      proposedTarget?: string;
    };
    expect(payload.proposedTarget).toBe('fix');
    // siblings preserved
    expect(payload.kind).toBe('finding');
    expect(payload.category).toBe('perf');
    expect(payload.suggestedFix).toBe('batch the reads');
  });

  it('mutate synthesizes a finding payload when the row has no payload yet', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router, { payload: undefined });

    await router.applyReviewItem(1, {
      op: 'mutate',
      actor: 'user',
      reviewItemId,
      proposedTarget: 'docs',
    });

    const cols = triageCols(db, reviewItemId);
    const payload = JSON.parse(cols.payload_json ?? '{}') as { kind: string; proposedTarget?: string };
    expect(payload.kind).toBe('finding');
    expect(payload.proposedTarget).toBe('docs');
  });

  it('mutate re-prioritizes a finding (sets the priority column)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    await router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, priority: 'P0' });

    const cols = triageCols(db, reviewItemId);
    expect(cols.priority).toBe('P0');
    expect(cols.status).toBe('pending');
    expect(cols.staged_at).toBeNull();
  });

  it('mutate re-tags AND re-prioritizes in one call', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router, {
      payload: { kind: 'finding', category: 'security' },
    });

    await router.applyReviewItem(1, {
      op: 'mutate',
      actor: 'user',
      reviewItemId,
      proposedTarget: 'backlog',
      priority: 'P1',
    });

    const cols = triageCols(db, reviewItemId);
    expect(cols.priority).toBe('P1');
    const payload = JSON.parse(cols.payload_json ?? '{}') as { proposedTarget?: string; category?: string };
    expect(payload.proposedTarget).toBe('backlog');
    expect(payload.category).toBe('security'); // sibling preserved
  });

  it('mutate writes a "mutated" entity_events delta carrying from/to', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router, {
      payload: { kind: 'finding', proposedTarget: 'docs' },
    });

    await router.applyReviewItem(1, {
      op: 'mutate',
      actor: 'user',
      reviewItemId,
      proposedTarget: 'fix',
      priority: 'P0',
    });

    const ev = lastEntityEvent(db, reviewItemId);
    expect(ev.kind).toBe('mutated');
    expect(ev.actor).toBe('user');
    const deltas = JSON.parse(ev.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
    expect(deltas).toContainEqual({ field: 'proposedTarget', from: 'docs', to: 'fix' });
    expect(deltas).toContainEqual({ field: 'priority', from: null, to: 'P0' });
  });

  it('mutate emits a "mutated" ReviewItemChangedEvent on review-project-<id>', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    const events: ReviewItemChangedEvent[] = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => events.push(e));

    await router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, priority: 'P2' });

    expect(events.map((e) => e.action)).toEqual(['mutated']);
    expect(events[0].item.priority).toBe('P2');
  });

  it('mutate rejects a staged (ready) finding with invalid_status', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });

    await expect(
      router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, priority: 'P0' }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
  });

  it('mutate rejects a non-finding kind with invalid_payload', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const { reviewItemId } = await router.applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'decision',
      title: 'Approve plan?',
      payload: { kind: 'decision', gate: 'approve-plan' },
    });

    await expect(
      router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, proposedTarget: 'fix' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  // -------------------------------------------------------------------------
  // approve — untriaged → ready (staged, NOT selected)
  // -------------------------------------------------------------------------

  it('approve sets staged_at WITHOUT selecting and writes a "staged" event', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });

    const cols = triageCols(db, reviewItemId);
    expect(cols.status).toBe('pending'); // status NOT overloaded
    expect(cols.staged_at).not.toBeNull();
    expect(cols.selected).toBe(0); // approve stages a candidate; selection is separate

    const ev = lastEntityEvent(db, reviewItemId);
    expect(ev.kind).toBe('staged');
    const deltas = JSON.parse(ev.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
    expect(deltas).toEqual([{ field: 'staged_at', from: null, to: 'set' }]); // no selected delta
  });

  it('approve emits a "staged" ReviewItemChangedEvent with selected=false', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    const events: ReviewItemChangedEvent[] = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => events.push(e));

    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });

    expect(events.map((e) => e.action)).toEqual(['staged']);
    expect(events[0].item.selected).toBe(false);
    expect(events[0].item.staged_at).not.toBeNull();
  });

  it('approve rejects a non-pending (resolved) finding with invalid_status', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);
    await router.applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId });

    await expect(
      router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
  });

  it('approve rejects an already-staged finding with invalid_status', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });

    await expect(
      router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
  });

  // -------------------------------------------------------------------------
  // set-selected — batch toggle of the compound-this checkbox
  // -------------------------------------------------------------------------

  it('set-selected batch-toggles selected over the explicit id list', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const a = await createFinding(router, { title: 'a' });
    const b = await createFinding(router, { title: 'b' });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: a });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: b });

    // approve stages without selecting — select both explicitly, then clear both
    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'user',
      reviewItemIds: [a, b],
      selected: true,
    });
    expect(triageCols(db, a).selected).toBe(1);
    expect(triageCols(db, b).selected).toBe(1);

    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'user',
      reviewItemIds: [a, b],
      selected: false,
    });
    expect(triageCols(db, a).selected).toBe(0);
    expect(triageCols(db, b).selected).toBe(0);

    // re-select only a
    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'user',
      reviewItemIds: [a],
      selected: true,
    });
    expect(triageCols(db, a).selected).toBe(1);
    expect(triageCols(db, b).selected).toBe(0);
  });

  it('set-selected emits one "selection-changed" event per affected id', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const a = await createFinding(router, { title: 'a' });
    const b = await createFinding(router, { title: 'b' });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: a });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: b });

    const events: ReviewItemChangedEvent[] = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => events.push(e));

    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'user',
      reviewItemIds: [a, b],
      selected: false,
    });

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === 'selection-changed')).toBe(true);
    expect(new Set(events.map((e) => e.reviewItemId))).toEqual(new Set([a, b]));
    expect(events.every((e) => e.item.selected === false)).toBe(true);
  });

  it('set-selected rejects an unstaged id with invalid_status (whole batch rolls back)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const staged = await createFinding(router, { title: 'staged' });
    const untriaged = await createFinding(router, { title: 'untriaged' });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: staged });
    // approve no longer pre-selects — select the staged row so the rollback below
    // has a non-default value to preserve.
    await router.applyReviewItem(1, { op: 'set-selected', actor: 'user', reviewItemIds: [staged], selected: true });

    await expect(
      router.applyReviewItem(1, {
        op: 'set-selected',
        actor: 'user',
        reviewItemIds: [staged, untriaged],
        selected: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_status' });
    // atomic: the failed batch rolled back, so the staged row stays selected=1
    expect(triageCols(db, staged).selected).toBe(1);
  });

  it('set-selected with selected=false clears selection (orchestrator close-out path)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-x'); // entity_events.run_id FKs workflow_runs — the close-out passes a real runId
    const reviewItemId = await createFinding(router);
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });
    // approve no longer pre-selects — select it so the close-out has something to clear.
    await router.applyReviewItem(1, { op: 'set-selected', actor: 'user', reviewItemIds: [reviewItemId], selected: true });
    expect(triageCols(db, reviewItemId).selected).toBe(1);

    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'orchestrator',
      reviewItemIds: [reviewItemId],
      selected: false,
      runId: 'run-x',
    });

    const cols = triageCols(db, reviewItemId);
    expect(cols.selected).toBe(0);
    expect(cols.staged_at).not.toBeNull(); // stays in READY for the human to re-decide

    const ev = lastEntityEvent(db, reviewItemId);
    expect(ev.kind).toBe('selection-changed');
    expect(ev.actor).toBe('orchestrator');
  });

  // -------------------------------------------------------------------------
  // exhaustive-switch dispatch — a new op does NOT fall through to runTriage
  // -------------------------------------------------------------------------

  it('mutate/approve/set-selected do NOT fall through to the resolve/dismiss path', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    // mutate must NOT resolve/dismiss the row (the old ternary would have).
    await router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, priority: 'P1' });
    expect(triageCols(db, reviewItemId).status).toBe('pending');
    expect(db.prepare('SELECT resolved_by FROM review_items WHERE id = ?').get(reviewItemId)).toMatchObject({
      resolved_by: null,
    });

    // approve must NOT set status terminal.
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });
    expect(triageCols(db, reviewItemId).status).toBe('pending');

    // set-selected must NOT set status terminal.
    await router.applyReviewItem(1, {
      op: 'set-selected',
      actor: 'user',
      reviewItemIds: [reviewItemId],
      selected: false,
    });
    expect(triageCols(db, reviewItemId).status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // shapeRow — normalizes selected + surfaces priority/staged_at
  // -------------------------------------------------------------------------

  it('shapeRow normalizes selected 0/1 → boolean and surfaces priority/staged_at', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const reviewItemId = await createFinding(router);

    // untriaged baseline
    const beforeRow = db.prepare('SELECT * FROM review_items WHERE id = ?').get(reviewItemId) as Parameters<
      typeof ReviewItemRouter.shapeRow
    >[0];
    const before = ReviewItemRouter.shapeRow(beforeRow);
    expect(before.selected).toBe(false);
    expect(before.priority).toBeNull();
    expect(before.staged_at).toBeNull();

    await router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId, priority: 'P0' });
    await router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId });
    // approve no longer pre-selects — select it so shapeRow's 1→true path is exercised.
    await router.applyReviewItem(1, { op: 'set-selected', actor: 'user', reviewItemIds: [reviewItemId], selected: true });

    const afterRow = db.prepare('SELECT * FROM review_items WHERE id = ?').get(reviewItemId) as Parameters<
      typeof ReviewItemRouter.shapeRow
    >[0];
    const after = ReviewItemRouter.shapeRow(afterRow);
    expect(after.selected).toBe(true);
    expect(after.priority).toBe('P0');
    expect(after.staged_at).not.toBeNull();
  });

  it('serializes mutate/approve/set-selected per project (PQueue concurrency=1)', async () => {
    const db = buildDb();
    const router = ReviewItemRouter.initialize(dbAdapter(db));
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createFinding(router, { title: `f${i}` })),
    );
    // fan out interleaved triage ops; the per-project queue must serialize them.
    await Promise.all([
      ...ids.map((id) => router.applyReviewItem(1, { op: 'mutate', actor: 'user', reviewItemId: id, priority: 'P2' })),
    ]);
    await Promise.all(ids.map((id) => router.applyReviewItem(1, { op: 'approve', actor: 'user', reviewItemId: id })));
    // approve no longer pre-selects — select via the set-selected op (also exercises
    // the third op the per-project queue must serialize).
    await Promise.all(
      ids.map((id) => router.applyReviewItem(1, { op: 'set-selected', actor: 'user', reviewItemIds: [id], selected: true })),
    );

    for (const id of ids) {
      const cols = triageCols(db, id);
      expect(cols.priority).toBe('P2');
      expect(cols.selected).toBe(1);
      expect(cols.staged_at).not.toBeNull();
    }
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
