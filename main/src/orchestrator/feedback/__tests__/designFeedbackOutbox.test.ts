/**
 * Unit tests for DesignFeedbackOutbox — the design-feedback DELIVERY PIPELINE
 * (Design Mode v1, docs/ideas/design-mode.md "Design feedback v1 — acknowledged
 * durable outbox").
 *
 * These run the REAL FeedbackRouter over a real in-memory DB (migrations 077 +
 * 092) so every assertion is against the durable state machine, not a double.
 * Only the impure seams are faked: `dispatchTurn` (the SDK turn), the clock, the
 * attempt-id minter, and — where a test is about a specific guard — the three
 * lifecycle guards. A separate block exercises the DB-backed default guards.
 *
 * Covered:
 *  - happy path queued → dispatching → dispatched, with the prompt carrying the
 *    batch id, the attempt id, every comment body, and the element breadcrumb;
 *  - dispatchTurn rejection → 'failed' with the (concise) error;
 *  - each of the three guard failures → 'blocked' with its user-visible reason,
 *    at BOTH notifyQueued and recoverOnBoot;
 *  - a 'blocked' batch is never re-delivered by recovery;
 *  - recovery of 'dispatching' / 'dispatched' re-delivers the SAME batch under a
 *    NEW attempt id with the possibly-delivered note; recovery of 'queued'
 *    dispatches normally (no note);
 *  - the four crash windows (queued-only, dispatching-no-ack, dispatched-no-ack,
 *    dispatched-then-acked) recovered from directly-driven states;
 *  - no unhandled rejection: unknown batch, terminal batch, throwing guard, and a
 *    dispatchTurn that rejects all resolve, leaving a legal status behind.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedbackRouter } from '../../feedbackRouter';
import { feedbackEvents } from '../../trpc/routers/events';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import {
  DesignFeedbackOutbox,
  DESIGN_OUTBOX_BLOCKED_REASONS,
  makeDefaultGuards,
  _resetDesignBatchNotifierForTesting,
  type DesignOutboxGuards,
} from '../designFeedbackOutbox';
import type { DatabaseLike } from '../../types';
import type { ElementCommentAnchor, FeedbackBatchStatus } from '../../../../../shared/types/feedback';

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

  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '035_artifacts.sql',
    '077_artifact_feedback.sql',
    '092_design_feedback_outbox.sql',
  ]) {
    const sql = readFileSync(join(migDir, f), 'utf-8');
    const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
    if (needsFkOff) db.pragma('foreign_keys = OFF');
    db.exec(sql);
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
  // Additive slices the default guards read: ideas' liveness stamps (024 / 042)
  // and the Crystal-legacy `sessions` table with migration 082's design link.
  db.exec('ALTER TABLE ideas ADD COLUMN archived_at DATETIME');
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at DATETIME');
  db.exec(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, project_id INTEGER, archived BOOLEAN DEFAULT 0, design_idea_id TEXT
     )`,
  );
  // Hand-seeded ideas use placeholder board/stage refs; no FK behavior is under test.
  db.pragma('foreign_keys = OFF');
  return db;
}

/** A design session's run: 'running', with no review_items row anywhere. */
function seedLiveRun(db: Database.Database, runId = 'run-1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'design', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

const ELEMENT_ANCHOR: ElementCommentAnchor = {
  kind: 'element',
  designId: 'hero-cta',
  ancestorStack: [
    { tag: 'button', designId: 'hero-cta', label: 'Get started' },
    { tag: 'section', designId: 'hero', label: null },
    { tag: 'body', designId: null, label: null },
  ],
  pickedIndex: 0,
};

function batchRow(db: Database.Database, batchId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM feedback_batches WHERE id = ?').get(batchId) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface DispatchCall {
  sessionId: string;
  prompt: string;
}

interface Harness {
  db: Database.Database;
  router: FeedbackRouter;
  outbox: DesignFeedbackOutbox;
  calls: DispatchCall[];
  /** Attempt ids handed out, in order. */
  attemptIds: string[];
}

const ALL_GUARDS_PASS: DesignOutboxGuards = {
  isSessionAlive: () => true,
  isIdeaLinkValid: () => true,
  hasPrototypeArtifact: () => true,
};

function makeHarness(options?: {
  guards?: Partial<DesignOutboxGuards>;
  dispatchTurn?: (args: DispatchCall) => Promise<void>;
}): Harness {
  const db = buildDb();
  seedLiveRun(db);
  const router = FeedbackRouter.initialize(dbAdapter(db) as DatabaseLike);

  const calls: DispatchCall[] = [];
  const attemptIds: string[] = [];
  let attemptSeq = 0;

  const outbox = new DesignFeedbackOutbox({
    db: dbAdapter(db) as DatabaseLike,
    feedbackRouter: router,
    dispatchTurn: async (args) => {
      calls.push(args);
      if (options?.dispatchTurn) await options.dispatchTurn(args);
    },
    guards: { ...ALL_GUARDS_PASS, ...(options?.guards ?? {}) },
    now: () => '2026-07-28T09:00:00.000Z',
    newAttemptId: () => {
      attemptSeq += 1;
      const id = `att-${attemptSeq}`;
      attemptIds.push(id);
      return id;
    },
  });

  return { db, router, outbox, calls, attemptIds };
}

/** Mint a queued design batch from `bodies`, one element-anchored comment each. */
async function queueBatch(h: Harness, bodies: string[] = ['make the CTA bigger']): Promise<string> {
  const commentIds: string[] = [];
  for (const body of bodies) {
    const { commentId } = await h.router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      anchor: ELEMENT_ANCHOR,
      body,
    });
    commentIds.push(commentId);
  }
  const { batchId } = await h.router.createDesignBatch({
    projectId: 1,
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'interactive-prototype',
    sourceRef: 'idea-1',
    commentIds,
  });
  return batchId;
}

