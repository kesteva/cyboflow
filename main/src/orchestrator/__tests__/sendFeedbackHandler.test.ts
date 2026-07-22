/**
 * Unit tests for sendFeedbackHandler — the guarded "Send feedback" entry point
 * (IDEA-033). Exercises the full guard matrix (not_found / not_parked / no_gate /
 * decomposed / busy / no_comments) plus the happy path that mints a batch and
 * fires the injected launchRevision exactly once. The REAL FeedbackRouter mints
 * the batch (so busy / no_comments surface from the chokepoint); launchRevision is
 * a spy (the detached revision itself is tested in revisionWorker.test.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendFeedbackHandler, type RevisionBatchInfo } from '../sendFeedbackHandler';
import { FeedbackRouter } from '../feedbackRouter';
import { feedbackEvents } from '../trpc/routers/events';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { CommentAnchor } from '../../../../shared/types/feedback';

const MIG_DIR = join(__dirname, '..', '..', 'database', 'migrations');

function buildDb(): Database.Database {
  const db = new Database(':memory:');
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
    '035_artifacts.sql',
    '075_artifact_feedback.sql',
  ]) {
    db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at DATETIME'); // migration 042 slice
  // Hand-seeded ideas use placeholder board/stage refs; no FK behavior is under test.
  db.pragma('foreign_keys = OFF');
  return db;
}

function seedRun(db: Database.Database, runId: string, status: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf', 1, ?, 'default')`,
  ).run(runId, status);
}

function seedGate(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title)
     VALUES (?, 1, ?, 'decision', 'pending', 1, 'approve-plan')`,
  ).run(`rvw_${runId}`, runId);
}

function seedIdea(db: Database.Database, id: string, decomposedAt: string | null = null): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, version, body, decomposed_at)
     VALUES (?, 1, 'IDEA-1', 'T', 'board', 'stage', 1, '# Idea\n\nspec', ?)`,
  ).run(id, decomposedAt);
}

/** Seed the per-entity artifact row the identity guard requires (runId, atype, sourceRef). */
function seedArtifact(db: Database.Database, runId: string, sourceRef: string, atype = 'idea-spec'): void {
  db.prepare(
    `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref)
     VALUES (?, ?, ?, 'Idea spec', 'template', ?)`,
  ).run(`art_${runId}_${sourceRef}`, runId, atype, sourceRef);
}

const ANCHOR: CommentAnchor = { quote: 'q', occurrence: 0, bodyHash: 'h' };

async function seedDraft(router: FeedbackRouter, runId: string, sourceRef: string): Promise<void> {
  await router.apply(1, {
    op: 'create-comment',
    runId,
    atype: 'idea-spec',
    sourceRef,
    anchor: ANCHOR,
    body: 'fix this',
  });
}

function makeDeps(db: Database.Database, launchRevision = vi.fn(async (_i: RevisionBatchInfo) => {})) {
  return {
    deps: { db: dbAdapter(db), feedbackRouter: FeedbackRouter.getInstance(), launchRevision },
    launchRevision,
  };
}

afterEach(() => {
  FeedbackRouter._resetForTesting();
  feedbackEvents.removeAllListeners();
  vi.restoreAllMocks();
});

describe('sendFeedbackHandler — guard matrix', () => {
  it('not_found when the run row is missing', async () => {
    const db = buildDb();
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'nope', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'not_found' });
  });

  it('not_parked when the run is not at a parked status', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'running');
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'not_parked' });
  });

  // Inline AskUserQuestion gates (QuestionRouter — e.g. the single-idea
  // approve-idea stub gate) park the run at 'awaiting_input', NOT
  // 'awaiting_review'; both must clear the parked guard.
  it('accepts a run parked at awaiting_input (inline question gate)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_input');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_1');
    seedIdea(db, 'ide_1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await seedDraft(router, 'run-1', 'ide_1');
    const { deps, launchRevision } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toMatchObject({ sent: true, round: 1 });
    expect(launchRevision).toHaveBeenCalledTimes(1);
  });

  it('no_gate when no pending blocking decision gate is open', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedIdea(db, 'ide_1');
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'no_gate' });
  });

  it('not_found when the idea row is missing (gate + artifact present)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_gone'); // pass the identity guard so the idea check is reached
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_gone' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'not_found' });
  });

  it('not_found when the per-entity artifact row is absent (gate present, unrelated idea)', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedIdea(db, 'ide_1'); // the idea exists, but this run never produced its artifact
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps, launchRevision } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'not_found' });
    expect(launchRevision).not.toHaveBeenCalled();
  });

  it('decomposed when the idea has been decomposed', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_1');
    seedIdea(db, 'ide_1', '2026-07-21T00:00:00.000Z');
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'decomposed' });
  });

  it('no_comments when there are no draft comments to send', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_1');
    seedIdea(db, 'ide_1');
    FeedbackRouter.initialize(dbAdapter(db));
    const { deps, launchRevision } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'no_comments' });
    expect(launchRevision).not.toHaveBeenCalled();
  });

  it('busy when a pending batch already exists for the document', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_1');
    seedIdea(db, 'ide_1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await seedDraft(router, 'run-1', 'ide_1');
    await router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' });
    await seedDraft(router, 'run-1', 'ide_1'); // a fresh draft, but a batch is already pending

    const { deps, launchRevision } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);
    expect(res).toEqual({ noOp: true, reason: 'busy' });
    expect(launchRevision).not.toHaveBeenCalled();
  });
});

describe('sendFeedbackHandler — happy path', () => {
  it('mints a batch, returns sent+batchId+round, and fires launchRevision exactly once', async () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'awaiting_review');
    seedGate(db, 'run-1');
    seedArtifact(db, 'run-1', 'ide_1');
    seedIdea(db, 'ide_1');
    const router = FeedbackRouter.initialize(dbAdapter(db));
    await seedDraft(router, 'run-1', 'ide_1');

    const { deps, launchRevision } = makeDeps(db);
    const res = await sendFeedbackHandler({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'ide_1' }, deps);

    expect(res).toMatchObject({ sent: true, round: 1 });
    if (!('sent' in res)) throw new Error('expected sent result');
    expect(res.batchId).toMatch(/^fbb_/);

    expect(launchRevision).toHaveBeenCalledTimes(1);
    expect(launchRevision.mock.calls[0][0]).toMatchObject({
      projectId: 1,
      runId: 'run-1',
      batchId: res.batchId,
      atype: 'idea-spec',
      sourceRef: 'ide_1',
      round: 1,
      // The batch is BOUND to the gate(s) open at send time — the revision's
      // pre-write revalidation requires one of these exact ids to stay pending.
      gateReviewItemIds: ['rvw_run-1'],
    });

    const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(res.batchId) as {
      status: string;
    };
    expect(batch.status).toBe('pending');
  });
});
