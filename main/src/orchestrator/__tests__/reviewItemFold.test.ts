/**
 * Integration tests for the P4 run-pause review_items fold.
 *
 * Covers, on a migration-backed in-memory DB (projects + 006/011/014/015/016 so
 * workflow_runs/approvals/questions/entity_events/review_items all exist):
 *
 *  - ApprovalRouter.requestApproval co-writes a blocking permission review_item
 *    in the SAME transaction as the approvals INSERT (both present, or — when the
 *    run is not running — NEITHER present: rollback together).
 *  - ApprovalRouter.respond resolves the folded permission item idempotently
 *    (allow + deny both resolve; a second respond is a no-op).
 *  - QuestionRouter.requestQuestion co-writes a blocking decision review_item +
 *    respond resolves it (answered + canceled-supersede both resolve).
 *  - HumanStepManager human-gate: openHumanGate creates a blocking decision item
 *    + transitions running -> awaiting_review (the run does NOT pass the step);
 *    is idempotent per step; resolveHumanGate AUTO-RESUMES only when the run has
 *    NO other pending blocking item (aggregate-unblock).
 *  - Aggregate-blocking: a permission AND a decision both pending keep the run
 *    paused until BOTH resolve, then it auto-resumes.
 *  - permission-mode 'dontAsk' installs NO hook, so NO permission review_item is
 *    created (mode=ignore short-circuits before requestApproval).
 *
 * The fold writes review_items DIRECTLY in the router transaction (NOT via the
 * async ReviewItemRouter PQueue) — these tests assert the synchronous co-write.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalRouter } from '../approvalRouter';
import { QuestionRouter } from '../questionRouter';
import { HumanStepManager } from '../humanStepManager';
import { buildPreToolUseHook } from '../permissionModeMapper';
import { resolvePermissionReviewItem } from '../reviewItemListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { QuestionPayload } from '../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Migration-backed test DB (projects + 006 + 011 + 014 + 015 + 016).
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

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  // 007 (stuck_detected_at) + 010 (questions table + the workflow_runs CHECK
  // recreate that adds 'awaiting_input') are required so QuestionRouter can
  // transition a run to awaiting_input. 010 references stuck_detected_at, so 007
  // must run first; both run before 011/014 which ALTER workflow_runs.
  db.exec(readFileSync(join(migDir, '007_add_stuck_reason.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '010_questions.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

function seedRun(db: Database.Database, runId: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, ?, 'default')`,
  ).run(runId, status);
}

function runStatus(db: Database.Database, runId: string): string {
  return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
}

function reviewRows(
  db: Database.Database,
  runId: string,
): Array<{ id: string; kind: string; status: string; blocking: number; source: string }> {
  return db
    .prepare('SELECT id, kind, status, blocking, source FROM review_items WHERE run_id = ? ORDER BY created_at ASC, id ASC')
    .all(runId) as Array<{ id: string; kind: string; status: string; blocking: number; source: string }>;
}

const QUESTIONS: QuestionPayload[] = [
  { question: 'Pick a path forward', header: 'Path', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
];

afterEach(() => {
  ApprovalRouter._resetForTesting();
  QuestionRouter._resetForTesting();
  HumanStepManager._resetForTesting();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ApprovalRouter — permission fold
// ---------------------------------------------------------------------------

describe('ApprovalRouter permission review_item co-write', () => {
  it('co-writes a blocking permission review_item in the SAME txn as the approvals row', async () => {
    const db = buildDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-1');

    const p = router.requestApproval('run-1', 'Bash', { command: 'ls' }, () => {});
    await router['getApprovalQueue']('run-1').onIdle();

    const rows = reviewRows(db, 'run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('permission');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].blocking).toBe(1);
    expect(rows[0].source).toBe('approval');

    // payload carries the approvalId link.
    const payload = JSON.parse(
      (db.prepare('SELECT payload_json FROM review_items WHERE run_id = ?').get('run-1') as { payload_json: string })
        .payload_json,
    ) as { kind: string; toolName: string; approvalId: string };
    expect(payload.kind).toBe('permission');
    expect(payload.toolName).toBe('Bash');
    const approvalId = (db.prepare('SELECT id FROM approvals WHERE run_id = ?').get('run-1') as { id: string }).id;
    expect(payload.approvalId).toBe(approvalId);

    await router.respond(approvalId, { behavior: 'allow' });
    await p;
  });

  it('rolls back the review_item WITH the approvals row when the run is not running', async () => {
    const db = buildDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-1', 'canceled'); // not 'running' → guard fails → rollback

    await expect(router.requestApproval('run-1', 'Bash', { command: 'ls' }, () => {})).rejects.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?').get('run-1')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE run_id = ?').get('run-1')).toEqual({ n: 0 });
  });

  it('respond (allow) resolves the folded permission review_item idempotently', async () => {
    const db = buildDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-1');

    const p = router.requestApproval('run-1', 'Bash', { command: 'ls' }, () => {});
    await router['getApprovalQueue']('run-1').onIdle();
    const approvalId = (db.prepare('SELECT id FROM approvals WHERE run_id = ?').get('run-1') as { id: string }).id;

    await router.respond(approvalId, { behavior: 'allow' });
    await p;

    const rows = reviewRows(db, 'run-1');
    expect(rows[0].status).toBe('resolved');

    // Idempotent resolve: a second resolve of the SAME folded item is a guarded
    // no-op (returns null, writes no second 'resolved' event). This is the
    // exactly-once property the respond() path relies on when a concurrent
    // settle has already resolved the item.
    const second = resolvePermissionReviewItem(dbAdapter(db), approvalId, 'user', 'approved', new Date().toISOString());
    expect(second).toBeNull();
    expect(reviewRows(db, 'run-1')[0].status).toBe('resolved');

    // Exactly one 'resolved' entity_events delta was written for the item.
    const resolvedEvents = db
      .prepare(
        "SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'review_item' AND entity_id = ? AND kind = 'resolved'",
      )
      .get(rows[0].id) as { n: number };
    expect(resolvedEvents.n).toBe(1);
  });

  it('respond (deny) resolves the folded permission review_item', async () => {
    const db = buildDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-1');

    const p = router.requestApproval('run-1', 'Bash', { command: 'rm -rf /' }, () => {});
    await router['getApprovalQueue']('run-1').onIdle();
    const approvalId = (db.prepare('SELECT id FROM approvals WHERE run_id = ?').get('run-1') as { id: string }).id;

    await router.respond(approvalId, { behavior: 'deny', message: 'no' });
    await p;

    expect(reviewRows(db, 'run-1')[0].status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// QuestionRouter — decision fold
// ---------------------------------------------------------------------------

describe('QuestionRouter decision review_item co-write', () => {
  it('co-writes a blocking decision review_item in the SAME txn as the questions row', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-q');

    const p = router.requestQuestion('run-q', 'tool-use-1', QUESTIONS, () => {});
    await router['getQuestionQueue']('run-q').onIdle();

    const rows = reviewRows(db, 'run-q');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('decision');
    expect(rows[0].blocking).toBe(1);
    expect(rows[0].source).toBe('question');
    expect(runStatus(db, 'run-q')).toBe('awaiting_input');

    const questionId = (db.prepare('SELECT id FROM questions WHERE run_id = ?').get('run-q') as { id: string }).id;
    await router.respond(questionId, { answers: { 'Pick a path forward': 'A' } });
    await p;

    expect(reviewRows(db, 'run-q')[0].status).toBe('resolved');
    expect(runStatus(db, 'run-q')).toBe('running');
  });

  it('rolls back the decision review_item when the run is not running', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-q', 'completed');

    await expect(router.requestQuestion('run-q', 'tool-use-1', QUESTIONS, () => {})).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE run_id = ?').get('run-q')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE run_id = ?').get('run-q')).toEqual({ n: 0 });
  });

  it('respond resolves the decision item even when the run was canceled (supersede)', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-q');

    const p = router.requestQuestion('run-q', 'tool-use-1', QUESTIONS, () => {});
    await router['getQuestionQueue']('run-q').onIdle();
    const questionId = (db.prepare('SELECT id FROM questions WHERE run_id = ?').get('run-q') as { id: string }).id;

    // Concurrent cancel OUTSIDE the queue (the supersede race).
    db.prepare(`UPDATE workflow_runs SET status = 'canceled' WHERE id = ?`).run('run-q');

    await router.respond(questionId, { answers: { 'Pick a path forward': 'A' } });
    await p;

    // The folded decision item is resolved (not left lingering as blocking).
    expect(reviewRows(db, 'run-q')[0].status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// HumanStepManager — human=true step gate + aggregate-unblock
// ---------------------------------------------------------------------------

describe('HumanStepManager human gate (run-pause + aggregate-unblock)', () => {
  it('openHumanGate creates a blocking decision item AND pauses the run (does not pass the step)', async () => {
    const db = buildDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedRun(db, 'run-h');

    const reviewItemId = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    expect(reviewItemId).not.toBeNull();
    expect(runStatus(db, 'run-h')).toBe('awaiting_review'); // run PAUSED, not advanced

    const rows = reviewRows(db, 'run-h');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('decision');
    expect(rows[0].blocking).toBe(1);
    expect(rows[0].source).toBe('gate:human-step:plan-review');
  });

  it('openHumanGate is idempotent per (run, step) — a second open does NOT create a second gate', async () => {
    const db = buildDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedRun(db, 'run-h');

    const first = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    const second = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(reviewRows(db, 'run-h')).toHaveLength(1);
  });

  it('clearPendingForRun dismisses orphan gate decision rows (cancel cleanup) and is bounded to the run', async () => {
    const db = buildDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedRun(db, 'run-h');
    seedRun(db, 'run-other');

    const gateThis = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    const gateOther = await mgr.openHumanGate('run-other', 'plan-review', 'Plan review');
    expect(gateThis).not.toBeNull();
    expect(gateOther).not.toBeNull();

    const dismissed = mgr.clearPendingForRun('run-h');

    expect(dismissed).toBe(1);
    expect(reviewRows(db, 'run-h')[0].status).toBe('dismissed');
    // The OTHER run's gate is untouched.
    expect(reviewRows(db, 'run-other')[0].status).toBe('pending');
    // Idempotent: a second clear finds nothing pending.
    expect(mgr.clearPendingForRun('run-h')).toBe(0);
  });

  it('resolveHumanGate auto-resumes the run when it is the only blocking item', async () => {
    const db = buildDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedRun(db, 'run-h');

    const reviewItemId = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    const { resolved, resumed } = await mgr.resolveHumanGate('run-h', reviewItemId!, 'user', 'approved');
    expect(resolved).toBe(true);
    expect(resumed).toBe(true);
    expect(runStatus(db, 'run-h')).toBe('running');
    expect(reviewRows(db, 'run-h')[0].status).toBe('resolved');
  });

  it('aggregate-blocking: two pending blocking items keep the run paused; it auto-resumes only when BOTH resolve', async () => {
    const db = buildDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedRun(db, 'run-h');

    // Gate 1 (human step) opens — run -> awaiting_review.
    const gate1 = await mgr.openHumanGate('run-h', 'plan-review', 'Plan review');
    expect(gate1).not.toBeNull();
    expect(runStatus(db, 'run-h')).toBe('awaiting_review');

    // A SECOND blocking decision item is pending for the SAME run (e.g. a sibling
    // gate / a permission folded while running). Insert it directly so two
    // blocking items co-exist while the run is paused.
    db.prepare(
      `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title, source, created_at, updated_at)
       VALUES ('rvw_sibling', 1, 'run-h', 'permission', 'pending', 1, 'sibling perm', 'approval', datetime('now'), datetime('now'))`,
    ).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE run_id = 'run-h' AND blocking = 1 AND status = 'pending'").get())
      .toEqual({ n: 2 });

    // Resolve gate 1 → ONE blocking item still pending → run must STAY paused.
    const r1 = await mgr.resolveHumanGate('run-h', gate1!, 'user', 'approved');
    expect(r1.resolved).toBe(true);
    expect(r1.resumed).toBe(false);
    expect(runStatus(db, 'run-h')).toBe('awaiting_review');

    // Resolve the sibling → no blocking item remains → AUTO-RESUME.
    const r2 = await mgr.resolveHumanGate('run-h', 'rvw_sibling', 'user', 'approved');
    expect(r2.resolved).toBe(true);
    expect(r2.resumed).toBe(true);
    expect(runStatus(db, 'run-h')).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// permission-mode 'dontAsk' (the workflow analogue of 'ignore') → NO review_item
// ---------------------------------------------------------------------------

describe("permission-mode 'dontAsk' (ignore) creates NO permission review_item", () => {
  it('installs no PreToolUse hook, so requestApproval is never reached and no review_item is written', () => {
    const db = buildDb();
    ApprovalRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-ignore');

    // 'dontAsk' returns undefined — there is no hook, so the SDK never routes a
    // PreToolUse through ApprovalRouter, so no permission review_item is created.
    const hook = buildPreToolUseHook('dontAsk', 'run-ignore');
    expect(hook).toBeUndefined();

    expect(db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE run_id = ?').get('run-ignore')).toEqual({ n: 0 });
  });
});
