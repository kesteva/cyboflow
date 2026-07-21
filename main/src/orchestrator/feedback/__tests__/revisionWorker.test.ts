/**
 * Unit tests for runRevisionBatch — the in-artifact feedback revision worker
 * (IDEA-033). A fake RevisionQueryFn stands in for the SDK agent and a captured
 * applyTaskChange stands in for the TaskChangeRouter chokepoint; the REAL
 * FeedbackRouter flips the batch so terminal state is asserted against the DB.
 *
 * Covered:
 *  - idea-spec happy path: revised body written verbatim, batch flipped applied.
 *  - arch-design happy path: only the '## Architecture design' section changes.
 *  - idea-spec HOST-SIDE SAFETY SPLICE: an agent that mutated the arch section has
 *    the ORIGINAL architecture restored (spec feedback never touches architecture).
 *  - invalid/empty structured result → batch-failed, no write.
 *  - queryFn throw → batch-failed, no write.
 *  - version drift (applyTaskChange concurrency rejection) → batch-failed with the
 *    concurrency reason, batch-applied never called.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRevisionBatch, type RevisionTaskChange } from '../revisionWorker';
import type { RevisionQueryFn } from '../revisionQuery';
import { FeedbackRouter } from '../../feedbackRouter';
import { feedbackEvents } from '../../trpc/routers/events';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { extractArchDesignSection } from '../../../../../shared/types/artifacts';
import type { CommentAnchor, FeedbackAtype } from '../../../../../shared/types/feedback';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  // FK OFF: we hand-seed ideas with placeholder board/stage refs (the worker only
  // reads ideas.body/version; no FK behavior is under test here).
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
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '075_artifact_feedback.sql',
  ]) {
    db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at DATETIME'); // migration 042 slice
  // Hand-seeded ideas use placeholder board/stage refs; no FK behavior is under test.
  db.pragma('foreign_keys = OFF');
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf', 1, 'awaiting_review', 'default')`,
  ).run(runId);
}

function seedIdea(db: Database.Database, id: string, body: string): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, version, body)
     VALUES (?, 1, 'IDEA-1', 'T', 'board', 'stage', 1, ?)`,
  ).run(id, body);
}

const ANCHOR: CommentAnchor = { quote: 'the quoted text', occurrence: 0, bodyHash: 'abcd1234' };

/** Seed a sent batch: create one draft comment then send it. Returns the batchId. */
async function seedSentBatch(
  router: FeedbackRouter,
  runId: string,
  atype: FeedbackAtype,
  sourceRef: string,
): Promise<string> {
  await router.apply(1, {
    op: 'create-comment',
    runId,
    atype,
    sourceRef,
    anchor: ANCHOR,
    body: 'please address this',
  });
  const { batchId } = await router.apply(1, { op: 'send-batch', runId, atype, sourceRef });
  return batchId;
}

function fakeQuery(revisedDocument: unknown): RevisionQueryFn {
  return vi.fn(async () => (revisedDocument === undefined ? {} : { revisedDocument }));
}

afterEach(() => {
  FeedbackRouter._resetForTesting();
  feedbackEvents.removeAllListeners();
  vi.restoreAllMocks();
});

describe('runRevisionBatch', () => {
  it('idea-spec happy path: writes the revised body verbatim and flips the batch applied', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery('# Idea\n\nRevised spec.\n'), feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).toHaveBeenCalledTimes(1);
    const [projectId, change] = applyTaskChange.mock.calls[0];
    expect(projectId).toBe(1);
    expect(change).toMatchObject({
      actor: 'orchestrator',
      entityType: 'idea',
      taskId: 'ide_1',
      runId: 'run-1',
      expectedVersion: 1,
      fields: { body: '# Idea\n\nRevised spec.\n' },
    });

    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('applied');
  });

  it('arch-design happy path: only the architecture section changes; the rest is preserved', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const originalBody = '# Idea\n\nIntro.\n\n## Architecture design\n\nOld design.\n\n## Rollout\n\nShip.';
    seedIdea(db, 'ide_1', originalBody);
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        queryFn: fakeQuery('## Architecture design\n\nNew queue-based design.'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    const written = applyTaskChange.mock.calls[0][1].fields.body;
    expect(written).toBe('# Idea\n\nIntro.\n\n## Architecture design\n\nNew queue-based design.\n\n## Rollout\n\nShip.');
    expect(extractArchDesignSection(written)).toBe('New queue-based design.');
    // Non-arch content untouched.
    expect(written).toContain('# Idea\n\nIntro.');
    expect(written).toContain('## Rollout\n\nShip.');

    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('applied');
  });

  it('idea-spec safety splice: an agent that mutated the arch section has the ORIGINAL restored', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const originalBody = '# Idea\n\nSpec intro.\n\n## Architecture design\n\nCanonical arch.\n\n## Risks\n\nnone.';
    seedIdea(db, 'ide_1', originalBody);
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));

    // The agent revised the spec AND (against the rules) rewrote the arch section.
    const misbehaved = '# Idea\n\nRevised spec intro.\n\n## Architecture design\n\nMUTATED arch!\n\n## Risks\n\nnone.';
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery(misbehaved), feedbackRouter: router, applyTaskChange },
    );

    const written = applyTaskChange.mock.calls[0][1].fields.body;
    // The revised (non-arch) prose is kept, but the architecture is the ORIGINAL.
    expect(written).toContain('Revised spec intro.');
    expect(extractArchDesignSection(written)).toBe('Canonical arch.');
    expect(written).not.toContain('MUTATED arch!');
  });

  it('idea-spec safety splice: re-appends the original arch section if the agent dropped it', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const originalBody = '# Idea\n\nSpec.\n\n## Architecture design\n\nKeep me.';
    seedIdea(db, 'ide_1', originalBody);
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery('# Idea\n\nRevised, no arch here.'), feedbackRouter: router, applyTaskChange },
    );

    const written = applyTaskChange.mock.calls[0][1].fields.body;
    expect(extractArchDesignSection(written)).toBe('Keep me.');
    expect(written).toContain('Revised, no arch here.');
  });

  it('invalid/empty structured result → batch-failed, no write', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nspec');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery('   '), feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toBeTruthy();
    // The failed batch reverted its comment to an editable draft.
    const comment = db.prepare("SELECT status FROM feedback_comments WHERE batch_id IS NULL").get() as
      | { status: string }
      | undefined;
    expect(comment?.status).toBe('draft');
  });

  it('queryFn throw → batch-failed, no write', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nspec');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    const throwingQuery: RevisionQueryFn = vi.fn(async () => {
      throw new Error('revision query timed out after 300000ms');
    });
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: throwingQuery, feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toContain('timed out');
  });

  it('version drift (concurrency rejection) → batch-failed with the concurrency reason', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nspec');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => {
      // Shape mirrors TaskChangeError('concurrency', ...).
      throw Object.assign(new Error('entity ide_1 version is 2, expected 1'), { code: 'concurrency' });
    });
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery('# Idea\n\nrevised'), feedbackRouter: router, applyTaskChange },
    );

    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toBe('the document changed during revision — resend to try again');
  });

  it('missing idea body → batch-failed before any query', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    // No idea row seeded.
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_missing');

    const queryFn = fakeQuery('# Idea\n\nrevised');
    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'x' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, atype: 'idea-spec', sourceRef: 'ide_missing' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(queryFn).not.toHaveBeenCalled();
    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });
});
