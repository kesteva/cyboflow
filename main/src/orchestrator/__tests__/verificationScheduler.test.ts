/**
 * VerificationScheduler — drain loop, ResourceLeasePool contention, and lifecycle
 * tests against an in-memory SQLite DB with FAKE backends + a FAKE judge.
 *
 * Proves the collision doctrine (scarce resources serialize; lanes keep flowing):
 *   - happy path  queued → running → passed (capture + judge)
 *   - lease contention: a single-screen lease SERIALIZES two requests; a
 *     null-lease backend PARALLELIZES them
 *   - an empty / unavailable chain → 'skipped' (never failed)
 *   - cancelForRun terminates a run's outstanding requests
 *   - low-confidence demotion + capture-failure → 'failed'
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ResourceLeasePool,
  VerificationScheduler,
  VERIFY_SCREEN_LEASE,
  verificationEvents,
  verificationChannel,
  type OnVerdict,
  type VerificationTerminalEvent,
} from '../verify/verificationScheduler';
import { Mutex } from '../../utils/mutex';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type {
  CaptureContext,
  CaptureResult,
  VerdictV1,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
} from '../../../../shared/types/visualVerification';

const MIG_DIR = join(__dirname, '..', '..', 'database', 'migrations');
const THROUGH_048 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
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
  for (const f of THROUGH_048) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
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

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['shot.png'],
  baselineUsed: false,
  model: 'fake',
};

function fakeJudge(verdict: VerdictV1 = PASS_VERDICT): VlmJudge {
  return { judge: vi.fn(async () => verdict) };
}

/** A fake backend; lease + capture behavior is configurable. */
function fakeBackend(opts: {
  id: VisualBackendId;
  rung: number;
  lease: string | null;
  capture?: (ctx: CaptureContext, signal: AbortSignal) => Promise<CaptureResult>;
}): VisualBackend {
  return {
    id: opts.id,
    rung: opts.rung,
    requiredLease: () => opts.lease,
    healthCheck: async () => true,
    capture:
      opts.capture ??
      (async () => ({ ok: true, fileNames: ['shot.png'] }) satisfies CaptureResult),
  };
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

  it('drains a queued request through running → passed (capture + judge)', async () => {
    const judge = fakeJudge();
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
      judge,
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });

    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'header is centered' },
      chain: ['capturePage'],
    });
    expect(status(db, id)).toBe('queued');

    await flushDrain();

    expect(status(db, id)).toBe('passed');
    expect(judge.judge).toHaveBeenCalledOnce();
    const row = db
      .prepare('SELECT current_backend, verdict_json, ended_at FROM verification_requests WHERE id = ?')
      .get(id) as { current_backend: string; verdict_json: string; ended_at: string };
    expect(row.current_backend).toBe('capturePage');
    expect(JSON.parse(row.verdict_json).status).toBe('pass');
    expect(row.ended_at).not.toBeNull();
  });

  it('emits a VerificationTerminalEvent on the run channel for every terminal verdict', async () => {
    const events: VerificationTerminalEvent[] = [];
    const onEvent = (e: VerificationTerminalEvent): void => void events.push(e);
    verificationEvents.on(verificationChannel('run-1'), onEvent);
    try {
      const sched = VerificationScheduler.initialize({
        db: dbAdapter(db),
        backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
        judge: fakeJudge(),
        artifactsDirResolver: (runId) => `/tmp/${runId}`,
        leasePool: new ResourceLeasePool(new Mutex()),
      });
      const id = sched.enqueue({
        runId: 'run-1',
        projectId: 1,
        type: 'static-render-snapshot',
        input: { intent: 'header centered', taskRef: 'TASK-008' },
        chain: ['capturePage'],
      });
      await flushDrain();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: 'run-1',
        requestId: id,
        projectId: 1,
        status: 'passed',
        type: 'static-render-snapshot',
        taskRef: 'TASK-008',
      });
    } finally {
      verificationEvents.off(verificationChannel('run-1'), onEvent);
    }
  });

  it('emits a terminal event even for a SKIPPED request (no backend / empty chain)', async () => {
    const events: VerificationTerminalEvent[] = [];
    const onEvent = (e: VerificationTerminalEvent): void => void events.push(e);
    verificationEvents.on(verificationChannel('run-1'), onEvent);
    try {
      const sched = VerificationScheduler.initialize({
        db: dbAdapter(db),
        backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
        judge: fakeJudge(),
        artifactsDirResolver: (runId) => `/tmp/${runId}`,
        leasePool: new ResourceLeasePool(new Mutex()),
      });
      const id = sched.enqueue({
        runId: 'run-1',
        projectId: 1,
        type: 'static-render-snapshot',
        input: { intent: 'native only' },
        chain: [], // empty → skipped
      });
      await flushDrain();
      expect(status(db, id)).toBe('skipped');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ requestId: id, status: 'skipped' });
    } finally {
      verificationEvents.off(verificationChannel('run-1'), onEvent);
    }
  });

  it('picks the cheapest backend in the chain by rung', async () => {
    const cheap = fakeBackend({ id: 'capturePage', rung: 0, lease: null });
    const dear = fakeBackend({ id: 'peekaboo', rung: 2, lease: VERIFY_SCREEN_LEASE });
    const dearCapture = vi.spyOn(dear, 'capture');
    const cheapCapture = vi.spyOn(cheap, 'capture');
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: cheap, peekaboo: dear },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });

    sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage', 'peekaboo'],
    });
    await flushDrain();

    expect(cheapCapture).toHaveBeenCalledOnce();
    expect(dearCapture).not.toHaveBeenCalled();
  });

  it('SERIALIZES screen-lease captures but PARALLELIZES null-lease captures', async () => {
    // The shared mutex backs both leases; a private instance keeps the test isolated.
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);

    // ---- screen lease: two concurrent requests must NOT overlap ----
    let screenActive = 0;
    let screenMaxConcurrent = 0;
    const screenBackend = fakeBackend({
      id: 'peekaboo',
      rung: 2,
      lease: VERIFY_SCREEN_LEASE,
      capture: async () => {
        screenActive += 1;
        screenMaxConcurrent = Math.max(screenMaxConcurrent, screenActive);
        await new Promise((r) => setTimeout(r, 15));
        screenActive -= 1;
        return { ok: true, fileNames: ['s.png'] };
      },
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { peekaboo: screenBackend },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: pool,
    });

    const a = sched.enqueue({ runId: 'run-1', projectId: 1, type: 'native-desktop', input: { intent: 'a' }, chain: ['peekaboo'] });
    const b = sched.enqueue({ runId: 'run-1', projectId: 1, type: 'native-desktop', input: { intent: 'b' }, chain: ['peekaboo'] });

    // The screen lease lets exactly ONE of {A,B} run per drain; the other stays
    // queued and is picked up on a later nudge. Which goes first is a FIFO tie-break
    // on the random row id (both share an enqueued_at second), so the test must NOT
    // assume an A-then-B order — it pumps drains until both settle, then asserts the
    // physics invariant: both passed AND the captures never overlapped.
    for (let i = 0; i < 4 && (status(db, a) !== 'passed' || status(db, b) !== 'passed'); i++) {
      sched.nudge();
      await flushDrain();
      await new Promise((r) => setTimeout(r, 40));
      await flushDrain();
    }
    expect(status(db, a)).toBe('passed');
    expect(status(db, b)).toBe('passed');
    expect(screenMaxConcurrent).toBe(1); // never overlapped — physics serialized

    // ---- null lease: two concurrent requests MAY overlap ----
    let nullActive = 0;
    let nullMaxConcurrent = 0;
    const nullBackend = fakeBackend({
      id: 'capturePage',
      rung: 0,
      lease: null,
      capture: async () => {
        nullActive += 1;
        nullMaxConcurrent = Math.max(nullMaxConcurrent, nullActive);
        await new Promise((r) => setTimeout(r, 15));
        nullActive -= 1;
        return { ok: true, fileNames: ['n.png'] };
      },
    });
    VerificationScheduler._resetForTesting();
    const sched2 = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: nullBackend },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: pool,
    });
    const c = sched2.enqueue({ runId: 'run-1', projectId: 1, type: 'static-render-snapshot', input: { intent: 'c' }, chain: ['capturePage'] });
    const d = sched2.enqueue({ runId: 'run-1', projectId: 1, type: 'static-render-snapshot', input: { intent: 'd' }, chain: ['capturePage'] });
    await flushDrain();
    await new Promise((r) => setTimeout(r, 40));
    await flushDrain();
    expect(status(db, c)).toBe('passed');
    expect(status(db, d)).toBe('passed');
    expect(nullMaxConcurrent).toBe(2); // both ran concurrently — no lease held
  });

  it('marks a request SKIPPED when the chain is empty', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'native-desktop',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    expect(status(db, id)).toBe('skipped');
  });

  it('marks SKIPPED when no listed backend is present in the registry', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {}, // empty registry (MVP boot state)
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage', 'peekaboo'],
    });
    await flushDrain();
    expect(status(db, id)).toBe('skipped');
  });

  it('marks FAILED when capture produces no images', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {
        capturePage: fakeBackend({
          id: 'capturePage',
          rung: 0,
          lease: null,
          capture: async () => ({ ok: false, fileNames: [], error: 'blank render' }),
        }),
      },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();
    expect(status(db, id)).toBe('failed');
    const row = db.prepare('SELECT error_message FROM verification_requests WHERE id = ?').get(id) as {
      error_message: string;
    };
    expect(row.error_message).toBe('blank render');
  });

  it('demotes a low-confidence judge verdict to low_confidence', async () => {
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
      judge: fakeJudge({ ...PASS_VERDICT, status: 'pass', confidence: 0.3 }),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      config: {
        enabled: true,
        defaultType: 'static-render-snapshot',
        vlmConfidenceThreshold: 0.7,
        maxPerRunJudgeCalls: 4,
        devServerPorts: [],
        simulatorDevices: [],
      },
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();
    expect(status(db, id)).toBe('low_confidence');
  });

  it('cancelForRun terminates a run\'s outstanding queued requests', async () => {
    // No backend present so the request would normally drain to skipped — instead
    // cancel it BEFORE draining and assert it goes to timeout.
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge(),
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

  it('times out a slow capture: aborts the signal, marks timeout, releases the lease', async () => {
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);
    let sawAbort = false;
    // A backend that hangs until aborted, then resolves (abort-aware via signal).
    const slow = fakeBackend({
      id: 'peekaboo',
      rung: 2,
      lease: VERIFY_SCREEN_LEASE,
      capture: (_ctx, signal) =>
        new Promise<CaptureResult>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ ok: true, fileNames: ['late.png'] });
          });
        }),
    });
    const judge = fakeJudge();
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { peekaboo: slow },
      judge,
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: pool,
      requestTimeoutMs: 20, // tiny deadline
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'native-desktop',
      input: { intent: 'x' },
      chain: ['peekaboo'],
    });

    await flushDrain();
    // Wait past the 20ms deadline so the timer fires + the abort unwinds.
    await new Promise((r) => setTimeout(r, 60));
    await flushDrain();

    expect(sawAbort).toBe(true);
    expect(status(db, id)).toBe('timeout');
    // The judge must never have run (capture was aborted before producing usable PNGs).
    expect(judge.judge).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT error_message, ended_at FROM verification_requests WHERE id = ?')
      .get(id) as { error_message: string; ended_at: string };
    expect(row.error_message).toBe('request timed out');
    expect(row.ended_at).not.toBeNull();
    // The screen lease was released in finally → reacquirable.
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
  });

  it('cancelForRun aborts an in-flight capture and marks it timeout (lease released)', async () => {
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);
    let sawAbort = false;
    // A backend that hangs forever unless aborted (no timeout in this test — cancel drives it).
    const hanging = fakeBackend({
      id: 'peekaboo',
      rung: 2,
      lease: VERIFY_SCREEN_LEASE,
      capture: (_ctx, signal) =>
        new Promise<CaptureResult>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ ok: false, fileNames: [], error: 'aborted' });
          });
        }),
    });
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { peekaboo: hanging },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      leasePool: pool,
      requestTimeoutMs: 60_000, // long — cancel, not the deadline, ends it
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'native-desktop',
      input: { intent: 'x' },
      chain: ['peekaboo'],
    });

    // Let the drain lease + start the capture (now 'running', in-flight registered).
    await flushDrain();
    expect(status(db, id)).toBe('running');
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(true); // lease held by the in-flight capture

    const canceled = sched.cancelForRun('run-1');
    expect(canceled).toBe(1); // the running row was swept
    // Let the aborted capture unwind + release the lease.
    await flushDrain();

    expect(sawAbort).toBe(true);
    expect(status(db, id)).toBe('timeout');
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
  });

  it('cancelForRun cancels a mix of queued + running non-terminal rows, leaving terminal ones', async () => {
    // Insert rows directly so we control statuses precisely (no drain).
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge(),
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
      backends: {},
      judge: fakeJudge(),
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
      backends: {},
      judge: fakeJudge(),
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

  it('fires the onVerdict hook with the terminal outcome', async () => {
    const onVerdict = vi.fn<OnVerdict>(async () => {});
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend({ id: 'capturePage', rung: 0, lease: null }) },
      judge: fakeJudge(),
      artifactsDirResolver: (runId) => `/tmp/${runId}`,
      onVerdict,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
    const id = sched.enqueue({
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();
    expect(onVerdict).toHaveBeenCalledOnce();
    expect(onVerdict.mock.calls[0][0]).toMatchObject({
      requestId: id,
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      fileNames: ['shot.png'],
    });
  });

  it('getInstance throws before initialize; _resetForTesting clears it', () => {
    VerificationScheduler._resetForTesting();
    expect(() => VerificationScheduler.getInstance()).toThrow(/not been initialized/);
    expect(VerificationScheduler.tryGetInstance()).toBeNull();
    VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge(),
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
