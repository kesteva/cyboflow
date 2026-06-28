/**
 * VerificationScheduler — S2 dev-server-runner tests.
 *
 * Focus (per the S2 slice testPlan): the scheduler's dev-server seam in runChosen.
 * A FAKE DevServerProvider is injected; we assert the LOCKED lease ordering:
 *   acquire verify:port lease -> devServerProvider.spawn(leased port) ->
 *   ctx.input.url rewritten with handle.baseUrl -> backend.capture -> handle
 *   release() AND lease.release() both in the SAME finally, on success AND on a
 *   capture throw. The null-provider path (no start / rung-0 null lease) skips the
 *   spawn and captures the static target unchanged.
 *
 * The DB is a minimal in-memory verification_requests table (the only table the
 * scheduler touches) — no migration chain / FK needed. Backends + judge are
 * fakes; nothing real is spawned or rendered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VerificationScheduler,
  ResourceLeasePool,
  verifyPortLease,
  sprintVerifyBatchLease,
  BATCH_MUTEX_MAX_QUEUED_HOLDERS,
  type DevServerProvider,
  type DevServerHandle,
  type DevServerSpawnArgs,
} from '../verificationScheduler';
import { Mutex } from '../../../utils/mutex';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import {
  PlaywrightBackend,
  type BrowserFactory,
} from '../../../services/visualVerify/playwrightBackend';
import { PlaywrightInstaller } from '../../../services/visualVerify/playwrightInstaller';
import type {
  CaptureContext,
  CaptureResult,
  ResolvedVisualVerifyConfig,
  VerdictV1,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
} from '../../../../../shared/types/visualVerification';

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
      ended_at         DATETIME
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

const fakeJudge: VlmJudge = {
  judge: async () => PASS_VERDICT,
};

/**
 * A fake capture backend. Records the ctx it was handed (so a test can assert the
 * rewritten url) and can be configured to need a port lease (rung 1 w/ dev server)
 * or no lease (rung 0), and to throw.
 */
function fakeBackend(opts: {
  id?: VisualBackendId;
  rung?: number;
  lease: string | null;
  throwOnCapture?: boolean;
  sink: { ctx?: CaptureContext };
}): VisualBackend {
  return {
    id: opts.id ?? 'playwright',
    rung: opts.rung ?? 1,
    requiredLease: () => opts.lease,
    healthCheck: async () => true,
    capture: async (ctx: CaptureContext): Promise<CaptureResult> => {
      opts.sink.ctx = ctx;
      if (opts.throwOnCapture) throw new Error('capture boom');
      return { ok: true, fileNames: ['default.png'] };
    },
  };
}

const baseConfig: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [5173, 3000],
  simulatorDevices: [],
};

/** Insert one queued request and return its id. */
function enqueueRow(
  db: Database.Database,
  opts: { chain: VisualBackendId[]; url?: string; start?: string },
): string {
  const id = `vr_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
     VALUES (?, 'run-1', 1, 'queued', 'static-render-snapshot', ?, ?, 0)`,
  ).run(
    id,
    JSON.stringify({
      intent: 'looks right',
      url: opts.url ?? 'http://placeholder',
      // `start` is the signal PlaywrightBackend.requiredLease keys off (hydrated from
      // the deliverable). Only stamped when the test declares one.
      ...(opts.start ? { start: opts.start } : {}),
    }),
    JSON.stringify(opts.chain),
  );
  return id;
}

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

