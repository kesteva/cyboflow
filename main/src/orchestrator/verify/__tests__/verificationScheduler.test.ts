/**
 * VerificationScheduler — request-row mechanics on a minimal in-memory
 * verification_requests table (no migration chain, no workflow_runs table, so no
 * row is ever on the agent engine here):
 *   - enqueue dual-write + idempotent enqueue keys
 *   - the queued-age deadline and its boot sweep
 *   - the delivery outbox (boot replay, pending-on-failed-consumer)
 *   - awaitTerminal on a pre-095 DB
 * The agent engine's drain is covered by verificationSchedulerAgent.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { VerificationScheduler, type OnVerdict } from '../verificationScheduler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { ResolvedVisualVerifyConfig, VerdictV1 } from '../../../../../shared/types/visualVerification';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE verification_requests (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      project_id       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'queued',
      verify_type      TEXT NOT NULL,
      deliverable_json TEXT NOT NULL,
      chain_json       TEXT,
      current_backend  TEXT,
      attempt          INTEGER NOT NULL DEFAULT 0,
      verdict_json     TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      -- Migration 078 (verification-agent dual-format request plumbing): additive
      -- nullable columns the scheduler's enqueue() may now dual-write alongside
      -- deliverable_json (task_json/snapshot_sha/enqueue_key) or the terminal
      -- delivery may set later (report_json/delivery_state — untouched by THIS slice).
      task_json        TEXT,
      report_json      TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT
    );
  `);
  return db;
}

/** A pass verdict the fake judge returns (above the default 0.7 threshold). */
const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['default.png'],
  baselineUsed: false,
  model: 'fake',
};

const baseConfig: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  devServerPorts: [5173, 3000],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
  mobileSimSlots: VISUAL_VERIFY_DEFAULTS.mobileSimSlots,
  mobileSimDeviceType: VISUAL_VERIFY_DEFAULTS.mobileSimDeviceType,
  mobileSimRuntime: VISUAL_VERIFY_DEFAULTS.mobileSimRuntime,
  mobileDeadlineFloorMs: VISUAL_VERIFY_DEFAULTS.mobileDeadlineFloorMs,
  autoBootstrapRunbook: false,
  requireProvenRunbook: VISUAL_VERIFY_DEFAULTS.requireProvenRunbook,
  exploreDeadlineFloorMs: VISUAL_VERIFY_DEFAULTS.exploreDeadlineFloorMs,
  mobileDriveEngine: VISUAL_VERIFY_DEFAULTS.mobileDriveEngine,
};

/** Insert one queued request and return its id. */
function rowStatus(db: Database.Database, id: string): { status: string; error: string | null } {
  return db
    .prepare('SELECT status, error_message AS error FROM verification_requests WHERE id = ?')
    .get(id) as { status: string; error: string | null };
}

let db: Database.Database;

