/**
 * A9 queued-age correctness, the scheduler half: the §5.6 expiry sweep and its
 * fallback timer driven through VerificationScheduler.drain() over a real
 * (in-memory) verification_requests table. The pure math is covered in
 * queuedAgeDeadline.test.ts.
 *
 * Rows carry `enqueued_at` in the exact shape the column DEFAULT writes
 * (`CURRENT_TIMESTAMP`: UTC, unzoned), and every case runs under one zone east
 * and one west of UTC — the two directions the old local-time parse broke in
 * (east: every fresh row expired at its first drain; west: the ceiling could
 * not bite for hours). A UTC host would pass the old code.
 *
 * nudge() is stubbed so each drain pass is one the test drives explicitly: the
 * point is what a pass does at a given clock, not the loop that schedules it.
 *
 * Rows run on the verification-AGENT engine with a stub runner. A `native-desktop`
 * row additionally takes the count-1 `verify:screen` lease, which a test holds
 * externally to wedge it; a `static-render-snapshot` row needs only an agent
 * slot, so it always runs and keeps the pool making progress.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { VerificationScheduler, ResourceLeasePool } from '../verificationScheduler';
import { queuedAgeHardCapMs } from '../queuedAgeDeadline';
import { Mutex } from '../../../utils/mutex';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { VerificationAgentRunResult, VerificationAgentRunnerLike } from '../verificationAgentRunner';
import type {
  ResolvedVisualVerifyConfig,
  VerdictV1,
  VerificationType,
} from '../../../../../shared/types/visualVerification';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** workflow_runs (for the agent stamp) + the 095-level verification_requests table. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id                         INTEGER PRIMARY KEY,
      visual_verify_budget_calls INTEGER
    );
    CREATE TABLE workflow_runs (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER NOT NULL,
      verify_chain   TEXT,
      worktree_path  TEXT,
      agent_provider TEXT,
      model          TEXT,
      batch_id       TEXT
    );
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
      report_json      TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT,
      judge_calls_used INTEGER NOT NULL DEFAULT 0,
      failure_class         TEXT,
      failure_evidence_json TEXT,
      modality              TEXT,
      preflight_json        TEXT,
      setup_proof           INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO projects (id, visual_verify_budget_calls) VALUES (1, NULL)').run();
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
     VALUES ('run-1', 1, ?, '/live/worktree', 'claude', 'claude-sonnet-5')`,
  ).run(JSON.stringify(['agent']));
  return db;
}

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['x.png'],
  baselineUsed: false,
  model: 'fake',
};

const PASS_RESULT: VerificationAgentRunResult = {
  status: 'passed',
  verdict: PASS_VERDICT,
  fileNames: [],
  deployed: true,
  provisionMode: 'snapshot',
};

/** The shipped defaults (15-min ceiling included), enabled. */
const baseConfig: ResolvedVisualVerifyConfig = {
  ...VISUAL_VERIFY_DEFAULTS,
  enabled: true,
  devServerPorts: [5173, 3000],
  autoBootstrapRunbook: false,
};

/** A whole-second UTC instant, so the SQLite shape round-trips exactly. */
const BASE = Date.UTC(2026, 8, 24, 10, 0, 0);
const MIN = 60_000;

/** The exact shape SQLite's CURRENT_TIMESTAMP writes: "YYYY-MM-DD HH:MM:SS", UTC, unzoned. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** A runner whose deployments pass at once, unless `deploy` holds them open. */
function stubRunner(deploy?: () => Promise<void>): {
  runner: VerificationAgentRunnerLike;
  deployments: () => number;
} {
  let n = 0;
  return {
    runner: {
      run: async () => {
        n += 1;
        if (deploy) await deploy();
        return PASS_RESULT;
      },
    },
    deployments: () => n,
  };
}

/** A row that needs the count-1 screen lease (the native-screen modality). */
const SCREEN: VerificationType = 'native-desktop';
/** A row that needs only an agent slot, so it always runs. */
const FREE: VerificationType = 'static-render-snapshot';

let db: Database.Database;

/** Insert a QUEUED row; `enqueuedAt` omitted ⇒ the column DEFAULT (CURRENT_TIMESTAMP). */
function insertQueued(opts: { id: string; type: VerificationType; enqueuedAt?: string }): void {
  const deliverable = JSON.stringify({ intent: 'looks right', url: 'http://x' });
  if (opts.enqueuedAt === undefined) {
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
       VALUES (?, 'run-1', 1, 'queued', ?, ?, '[]', 0)`,
    ).run(opts.id, opts.type, deliverable);
    return;
  }
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
     VALUES (?, 'run-1', 1, 'queued', ?, ?, '[]', 0, ?)`,
  ).run(opts.id, opts.type, deliverable, opts.enqueuedAt);
}