describe('VerificationScheduler — dev-server seam (S2)', () => {
  it('acquires the port lease BEFORE spawning, and spawns with that leased port', async () => {
    const calls: { spawnArgs?: DevServerSpawnArgs; leaseHeldAtSpawn?: boolean } = {};
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);

    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        calls.spawnArgs = args;
        // The port lease must already be held by the time spawn runs.
        calls.leaseHeldAtSpawn = mutex.isLocked(verifyPortLease(args.port));
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };

    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/artifacts/runs/run-1',
      config: baseConfig,
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/worktree',
        deliverable: { id: 'web', start: 'npm run dev -- --port ${PORT}' },
      }),
    });

    enqueueRow(db, { chain: ['playwright'], start: 'npm run dev' });
    await sched.drain();

    expect(calls.spawnArgs).toBeDefined();
    expect(calls.spawnArgs?.port).toBe(5173);
    expect(calls.spawnArgs?.cwd).toBe('/tmp/worktree');
    expect(calls.spawnArgs?.config.start).toBe('npm run dev -- --port ${PORT}');
    expect(calls.leaseHeldAtSpawn).toBe(true);
  });

  it('rewrites ctx.input.url with the dev-server baseUrl before capture', async () => {
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => ({
        baseUrl: `http://localhost:${args.port}/app`,
        release: async () => {},
      }),
    };
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'serve' },
      }),
    });

    enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    // The backend saw the spawned baseUrl, NOT the placeholder url in the request.
    expect(sink.ctx?.input.url).toBe('http://localhost:5173/app');
  });

  it('releases the dev-server handle AND the port lease in finally on SUCCESS', async () => {
    let released = 0;
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => ({
        baseUrl: `http://localhost:${args.port}`,
        release: async () => {
          released += 1;
        },
      }),
    };
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'serve' },
      }),
    });

    const id = enqueueRow(db, { chain: ['playwright'] });
    await sched.drain();

    expect(rowStatus(db, id).status).toBe('passed');
    expect(released).toBe(1); // dev server torn down
    // The port lease is free again (released in finally).
    expect(mutex.isLocked(verifyPortLease(5173))).toBe(false);
  });

  it('releases the dev-server handle AND the port lease in finally on a CAPTURE THROW', async () => {
    let released = 0;
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => ({
        baseUrl: `http://localhost:${args.port}`,
        release: async () => {
          released += 1;
        },
      }),
    };
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', throwOnCapture: true, sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'serve' },
      }),
    });

    const id = enqueueRow(db, { chain: ['playwright'] });
    await sched.drain();

    expect(rowStatus(db, id).status).toBe('failed'); // capture threw → failed
    expect(released).toBe(1); // dev server STILL torn down (finally)
    expect(mutex.isLocked(verifyPortLease(5173))).toBe(false); // lease STILL released
  });

  it('does NOT spawn a dev server when the deliverable has no start command', async () => {
    const spawnSpy = vi.fn();
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawnSpy();
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      devServerProvider: provider,
      // deliverable WITHOUT a start command → no dev server.
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'static', url: 'http://placeholder' },
      }),
    });

    enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    expect(spawnSpy).not.toHaveBeenCalled();
    // Static target preserved (no rewrite happened).
    expect(sink.ctx?.input.url).toBe('http://placeholder');
  });

  it('does NOT spawn a dev server for a rung-0 (null) lease backend', async () => {
    const spawnSpy = vi.fn();
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawnSpy();
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const sink: { ctx?: CaptureContext } = {};
    // capturePage-style backend: no lease.
    const backend = fakeBackend({ id: 'capturePage', rung: 0, lease: null, sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'serve' },
      }),
    });

    enqueueRow(db, { chain: ['capturePage'], url: 'http://placeholder' });
    await sched.drain();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(sink.ctx?.input.url).toBe('http://placeholder');
  });

  it('does NOT spawn when no devServerProvider is injected (static-capture deployment)', async () => {
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      // no devServerProvider / devServerContextResolver
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    expect(rowStatus(db, id).status).toBe('passed');
    expect(sink.ctx?.input.url).toBe('http://placeholder'); // unchanged
  });

  it('SKIPS the VLM and delivers the deterministic verdict when the backend sets one (S3)', async () => {
    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };
    // A backend that returns its OWN deterministic verdict (the Playwright a11y gate).
    const detVerdict: VerdictV1 = {
      status: 'fail',
      confidence: 1,
      issues: [{ severity: 'high', description: 'interaction target missing' }],
      feedback: 'interaction 0 (click "#gone") failed',
      judgedFileNames: ['default.png'],
      baselineUsed: false,
      model: 'playwright-deterministic',
    };
    const deterministicBackend: VisualBackend = {
      id: 'playwright',
      rung: 1,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async () => ({
        ok: true,
        fileNames: ['default.png'],
        deterministicVerdict: detVerdict,
      }),
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: deterministicBackend },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    // The VLM was NOT called (deterministic verdict short-circuited it)...
    expect(judgeCalls).toBe(0);
    // ...and the deterministic FAIL drove the terminal status + verdict_json.
    const row = db
      .prepare('SELECT status, verdict_json FROM verification_requests WHERE id = ?')
      .get(id) as { status: string; verdict_json: string | null };
    expect(row.status).toBe('failed');
    expect(row.verdict_json).not.toBeNull();
    const stored = JSON.parse(row.verdict_json as string) as VerdictV1;
    expect(stored.model).toBe('playwright-deterministic');
    expect(stored.feedback).toMatch(/#gone/);
  });

  it('runs the VLM as before when the backend sets NO deterministic verdict (S3)', async () => {
    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };
    // A backend that returns NO deterministic verdict (capturePage / undeclared assertions).
    const plainBackend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async () => ({ ok: true, fileNames: ['default.png'] }),
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: plainBackend },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = enqueueRow(db, { chain: ['capturePage'], url: 'http://placeholder' });
    await sched.drain();

    // The VLM ran exactly once and its PASS drove the terminal status.
    expect(judgeCalls).toBe(1);
    expect(rowStatus(db, id).status).toBe('passed');
  });

  it('marks the request failed (and releases the lease) when the dev-server spawn rejects', async () => {
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (): Promise<DevServerHandle> => {
        throw new Error('dev server not ready within 60000ms');
      },
    };
    const sink: { ctx?: CaptureContext } = {};
    const backend = fakeBackend({ lease: 'verify:port:5173', sink });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'serve' },
      }),
    });

    const id = enqueueRow(db, { chain: ['playwright'] });
    await sched.drain();

    // spawn rejected → runChosen catch → failed; the backend never captured.
    expect(rowStatus(db, id).status).toBe('failed');
    expect(sink.ctx).toBeUndefined();
    expect(mutex.isLocked(verifyPortLease(5173))).toBe(false); // lease released
  });
});

