/**
 * VerificationScheduler — lifecycle, dispatch and lease-pool tests against an
 * in-memory SQLite DB:
 *   - a request not on the agent engine (no / a retired capture-backend stamp)
 *     settles 'skipped' with its terminal event, never stranding 'queued'
 *   - cancelForRun terminates a run's outstanding requests
 *   - runRecovery re-drains orphaned leased/running rows through delivery
 *   - ResourceLeasePool slot semantics
 * The agent engine itself is covered by verify/__tests__/verificationSchedulerAgent.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETIRED_ENGINE_SKIP_REASON,
  ResourceLeasePool,
  VerificationScheduler,
  verificationEvents,
  verificationChannel,
  type OnVerdict,
  type VerificationTerminalEvent,
} from '../verify/verificationScheduler';
import { Mutex } from '../../utils/mutex';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

const MIG_DIR = join(__dirname, '..', '..', 'database', 'migrations');
const THROUGH_078 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  // Migration 078 (verification-agent dual-format request plumbing): additive
  // nullable columns on verification_requests (task_json/report_json/
  // delivery_state/snapshot_sha) — this suite's enqueue() calls now write
  // task_json/snapshot_sha alongside deliverable_json, so the real column set
  // must be present.
  '078_verification_agent_requests.sql',
];

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
  for (const f of THROUGH_078) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
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

/** Wait for any pending setImmediate drain passes to settle. */
async function flushDrain(): Promise<void> {
  // Two macrotask hops cover: nudge's setImmediate → async drain → onVerdict awaits.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function status(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM verification_requests WHERE id = ?').get(id) as { status: string })
    .status;
}

