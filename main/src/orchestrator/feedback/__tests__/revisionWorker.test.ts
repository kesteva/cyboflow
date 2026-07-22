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
    '007_add_stuck_reason.sql', // stuck columns 010's table rebuild copies
    '010_questions.sql', // widens the run-status CHECK to include 'awaiting_input'
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '077_artifact_feedback.sql',
  ]) {
    db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at DATETIME'); // migration 042 slice
  // Hand-seeded ideas use placeholder board/stage refs; no FK behavior is under test.
  db.pragma('foreign_keys = OFF');
  return db;
}

function seedRun(db: Database.Database, runId: string, status = 'awaiting_review'): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf', 1, ?, 'default')`,
  ).run(runId, status);
  // A pending blocking decision gate — the pre-write revalidation requires it to
  // still be open when the revision lands.
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title)
     VALUES (?, 1, ?, 'decision', 'pending', 1, 'approve-plan')`,
  ).run(`rvw_${runId}`, runId);
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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

  // Inline AskUserQuestion gates (QuestionRouter — the single-idea approve-idea
  // stub gate) park the run at 'awaiting_input'; the pre-write revalidation must
  // treat it as parked exactly like 'awaiting_review'.
  it('applies when the run is parked at awaiting_input (inline question gate)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_input');
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn: fakeQuery('# Idea\n\nRevised spec.\n'), feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).toHaveBeenCalledTimes(1);
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
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
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_missing' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(queryFn).not.toHaveBeenCalled();
    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });

  it('gate resolved mid-flight → batch-failed, applyTaskChange never called', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    // The user resolves the review gate WHILE the revision agent is running.
    const queryFn: RevisionQueryFn = vi.fn(async () => {
      db.prepare("UPDATE review_items SET status = 'resolved' WHERE run_id = 'run-1'").run();
      return { revisedDocument: '# Idea\n\nRevised spec.\n' };
    });

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toContain('review gate resolved');
  });

  it('batch canceled mid-flight → batch-failed, no write', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    // The batch flips out of 'pending' while the agent runs (e.g. a concurrent sweep).
    const queryFn: RevisionQueryFn = vi.fn(async () => {
      db.prepare("UPDATE feedback_batches SET status = 'failed' WHERE id = ?").run(batchId);
      return { revisedDocument: '# Idea\n\nRevised spec.\n' };
    });

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });

  it('arch-design output with an extra unfenced H2 → batch-failed, no write', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // The agent leaked a second section outside the architecture design.
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n## Rollout\n\nExtra content.'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toContain('outside the architecture section');
  });

  it('arch-design output with the extra H2 inside a code fence → accepted', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // The "## Rollout" line is INSIDE a fence — it neither starts nor leaks a section.
        queryFn: fakeQuery('## Architecture design\n\nNew design.\n\n```md\n## Rollout example\n```'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).toHaveBeenCalledTimes(1);
    const written = applyTaskChange.mock.calls[0][1].fields.body;
    expect(extractArchDesignSection(written)).toContain('New design.');
    expect(written).toContain('## Rollout example');
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('applied');
  });

  it('arch-design bare section content without a heading → heading prepended + applied', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // No heading, no H2 — benign bare section content; the worker prepends the heading.
        queryFn: fakeQuery('A queue-based design with no heading line.'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).toHaveBeenCalledTimes(1);
    const written = applyTaskChange.mock.calls[0][1].fields.body;
    expect(extractArchDesignSection(written)).toBe('A queue-based design with no heading line.');
    // The following section is preserved (the bare content did not leak into it).
    expect(written).toContain('## Rollout\n\nShip.');
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('applied');
  });

  it('stale anchor → the prompt carries the stale-anchor warning', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    // The seeded ANCHOR quote ("the quoted text") does NOT appear in this body →
    // the anchor is stale, so the prompt must warn the agent.
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec with different words.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    let capturedPrompt = '';
    const queryFn: RevisionQueryFn = vi.fn(async (args) => {
      capturedPrompt = args.prompt;
      return { revisedDocument: '# Idea\n\nRevised.\n' };
    });
    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(capturedPrompt).toContain('no longer appears verbatim in the current document');
  });

  it('a DIFFERENT later gate does not validate the batch — bound-gate revalidation fails it', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nOriginal spec.\n');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'idea-spec', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    // Mid-flight, the ORIGINAL gate resolves and the run advances to a NEW gate
    // (e.g. approve-design → approve-plan). The run is parked again and a pending
    // blocking decision exists — but it is not the gate this batch was sent under.
    const queryFn: RevisionQueryFn = vi.fn(async () => {
      db.prepare("UPDATE review_items SET status = 'resolved' WHERE id = 'rvw_run-1'").run();
      db.prepare(
        `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title)
         VALUES ('rvw_later', 1, 'run-1', 'decision', 'pending', 1, 'approve-plan')`,
      ).run();
      return { revisedDocument: '# Idea\n\nRevised spec.\n' };
    });

    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'idea-spec', sourceRef: 'ide_1' },
      { db: dbAdapter(db), queryFn, feedbackRouter: router, applyTaskChange },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toContain('review gate resolved');
  });

  it('arch-design output with a bare ## terminator → batch-failed (extractor-grammar parity)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // A bare '##' line terminates the section in the extractor's grammar, so
        // 'Trailing content' would land OUTSIDE the architecture section post-splice.
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n##\nTrailing content.'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status, error FROM feedback_batches WHERE id = ?').get(batchId) as {
      status: string;
      error: string | null;
    };
    expect(batch.status).toBe('failed');
    expect(batch.error).toContain('outside the architecture section');
  });

  it('arch-design output with an UNTERMINATED fence → batch-failed (would swallow following sections)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // The fence never closes: after splicing, the idea body's '## Rollout'
        // would be absorbed into the fenced arch section.
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n```md\nunclosed fence'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });

  it('arch-design output with a ``` fence "closed" by ~~~ → batch-failed (mismatched delimiters)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        // CommonMark: a ``` fence only closes on a matching ``` run — the ~~~ is
        // fence CONTENT, so the backtick fence is still open at EOF and would
        // swallow the idea body's following sections after the splice.
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n```md\ncode\n~~~'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });

  it('arch-design output closing a ```` fence with a shorter ``` run → batch-failed', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        // A 4-backtick opener needs a closing run of ≥4; the 3-run line is content.
        db: dbAdapter(db),
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n````md\ncode\n```'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).not.toHaveBeenCalled();
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('failed');
  });

  it('arch-design output with correctly paired mixed fences (``` then ~~~ blocks) → accepted', async () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedIdea(db, 'ide_1', '# Idea\n\nIntro.\n\n## Architecture design\n\nOld.\n\n## Rollout\n\nShip.');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    const batchId = await seedSentBatch(router, 'run-1', 'arch-design', 'ide_1');

    const applyTaskChange = vi.fn(async (_p: number, _c: RevisionTaskChange) => ({ taskId: 'ide_1' }));
    await runRevisionBatch(
      { projectId: 1, runId: 'run-1', batchId, gateReviewItemIds: ['rvw_run-1'], atype: 'arch-design', sourceRef: 'ide_1' },
      {
        db: dbAdapter(db),
        queryFn: fakeQuery('## Architecture design\n\nNew.\n\n```md\n## fenced\n```\n\n~~~\n## also fenced\n~~~'),
        feedbackRouter: router,
        applyTaskChange,
      },
    );

    expect(applyTaskChange).toHaveBeenCalledTimes(1);
    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string };
    expect(batch.status).toBe('applied');
  });
});