// ---------------------------------------------------------------------------
// MAJOR regression: route the REAL PlaywrightBackend.requiredLease through the
// scheduler. The S2 tests above use a fakeBackend returning a concrete
// 'verify:port:5173', so they never covered the real backend's lease seam. The real
// backend returns the VERIFY_PORT_ANY sentinel ("any free pooled port"); the
// scheduler must take a REAL configured port (never the old phantom 'verify:port:0'
// slot that defeated the concurrency cap and yielded port 0 under contention).
// ---------------------------------------------------------------------------

/** An installer that reports chromium present without spawning npx (no real binary). */
function presentInstaller(): PlaywrightInstaller {
  return new PlaywrightInstaller({
    executablePath: () => '/fake/chromium',
    pathExists: () => true,
    runInstall: async () => true,
  });
}

/** A minimal fake browser the real PlaywrightBackend can drive (no real launch). */
function fakeBrowserFactory(): BrowserFactory {
  const ONE_PX_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const fakeBrowser = {
    async newContext() {
      return {
        async newPage() {
          return {
            setDefaultTimeout(): void {},
            setDefaultNavigationTimeout(): void {},
            on(): void {},
            async goto() {
              return { ok: () => true, status: () => 200 };
            },
            async screenshot(): Promise<Buffer> {
              return ONE_PX_PNG;
            },
          };
        },
        async close(): Promise<void> {},
      };
    },
    async close(): Promise<void> {},
  };
  // The narrow slice the backend uses; the cast is confined to this test seam.
  return async () => fakeBrowser as unknown as Awaited<ReturnType<BrowserFactory>>;
}

describe('VerificationScheduler — REAL PlaywrightBackend lease seam (S3 MAJOR)', () => {
  let artifactsDir: string;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-sched-pw-'));
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('start present → takes a REAL pooled port (never port 0) and spawns the dev server on it', async () => {
    const calls: { spawnPort?: number } = {};
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        calls.spawnPort = args.port;
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig, // devServerPorts: [5173, 3000]
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'npm run dev -- --port ${PORT}' },
      }),
    });

    const id = enqueueRow(db, { chain: ['playwright'], start: 'npm run dev' });
    await sched.drain();

    // A REAL pooled port was taken (the first free configured one), NEVER 0.
    expect(calls.spawnPort).toBe(5173);
    expect(calls.spawnPort).not.toBe(0);
    expect(rowStatus(db, id).status).toBe('passed');
    // The phantom 'verify:port:0' slot never existed: only real pool members lock.
    expect(mutex.isLocked('verify:port:0')).toBe(false);
    expect(mutex.isLocked(verifyPortLease(5173))).toBe(false); // released in finally
  });

  it('pool exhausted → the request stays queued (no phantom always-free slot acquired)', async () => {
    let spawned = 0;
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawned += 1;
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    // Hold BOTH configured pool ports so the pool is fully exhausted.
    const held5173 = await mutex.acquire(verifyPortLease(5173));
    const held3000 = await mutex.acquire(verifyPortLease(3000));

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool,
      devServerProvider: provider,
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'npm run dev -- --port ${PORT}' },
      }),
    });

    const id = enqueueRow(db, { chain: ['playwright'], start: 'npm run dev' });
    await sched.drain();

    // No phantom slot was acquired: nothing spawned, request left queued (not failed).
    expect(spawned).toBe(0);
    expect(mutex.isLocked('verify:port:0')).toBe(false);
    expect(rowStatus(db, id).status).toBe('queued');

    held5173();
    held3000();
  });
});

// ---------------------------------------------------------------------------
// L4 — batch worktree-sync mutex (sprint-verify-<batchId>) (S5)
//
// For a verification operating on a BATCHED run the scheduler acquires a count-1
// `sprint-verify-<batchId>` mutex AFTER the dev-server/port lease and BEFORE
// backend.capture, and releases it in the SAME finally as the other leases. It
// is a serialization point per batchId (two concurrent batched captures on the
// same batchId serialize; different batchIds do not). A non-batch run (null
// batch_id) acquires NO batch mutex. batch_id is read from workflow_runs via the
// injected DatabaseLike, so these tests add that table.
// ---------------------------------------------------------------------------

/** A DB with verification_requests AND a minimal workflow_runs(id, batch_id). */
function buildDbWithRuns(): Database.Database {
  const db = buildDb();
  db.exec(`
    CREATE TABLE workflow_runs (
      id        TEXT PRIMARY KEY,
      batch_id  TEXT
    );
  `);
  return db;
}

/** Register a run row with the given batch_id (null = non-batch run). */
function insertRun(db: Database.Database, runId: string, batchId: string | null): void {
  db.prepare('INSERT INTO workflow_runs (id, batch_id) VALUES (?, ?)').run(runId, batchId);
}

/** Insert one queued request for a specific run id (default fixtures use 'run-1'). */
function enqueueRowForRun(
  db: Database.Database,
  runId: string,
  opts: { chain: VisualBackendId[]; url?: string },
): string {
  const id = `vr_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
     VALUES (?, ?, 1, 'queued', 'static-render-snapshot', ?, ?, 0)`,
  ).run(
    id,
    runId,
    JSON.stringify({ intent: 'looks right', url: opts.url ?? 'http://placeholder' }),
    JSON.stringify(opts.chain),
  );
  return id;
}