/** Force a batch to `status` by raw UPDATE — drives a crash-window state directly. */
function forceStatus(db: Database.Database, batchId: string, status: FeedbackBatchStatus): void {
  db.prepare('UPDATE feedback_batches SET status = ? WHERE id = ?').run(status, batchId);
}

afterEach(() => {
  FeedbackRouter._resetForTesting();
  _resetDesignBatchNotifierForTesting();
  feedbackEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('DesignFeedbackOutbox.notifyQueued — happy path', () => {
  it('drives queued → dispatching → dispatched and stamps the attempt', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h, ['make the CTA bigger', 'drop the divider']);

    await h.outbox.notifyQueued(batchId);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].sessionId).toBe('sess-1');
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'dispatched',
      current_attempt_id: 'att-1',
      attempt_count: 1,
      dispatched_at: '2026-07-28T09:00:00.000Z',
      blocked_reason: null,
      error: null,
    });
  });

  it('the prompt carries the batch id, the attempt id, every comment body and the element breadcrumb', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h, ['make the CTA bigger', 'drop the divider']);

    await h.outbox.notifyQueued(batchId);
    const { prompt } = h.calls[0];

    expect(prompt).toContain(batchId);
    expect(prompt).toContain('att-1');
    expect(prompt).toContain('make the CTA bigger');
    expect(prompt).toContain('drop the divider');
    // Breadcrumb: outermost-first, with the picked rung called out.
    expect(prompt).toContain('Commented element: button[data-design-id="hero-cta"] "Get started"');
    expect(prompt).toContain('Path: body › section[data-design-id="hero"] › button[data-design-id="hero-cta"] "Get started"');
    // The three-step contract, incl. the mandatory ack naming the same ids.
    expect(prompt).toContain('cyboflow_design_ack_feedback');
    expect(prompt).toContain('interactive-prototype');
    // A fresh send says nothing about a possible earlier delivery.
    expect(prompt).not.toContain('may ALREADY have been delivered');
  });

  it('renders the picked rung when the user walked the picker UP the stack', async () => {
    const h = makeHarness();
    const { commentId } = await h.router.apply(1, {
      op: 'create-comment',
      runId: 'run-1',
      atype: 'ui-prototype',
      sourceRef: 'idea-1',
      anchor: { ...ELEMENT_ANCHOR, designId: 'hero', pickedIndex: 1 },
      body: 'this whole section is too tall',
    });
    const { batchId } = await h.router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'ui-prototype',
      sourceRef: 'idea-1',
      commentIds: [commentId],
    });

    await h.outbox.notifyQueued(batchId);
    expect(h.calls[0].prompt).toContain('Commented element: section[data-design-id="hero"]');
  });
});

// ---------------------------------------------------------------------------
// Dispatch failure
// ---------------------------------------------------------------------------