describe('VerificationScheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    seedRun(db, 'run-1');
    VerificationScheduler._resetForTesting();
  });

  afterEach(() => {
    VerificationScheduler._resetForTesting();
    db.close();
  });

  it('terminalizes a request that is not on the agent engine as SKIPPED (retired engine) and emits its terminal event', async () => {
    // run-1 carries no verify_chain stamp and the request's own chain is empty,
    // so nothing routes it to the agent engine: it must settle rather than strand.
    const events: VerificationTerminalEvent[] = [];
    const onEvent = (e: VerificationTerminalEvent): void => void events.push(e);
    verificationEvents.on(verificationChannel('run-1'), onEvent);
    try {
      const sched = VerificationScheduler.initialize({
        db: dbAdapter(db),
        artifactsDirResolver: (runId) => `/tmp/${runId}`,
        leasePool: new ResourceLeasePool(new Mutex()),
      });
      const id = sched.enqueue({
        runId: 'run-1',
        projectId: 1,
        type: 'static-render-snapshot',
        input: { intent: 'legacy-stamped run' },
        chain: [],
      });
      await flushDrain();
      expect(status(db, id)).toBe('skipped');
      const row = db
        .prepare('SELECT error_message FROM verification_requests WHERE id = ?')
        .get(id) as { error_message: string };
      expect(row.error_message).toBe(RETIRED_ENGINE_SKIP_REASON);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ requestId: id, status: 'skipped' });
    } finally {
      verificationEvents.off(verificationChannel('run-1'), onEvent);
    }
  });

  it('terminalizes a request on a run stamped with the retired capture-backend chain as SKIPPED', async () => {
    db.prepare(`UPDATE workflow_runs SET verify_chain = ? WHERE id = 'run-1'`).run(
      JSON.stringify(['capturePage', 'playwright', 'peekaboo']),
    );
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'pre-agent-engine run' },
      chain: ['capturePage'],
    });
    await flushDrain();
    expect(status(db, id)).toBe('skipped');
  });

  it('cancelForRun terminates a run\'s outstanding queued requests', async () => {
    // No backend present so the request would normally drain to skipped — instead
    // cancel it BEFORE draining and assert it goes to timeout.
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    // Insert directly (do not nudge) so the row stays 'queued' for cancellation.
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, chain_json)
       VALUES ('vr_cancel', 'run-1', 1, 'queued', 'static-render-snapshot', '{"intent":"x"}', '["capturePage"]')`,
    ).run();

    const canceled = sched.cancelForRun('run-1');
    expect(canceled).toBe(1);
    expect(status(db, 'vr_cancel')).toBe('timeout');

    // A terminal (passed) row in the same run is untouched.
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('vr_done', 'run-1', 1, 'passed', 'static-render-snapshot', '{"intent":"y"}')`,
    ).run();
    expect(sched.cancelForRun('run-1')).toBe(0); // nothing non-terminal left
    expect(status(db, 'vr_done')).toBe('passed');
  });

  it('cancelForRun cancels a mix of queued + running non-terminal rows, leaving terminal ones', async () => {
    // Insert rows directly so we control statuses precisely (no drain).
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('q1', 'run-1', 1, 'queued', 'static-render-snapshot', '{"intent":"a"}')`,
    ).run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('r1', 'run-1', 1, 'running', 'static-render-snapshot', '{"intent":"b"}')`,
    ).run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('p1', 'run-1', 1, 'passed', 'static-render-snapshot', '{"intent":"c"}')`,
    ).run();
    // A different run must be untouched.
    seedRun(db, 'run-2');
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('q2', 'run-2', 1, 'queued', 'static-render-snapshot', '{"intent":"d"}')`,
    ).run();

    const canceled = sched.cancelForRun('run-1');
    expect(canceled).toBe(2); // queued + running swept
    expect(status(db, 'q1')).toBe('timeout');
    expect(status(db, 'r1')).toBe('timeout');
    expect(status(db, 'p1')).toBe('passed'); // terminal untouched
    expect(status(db, 'q2')).toBe('queued'); // other run untouched
  });

  it('runRecovery re-drains orphaned leased/running rows to timeout on init', async () => {
    // Simulate rows stranded by a PRIOR process: leased + running, plus terminal
    // and queued rows that must be left as-is.
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, leased_at)
       VALUES ('leased1', 'run-1', 1, 'leased', 'native-desktop', '{"intent":"a"}', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('running1', 'run-1', 1, 'running', 'static-render-snapshot', '{"intent":"b"}')`,
    ).run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('queued1', 'run-1', 1, 'queued', 'static-render-snapshot', '{"intent":"c"}')`,
    ).run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
       VALUES ('passed1', 'run-1', 1, 'passed', 'static-render-snapshot', '{"intent":"d"}')`,
    ).run();

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });

    const drained = await sched.runRecovery();
    expect(drained).toBe(2); // leased + running
    expect(status(db, 'leased1')).toBe('timeout');
    expect(status(db, 'running1')).toBe('timeout');
    expect(status(db, 'queued1')).toBe('queued'); // a fresh queued row is still drainable
    expect(status(db, 'passed1')).toBe('passed'); // terminal untouched
    const row = db
      .prepare('SELECT error_message, ended_at FROM verification_requests WHERE id = ?')
      .get('leased1') as { error_message: string; ended_at: string };
    expect(row.error_message).toBe('orphaned by process restart');
    expect(row.ended_at).not.toBeNull();
    // Idempotent: a second pass finds nothing.
    expect(await sched.runRecovery()).toBe(0);
  });

  it('R4: runRecovery routes each orphan through the delivery chokepoint (onVerdict + terminal event), not a bare UPDATE', async () => {
    // Regression: pre-R4 runRecovery bulk-UPDATEd orphans to 'timeout' with NO
    // delivery — no onVerdict (so no lane write, no finding) and no terminal event,
    // leaving a parked orchestrated lane wedged after a restart. Now each orphan is
    // re-driven through markTerminalAndDeliver: onVerdict fires with status 'timeout'
    // (carrying the parsed input.taskRef for lane attribution) AND the terminal event
    // is emitted — exactly like a live timeout.
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, leased_at)
       VALUES ('orph1', 'run-1', 1, 'leased', 'static-render-snapshot', ?, ?)`,
    ).run(JSON.stringify({ intent: 'shows the button', taskRef: 'TASK-042' }), new Date().toISOString());

    const delivered: Array<{ status: string; taskRef?: string }> = [];
    const onVerdict: OnVerdict = async ({ status, input }) => {
      delivered.push({ status, taskRef: input?.taskRef });
    };
    const events: VerificationTerminalEvent[] = [];
    const listener = (e: VerificationTerminalEvent): void => {
      events.push(e);
    };
    verificationEvents.on(verificationChannel('run-1'), listener);

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
    });

    const drained = await sched.runRecovery();
    verificationEvents.removeListener(verificationChannel('run-1'), listener);

    expect(drained).toBe(1);
    expect(status(db, 'orph1')).toBe('timeout');
    // The chokepoint fired delivery with the terminal status + the parsed taskRef.
    expect(delivered).toEqual([{ status: 'timeout', taskRef: 'TASK-042' }]);
    // And the terminal event was emitted (the wake signal for a parked programmatic lane).
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('timeout');
    expect(events[0].taskRef).toBe('TASK-042');
  });

  it('getInstance throws before initialize; _resetForTesting clears it', () => {
    VerificationScheduler._resetForTesting();
    expect(() => VerificationScheduler.getInstance()).toThrow(/not been initialized/);
    expect(VerificationScheduler.tryGetInstance()).toBeNull();
    VerificationScheduler.initialize({
      db: dbAdapter(db),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
    });
    expect(VerificationScheduler.getInstance()).toBeInstanceOf(VerificationScheduler);
  });
});

describe('ResourceLeasePool', () => {
  it('tryAcquireOneOf grabs the first FREE candidate, null when all held', async () => {
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);

    const a = await pool.tryAcquireOneOf(['verify:port:1', 'verify:port:2']);
    expect(a?.name).toBe('verify:port:1');

    const b = await pool.tryAcquireOneOf(['verify:port:1', 'verify:port:2']);
    expect(b?.name).toBe('verify:port:2'); // 1 is held → next free

    const c = await pool.tryAcquireOneOf(['verify:port:1', 'verify:port:2']);
    expect(c).toBeNull(); // both held → pool exhausted, non-blocking

    a?.release();
    const d = await pool.tryAcquireOneOf(['verify:port:1', 'verify:port:2']);
    expect(d?.name).toBe('verify:port:1'); // freed slot reusable
  });

  it('release is idempotent', async () => {
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);
    const h = await pool.tryAcquire('verify:screen');
    expect(h?.name).toBe('verify:screen');
    h?.release();
    h?.release(); // no throw, no double-free
    expect(mutex.isLocked('verify:screen')).toBe(false);
  });

  it('noLease() is always available and a no-op to release', () => {
    const pool = new ResourceLeasePool(new Mutex());
    const h = pool.noLease();
    expect(h.name).toBeNull();
    expect(() => h.release()).not.toThrow();
  });
});