describe('VerificationScheduler — batch worktree-sync mutex (S5 / L4)', () => {
  it('a BATCHED run acquires sprint-verify-<batchId> before capture and releases it in finally on SUCCESS', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-b', 'batch-XYZ');

    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const sink: { ctx?: CaptureContext } = {};
    let heldDuringCapture = false;
    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (ctx): Promise<CaptureResult> => {
        sink.ctx = ctx;
        // The batch mutex must be held by the time capture runs.
        heldDuringCapture = mutex.isLocked(sprintVerifyBatchLease('batch-XYZ'));
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    const id = enqueueRowForRun(dbR, 'run-b', { chain: ['capturePage'] });
    await sched.drain();

    expect(rowStatus(dbR, id).status).toBe('passed');
    expect(heldDuringCapture).toBe(true); // mutex held during capture
    // Released in finally — the batch lease is free again.
    expect(mutex.isLocked(sprintVerifyBatchLease('batch-XYZ'))).toBe(false);

    dbR.close();
  });

  it('a BATCHED run releases sprint-verify-<batchId> in finally on a CAPTURE THROW', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-b', 'batch-THROW');

    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (): Promise<CaptureResult> => {
        throw new Error('capture boom');
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    const id = enqueueRowForRun(dbR, 'run-b', { chain: ['capturePage'] });
    await sched.drain();

    expect(rowStatus(dbR, id).status).toBe('failed');
    // STILL released in finally despite the throw.
    expect(mutex.isLocked(sprintVerifyBatchLease('batch-THROW'))).toBe(false);

    dbR.close();
  });

  it('a NON-batch run (null batch_id) acquires NO batch mutex', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-solo', null);

    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    let lockedNames: string[] = [];
    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (): Promise<CaptureResult> => {
        lockedNames = mutex.getLockedResources();
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    const id = enqueueRowForRun(dbR, 'run-solo', { chain: ['capturePage'] });
    await sched.drain();

    expect(rowStatus(dbR, id).status).toBe('passed');
    // No sprint-verify-* lease was ever held during the capture.
    expect(lockedNames.some((n) => n.startsWith('sprint-verify-'))).toBe(false);

    dbR.close();
  });

  it('two concurrent BATCHED captures on the SAME batchId serialize (the second waits for the first)', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-a', 'batch-SAME');
    insertRun(dbR, 'run-c', 'batch-SAME');

    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);

    // Gate the FIRST capture so it holds the batch mutex until we release it; record
    // the order captures actually begin to prove the second waited.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;

    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (ctx): Promise<CaptureResult> => {
        order.push(`start:${ctx.runId}`);
        if (!firstStarted) {
          firstStarted = true;
          await firstGate; // hold the batch mutex (first capture) until released
        }
        order.push(`end:${ctx.runId}`);
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    enqueueRowForRun(dbR, 'run-a', { chain: ['capturePage'] });
    enqueueRowForRun(dbR, 'run-c', { chain: ['capturePage'] });

    const drainP = sched.drain();
    // Let the first capture start and PARK on the batch mutex for the second.
    await new Promise((r) => setTimeout(r, 30));
    // Only ONE capture has started; the second is blocked on the batch mutex.
    expect(order.filter((e) => e.startsWith('start:')).length).toBe(1);

    releaseFirst();
    await drainP;

    // The first fully finished BEFORE the second started → strict serialization:
    // start, end, start, end (NOT start, start, ... which would mean both ran at once).
    expect(order[0]).toMatch(/^start:/);
    expect(order[1]).toMatch(/^end:/);
    expect(order[2]).toMatch(/^start:/);
    expect(order[3]).toMatch(/^end:/);
    // The two captures belonged to the two different runs (both lanes verified).
    expect(new Set(order.map((e) => e.split(':')[1]))).toEqual(new Set(['run-a', 'run-c']));

    dbR.close();
  });

  it('a second batched capture whose holder runs LONGER than the Mutex default timeout still SERIALIZES and PASSES (not failed)', async () => {
    // REGRESSION (S5 major): a holder legitimately holds sprint-verify-<batchId> for
    // the WHOLE capture+judge lifetime (up to requestTimeoutMs, default 5 min). If the
    // scheduler's blocking acquire reused the Mutex 30s DEFAULT timeout, a second
    // concurrent capture on the same batchId whose wait exceeds that default would
    // throw 'Mutex timeout' and be marked 'failed' — the EXACT opposite of the
    // serialize-don't-fail guarantee. We prove the scheduler passes an explicit
    // timeout that overrides the default by shrinking the Mutex default to a tiny
    // value, holding the first capture LONGER than it, and asserting the second still
    // waits and PASSES.
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-a', 'batch-LONG');
    insertRun(dbR, 'run-c', 'batch-LONG');

    // A Mutex whose DEFAULT acquire timeout is tiny (20ms). If acquireBatchMutex relied
    // on the default, the second capture (held ~80ms behind the first) would throw.
    const TINY_DEFAULT_MS = 20;
    const mutex = new Mutex();
    (mutex as unknown as { defaultTimeout: number }).defaultTimeout = TINY_DEFAULT_MS;
    const leasePool = new ResourceLeasePool(mutex);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;

    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (ctx): Promise<CaptureResult> => {
        order.push(`start:${ctx.runId}`);
        if (!firstStarted) {
          firstStarted = true;
          await firstGate; // hold the batch mutex well past TINY_DEFAULT_MS
        }
        order.push(`end:${ctx.runId}`);
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
      // requestTimeoutMs * BATCH_MUTEX_MAX_QUEUED_HOLDERS is the acquire bound. Keep
      // requestTimeoutMs comfortably above the hold duration so the per-request
      // deadline never fires, isolating the acquire-timeout behavior under test.
      requestTimeoutMs: 5000,
    });

    const idA = enqueueRowForRun(dbR, 'run-a', { chain: ['capturePage'] });
    const idC = enqueueRowForRun(dbR, 'run-c', { chain: ['capturePage'] });

    const drainP = sched.drain();
    // Wait LONGER than the tiny Mutex default so a default-timeout acquire would have
    // already thrown for the second capture by now.
    await new Promise((r) => setTimeout(r, TINY_DEFAULT_MS * 4));
    // Only the first capture has started; the second is still WAITING (not thrown).
    expect(order.filter((e) => e.startsWith('start:')).length).toBe(1);

    releaseFirst();
    await drainP;

    // Both serialized and BOTH PASSED — neither was spuriously marked 'failed'.
    expect(rowStatus(dbR, idA).status).toBe('passed');
    expect(rowStatus(dbR, idC).status).toBe('passed');
    // Strict serialization order: start, end, start, end.
    expect(order[0]).toMatch(/^start:/);
    expect(order[1]).toMatch(/^end:/);
    expect(order[2]).toMatch(/^start:/);
    expect(order[3]).toMatch(/^end:/);

    dbR.close();
  });

  it('acquires the batch mutex with an explicit timeout sized to requestTimeoutMs (never the 30s default)', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-b', 'batch-TO');

    const mutex = new Mutex();
    const acquireSpy = vi.spyOn(mutex, 'acquire');
    const leasePool = new ResourceLeasePool(mutex);
    const requestTimeoutMs = 5000;

    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (): Promise<CaptureResult> => ({ ok: true, fileNames: ['default.png'] }),
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
      requestTimeoutMs,
    });

    const id = enqueueRowForRun(dbR, 'run-b', { chain: ['capturePage'] });
    await sched.drain();

    expect(rowStatus(dbR, id).status).toBe('passed');
    // The batch mutex acquire was given an EXPLICIT timeout = requestTimeoutMs *
    // BATCH_MUTEX_MAX_QUEUED_HOLDERS, far above the Mutex 30s default (so a legitimate
    // long holder never trips a spurious 'Mutex timeout').
    const batchCall = acquireSpy.mock.calls.find(
      ([name]) => name === sprintVerifyBatchLease('batch-TO'),
    );
    expect(batchCall).toBeDefined();
    expect(batchCall?.[1]).toBe(requestTimeoutMs * BATCH_MUTEX_MAX_QUEUED_HOLDERS);
    expect(batchCall?.[1]).toBeGreaterThan(30000);

    dbR.close();
  });

  it('two concurrent captures on DIFFERENT batchIds do NOT serialize against each other', async () => {
    const dbR = buildDbWithRuns();
    insertRun(dbR, 'run-a', 'batch-A');
    insertRun(dbR, 'run-c', 'batch-C');

    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);

    // Both captures park on the SAME gate; if they truly run in parallel both will be
    // started before either is released. If the batch mutex (wrongly) serialized
    // different batchIds, only one would have started.
    let started = 0;
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (): Promise<CaptureResult> => {
        started += 1;
        if (started === 2) resolveBothStarted();
        await gate;
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbR),
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    enqueueRowForRun(dbR, 'run-a', { chain: ['capturePage'] });
    enqueueRowForRun(dbR, 'run-c', { chain: ['capturePage'] });

    const drainP = sched.drain();
    // Both captures must reach the gate concurrently (no cross-batch serialization).
    await bothStarted;
    expect(started).toBe(2);

    releaseGate();
    await drainP;

    dbR.close();
  });

  it('a missing workflow_runs row / table degrades to a non-batch run (no batch mutex)', async () => {
    // Use the plain buildDb() (NO workflow_runs table at all): the batch_id lookup
    // must fail-soft to "no batch", preserving the byte-identical single-run path.
    const sink: { ctx?: CaptureContext } = {};
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    let lockedNames: string[] = [];
    const backend: VisualBackend = {
      id: 'capturePage',
      rung: 0,
      requiredLease: () => null,
      healthCheck: async () => true,
      capture: async (ctx): Promise<CaptureResult> => {
        sink.ctx = ctx;
        lockedNames = mutex.getLockedResources();
        return { ok: true, fileNames: ['default.png'] };
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db), // the module-level `db` from buildDb() — no workflow_runs
      backends: { capturePage: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      leasePool,
    });

    const id = enqueueRow(db, { chain: ['capturePage'] });
    await sched.drain();

    expect(rowStatus(db, id).status).toBe('passed');
    expect(lockedNames.some((n) => n.startsWith('sprint-verify-'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S5 — golden-baseline SSIM pre-diff + per-project judge budget enforcement
//
// The DETERMINISTIC-FIRST order now inserts an SSIM pre-diff (injected
// baselinePreDiff) BEFORE the VLM: a match >= threshold is a cheap PASS
// (verdictSource:'ssim_match', no judge call); below it the resolved baselinePath is
// threaded into the judge. The per-project budget (projects.visual_verify_budget_calls
// + SUM(verification_requests.judge_calls_used)) is enforced before a VLM call:
// exhausted ⇒ a non-blocking low_confidence verdict (no judge call), else a real call
// increments judge_calls_used. These tests add a projects table for the budget read.
// ---------------------------------------------------------------------------

/** A DB with verification_requests AND projects (budget cap + telemetry counter). */
function buildDbWithProjects(): Database.Database {
  const dbP = buildDb();
  dbP.exec(`
    ALTER TABLE verification_requests ADD COLUMN judge_calls_used INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      visual_verify_budget_calls INTEGER
    );
    INSERT INTO projects (id, visual_verify_budget_calls) VALUES (1, NULL);
  `);
  return dbP;
}

/** Insert one queued request with a baselineKey on the deliverable. */
function enqueueRowWithBaseline(
  dbX: Database.Database,
  opts: { chain: VisualBackendId[]; baselineKey: string },
): string {
  const id = `vr_${Math.random().toString(36).slice(2)}`;
  dbX.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
     VALUES (?, 'run-1', 1, 'queued', 'static-render-snapshot', ?, ?, 0)`,
  ).run(
    id,
    JSON.stringify({ intent: 'looks right', url: 'http://placeholder', baselineKey: opts.baselineKey }),
    JSON.stringify(opts.chain),
  );
  return id;
}

const plainCapturePage: VisualBackend = {
  id: 'capturePage',
  rung: 0,
  requiredLease: () => null,
  healthCheck: async () => true,
  capture: async () => ({ ok: true, fileNames: ['default.png'] }),
};

describe('VerificationScheduler — SSIM pre-diff gates the VLM (S5)', () => {
  it('an SSIM match >= threshold returns PASS (verdictSource ssim_match) with NO judge call', async () => {
    const dbP = buildDbWithProjects();
    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      baselineMatchThreshold: 0.98,
      baselinePreDiff: async () => ({ baselinePath: '/b/default.png', ssimScore: 0.995, match: true }),
    });

    const id = enqueueRowWithBaseline(dbP, { chain: ['capturePage'], baselineKey: 'home' });
    await sched.drain();

    expect(judgeCalls).toBe(0); // SSIM short-circuited the VLM
    const row = dbP
      .prepare('SELECT status, verdict_json, judge_calls_used FROM verification_requests WHERE id = ?')
      .get(id) as { status: string; verdict_json: string | null; judge_calls_used: number };
    expect(row.status).toBe('passed');
    expect(row.judge_calls_used).toBe(0);
    const verdict = JSON.parse(row.verdict_json as string) as VerdictV1;
    expect(verdict.verdictSource).toBe('ssim_match');
    expect(verdict.ssimScore).toBeCloseTo(0.995, 5);
    expect(verdict.baselineUsed).toBe(true);
    dbP.close();
  });

  it('below threshold passes the resolved baselinePath to the judge (verdictSource vlm_verdict)', async () => {
    const dbP = buildDbWithProjects();
    let seenBaselinePath: string | undefined;
    const probingJudge: VlmJudge = {
      judge: async (args) => {
        seenBaselinePath = args.baselinePath;
        return PASS_VERDICT;
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: probingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      baselineMatchThreshold: 0.98,
      // ssimScore below the threshold → fall through to the VLM with the baseline.
      baselinePreDiff: async () => ({ baselinePath: '/b/default.png', ssimScore: 0.5, match: false }),
    });

    const id = enqueueRowWithBaseline(dbP, { chain: ['capturePage'], baselineKey: 'home' });
    await sched.drain();

    expect(seenBaselinePath).toBe('/b/default.png');
    const row = dbP
      .prepare('SELECT status, verdict_json, judge_calls_used FROM verification_requests WHERE id = ?')
      .get(id) as { status: string; verdict_json: string | null; judge_calls_used: number };
    expect(row.status).toBe('passed');
    expect(row.judge_calls_used).toBe(1); // a real VLM call was made + counted
    const verdict = JSON.parse(row.verdict_json as string) as VerdictV1;
    expect(verdict.verdictSource).toBe('vlm_verdict');
    expect(verdict.ssimScore).toBeCloseTo(0.5, 5); // telemetry: the below-threshold score
    dbP.close();
  });

  it('runs the VLM with no baselinePath when there is no baselineKey / pre-diff result', async () => {
    const dbP = buildDbWithProjects();
    let seenBaselinePath: string | undefined = 'sentinel';
    const probingJudge: VlmJudge = {
      judge: async (args) => {
        seenBaselinePath = args.baselinePath;
        return PASS_VERDICT;
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: probingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
      // pre-diff resolver returns null (no accepted baseline).
      baselinePreDiff: async () => null,
    });

    const id = enqueueRowWithBaseline(dbP, { chain: ['capturePage'], baselineKey: 'home' });
    await sched.drain();

    expect(seenBaselinePath).toBeUndefined();
    const verdict = JSON.parse(
      (dbP.prepare('SELECT verdict_json FROM verification_requests WHERE id = ?').get(id) as { verdict_json: string })
        .verdict_json,
    ) as VerdictV1;
    expect(verdict.verdictSource).toBe('vlm_verdict');
    expect(verdict.ssimScore).toBeUndefined(); // no baseline compared
    dbP.close();
  });
});

describe('VerificationScheduler — per-project judge budget (S5)', () => {
  it('budget exhausted → non-blocking low_confidence finding, NOT FAIL, no judge call', async () => {
    const dbP = buildDbWithProjects();
    // Budget = 2; already spent 2 across prior requests.
    dbP.prepare('UPDATE projects SET visual_verify_budget_calls = 2 WHERE id = 1').run();
    dbP.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_prior', 'run-0', 1, 'passed', 'static-render-snapshot', '{"intent":"x"}', 2)`,
    ).run();

    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = enqueueRow(dbP, { chain: ['capturePage'], url: 'http://placeholder' });
    await sched.drain();

    expect(judgeCalls).toBe(0); // budget gate skipped the VLM
    const row = dbP
      .prepare('SELECT status, verdict_json, judge_calls_used FROM verification_requests WHERE id = ?')
      .get(id) as { status: string; verdict_json: string | null; judge_calls_used: number };
    // NOT failed, NOT a fabricated pass — a non-blocking low_confidence verdict.
    expect(row.status).toBe('low_confidence');
    expect(row.judge_calls_used).toBe(0);
    const verdict = JSON.parse(row.verdict_json as string) as VerdictV1;
    expect(verdict.status).toBe('low_confidence');
    expect(verdict.model).toBe('budget-exhausted');
    dbP.close();
  });

  it('within budget → a real VLM call increments judge_calls_used', async () => {
    const dbP = buildDbWithProjects();
    dbP.prepare('UPDATE projects SET visual_verify_budget_calls = 5 WHERE id = 1').run();

    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = enqueueRow(dbP, { chain: ['capturePage'], url: 'http://placeholder' });
    await sched.drain();

    expect(judgeCalls).toBe(1);
    const row = dbP
      .prepare('SELECT status, judge_calls_used FROM verification_requests WHERE id = ?')
      .get(id) as { status: string; judge_calls_used: number };
    expect(row.status).toBe('passed');
    expect(row.judge_calls_used).toBe(1);
    dbP.close();
  });

  it('a NULL budget (unlimited) never skips the VLM', async () => {
    const dbP = buildDbWithProjects(); // projects.id=1 budget is NULL
    let judgeCalls = 0;
    const countingJudge: VlmJudge = {
      judge: async () => {
        judgeCalls += 1;
        return PASS_VERDICT;
      },
    };
    const sched = VerificationScheduler.initialize({
      db: dbAdapter(dbP),
      backends: { capturePage: plainCapturePage },
      judge: countingJudge,
      artifactsDirResolver: () => '/tmp/a',
      config: baseConfig,
    });

    const id = enqueueRow(dbP, { chain: ['capturePage'], url: 'http://placeholder' });
    await sched.drain();

    expect(judgeCalls).toBe(1);
    expect(rowStatus(dbP, id).status).toBe('passed');
    dbP.close();
  });
});

// ---------------------------------------------------------------------------
// S8 — hydrate VerificationRequestInput (start/assertions) from verify.json
// BEFORE lease selection so the dev-server + Playwright path fires end-to-end.
//
// ROOT CAUSE this slice fixes: PlaywrightBackend.requiredLease(input) returns a
// verify:port lease ONLY when input.start is present, but pre-S8 input.start was
// never set (the resolver was read INSIDE maybeSpawnDevServer, AFTER the lease was
// chosen). So the backend never leased a port → no dev server → the dev-build path
// was inert. These tests use the REAL PlaywrightBackend so the lease seam is the
// genuine one, and inject a deliverable carrying `start` to prove hydration now
// flips requiredLease to a verify:port lease + spawns the dev server.
// ---------------------------------------------------------------------------

describe('VerificationScheduler — hydrate input from verify.json before lease selection (S8)', () => {
  let artifactsDir: string;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-sched-s8-'));
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('hydrates input.start from the deliverable → the REAL Playwright backend leases a verify:port + the dev server spawns', async () => {
    const calls: { spawnPort?: number; leaseHeldAtSpawn?: boolean } = {};
    const mutex = new Mutex();
    const leasePool = new ResourceLeasePool(mutex);
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        calls.spawnPort = args.port;
        calls.leaseHeldAtSpawn = mutex.isLocked(verifyPortLease(args.port));
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    // The REAL backend: requiredLease keys off input.start (VERIFY_PORT_ANY when set,
    // null otherwise) — exactly the seam this slice exercises.
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig, // devServerPorts: [5173, 3000]
      leasePool,
      devServerProvider: provider,
      // Deliverable carries a `start`; the request's input does NOT.
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'npm run dev -- --port ${PORT}' },
      }),
    });

    // The request input LACKS start — pre-S8 this never leased a port.
    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    // Hydration set input.start BEFORE lease selection → a REAL pooled port leased
    // → the dev server spawned on it, with the lease already held.
    expect(calls.spawnPort).toBe(5173);
    expect(calls.leaseHeldAtSpawn).toBe(true);
    expect(rowStatus(db, id).status).toBe('passed');
    expect(mutex.isLocked(verifyPortLease(5173))).toBe(false); // released in finally
  });

  it('without a resolver (or no matching deliverable) input is unchanged → no port lease, no spawn (byte-identical to today)', async () => {
    // No resolver injected at all → no hydration → the real backend stays null-lease.
    const spawnSpy = vi.fn();
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawnSpy();
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool: new ResourceLeasePool(new Mutex()),
      devServerProvider: provider,
      // NO devServerContextResolver → resolveDeliverableContext returns null.
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    // No start hydrated → backend asked for no port lease → no dev server.
    expect(spawnSpy).not.toHaveBeenCalled();
    // Static capture still ran (the real backend captured the static url) → passed.
    expect(rowStatus(db, id).status).toBe('passed');
  });

  it('a resolver that returns no matching deliverable leaves input unhydrated (no spawn)', async () => {
    const spawnSpy = vi.fn();
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawnSpy();
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool: new ResourceLeasePool(new Mutex()),
      devServerProvider: provider,
      // Resolver returns null (no matching/startable deliverable).
      devServerContextResolver: async () => null,
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(rowStatus(db, id).status).toBe('passed');
  });

  it('an AGENT-PROVIDED input.start is NOT overwritten by the resolver value', async () => {
    // The deliverable would supply a DIFFERENT start; the agent's wins. We assert via
    // the dev-server config the provider receives (the deliverable's start is still
    // what the provider runs — the provider reads its `config`, not input — but the
    // KEY assertion is that the request was driven by the agent's start, i.e. it still
    // leased + spawned). To prove input.start specifically was not clobbered we use a
    // fakeBackend whose requiredLease echoes input.start into a sink.
    const seen: { startAtLease?: string } = {};
    const sink: { ctx?: CaptureContext } = {};
    const backend: VisualBackend = {
      id: 'playwright',
      rung: 1,
      // requiredLease reads input.start — the exact seam. Record what it saw.
      requiredLease: (input) => {
        seen.startAtLease = input.start;
        return input.start && input.start.trim().length > 0 ? 'verify:port:5173' : null;
      },
      healthCheck: async () => true,
      capture: async (ctx): Promise<CaptureResult> => {
        sink.ctx = ctx;
        return { ok: true, fileNames: ['default.png'] };
      },
    };
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => ({
        baseUrl: `http://localhost:${args.port}`,
        release: async () => {},
      }),
    };

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool: new ResourceLeasePool(new Mutex()),
      devServerProvider: provider,
      // Deliverable supplies a DIFFERENT start.
      devServerContextResolver: async () => ({
        cwd: '/tmp/wt',
        deliverable: { id: 'web', start: 'deliverable-start' },
      }),
    });

    // Agent passes its OWN start inline.
    enqueueRow(db, { chain: ['playwright'], start: 'agent-start' });
    await sched.drain();

    // The agent's start survived hydration (not overwritten by 'deliverable-start').
    expect(seen.startAtLease).toBe('agent-start');
  });

  it('invokes the devServerContextResolver AT MOST ONCE per request (no double verify.json load)', async () => {
    const resolverSpy = vi.fn(async () => ({
      cwd: '/tmp/wt',
      deliverable: { id: 'web', start: 'npm run dev -- --port ${PORT}' } as const,
    }));
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => ({
        baseUrl: `http://localhost:${args.port}`,
        release: async () => {},
      }),
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool: new ResourceLeasePool(new Mutex()),
      devServerProvider: provider,
      devServerContextResolver: resolverSpy,
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    await sched.drain();

    // Resolved ONCE for hydration + reused in maybeSpawnDevServer (not loaded twice).
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(rowStatus(db, id).status).toBe('passed');
  });

  it('a resolver that THROWS leaves input unhydrated and the request still proceeds (fail-soft)', async () => {
    const spawnSpy = vi.fn();
    const provider: DevServerProvider = {
      spawn: async (args): Promise<DevServerHandle> => {
        spawnSpy();
        return { baseUrl: `http://localhost:${args.port}`, release: async () => {} };
      },
    };
    const backend = new PlaywrightBackend({
      installer: presentInstaller(),
      browserFactory: fakeBrowserFactory(),
    });

    const sched = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { playwright: backend },
      judge: fakeJudge,
      artifactsDirResolver: () => artifactsDir,
      config: baseConfig,
      leasePool: new ResourceLeasePool(new Mutex()),
      devServerProvider: provider,
      // Resolver throws — hydration must fail-soft (no throw, input unhydrated).
      devServerContextResolver: async () => {
        throw new Error('verify.json read boom');
      },
    });

    const id = enqueueRow(db, { chain: ['playwright'], url: 'http://placeholder' });
    // Must NOT throw out of drain.
    await expect(sched.drain()).resolves.toBeUndefined();

    // No start hydrated → no port lease → no spawn; the static capture still ran.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(rowStatus(db, id).status).toBe('passed');
  });
});