function rowStatus(id: string): { status: string; error: string | null } {
  return db
    .prepare('SELECT status, error_message AS error FROM verification_requests WHERE id = ?')
    .get(id) as { status: string; error: string | null };
}

function makeScheduler(opts: {
  runner: VerificationAgentRunnerLike;
  ceilingMs?: number;
  leasePool?: ResourceLeasePool;
  now?: () => number;
}): VerificationScheduler {
  const sched = VerificationScheduler.initialize({
    db: dbAdapter(db),
    artifactsDirResolver: () => '/tmp/a',
    config: { ...baseConfig, ...(opts.ceilingMs !== undefined ? { queuedAgeCeilingMs: opts.ceilingMs } : {}) },
    leasePool: opts.leasePool ?? new ResourceLeasePool(new Mutex()),
    agentRunner: opts.runner,
    nativeCaptureProbe: async () => true,
    ...(opts.now ? { now: opts.now } : {}),
  });
  vi.spyOn(sched, 'nudge').mockImplementation(() => {});
  return sched;
}

beforeEach(() => {
  VerificationScheduler._resetForTesting();
  db = buildDb();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each([
  // [zone, getTimezoneOffset() on BASE: minutes WEST of UTC]
  ['Asia/Kolkata', -330],
  ['America/Los_Angeles', 420],
])('VerificationScheduler queued-age deadline (A9, TZ=%s)', (tz, offsetMin) => {
  const savedTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('the host really is off UTC here (guards every case below from passing vacuously)', () => {
    expect(new Date(BASE).getTimezoneOffset()).toBe(offsetMin);
  });

  it('does NOT expire a fresh row on its first drain (enqueued_at from the column DEFAULT, real clock)', async () => {
    const leasePool = new ResourceLeasePool(new Mutex());
    const held = await leasePool.tryAcquire('verify:screen');
    const sched = makeScheduler({ runner: stubRunner().runner, leasePool });
    insertQueued({ id: 'vr_fresh', type: SCREEN });
    await sched.drain();
    expect(rowStatus('vr_fresh')).toEqual({ status: 'queued', error: null });
    held?.release();
  });

  it('a wedged pool (no progress) still expires the row exactly one ceiling after enqueue', async () => {
    const leasePool = new ResourceLeasePool(new Mutex());
    const held = await leasePool.tryAcquire('verify:screen');
    let clock = BASE;
    const sched = makeScheduler({
      runner: stubRunner().runner,
      ceilingMs: 5_000,
      leasePool,
      now: () => clock,
    });
    insertQueued({ id: 'vr_wedged', type: SCREEN, enqueuedAt: sqliteUtc(BASE) });

    clock = BASE + 1_000;
    await sched.drain();
    expect(rowStatus('vr_wedged').status).toBe('queued');
    clock = BASE + 4_999;
    await sched.drain();
    expect(rowStatus('vr_wedged').status).toBe('queued');
    clock = BASE + 5_000;
    await sched.drain();
    expect(rowStatus('vr_wedged').status).toBe('skipped');
    expect(rowStatus('vr_wedged').error).toMatch(/queued-age deadline exceeded/);
    held?.release();
  });

  it('a row queued behind a long in-flight run is NOT expired at the pass boundary that frees its lease', async () => {
    let releaseLongRun!: () => void;
    const longRun = new Promise<void>((resolve) => {
      releaseLongRun = resolve;
    });
    let started = 0;
    const { runner, deployments } = stubRunner(async () => {
      started += 1;
      if (started === 1) await longRun;
    });
    let clock = BASE;
    const sched = makeScheduler({ runner, ceilingMs: 5_000, now: () => clock });
    insertQueued({ id: 'vr_long', type: SCREEN, enqueuedAt: sqliteUtc(BASE) });
    insertQueued({ id: 'vr_behind', type: SCREEN, enqueuedAt: sqliteUtc(BASE + 1_000) });

    clock = BASE + 1_000;
    const firstPass = sched.drain();
    await vi.waitFor(() => expect(deployments()).toBe(1));
    // The long run holds the only screen lease for a minute — twelve ceilings.
    clock = BASE + 60_000;
    releaseLongRun();
    await firstPass;
    expect(rowStatus('vr_long').status).toBe('passed');
    expect(rowStatus('vr_behind').status).toBe('queued');

    // The pass the release wakes: enqueue-anchored, vr_behind is 59 s old against a
    // 5 s ceiling and would be skipped here. Progress-anchored, it leases and runs.
    await sched.drain();
    expect(deployments()).toBe(2);
    expect(rowStatus('vr_behind').status).toBe('passed');
  });

  it('a row enqueued DURING a long in-flight run is NOT expired at the next pass boundary', async () => {
    let releaseLongRun!: () => void;
    const longRun = new Promise<void>((resolve) => {
      releaseLongRun = resolve;
    });
    let started = 0;
    const { runner, deployments } = stubRunner(async () => {
      started += 1;
      if (started === 1) await longRun;
    });
    let clock = BASE;
    const sched = makeScheduler({ runner, ceilingMs: 5_000, now: () => clock });
    insertQueued({ id: 'vr_long', type: SCREEN, enqueuedAt: sqliteUtc(BASE) });

    const firstPass = sched.drain();
    await vi.waitFor(() => expect(deployments()).toBe(1));
    // Arrives while the only screen lease is busy; the pass running now never saw it.
    clock = BASE + 2_000;
    insertQueued({ id: 'vr_during', type: SCREEN, enqueuedAt: sqliteUtc(clock) });
    clock = BASE + 60_000;
    releaseLongRun();
    await firstPass;
    expect(rowStatus('vr_during').status).toBe('queued');

    // Enqueue-anchored it is 58 s old against a 5 s ceiling here; progress-anchored it runs.
    await sched.drain();
    expect(deployments()).toBe(2);
    expect(rowStatus('vr_during').status).toBe('passed');
  });

  it("runRecovery's boot sweep leaves a fresh column-DEFAULT row queued (real clock)", async () => {
    const sched = makeScheduler({ runner: stubRunner().runner });
    insertQueued({ id: 'vr_boot_fresh', type: SCREEN });
    // East of UTC the local-time parse aged this row by the host offset and the boot
    // sweep skipped every queued row on every launch.
    await sched.runRecovery();
    expect(rowStatus('vr_boot_fresh')).toEqual({ status: 'queued', error: null });
  });

  it('the outer hard cap expires a row even while the pool keeps making progress', async () => {
    // vr_starved needs a screen lease held elsewhere the whole time; slot-only rows
    // keep draining alongside it, so every pass stamps progress.
    const ceilingMs = 30 * MIN;
    const hardCapMs = queuedAgeHardCapMs(ceilingMs); // 70 min
    const leasePool = new ResourceLeasePool(new Mutex());
    const held = await leasePool.tryAcquire('verify:screen');
    let clock = BASE;
    const sched = makeScheduler({ runner: stubRunner().runner, ceilingMs, leasePool, now: () => clock });
    insertQueued({ id: 'vr_starved', type: SCREEN, enqueuedAt: sqliteUtc(BASE) });

    for (const atMin of [20, 40, 60]) {
      clock = BASE + atMin * MIN;
      insertQueued({ id: `vr_free_${atMin}`, type: FREE, enqueuedAt: sqliteUtc(clock) });
      await sched.drain();
      expect(rowStatus(`vr_free_${atMin}`).status).toBe('passed');
      // At 40 and 60 min it is well past one ceiling from enqueue — progress keeps it.
      expect(rowStatus('vr_starved').status).toBe('queued');
    }

    clock = BASE + hardCapMs - 1_000;
    await sched.drain();
    expect(rowStatus('vr_starved').status).toBe('queued');
    // Progress at 60 min would carry it to 90; the cap from enqueue ends it at 70.
    clock = BASE + hardCapMs;
    await sched.drain();
    expect(rowStatus('vr_starved').status).toBe('skipped');
    expect(rowStatus('vr_starved').error).toMatch(/queued-age deadline exceeded .* within 70 min/);
    held?.release();
  });

  it('the fallback timer re-arms on the progress anchor, not on enqueue', async () => {
    const leasePool = new ResourceLeasePool(new Mutex());
    const held = await leasePool.tryAcquire('verify:screen');
    let clock = BASE;
    const sched = makeScheduler({ runner: stubRunner().runner, ceilingMs: 5_000, leasePool, now: () => clock });
    const nudge = vi.mocked(sched.nudge);
    insertQueued({ id: 'vr_waiting', type: SCREEN, enqueuedAt: sqliteUtc(BASE) });
    insertQueued({ id: 'vr_runs', type: FREE, enqueuedAt: sqliteUtc(BASE) });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock = BASE + 3_000;
    await sched.drain(); // vr_runs settles → progress at +3 s; vr_waiting stays queued
    expect(rowStatus('vr_runs').status).toBe('passed');
    expect(rowStatus('vr_waiting').status).toBe('queued');
    const nudgesAfterPass = nudge.mock.calls.length;

    // Enqueue-anchored the timer would fire 2 s from now; progress-anchored it waits 5 s.
    vi.advanceTimersByTime(4_999);
    expect(nudge.mock.calls.length).toBe(nudgesAfterPass);
    vi.advanceTimersByTime(1);
    expect(nudge.mock.calls.length).toBe(nudgesAfterPass + 1);
    held?.release();
  });
});