beforeEach(() => {
  VerificationScheduler._resetForTesting();
  db = buildDb();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationScheduler — enqueue dual-write (verification-agent redesign §5.2/§5.13)', () => {
  /** Read back the raw persisted row for the dual-write assertions below. */
  function rawRow(
    id: string,
  ): { deliverable_json: string; task_json: string | null; snapshot_sha: string | null } {
    return db
      .prepare('SELECT deliverable_json, task_json, snapshot_sha FROM verification_requests WHERE id = ?')
      .get(id) as { deliverable_json: string; task_json: string | null; snapshot_sha: string | null };
  }

  it('enqueue WITHOUT a task leaves task_json/snapshot_sha NULL and writes deliverable_json exactly as before', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right', url: 'http://localhost:3000' },
      chain: [],
    });

    const row = rawRow(id);
    expect(row.task_json).toBeNull();
    expect(row.snapshot_sha).toBeNull();
    expect(JSON.parse(row.deliverable_json)).toEqual({ intent: 'looks right', url: 'http://localhost:3000' });
  });

  it('enqueue WITH a task dual-writes: the row carries BOTH a legacy-shaped deliverable_json AND task_json', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const task = {
      version: 1 as const,
      summary: 'Check the login form renders',
      behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
    };

    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: task.summary },
      chain: [],
      task,
    });

    const row = rawRow(id);
    expect(row.task_json).not.toBeNull();
    expect(JSON.parse(row.task_json as string)).toEqual(task);
    expect(JSON.parse(row.deliverable_json)).toEqual({ intent: task.summary });
  });

  it('enqueue persists snapshot_sha when passed', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
      snapshotSha: 'abc123deadbeef',
    });

    expect(rawRow(id).snapshot_sha).toBe('abc123deadbeef');
  });

  it('enqueue treats an explicit snapshotSha: null the same as omitted (NULL)', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
      snapshotSha: null,
    });

    expect(rawRow(id).snapshot_sha).toBeNull();
  });

  it('enqueue TWICE with the same enqueueKey returns the SAME requestId and inserts only ONE row', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const first = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:1',
    });
    const second = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right (re-walked after a crash)' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:1',
    });

    expect(second).toBe(first);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM verification_requests WHERE enqueue_key = ?')
      .get('run-1:TASK-008:1') as { n: number };
    expect(count.n).toBe(1);
  });

  it('enqueue with DIFFERENT enqueueKeys inserts TWO distinct rows', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const first = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:1',
    });
    const second = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right, attempt 2' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:2',
    });

    expect(second).not.toBe(first);
    const count = db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('a CANCELED row sharing the key does NOT block a fresh enqueue (a re-attempt after cancel re-fires)', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const canceled = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:1',
    });
    // Mirror cancelForRun's sweep signature exactly (status='timeout' AND
    // error_message='canceled') rather than calling cancelForRun itself, so this
    // test stays scoped to the dedup lookup rather than the abort machinery.
    db.prepare(
      `UPDATE verification_requests SET status = 'timeout', error_message = 'canceled' WHERE id = ?`,
    ).run(canceled);

    const freshAttempt = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right, re-fired' },
      chain: [],
      enqueueKey: 'run-1:TASK-008:1',
    });

    expect(freshAttempt).not.toBe(canceled);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM verification_requests WHERE enqueue_key = ?')
      .get('run-1:TASK-008:1') as { n: number };
    expect(count.n).toBe(2);
  });

  it('enqueue WITHOUT an enqueueKey never dedups — two calls insert two rows', () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const first = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
    });
    const second = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'looks right' },
      chain: [],
    });

    expect(second).not.toBe(first);
    const count = db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §5.6 — queued-age deadline + delivery outbox (slices 9a/9b)
// ---------------------------------------------------------------------------

