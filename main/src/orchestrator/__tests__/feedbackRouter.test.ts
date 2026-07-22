/**
 * Unit tests for FeedbackRouter — the in-artifact feedback write chokepoint
 * (feedback_batches / feedback_comments, migration 077, IDEA-033).
 *
 * Covered:
 *  - create/update/delete draft lifecycle, incl. body-trim + empty-body rejection.
 *  - draft-only guards on update/delete (not_draft) once a comment is sent/addressed.
 *  - send-batch happy path: round increments across successive sends, comments
 *    stamped sent + batch_id, commentIds returned.
 *  - send-batch refusals: 'busy' (a pending batch already exists) and
 *    'no_comments' (nothing to send).
 *  - batch-applied flips the batch + its sent comments to applied/addressed;
 *    idempotent no-op on a non-pending batch.
 *  - batch-failed reverts sent comments to editable drafts (batch_id/sent_at
 *    cleared) while the failed batch row is preserved as the durable record;
 *    idempotent no-op on a non-pending batch.
 *  - not_found on an unknown commentId/batchId.
 *  - list helpers' camelCase shapes + fail-soft anchor parsing (a malformed
 *    anchor_json row is skipped, not thrown).
 *  - feedbackEvents emits on feedback-project-<id> after every committed write,
 *    carrying the full refreshed comments+batches for the touched document.
 *  - per-project PQueue keeps queues independent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedbackRouter } from '../feedbackRouter';
import { feedbackEvents, feedbackProjectChannel } from '../trpc/routers/events';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import type { FeedbackChangedEvent, CommentAnchor } from '../../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 075.
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
    '077_artifact_feedback.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

function seedRun(db: Database.Database, runId: string, projectId = 1): void {
  const wfId = `wf-p${projectId}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'planner', '{}')`,
  ).run(wfId, projectId);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, ?, ?, 'running', 'default')`,
  ).run(runId, wfId, projectId);
}

const ANCHOR: CommentAnchor = { quote: 'the quoted text', occurrence: 0, bodyHash: 'abcd1234' };

describe('FeedbackRouter (in-artifact feedback chokepoint)', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // create-comment
  // -------------------------------------------------------------------------

  it('creates a draft comment (fbc_ id, status=draft, batch_id NULL)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));

    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'please clarify this',
    });

    expect(commentId.startsWith('fbc_')).toBe(true);
    const row = db
      .prepare('SELECT project_id, run_id, atype, source_ref, batch_id, body, status, anchor_json FROM feedback_comments WHERE id = ?')
      .get(commentId) as {
      project_id: number;
      run_id: string;
      atype: string;
      source_ref: string;
      batch_id: string | null;
      body: string;
      status: string;
      anchor_json: string;
    };
    expect(row.project_id).toBe(1);
    expect(row.run_id).toBe('run-1');
    expect(row.atype).toBe('idea-spec');
    expect(row.source_ref).toBe('idea-1');
    expect(row.batch_id).toBeNull();
    expect(row.body).toBe('please clarify this');
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.anchor_json)).toEqual(ANCHOR);
  });

  it('trims the comment body and rejects an empty-after-trim body', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));

    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: '  padded  ',
    });
    const row = db.prepare('SELECT body FROM feedback_comments WHERE id = ?').get(commentId) as { body: string };
    expect(row.body).toBe('padded');

    await expect(
      router.apply(1, {
        op: 'create-comment',
        runId: 'run-1',
        atype: 'idea-spec',
        sourceRef: 'idea-1',
        anchor: ANCHOR,
        body: '   ',
      }),
    ).rejects.toMatchObject({ code: 'invalid_body' });
  });

  it('rejects an unknown atype with invalid_atype', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));

    await expect(
      router.apply(1, {
        op: 'create-comment',
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against a bad atype crossing an untyped boundary
        atype: 'bogus' as any,
        sourceRef: 'idea-1',
        anchor: ANCHOR,
        body: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_atype' });
  });

  // -------------------------------------------------------------------------
  // update-comment / delete-comment — draft-only guards
  // -------------------------------------------------------------------------

  it('update-comment edits body and/or anchor on a draft and bumps updated_at', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'original',
    });
    const before = db.prepare('SELECT updated_at FROM feedback_comments WHERE id = ?').get(commentId) as {
      updated_at: string;
    };

    const newAnchor: CommentAnchor = { quote: 'new quote', occurrence: 1, bodyHash: 'deadbeef' };
    await router.apply(1, { op: 'update-comment', commentId, body: 'revised', anchor: newAnchor });

    const row = db.prepare('SELECT body, anchor_json, updated_at FROM feedback_comments WHERE id = ?').get(commentId) as {
      body: string;
      anchor_json: string;
      updated_at: string;
    };
    expect(row.body).toBe('revised');
    expect(JSON.parse(row.anchor_json)).toEqual(newAnchor);
    expect(row.updated_at >= before.updated_at).toBe(true);
  });

  it('update-comment on a sent comment is rejected with not_draft', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    await expect(
      router.apply(1, { op: 'update-comment', commentId, body: 'edit after send' }),
    ).rejects.toMatchObject({ code: 'not_draft' });
  });

  it('delete-comment hard-deletes a draft; rejects a sent comment with not_draft', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId: draftId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'to delete',
    });
    await router.apply(1, { op: 'delete-comment', commentId: draftId });
    expect(db.prepare('SELECT id FROM feedback_comments WHERE id = ?').get(draftId)).toBeUndefined();

    const { commentId: sentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'to send',
    });
    await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    await expect(router.apply(1, { op: 'delete-comment', commentId: sentId })).rejects.toMatchObject({
      code: 'not_draft',
    });
  });

  it('update-comment / delete-comment on an unknown id is rejected with not_found', async () => {
    const db = buildDb();
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await expect(
      router.apply(1, { op: 'update-comment', commentId: 'fbc_nope', body: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(router.apply(1, { op: 'delete-comment', commentId: 'fbc_nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  // -------------------------------------------------------------------------
  // send-batch
  // -------------------------------------------------------------------------

  it('send-batch mints round 1, stamps every draft sent + batch_id, and increments the round on the next send', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId: c1 } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'one',
    });
    const { commentId: c2 } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'two',
    });

    const first = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    expect(first.round).toBe(1);
    expect(new Set(first.commentIds)).toEqual(new Set([c1, c2]));

    for (const id of [c1, c2]) {
      const row = db.prepare('SELECT status, batch_id, sent_at FROM feedback_comments WHERE id = ?').get(id) as {
        status: string;
        batch_id: string | null;
        sent_at: string | null;
      };
      expect(row.status).toBe('sent');
      expect(row.batch_id).toBe(first.batchId);
      expect(row.sent_at).not.toBeNull();
    }

    const batchRow = db.prepare('SELECT status, round FROM feedback_batches WHERE id = ?').get(first.batchId) as {
      status: string;
      round: number;
    };
    expect(batchRow.status).toBe('pending');
    expect(batchRow.round).toBe(1);

    // batch-applied clears the pending gate so a second round can be sent.
    await router.apply(1, { op: 'batch-applied', batchId: first.batchId });
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'round 2',
    });
    const second = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    expect(second.round).toBe(2);
    expect(second.batchId).not.toBe(first.batchId);
  });

  it('send-batch refuses with busy when a pending batch already exists for the document', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'one',
    });
    await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'two',
    });
    await expect(
      router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('send-batch refuses with no_comments when there are no draft comments', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await expect(
      router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' }),
    ).rejects.toMatchObject({ code: 'no_comments' });
  });

  it('a busy or no_comments refusal rolls back — no batch row is left behind', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await expect(
      router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' }),
    ).rejects.toMatchObject({ code: 'no_comments' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM feedback_batches').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // batch-applied
  // -------------------------------------------------------------------------

  it('batch-applied flips a pending batch to applied and its sent comments to addressed', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    const result = await router.apply(1, { op: 'batch-applied', batchId });
    expect(result.applied).toBe(true);

    const batchRow = db.prepare('SELECT status, applied_at FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      applied_at: string | null;
    };
    expect(batchRow.status).toBe('applied');
    expect(batchRow.applied_at).not.toBeNull();

    const commentRow = db
      .prepare('SELECT status, addressed_at FROM feedback_comments WHERE id = ?')
      .get(commentId) as { status: string; addressed_at: string | null };
    expect(commentRow.status).toBe('addressed');
    expect(commentRow.addressed_at).not.toBeNull();
  });

  it('batch-applied on an already-terminal batch is an idempotent no-op', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    await router.apply(1, { op: 'batch-applied', batchId });

    const result = await router.apply(1, { op: 'batch-applied', batchId });
    expect(result.applied).toBe(false);
    const batchRow = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batchRow.status).toBe('applied'); // unchanged
  });

  it('batch-applied on an unknown batchId is rejected with not_found', async () => {
    const db = buildDb();
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await expect(router.apply(1, { op: 'batch-applied', batchId: 'fbb_nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  // -------------------------------------------------------------------------
  // batch-failed
  // -------------------------------------------------------------------------

  it('batch-failed flips a pending batch to failed + records error, and reverts sent comments to editable drafts', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    const result = await router.apply(1, { op: 'batch-failed', batchId, error: 'revision agent crashed' });
    expect(result.failed).toBe(true);

    const batchRow = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batchRow.status).toBe('failed');
    expect(batchRow.error).toBe('revision agent crashed');

    // The failed batch row is preserved as the durable record...
    expect(db.prepare('SELECT id FROM feedback_batches WHERE id = ?').get(batchId)).toBeDefined();

    // ...while its comment reverts to an editable draft.
    const commentRow = db
      .prepare('SELECT status, batch_id, sent_at FROM feedback_comments WHERE id = ?')
      .get(commentId) as { status: string; batch_id: string | null; sent_at: string | null };
    expect(commentRow.status).toBe('draft');
    expect(commentRow.batch_id).toBeNull();
    expect(commentRow.sent_at).toBeNull();

    // The user can now edit and re-send.
    await router.apply(1, { op: 'update-comment', commentId, body: 'revised after failure' });
    const resend = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    expect(resend.round).toBe(2);
    expect(resend.commentIds).toEqual([commentId]);
  });

  it('batch-failed on an already-terminal batch is an idempotent no-op', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    await router.apply(1, { op: 'batch-applied', batchId });

    const result = await router.apply(1, { op: 'batch-failed', batchId, error: 'too late' });
    expect(result.failed).toBe(false);
    const batchRow = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batchRow.status).toBe('applied'); // unchanged — already terminal
    expect(batchRow.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // list helpers
  // -------------------------------------------------------------------------

  it('listComments/listBatches return camelCase shapes filtered by (runId, atype, sourceRef)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'spec comment',
    });
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'arch-design',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'arch comment',
    });
    await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    const specComments = router.listComments('run-1', 'idea-spec', 'idea-1');
    expect(specComments).toHaveLength(1);
    expect(specComments[0]).toMatchObject({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      body: 'spec comment',
      status: 'sent',
      anchor: ANCHOR,
    });

    const allForRun = router.listComments('run-1');
    expect(allForRun).toHaveLength(2);

    const specBatches = router.listBatches('run-1', 'idea-spec', 'idea-1');
    expect(specBatches).toHaveLength(1);
    expect(specBatches[0]).toMatchObject({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1', round: 1, status: 'pending' });

    const archBatches = router.listBatches('run-1', 'arch-design', 'idea-1');
    expect(archBatches).toHaveLength(0);
  });

  it('listComments skips a malformed anchor_json row (fail-soft) rather than throwing', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId: good } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'good',
    });
    // Directly corrupt a second row's anchor_json (bypassing the chokepoint) to
    // exercise the fail-soft parse path.
    db.prepare(
      `INSERT INTO feedback_comments (id, project_id, run_id, atype, source_ref, anchor_json, body, status)
       VALUES ('fbc_bad', 1, 'run-1', 'idea-spec', 'idea-1', ?, 'corrupt', 'draft')`,
    ).run('not json');

    const comments = router.listComments('run-1', 'idea-spec', 'idea-1');
    expect(comments.map((c) => c.id)).toEqual([good]);
  });

  // -------------------------------------------------------------------------
  // emit
  // -------------------------------------------------------------------------

  it('emits FeedbackChangedEvent on feedback-project-<id> with the full refreshed document after every write', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));

    const events: FeedbackChangedEvent[] = [];
    feedbackEvents.on(feedbackProjectChannel(1), (e: FeedbackChangedEvent) => events.push(e));

    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    await router.apply(1, { op: 'batch-applied', batchId });

    expect(events).toHaveLength(3); // create, send-batch, batch-applied
    for (const e of events) {
      expect(e.projectId).toBe(1);
      expect(e.runId).toBe('run-1');
      expect(e.atype).toBe('idea-spec');
      expect(e.sourceRef).toBe('idea-1');
    }
    const last = events[events.length - 1];
    expect(last.comments).toHaveLength(1);
    expect(last.comments[0].id).toBe(commentId);
    expect(last.comments[0].status).toBe('addressed');
    expect(last.batches).toHaveLength(1);
    expect(last.batches[0].status).toBe('applied');
  });

  it('an idempotent no-op (batch-applied on a terminal batch) emits nothing', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    await router.apply(1, { op: 'batch-applied', batchId });

    const events: FeedbackChangedEvent[] = [];
    feedbackEvents.on(feedbackProjectChannel(1), (e: FeedbackChangedEvent) => events.push(e));
    await router.apply(1, { op: 'batch-applied', batchId });
    expect(events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // per-project queue
  // -------------------------------------------------------------------------

  it('keeps per-project queues independent', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 1);
    seedRun(db, 'run-2', 2);
    const router = FeedbackRouter.initialize(dbAdapter(db));

    const a = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'p1',
    });
    const b = await router.apply(2, {
      op: 'create-comment',
      runId: 'run-2',
      atype: 'idea-spec',
      sourceRef: 'idea-2',
      anchor: ANCHOR,
      body: 'p2',
    });
    expect(
      (db.prepare('SELECT project_id FROM feedback_comments WHERE id = ?').get(a.commentId) as { project_id: number })
        .project_id,
    ).toBe(1);
    expect(
      (db.prepare('SELECT project_id FROM feedback_comments WHERE id = ?').get(b.commentId) as { project_id: number })
        .project_id,
    ).toBe(2);
    expect(router._queueForProject(1)).not.toBe(router._queueForProject(2));
  });

  // -------------------------------------------------------------------------
  // FK cascade
  // -------------------------------------------------------------------------

  it('FK cascade: deleting the run removes its feedback comments and batches', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const { commentId } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });
    const { batchId } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('run-1');

    expect(db.prepare('SELECT id FROM feedback_comments WHERE id = ?').get(commentId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM feedback_batches WHERE id = ?').get(batchId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // sweepInterruptedBatches (boot recovery)
  // -------------------------------------------------------------------------

  it('sweepInterruptedBatches flips pending→failed across projects, reverts comments to drafts, emits, returns count', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 1);
    seedRun(db, 'run-2', 2);
    const router = FeedbackRouter.initialize(dbAdapter(db));

    const { commentId: c1 } = await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'p1',
    });
    const { batchId: b1 } = await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' });
    const { commentId: c2 } = await router.apply(2, {
      op: 'create-comment',
      runId: 'run-2',
      atype: 'arch-design',
      sourceRef: 'idea-2',
      anchor: ANCHOR,
      body: 'p2',
    });
    const { batchId: b2 } = await router.apply(2, { op: 'send-batch', runId: 'run-2', atype: 'arch-design', sourceRef: 'idea-2' });

    const events: FeedbackChangedEvent[] = [];
    feedbackEvents.on(feedbackProjectChannel(1), (e: FeedbackChangedEvent) => events.push(e));
    feedbackEvents.on(feedbackProjectChannel(2), (e: FeedbackChangedEvent) => events.push(e));

    const swept = await router.sweepInterruptedBatches();
    expect(swept).toBe(2);

    for (const b of [b1, b2]) {
      const row = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(b) as {
        status: string;
        error: string | null;
      };
      expect(row.status).toBe('failed');
      expect(row.error).toContain('interrupted by app restart');
    }
    for (const c of [c1, c2]) {
      const row = db.prepare('SELECT status, batch_id, sent_at FROM feedback_comments WHERE id = ?').get(c) as {
        status: string;
        batch_id: string | null;
        sent_at: string | null;
      };
      expect(row.status).toBe('draft');
      expect(row.batch_id).toBeNull();
      expect(row.sent_at).toBeNull();
    }
    // One change-event per swept batch (one per project channel).
    expect(events).toHaveLength(2);
  });

  it('sweepInterruptedBatches is a 0-count no-op when nothing is pending', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    // A draft comment that was never sent leaves no pending batch behind.
    await router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: ANCHOR,
      body: 'x',
    });

    const events: FeedbackChangedEvent[] = [];
    feedbackEvents.on(feedbackProjectChannel(1), (e: FeedbackChangedEvent) => events.push(e));
    const swept = await router.sweepInterruptedBatches();
    expect(swept).toBe(0);
    expect(events).toHaveLength(0);
  });
});

// Compile-time smoke: FeedbackRouter satisfies a DatabaseLike-injected constructor.
const _typecheck = (db: DatabaseLike): FeedbackRouter => new FeedbackRouter(db);
void _typecheck;