describe('DesignFeedbackOutbox — SDK refusal', () => {
  it('a rejecting dispatchTurn lands the batch in failed with the error, and never throws', async () => {
    const h = makeHarness({
      dispatchTurn: () => Promise.reject(new Error('no Claude panel for this session\nstack line')),
    });
    const batchId = await queueBatch(h);

    await expect(h.outbox.notifyQueued(batchId)).resolves.toBeUndefined();

    const row = batchRow(h.db, batchId);
    expect(row.status).toBe('failed');
    // Concise: first line only, never a stack dump.
    expect(row.error).toBe('no Claude panel for this session');
    expect(row.dispatched_at).toBeNull();
    // The attempt is still durably recorded — the SDK call DID happen.
    expect(row.attempt_count).toBe(1);
    expect(row.current_attempt_id).toBe('att-1');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle guards
// ---------------------------------------------------------------------------

const GUARD_CASES: Array<[string, Partial<DesignOutboxGuards>, string]> = [
  ['session closed', { isSessionAlive: () => false }, DESIGN_OUTBOX_BLOCKED_REASONS.sessionClosed],
  ['idea link broken', { isIdeaLinkValid: () => false }, DESIGN_OUTBOX_BLOCKED_REASONS.ideaLinkBroken],
  ['prototype missing', { hasPrototypeArtifact: () => false }, DESIGN_OUTBOX_BLOCKED_REASONS.prototypeMissing],
];

describe('DesignFeedbackOutbox — lifecycle guards block instead of dispatching', () => {
  it.each(GUARD_CASES)('notifyQueued: %s → blocked with its reason, no turn sent', async (_label, guards, reason) => {
    const h = makeHarness({ guards });
    const batchId = await queueBatch(h);

    await h.outbox.notifyQueued(batchId);

    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'blocked',
      blocked_reason: reason,
      attempt_count: 0,
      current_attempt_id: null,
    });
  });

  it.each(GUARD_CASES)(
    'recoverOnBoot: %s blocks an in-flight batch rather than re-delivering it',
    async (_label, guards, reason) => {
      const h = makeHarness({ guards });
      const batchId = await queueBatch(h);
      // A crash left it mid-delivery; the guard broke while the app was down.
      forceStatus(h.db, batchId, 'dispatching');

      expect(await h.outbox.recoverOnBoot()).toBe(0);
      expect(h.calls).toHaveLength(0);
      expect(batchRow(h.db, batchId)).toMatchObject({ status: 'blocked', blocked_reason: reason });
    },
  );

  it('a batch with no session binding is blocked, never dispatched', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);
    h.db.prepare('UPDATE feedback_batches SET session_id = NULL WHERE id = ?').run(batchId);

    await h.outbox.notifyQueued(batchId);
    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'blocked',
      blocked_reason: DESIGN_OUTBOX_BLOCKED_REASONS.noSessionBinding,
    });
  });

  it('recovery NEVER re-delivers an already-blocked batch', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);
    await h.router.transitionBatch({
      batchId,
      from: 'queued',
      to: 'blocked',
      blockedReason: DESIGN_OUTBOX_BLOCKED_REASONS.sessionClosed,
    });

    expect(await h.outbox.recoverOnBoot()).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'blocked',
      blocked_reason: DESIGN_OUTBOX_BLOCKED_REASONS.sessionClosed,
      attempt_count: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Boot recovery / crash windows
// ---------------------------------------------------------------------------

