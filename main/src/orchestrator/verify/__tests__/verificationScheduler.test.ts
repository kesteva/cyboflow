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
import {
  VerificationScheduler,
  ResourceLeasePool,
  verifyPortLease,
  type DevServerProvider,
  type DevServerHandle,
  type DevServerSpawnArgs,
} from '../verificationScheduler';
import { Mutex } from '../../../utils/mutex';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
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
    JSON.stringify({ intent: 'looks right', url: opts.url ?? 'http://placeholder' }),
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