describe('VerificationScheduler — queued-age deadline (§5.6)', () => {
  /** Insert a QUEUED row with an explicit enqueued_at (the age anchor). */
  function insertQueuedAt(
    dbX: Database.Database,
    opts: { id: string; enqueuedAt: string; url?: string },
  ): void {
    dbX
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
         VALUES (?, 'run-1', 1, 'queued', 'static-render-snapshot', ?, ?, 0, ?)`,
      )
      .run(
        opts.id,
        JSON.stringify({ intent: 'looks right', url: opts.url ?? 'http://x' }),
        '[]',
        opts.enqueuedAt,
      );
  }

  it('expires an over-age queued row as skipped (through delivery), before dispatch', async () => {
    const verdicts: Array<{ status: string; requestId: string }> = [];
    const onVerdict: OnVerdict = async (a) => {
      verdicts.push({ status: a.status, requestId: a.requestId });
    };
    const clock = 10_000_000;
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: { ...baseConfig, queuedAgeCeilingMs: 5_000 },
      onVerdict,
      now: () => clock,
    });
    // Enqueued 1h before the clock — far past the 5s ceiling.
    insertQueuedAt(db, { id: 'vr_old', enqueuedAt: new Date(clock - 3_600_000).toISOString() });
    await sched.drain();

    const row = rowStatus(db, 'vr_old');
    expect(row.status).toBe('skipped');
    // The expiry preceded dispatch: the queued-age reason, not the retired-engine one.
    expect(row.error).toMatch(/queued-age deadline exceeded/);
    expect(verdicts).toEqual([{ status: 'skipped', requestId: 'vr_old' }]);
    // The terminal write also stamped the outbox marker as delivered.
    const del = db.prepare('SELECT delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_old') as { d: string | null };
    expect(del.d).toBe('delivered');
  });

  it('runRecovery boot-sweeps a STALE over-age queued row (§5.6 boot sweep)', async () => {
    const verdicts: string[] = [];
    const clock = 30_000_000;
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: { ...baseConfig, queuedAgeCeilingMs: 5_000 },
      onVerdict: async (a) => void verdicts.push(a.status),
      now: () => clock,
    });
    // A queued row left by a prior process, enqueued well before the ceiling.
    insertQueuedAt(db, { id: 'vr_stale', enqueuedAt: new Date(clock - 60_000).toISOString() });
    const swept = await sched.runRecovery();
    expect(swept).toBe(1);
    expect(rowStatus(db, 'vr_stale').status).toBe('skipped');
    expect(rowStatus(db, 'vr_stale').error).toMatch(/queued-age deadline exceeded/);
    expect(verdicts).toEqual(['skipped']);
  });
});

describe('VerificationScheduler — delivery outbox (§5.6)', () => {
  /** Insert a TERMINAL row with an explicit delivery_state (the outbox marker). */
  function insertTerminal(
    dbX: Database.Database,
    opts: {
      id: string;
      status: string;
      deliveryState: string | null;
      verdictJson?: string | null;
      reportJson?: string | null;
      errorMessage?: string | null;
    },
  ): void {
    dbX
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt,
            verdict_json, report_json, delivery_state, error_message, enqueued_at)
         VALUES (?, 'run-1', 1, ?, 'static-render-snapshot', ?, '[]', 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(
        opts.id,
        opts.status,
        JSON.stringify({ intent: 'x', taskRef: 'TASK-1' }),
        opts.verdictJson ?? null,
        opts.reportJson ?? null,
        opts.deliveryState,
        opts.errorMessage ?? null,
      );
  }

  function makeSched(onVerdict: OnVerdict): VerificationScheduler {
    return VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      onVerdict,
    });
  }

  it('boot replay re-delivers a terminal-but-pending row exactly once, then stamps delivered', async () => {
    const calls: Array<{ requestId: string; status: string; verdictStatus?: string }> = [];
    const sched = makeSched(async (a) => {
      calls.push({ requestId: a.requestId, status: a.status, verdictStatus: a.verdict?.status });
    });
    const verdictJson = JSON.stringify({
      status: 'fail',
      confidence: 0.9,
      issues: [],
      feedback: 'nope',
      judgedFileNames: ['a.png'],
      baselineUsed: false,
      model: 'fake',
    });
    insertTerminal(db, { id: 'vr_pending', status: 'failed', deliveryState: 'pending', verdictJson });

    const n = await sched.runRecovery();
    expect(n).toBe(1);
    expect(calls).toEqual([{ requestId: 'vr_pending', status: 'failed', verdictStatus: 'fail' }]);
    const del = db.prepare('SELECT delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_pending') as { d: string | null };
    expect(del.d).toBe('delivered');
  });

  it('a double boot replay does NOT re-deliver (delivered rows are not pending)', async () => {
    const calls: string[] = [];
    const sched = makeSched(async (a) => void calls.push(a.requestId));
    insertTerminal(db, { id: 'vr_p', status: 'skipped', deliveryState: 'pending', errorMessage: 'no backend' });
    await sched.runRecovery();
    await sched.runRecovery();
    expect(calls).toEqual(['vr_p']); // delivered exactly once across two boots
  });

  it('a legacy row (delivery_state NULL) is NEVER replayed', async () => {
    const calls: string[] = [];
    const sched = makeSched(async (a) => void calls.push(a.requestId));
    insertTerminal(db, { id: 'vr_legacy', status: 'passed', deliveryState: null });
    await sched.runRecovery();
    expect(calls).toEqual([]);
    const del = db.prepare('SELECT delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_legacy') as { d: string | null };
    expect(del.d).toBeNull(); // untouched
  });

  // §5.6 amended (adversarial-review fix 2026-07-23): a failed required consumer
  // must leave the row 'pending' for replay — never stamp 'delivered'.
  it('a hook returning false leaves the row pending on replay; it delivers once the consumer recovers', async () => {
    let consumerHealthy = false;
    const calls: string[] = [];
    const sched = makeSched(async (a) => {
      calls.push(a.requestId);
      return consumerHealthy;
    });
    insertTerminal(db, { id: 'vr_retry', status: 'failed', deliveryState: 'pending' });

    expect(await sched.runRecovery()).toBe(0); // delivery failed → NOT counted as replayed
    let del = db.prepare('SELECT delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_retry') as { d: string | null };
    expect(del.d).toBe('pending');

    consumerHealthy = true;
    expect(await sched.runRecovery()).toBe(1);
    del = db.prepare('SELECT delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_retry') as { d: string | null };
    expect(del.d).toBe('delivered');
    expect(calls).toEqual(['vr_retry', 'vr_retry']); // idempotent consumers make the re-run safe
  });

  it('a THROWING hook on a live terminal leaves the row pending (not delivered)', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: { ...baseConfig, queuedAgeCeilingMs: 1 },
      onVerdict: async () => {
        throw new Error('router down');
      },
      now: () => 40_000_000,
    });
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
       VALUES ('vr_hookthrow', 'run-1', 1, 'queued', 'static-render-snapshot', ?, '[]', 0, ?)`,
    ).run(JSON.stringify({ intent: 'x' }), new Date(40_000_000 - 10_000).toISOString());
    await sched.drain();
    const row = db.prepare('SELECT status, delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_hookthrow') as { status: string; d: string | null };
    expect(row.status).toBe('skipped'); // terminal status committed regardless
    expect(row.d).toBe('pending'); // …but the outbox row awaits replay
  });

  it('a hook returning false on a live terminal leaves the row pending', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: { ...baseConfig, queuedAgeCeilingMs: 1 },
      onVerdict: async () => false,
      now: () => 40_000_000,
    });
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
       VALUES ('vr_hookfalse', 'run-1', 1, 'queued', 'static-render-snapshot', ?, '[]', 0, ?)`,
    ).run(JSON.stringify({ intent: 'x' }), new Date(40_000_000 - 10_000).toISOString());
    await sched.drain();
    const row = db.prepare('SELECT status, delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_hookfalse') as { status: string; d: string | null };
    expect(row.status).toBe('skipped');
    expect(row.d).toBe('pending');
  });

  it('markTerminal stamps delivery_state=pending and markTerminalAndDeliver flips it to delivered', async () => {
    // A live over-age expiry exercises the full terminal→deliver→delivered path.
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: { ...baseConfig, queuedAgeCeilingMs: 1 },
      onVerdict: async () => {},
      now: () => 40_000_000,
    });
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
       VALUES ('vr_flip', 'run-1', 1, 'queued', 'static-render-snapshot', ?, '[]', 0, ?)`,
    ).run(JSON.stringify({ intent: 'x' }), new Date(40_000_000 - 10_000).toISOString());
    await sched.drain();
    const row = db.prepare('SELECT status, delivery_state AS d FROM verification_requests WHERE id = ?').get('vr_flip') as { status: string; d: string | null };
    expect(row.status).toBe('skipped');
    expect(row.d).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// awaitTerminal on a PRE-095 DB (§5.2 seam 2).
//
// This file's fixture table deliberately stops at migration 078 — no
// `failure_class` column — which is exactly the shape an older binary (or any
// minimal fixture) presents. The widened snapshot SELECT throws on `prepare`
// there, and the fallback must lose only the ATTRIBUTION: losing the STATUS to
// that throw would make every await on such a DB answer "request not found"
// forever, which reads as a skip and would advance a setup flow past a proof it
// never actually observed.
// ---------------------------------------------------------------------------

describe('VerificationScheduler — awaitTerminal on a pre-095 DB', () => {
  it('still resolves the status + feedback, with a null failure class', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, verdict_json)
       VALUES ('vr_pre095', 'run-1', 1, 'failed', 'static-render-snapshot', ?, '[]', 0, ?)`,
    ).run(JSON.stringify({ intent: 'x' }), JSON.stringify({ ...PASS_VERDICT, feedback: 'nope' }));

    const outcome = await sched.awaitTerminal('vr_pre095', 5_000, 5);
    expect(outcome.status).toBe('failed');
    expect(outcome.feedback).toBe('nope');
    expect(outcome.failureClass).toBeNull();
  });
});