describe('DesignFeedbackOutbox.recoverOnBoot — the crash windows', () => {
  it('crash BEFORE dispatch (queued): delivers normally, with no possibly-delivered note', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);

    expect(await h.outbox.recoverOnBoot()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt).not.toContain('may ALREADY have been delivered');
    expect(batchRow(h.db, batchId)).toMatchObject({ status: 'dispatched', attempt_count: 1 });
  });

  it.each(['dispatching', 'dispatched'] as const)(
    'crash in the %s window: re-delivers the SAME batch under a NEW attempt id, with the possibly-delivered note',
    async (status) => {
      const h = makeHarness();
      const batchId = await queueBatch(h);
      // Attempt 1 happened before the crash.
      await h.router.recordDispatchAttempt({ batchId, attemptId: 'att-pre-crash' });
      forceStatus(h.db, batchId, status);

      expect(await h.outbox.recoverOnBoot()).toBe(1);

      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].prompt).toContain('may ALREADY have been delivered');
      expect(h.calls[0].prompt).toContain(batchId);
      // SAME batch id, NEW attempt id, monotonic count.
      const row = batchRow(h.db, batchId);
      expect(row).toMatchObject({ id: batchId, status: 'dispatched', attempt_count: 2 });
      expect(row.current_attempt_id).toBe('att-1');
      expect(row.current_attempt_id).not.toBe('att-pre-crash');
      expect(h.calls[0].prompt).toContain('att-1');
    },
  );

  it('crash AFTER the ack (already applied): recovery does not touch the batch', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);
    await h.router.recordDispatchAttempt({ batchId, attemptId: 'att-pre-crash' });
    await h.router.transitionBatch({ batchId, from: 'dispatching', to: 'dispatched' });
    await h.router.applyBatchResult({ batchId, attemptId: 'att-pre-crash', prototypeRevision: 7 });

    expect(await h.outbox.recoverOnBoot()).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'applied',
      current_attempt_id: 'att-pre-crash',
      applied_prototype_revision: 7,
      attempt_count: 1,
    });
  });

  it('attempt ids differ across attempts, and each dispatch prompt names its own', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);

    await h.outbox.notifyQueued(batchId); // attempt att-1 → dispatched
    await h.outbox.recoverOnBoot(); // possibly-delivered → attempt att-2

    expect(h.attemptIds).toEqual(['att-1', 'att-2']);
    expect(h.calls[0].prompt).toContain('att-1');
    expect(h.calls[1].prompt).toContain('att-2');
    expect(h.calls[1].prompt).not.toContain('att-1');
    expect(batchRow(h.db, batchId)).toMatchObject({ current_attempt_id: 'att-2', attempt_count: 2 });
  });

  it('processes multiple in-flight batches sequentially and skips document batches', async () => {
    const h = makeHarness();
    const first = await queueBatch(h, ['one']);
    // Close the first out so the per-document in-flight guard allows a second.
    await h.router.recordDispatchAttempt({ batchId: first, attemptId: 'att-seed' });
    await h.router.applyBatchResult({ batchId: first, attemptId: 'att-seed', prototypeRevision: 1 });
    const second = await queueBatch(h, ['two']);

    // A DOCUMENT batch left 'pending' by a crash must not be picked up here — it
    // belongs to FeedbackRouter.sweepInterruptedBatches.
    h.db
      .prepare(
        `INSERT INTO feedback_batches (id, project_id, run_id, atype, source_ref, round, status, created_at)
         VALUES ('fbb_doc', 1, 'run-1', 'idea-spec', 'idea-1', 1, 'pending', '2026-07-28T00:00:00.000Z')`,
      )
      .run();

    expect(await h.outbox.recoverOnBoot()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(batchRow(h.db, second).status).toBe('dispatched');
    expect(batchRow(h.db, 'fbb_doc').status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Never-throws / serialization
// ---------------------------------------------------------------------------

describe('DesignFeedbackOutbox — no unhandled rejection paths', () => {
  it('an unknown batch id resolves without throwing and dispatches nothing', async () => {
    const h = makeHarness();
    await expect(h.outbox.notifyQueued('fbb_ghost')).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it('a terminal batch is a no-op (applied stays applied)', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);
    await h.router.recordDispatchAttempt({ batchId, attemptId: 'att-x' });
    await h.router.applyBatchResult({ batchId, attemptId: 'att-x', prototypeRevision: 3 });

    await expect(h.outbox.notifyQueued(batchId)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId).status).toBe('applied');
  });

  it('a THROWING guard leaves the batch in its current in-flight state (an unknown is not a failure)', async () => {
    const h = makeHarness({
      guards: {
        isIdeaLinkValid: () => {
          throw new Error('database is locked');
        },
      },
    });
    const batchId = await queueBatch(h);

    await expect(h.outbox.notifyQueued(batchId)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
    // Still 'queued' — retryable, NOT terminally blocked on a transient error.
    expect(batchRow(h.db, batchId)).toMatchObject({ status: 'queued', blocked_reason: null });
  });

  it('a batch whose comments vanished fails visibly instead of dispatching an empty turn', async () => {
    const h = makeHarness();
    const batchId = await queueBatch(h);
    h.db.prepare('DELETE FROM feedback_comments WHERE batch_id = ?').run(batchId);

    await expect(h.outbox.notifyQueued(batchId)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(batchRow(h.db, batchId)).toMatchObject({
      status: 'failed',
      error: 'no sent comments were found for this feedback batch',
    });
  });

  it('two concurrent pokes for the same batch open exactly ONE attempt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ dispatchTurn: () => gate });
    const batchId = await queueBatch(h);

    const a = h.outbox.notifyQueued(batchId);
    const b = h.outbox.notifyQueued(batchId);
    release();
    await Promise.all([a, b]);

    expect(h.calls).toHaveLength(1);
    expect(batchRow(h.db, batchId)).toMatchObject({ status: 'dispatched', attempt_count: 1 });
  });
});

// ---------------------------------------------------------------------------
// The DB-backed default guards
// ---------------------------------------------------------------------------

describe('makeDefaultGuards', () => {
  function seedSession(db: Database.Database, opts: { archived?: number; ideaId?: string | null }): void {
    db.prepare('INSERT INTO sessions (id, project_id, archived, design_idea_id) VALUES (?, 1, ?, ?)').run(
      'sess-1',
      opts.archived ?? 0,
      opts.ideaId === undefined ? 'idea-1' : opts.ideaId,
    );
  }
  function seedIdea(
    db: Database.Database,
    opts?: { projectId?: number; decomposedAt?: string | null; archivedAt?: string | null },
  ): void {
    db.prepare(
      `INSERT INTO ideas (id, project_id, board_id, stage_id, ref, title, body, decomposed_at, archived_at)
       VALUES ('idea-1', ?, 'board-1', 'stage-1', 'IDEA-001', 'An idea', 'body', ?, ?)`,
    ).run(opts?.projectId ?? 1, opts?.decomposedAt ?? null, opts?.archivedAt ?? null);
  }

  it('isSessionAlive: true for a live session, false for archived or missing', () => {
    const db = buildDb();
    const guards = makeDefaultGuards(dbAdapter(db) as DatabaseLike);
    expect(guards.isSessionAlive('sess-1')).toBe(false);
    seedSession(db, {});
    expect(guards.isSessionAlive('sess-1')).toBe(true);
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('sess-1');
    expect(guards.isSessionAlive('sess-1')).toBe(false);
  });

  it('isIdeaLinkValid: false when the idea is missing, decomposed, archived, or cross-project', () => {
    const db = buildDb();
    const guards = makeDefaultGuards(dbAdapter(db) as DatabaseLike);
    seedSession(db, {});
    expect(guards.isIdeaLinkValid('sess-1')).toBe(false); // no idea row

    seedIdea(db);
    expect(guards.isIdeaLinkValid('sess-1')).toBe(true);

    db.prepare("UPDATE ideas SET decomposed_at = '2026-07-28T00:00:00.000Z'").run();
    expect(guards.isIdeaLinkValid('sess-1')).toBe(false);
    db.prepare("UPDATE ideas SET decomposed_at = NULL, archived_at = '2026-07-28T00:00:00.000Z'").run();
    expect(guards.isIdeaLinkValid('sess-1')).toBe(false);
    db.prepare('UPDATE ideas SET archived_at = NULL, project_id = 2').run();
    expect(guards.isIdeaLinkValid('sess-1')).toBe(false); // cross-project
  });

  it('hasPrototypeArtifact: only a prototype-family artifact WITH bytes counts', () => {
    const db = buildDb();
    seedLiveRun(db);
    const guards = makeDefaultGuards(dbAdapter(db) as DatabaseLike);
    expect(guards.hasPrototypeArtifact('run-1')).toBe(false);

    // The bytes-less re-entry stub does NOT count.
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json)
       VALUES ('art_stub', 'run-1', 'ui-prototype', 'Prototype', 'canvas', NULL)`,
    ).run();
    expect(guards.hasPrototypeArtifact('run-1')).toBe(false);

    // A non-prototype artifact with bytes does not count either.
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json)
       VALUES ('art_spec', 'run-1', 'idea-spec', 'Spec', 'template', '{"x":1}')`,
    ).run();
    expect(guards.hasPrototypeArtifact('run-1')).toBe(false);

    // A prototype WITH bytes does (asserted on its own run — one artifact per
    // (run_id, atype)).
    seedLiveRun(db, 'run-2');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json)
       VALUES ('art_live', 'run-2', 'ui-prototype', 'Prototype', 'canvas', '{"fileName":"prototype/index.html"}')`,
    ).run();
    expect(guards.hasPrototypeArtifact('run-2')).toBe(true);
  });
});
