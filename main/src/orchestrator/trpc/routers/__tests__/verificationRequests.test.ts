/**
 * Integration tests for the orchestrator tRPC verificationRequests router (S7/L6).
 *
 * Exercises the live verificationRequestsRouter.list/.budget procedures via
 * createCaller, using an in-memory SQLite DB built from projects + migrations
 * 006/011/014/015/016/019/055/056(/095) (so workflow_runs + verification_requests
 * + judge_calls_used + the migration-095 failure-classification columns all
 * exist), the shared dbAdapter fixture, and a real DatabaseLike — mirroring the
 * verificationScheduler test's DB harness.
 *
 * Tests:
 *  1. list filters by projectId (rows from another project are excluded).
 *  2. optional runId filter narrows to a single run.
 *  3. optional status filter narrows to a single lifecycle status.
 *  4. runId + status filters compose.
 *  5. results are ordered by enqueued_at DESC (newest first).
 *  6. each row matches the VerificationRequestRow shape (chain_json NULL -> '[]').
 *  7. an empty projectId result returns [].
 *  8. zod rejects projectId 0 / negative + an out-of-domain status.
 *  9. PRECONDITION_FAILED when ctx.db is missing.
 *  10. migration-095 surfacing (verification-setup-flow.md §3.1/§3.6):
 *      failureClass/modality parse valid values and fail-soft on invalid ones;
 *      failureEvidence parses/fail-softs off failure_evidence_json;
 *      setupProof reflects the raw 0/1 flag; a pre-095 DB (columns absent
 *      entirely) renders every new field exactly as today (undefined/false).
 *  11. budget: sums judge_calls_used per project, reads
 *      visual_verify_budget_calls (null = unlimited), zod validation, and
 *      PRECONDITION_FAILED parity with list.
 *  12. health (verification-setup-flow.md §6): per-modality bucketing, a pass
 *      rate whose denominator INCLUDES skips, a failure histogram that
 *      reconciles against attempts - passed, median duration across mixed
 *      SQLite/ISO timestamp formats, setup-proof traffic counted apart (plus
 *      the proof-spend/budget overlap made visible), capability suppressions
 *      resolved through their TTL + host-generation rules, and pre-095
 *      degradation.
 *  13. hostProbes / provisionChromium (§6): the fail-open mapping (a REJECTING
 *      probe is 'inconclusive', never 'missing'; only node's rejection is
 *      affirmative), the conditional grants branch (native rows appear only
 *      when a runbook declares native-screen), the drive round-trip reported
 *      as 'blocked' rather than faked, PRECONDITION_FAILED when unwired, and
 *      provisioning returning a RE-PROBED report.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { VerifyRunbookStatusLike } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../../types';
import type {
  NativeGrantProbe,
  RequestStatus,
  VerifyHostProbeReport,
  VerifyProbeId,
  VerifyProbeRow,
} from '../../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 019 + 055 + 056 (+ 095).
// ---------------------------------------------------------------------------

const MIG_DIR = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const MIGRATIONS_PRE_095 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  // 019 adds workflow_runs.session_id — the hop the list query LEFT-JOINs
  // through to attribute each request to its origin session.
  '019_workflow_run_session_id.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
];
// The default migration set every test builds against, UNLESS it explicitly
// wants a pre-095 DB (the "absent columns render exactly as today" case) —
// those tests pass MIGRATIONS_PRE_095 to buildDb/buildCaller directly.
const MIGRATIONS = [...MIGRATIONS_PRE_095, '095_verify_failure_classes.sql'];

function buildDb(migrations: readonly string[] = MIGRATIONS): Database.Database {
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
  // Minimal sessions table — migration 019 backfills workflow_runs.session_id
  // from it, and the list query joins it for the session pill's display name.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, run_id TEXT);`);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('ProjA', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('ProjB', '/tmp/p2');
  for (const f of migrations) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  return db;
}

/**
 * Seed a run, optionally attached to a session (`sessionName` also inserts the
 * sessions row the join resolves). Omitting it leaves session_id NULL — the
 * unattributed-run case the panel falls back to the run id for.
 */
function seedRun(
  db: Database.Database,
  runId: string,
  projectId: number,
  session?: { id: string; name: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'sprint', '{}')`,
  ).run(`wf-${projectId}`, projectId);
  if (session !== undefined) {
    db.prepare('INSERT OR IGNORE INTO sessions (id, name, run_id) VALUES (?, ?, ?)').run(
      session.id,
      session.name,
      runId,
    );
  }
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
     VALUES (?, ?, ?, 'running', 'default', ?)`,
  ).run(runId, `wf-${projectId}`, projectId, session?.id ?? null);
}

/** Insert one verification_requests row with explicit fields. */
function seedRequest(
  db: Database.Database,
  opts: {
    id: string;
    runId: string;
    projectId: number;
    status: RequestStatus;
    verifyType?: string;
    deliverableJson?: string;
    chainJson?: string | null;
    currentBackend?: string | null;
    attempt?: number;
    verdictJson?: string | null;
    errorMessage?: string | null;
    enqueuedAt: string;
    // Migration-095 columns (verification-setup-flow.md §3.1/§3.6). Leave all
    // five OMITTED (the default) on a pre-095 test DB — providing any one
    // triggers the follow-up UPDATE below, which requires the caller's DB to
    // actually carry migration 095 (the default MIGRATIONS set does; a
    // pre-095 test always builds via MIGRATIONS_PRE_095 and never passes
    // these).
    failureClass?: string | null;
    modality?: string | null;
    failureEvidenceJson?: string | null;
    setupProof?: number;
    judgeCallsUsed?: number;
  },
): void {
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json,
        current_backend, attempt, verdict_json, error_message, enqueued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.runId,
    opts.projectId,
    opts.status,
    opts.verifyType ?? 'static-render-snapshot',
    opts.deliverableJson ?? JSON.stringify({ intent: 'looks right' }),
    opts.chainJson === undefined ? JSON.stringify(['capturePage']) : opts.chainJson,
    opts.currentBackend ?? null,
    opts.attempt ?? 0,
    opts.verdictJson ?? null,
    opts.errorMessage ?? null,
    opts.enqueuedAt,
  );
  // Migration-095 columns are set via a follow-up UPDATE (rather than folded
  // into the INSERT above) so a pre-095 test DB — which lacks these columns
  // entirely — keeps calling this helper unmodified; only a test that
  // explicitly passes one of the five new fields touches the new columns.
  if (
    opts.failureClass !== undefined ||
    opts.modality !== undefined ||
    opts.failureEvidenceJson !== undefined ||
    opts.setupProof !== undefined ||
    opts.judgeCallsUsed !== undefined
  ) {
    db.prepare(
      `UPDATE verification_requests
          SET failure_class = ?, modality = ?, failure_evidence_json = ?, setup_proof = ?, judge_calls_used = ?
        WHERE id = ?`,
    ).run(
      opts.failureClass ?? null,
      opts.modality ?? null,
      opts.failureEvidenceJson ?? null,
      opts.setupProof ?? 0,
      opts.judgeCallsUsed ?? 0,
      opts.id,
    );
  }
}

/**
 * `verifyRunbookStatus` defaults to `'proven'` — "the live conjunction still
 * holds", which is the premise every test here except the drift ones is built
 * on. It is consulted ONLY for records already stored proven (the router never
 * probes a draft, since the conjunction can only demote), so this default
 * cannot launder an unproven record into a proven one.
 */
function buildCaller(
  migrations?: readonly string[],
  verifyRunbookStatus: VerifyRunbookStatusLike = async () => ({ status: 'proven', reason: 'proven' }),
): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
  adapter: DatabaseLike;
} {
  const db = buildDb(migrations);
  const adapter = dbAdapter(db);
  const caller = appRouter.createCaller(createContext({ db: adapter, verifyRunbookStatus }));
  return { caller, db, adapter };
}

let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
});

describe('cyboflow.verificationRequests.list', () => {
  it('filters by projectId (excludes other projects)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-b', 2);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-b', projectId: 2, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vr-1');
    expect(result[0].project_id).toBe(1);
  });

  it('narrows to a single run via the optional runId filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, runId: 'run-c' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('narrows to a single status via the optional status filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'passed' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
    expect(result[0].status).toBe('passed');
  });

  it('composes the runId + status filters', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:02.000Z' });
    seedRequest(db, { id: 'vr-3', runId: 'run-c', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:03.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({
      projectId: 1,
      runId: 'run-c',
      status: 'failed',
    });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('orders by enqueued_at DESC (newest first)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-old', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-new', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:09.000Z' });
    seedRequest(db, { id: 'vr-mid', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:05.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.map((r) => r.id)).toEqual(['vr-new', 'vr-mid', 'vr-old']);
  });

  it('returns rows matching the VerificationRequestRow shape (chain_json NULL -> "[]")', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'running',
      verifyType: 'interactive-web-behavior',
      deliverableJson: JSON.stringify({ intent: 'click works' }),
      chainJson: null, // unresolved chain -> normalized to '[]'
      currentBackend: 'playwright',
      attempt: 1,
      verdictJson: null,
      errorMessage: null,
      enqueuedAt: '2026-06-28T00:00:01.000Z',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row).toEqual({
      id: 'vr-1',
      run_id: 'run-a',
      project_id: 1,
      status: 'running',
      verify_type: 'interactive-web-behavior',
      deliverable_json: JSON.stringify({ intent: 'click works' }),
      chain_json: '[]',
      current_backend: 'playwright',
      attempt: 1,
      verdict_json: null,
      error_message: null,
      enqueued_at: '2026-06-28T00:00:01.000Z',
      leased_at: null,
      ended_at: null,
      task_json: null,
      report_json: null,
      delivery_state: null,
      snapshot_sha: null,
      enqueue_key: null,
      session_id: null,
      session_name: null,
      // Migration-095 columns — every field NULL/unset on this row, so every
      // derived field fail-softs to its default (undefined/false).
      failureClass: undefined,
      modality: undefined,
      setupProof: false,
      failureEvidence: undefined,
    });
    // chain_json is always a parseable VisualBackendId[] for the renderer.
    expect(() => JSON.parse(row.chain_json)).not.toThrow();
  });

  it('attributes each row to its origin session (run -> session join)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1, { id: 'sess-a', name: 'twilight-leaf' });
    seedRun(db, 'run-b', 1, { id: 'sess-b', name: 'curious-basin' });
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-b', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.map((r) => [r.id, r.session_id, r.session_name])).toEqual([
      ['vr-1', 'sess-a', 'twilight-leaf'],
      ['vr-2', 'sess-b', 'curious-basin'],
    ]);
  });

  it('reads back NULL session fields for a run with no session (LEFT JOIN, row still lists)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1); // no session attached
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.id).toBe('vr-1');
    expect(row.session_id).toBeNull();
    expect(row.session_name).toBeNull();
  });

  it('filters on the REQUEST status/project, not the joined run\'s columns', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    // The run is 'running' while its request is terminal — an unqualified
    // `status = ?` predicate would silently filter on workflow_runs.status here.
    seedRun(db, 'run-a', 1, { id: 'sess-a', name: 'twilight-leaf' });
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const passed = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'passed' });
    const running = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'running' });

    expect(passed.map((r) => r.id)).toEqual(['vr-1']);
    expect(running).toEqual([]);
  });

  it('returns [] when the project has no requests', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });
    expect(result).toEqual([]);
  });

  it('rejects projectId 0 without querying', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects a negative projectId', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: -2 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects an out-of-domain status', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      // @ts-expect-error — 'bogus' is not a RequestStatus; the zod enum rejects it.
      caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'bogus' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  // --- migration-095 surfacing (verification-setup-flow.md §3.1/§3.6) -----

  it('parses a valid failure_class/modality into failureClass/modality', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'skipped',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'env',
      modality: 'cdp-app',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureClass).toBe('env');
    expect(row.modality).toBe('cdp-app');
  });

  it('fail-softs an out-of-domain failure_class/modality to undefined', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      // Neither is a real VerificationFailureClass/VerificationModality member
      // — simulates a future-added value from a newer binary, or corruption.
      failureClass: 'not-a-real-class',
      modality: 'not-a-real-modality',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureClass).toBeUndefined();
    expect(row.modality).toBeUndefined();
  });

  it('parses failure_evidence_json into failureEvidence', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    const evidence = [{ source: 'preflight', check: 'chromium', detail: 'chromium binary not resolvable' }];
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'skipped',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'env',
      failureEvidenceJson: JSON.stringify(evidence),
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureEvidence).toEqual(evidence);
  });

  it('fail-softs malformed failure_evidence_json to undefined (invalid JSON, non-array, and ill-shaped entries)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-invalid-json',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: '{not json',
    });
    seedRequest(db, {
      id: 'vr-not-array',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:02.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: JSON.stringify({ source: 'runner', detail: 'not an array' }),
    });
    seedRequest(db, {
      id: 'vr-ill-shaped',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:03.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: JSON.stringify([{ source: 'runner' /* missing detail */ }]),
    });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.every((r) => r.failureEvidence === undefined)).toBe(true);
  });

  it('setupProof reflects the raw 0/1 flag', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-proof',
      runId: 'run-a',
      projectId: 1,
      status: 'passed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      setupProof: 1,
    });
    seedRequest(db, {
      id: 'vr-ordinary',
      runId: 'run-a',
      projectId: 1,
      status: 'passed',
      enqueuedAt: '2026-06-28T00:00:02.000Z',
      setupProof: 0,
    });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.find((r) => r.id === 'vr-proof')?.setupProof).toBe(true);
    expect(result.find((r) => r.id === 'vr-ordinary')?.setupProof).toBe(false);
  });

  it('a pre-095 DB (columns absent entirely) renders every new field exactly as today', async () => {
    const { caller, db } = buildCaller(MIGRATIONS_PRE_095);
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.id).toBe('vr-1');
    expect(row.failureClass).toBeUndefined();
    expect(row.modality).toBeUndefined();
    expect(row.setupProof).toBe(false);
    expect(row.failureEvidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// budget (§3.6 "surface budget state in the Verify Queue")
// ---------------------------------------------------------------------------

describe('cyboflow.verificationRequests.budget', () => {
  it('sums judge_calls_used across the project\'s requests, ignoring other projects', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-b', 2);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z', judgeCallsUsed: 2 });
    seedRequest(db, { id: 'vr-2', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:02.000Z', judgeCallsUsed: 3 });
    seedRequest(db, { id: 'vr-3', runId: 'run-b', projectId: 2, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z', judgeCallsUsed: 100 });

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.usedCalls).toBe(5);
    expect(result.projectId).toBe(1);
    expect(result.projectName).toBe('ProjA');
  });

  it('reads budgetCalls as null when visual_verify_budget_calls is unset (unlimited)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.budgetCalls).toBeNull();
    expect(result.usedCalls).toBe(0);
  });

  it('reads a numeric budgetCalls when the project sets one', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    db.prepare('UPDATE projects SET visual_verify_budget_calls = ? WHERE id = ?').run(50, 1);

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.budgetCalls).toBe(50);
  });

  it('rejects a non-positive projectId', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.budget({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.verificationRequests.budget({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// health — the phase-3 panel aggregation (verification-setup-flow.md §6)
// ---------------------------------------------------------------------------

/**
 * Stamp the lifecycle timestamps the median-duration span is computed from.
 * Kept local (rather than widened onto `seedRequest`) so the pre-095 tests and
 * every existing caller stay byte-identical.
 */
function stampSpan(db: Database.Database, id: string, leasedAt: string, endedAt: string): void {
  db.prepare('UPDATE verification_requests SET leased_at = ?, ended_at = ? WHERE id = ?').run(
    leasedAt,
    endedAt,
    id,
  );
}

function seedCapability(
  db: Database.Database,
  opts: {
    projectId: number;
    modality: string;
    status: 'active' | 'suppressed' | 'unsupported';
    reason?: string;
    envFailures?: number;
    hostGeneration?: number;
    suppressedUntil?: string | null;
    updatedAt?: string;
    runbookHash?: string;
  },
): void {
  db.prepare(
    `INSERT INTO verify_capability_state
       (project_id, modality, runbook_hash, status, reason, consecutive_env_failures, host_generation, suppressed_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.projectId,
    opts.modality,
    opts.runbookHash ?? '',
    opts.status,
    opts.reason ?? '',
    opts.envFailures ?? 0,
    opts.hostGeneration ?? 0,
    opts.suppressedUntil ?? null,
    opts.updatedAt ?? '2026-08-01T00:00:00.000Z',
  );
}

function setHostGeneration(db: Database.Database, generation: number): void {
  db.prepare(
    `INSERT INTO verify_host_state (id, capability_generation) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET capability_generation = excluded.capability_generation`,
  ).run(generation);
}

describe('verificationRequests.health', () => {
  const cleanups: Database.Database[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.close();
  });

  function setup(migrations?: readonly string[]): ReturnType<typeof buildCaller> {
    const built = buildCaller(migrations);
    cleanups.push(built.db);
    return built;
  }

  it('buckets attempts per modality and computes the pass rate over ALL terminal rows', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    // web: 2 passed, 1 failed, 1 skipped -> 4 attempts, 0.5 pass rate.
    seedRequest(db, { id: 'r1', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z', modality: 'web' });
    seedRequest(db, { id: 'r2', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:02Z', modality: 'web' });
    seedRequest(db, { id: 'r3', runId: 'run-1', projectId: 1, status: 'failed', enqueuedAt: '2026-08-01T00:00:03Z', modality: 'web', failureClass: 'deliverable' });
    seedRequest(db, { id: 'r4', runId: 'run-1', projectId: 1, status: 'skipped', enqueuedAt: '2026-08-01T00:00:04Z', modality: 'web', failureClass: 'env' });
    // An in-flight row must NOT dilute the pass rate.
    seedRequest(db, { id: 'r5', runId: 'run-1', projectId: 1, status: 'running', enqueuedAt: '2026-08-01T00:00:05Z', modality: 'web' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const web = health.modalities.find((m) => m.modality === 'web');

    expect(web?.attempts).toBe(4);
    expect(web?.inFlight).toBe(1);
    expect(web?.passed).toBe(2);
    // Skips are IN the denominator on purpose — a project whose verifications
    // all skip must not report a healthy pass rate (§3.2 degrade path).
    expect(web?.passRate).toBe(0.5);
    expect(web?.outcomes.passed).toBe(2);
    expect(web?.outcomes.skipped).toBe(1);
    expect(web?.failures).toMatchObject({ env: 1, deliverable: 1, ambiguous: 0, unclassified: 0 });
  });

  it('the failure histogram reconciles against attempts - passed, unclassified included', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'r1', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z', modality: 'web' });
    seedRequest(db, { id: 'r2', runId: 'run-1', projectId: 1, status: 'failed', enqueuedAt: '2026-08-01T00:00:02Z', modality: 'web', failureClass: 'env' });
    // Terminal, non-passing, never classified -> 'unclassified', not dropped.
    seedRequest(db, { id: 'r3', runId: 'run-1', projectId: 1, status: 'timeout', enqueuedAt: '2026-08-01T00:00:03Z', modality: 'web' });
    // A garbage class value fail-softs into 'unclassified' too.
    seedRequest(db, { id: 'r4', runId: 'run-1', projectId: 1, status: 'failed', enqueuedAt: '2026-08-01T00:00:04Z', modality: 'web', failureClass: 'not-a-class' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const web = health.modalities.find((m) => m.modality === 'web');
    const histogramTotal = Object.values(web?.failures ?? {}).reduce((a, b) => a + b, 0);

    expect(web?.failures.unclassified).toBe(2);
    expect(histogramTotal).toBe((web?.attempts ?? 0) - (web?.passed ?? 0));
  });

  it('median duration is the middle leased->ended span, ignoring rows without both stamps', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    for (const [id, secs] of [['r1', 10], ['r2', 30], ['r3', 110]] as const) {
      seedRequest(db, { id, runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:00Z', modality: 'web' });
      stampSpan(db, id, '2026-08-01T00:00:00Z', `2026-08-01T00:0${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}Z`);
    }
    // No leased_at/ended_at -> contributes an attempt but no span.
    seedRequest(db, { id: 'r4', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:00Z', modality: 'web' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const web = health.modalities.find((m) => m.modality === 'web');

    expect(web?.attempts).toBe(4);
    expect(web?.medianDurationMs).toBe(30_000);
  });

  it('a span MIXING the two timestamp formats is exact (julianday, not Date.parse)', async () => {
    // The regression this guards: these columns hold BOTH 'YYYY-MM-DD HH:MM:SS'
    // and ISO-8601, and Date.parse reads the first as LOCAL and the second as
    // UTC. Note the mixing has to be WITHIN a row to bite — two same-format
    // stamps subtract their (identical) offset away, so a per-row-consistent
    // fixture passes under Date.parse too and guards nothing.
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    // leased_at SQLite-naive, ended_at ISO-UTC: under Date.parse this reads as
    // 20s ± the host's UTC offset (an HOUR or more off outside UTC).
    seedRequest(db, { id: 'mixed', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:00Z', modality: 'web' });
    stampSpan(db, 'mixed', '2026-08-01 00:00:00', '2026-08-01T00:00:20.000Z');
    // ...and the reverse ordering of the two formats.
    seedRequest(db, { id: 'mixed-rev', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:00Z', modality: 'cdp-app' });
    stampSpan(db, 'mixed-rev', '2026-08-01T00:00:00.000Z', '2026-08-01 00:00:20');

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });

    expect(health.modalities.find((m) => m.modality === 'web')?.medianDurationMs).toBe(20_000);
    expect(health.modalities.find((m) => m.modality === 'cdp-app')?.medianDurationMs).toBe(20_000);
  });

  it('setup-proof rows are counted APART from lane traffic, with their own call spend', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'lane', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z', modality: 'web', judgeCallsUsed: 1 });
    seedRequest(db, { id: 'proof1', runId: 'run-1', projectId: 1, status: 'failed', enqueuedAt: '2026-08-01T00:00:02Z', modality: 'web', setupProof: 1, judgeCallsUsed: 2 });
    seedRequest(db, { id: 'proof2', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:03Z', modality: 'web', setupProof: 1, judgeCallsUsed: 3 });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });

    // The lane bucket sees ONLY the lane row — a project being FIXED must not
    // read as unhealthy because its proof attempts failed on the way there.
    const web = health.modalities.find((m) => m.modality === 'web');
    expect(web?.attempts).toBe(1);
    expect(web?.passRate).toBe(1);

    expect(health.setupProof.attempts).toBe(2);
    expect(health.setupProof.passed).toBe(1);
    expect(health.setupProofCallsUsed).toBe(5);
  });

  it('surfaces the proof spend that budget enforcement still counts (the known overlap)', async () => {
    // Proof runs skip the budget CHECK but their judge_calls_used remains in
    // the SUM that check reads, so it consumes the allowance ordinary lanes are
    // measured against. The panel shows the overlap rather than hiding it.
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'lane', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z', judgeCallsUsed: 4 });
    seedRequest(db, { id: 'proof', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:02Z', setupProof: 1, judgeCallsUsed: 6 });

    const [health, budget] = await Promise.all([
      caller.cyboflow.verificationRequests.health({ projectId: 1 }),
      caller.cyboflow.verificationRequests.budget({ projectId: 1 }),
    ]);

    expect(budget.usedCalls).toBe(10);
    expect(health.setupProofCallsUsed).toBe(6);
    // i.e. 6 of the 10 calls the scheduler will measure lanes against came from
    // proof traffic the tool contract calls exempt.
  });

  it('rows with no modality land in the unattributed bucket, not silently in web', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'r1', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z' });
    seedRequest(db, { id: 'r2', runId: 'run-1', projectId: 1, status: 'failed', enqueuedAt: '2026-08-01T00:00:02Z', modality: 'bogus' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });

    expect(health.unattributed.attempts).toBe(2);
    expect(health.modalities).toHaveLength(0);
  });

  it('resolves a suppression as IN FORCE only while its TTL and host generation both hold', async () => {
    const { caller, db } = setup();
    setHostGeneration(db, 7);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // In force: unexpired TTL + matching generation.
    seedCapability(db, { projectId: 1, modality: 'web', status: 'suppressed', reason: 'port taken', envFailures: 5, hostGeneration: 7, suppressedUntil: future });
    // TTL lapsed -> inert, the next request re-attempts freely.
    seedCapability(db, { projectId: 1, modality: 'cdp-app', status: 'suppressed', reason: 'stale', hostGeneration: 7, suppressedUntil: past });
    // Host moved on -> inert even though the TTL is live.
    seedCapability(db, { projectId: 1, modality: 'native-screen', status: 'unsupported', reason: 'no grant', hostGeneration: 3, suppressedUntil: future });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const byModality = new Map(health.modalities.map((m) => [m.modality, m]));

    expect(health.hostGeneration).toBe(7);
    expect(byModality.get('web')?.capability).toMatchObject({ status: 'suppressed', reason: 'port taken', consecutiveEnvFailures: 5, suppressionActive: true });
    expect(byModality.get('cdp-app')?.capability?.suppressionActive).toBe(false);
    expect(byModality.get('native-screen')?.capability?.suppressionActive).toBe(false);
  });

  it('reads the capability row the ENGINE reads — keyed by the proven runbook hash, not the newest row', async () => {
    // verify_capability_state is keyed (project, modality, runbook_hash) and the
    // scheduler looks up exactly the request's PIN hash. An old revision's row
    // can be UPDATED last (a request pinned to it finishing after a new runbook
    // is registered), so "newest updated_at wins" reports a suppression the
    // engine will never honour.
    const db = buildDb([...MIGRATIONS, '096_verify_runbook_local.sql']);
    cleanups.push(db);
    setHostGeneration(db, 2);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
       VALUES (1, 'web', 'hash-new', '{}', 2, 'proven')`,
    ).run();
    // The live row: keyed to the proven hash, and NOT suppressed.
    seedCapability(db, { projectId: 1, modality: 'web', runbookHash: 'hash-new', status: 'active', envFailures: 1, hostGeneration: 2, updatedAt: '2026-08-01T00:00:00.000Z' });
    // The stale row: a superseded revision, tripped, and updated MORE recently.
    seedCapability(db, { projectId: 1, modality: 'web', runbookHash: 'hash-old', status: 'suppressed', reason: 'port taken', envFailures: 5, hostGeneration: 2, suppressedUntil: future, updatedAt: '2026-08-02T00:00:00.000Z' });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db), verifyRunbookStatus: async () => ({ status: 'proven', reason: 'proven' }) }));

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const web = health.modalities.find((m) => m.modality === 'web');

    expect(web?.capability?.status).toBe('active');
    expect(web?.capability?.consecutiveEnvFailures).toBe(1);
    expect(web?.capability?.suppressionActive).toBe(false);
  });

  it("falls back to the phase-0 '' key when no runbook is proven", async () => {
    // A pin only ever resolves to a PROVEN revision, so an unproven draft leaves
    // the engine reading migration 095's default key. A suppression stamped
    // against the draft's hash is therefore inert and must not be reported.
    const db = buildDb([...MIGRATIONS, '096_verify_runbook_local.sql']);
    cleanups.push(db);
    setHostGeneration(db, 2);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
       VALUES (1, 'web', 'hash-draft', '{}', 1, 'unproven-draft')`,
    ).run();
    seedCapability(db, { projectId: 1, modality: 'web', runbookHash: 'hash-draft', status: 'suppressed', reason: 'draft-era trip', hostGeneration: 2, suppressedUntil: future });
    seedCapability(db, { projectId: 1, modality: 'web', runbookHash: '', status: 'suppressed', reason: 'phase-0 trip', envFailures: 3, hostGeneration: 2, suppressedUntil: future });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });

    expect(health.modalities.find((m) => m.modality === 'web')?.capability?.reason).toBe('phase-0 trip');
  });

  it('lists a modality that has a capability row but no traffic yet', async () => {
    // A capability suppressed before its first success has no requests to show
    // — exactly when a user most needs to see it.
    const { caller, db } = setup();
    seedCapability(db, { projectId: 1, modality: 'native-screen', status: 'unsupported', reason: 'screen recording not granted' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const native = health.modalities.find((m) => m.modality === 'native-screen');

    expect(native).toBeDefined();
    expect(native?.attempts).toBe(0);
    // null, never 0 — "no data" is not "never passed".
    expect(native?.passRate).toBeNull();
    expect(native?.capability?.reason).toBe('screen recording not granted');
  });

  it('scopes to the project and returns an empty summary for one with no traffic', async () => {
    const { caller, db } = setup();
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'r1', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z', modality: 'web' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 2 });

    expect(health.projectId).toBe(2);
    expect(health.modalities).toHaveLength(0);
    expect(health.unattributed.attempts).toBe(0);
    expect(health.unattributed.passRate).toBeNull();
    expect(health.setupProofCallsUsed).toBe(0);
  });

  it('degrades on a pre-095 DB instead of throwing on the absent columns/tables', async () => {
    const { caller, db } = setup(MIGRATIONS_PRE_095);
    seedRun(db, 'run-1', 1);
    seedRequest(db, { id: 'r1', runId: 'run-1', projectId: 1, status: 'passed', enqueuedAt: '2026-08-01T00:00:01Z' });

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });

    // No modality/setup_proof columns and no ledger tables: everything lands in
    // unattributed, capabilities read empty, generation reads 0.
    expect(health.unattributed.attempts).toBe(1);
    expect(health.unattributed.passed).toBe(1);
    expect(health.modalities).toHaveLength(0);
    expect(health.hostGeneration).toBe(0);
  });

  it('surfaces an unproven runbook for a modality with no traffic at all', async () => {
    // The most actionable state the panel carries, and the one that looks like
    // silence: until a runbook is PROVEN the degrade gate skips every
    // build/serve check for that modality, so "no requests" is the SYMPTOM
    // rather than the absence of a problem.
    const db = buildDb([...MIGRATIONS, '096_verify_runbook_local.sql']);
    cleanups.push(db);
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
       VALUES (1, 'web', 'abc123', '{}', 4, 'unproven-draft')`,
    ).run();
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    const health = await caller.cyboflow.verificationRequests.health({ projectId: 1 });
    const web = health.modalities.find((m) => m.modality === 'web');

    expect(web).toBeDefined();
    expect(web?.attempts).toBe(0);
    // `origin` is null: this record predates migration 105's provenance column
    // in the fixture, which is exactly the honestly-unknown case — a reader must
    // not infer 'setup-flow' from its absence.
    expect(web?.runbook).toEqual({
      status: 'unproven-draft',
      version: 4,
      portableHash: 'abc123',
      origin: null,
    });
  });

  it('rejects a non-positive projectId and PRECONDITION_FAILEDs without a db', async () => {
    const { caller } = setup();
    await expect(caller.cyboflow.verificationRequests.health({ projectId: 0 })).rejects.toThrow();

    const noDb = appRouter.createCaller(createContext({}));
    await expect(noDb.cyboflow.verificationRequests.health({ projectId: 1 })).rejects.toThrow(TRPCError);
  });
});

// ---------------------------------------------------------------------------
// hostProbes / provisionChromium — the §6 live probe table
// ---------------------------------------------------------------------------

type ProbeOverrides = Partial<{
  resolveNode: () => Promise<string>;
  resolveChromium: () => Promise<string | null>;
  probeDriverCli: () => Promise<{ path: string; exists: boolean }>;
  nativeGrants: (() => Promise<NativeGrantProbe>) | undefined;
  ensureChromium: () => Promise<boolean>;
  requestAccessibility: (() => Promise<void>) | undefined;
  openScreenRecordingSettings: (() => Promise<void>) | undefined;
  mobileSimulator: (() => Promise<VerifyProbeRow>) | undefined;
}>;

type ProbeStub = {
  resolveNode: () => Promise<string>;
  resolveChromium: () => Promise<string | null>;
  probeDriverCli: () => Promise<{ path: string; exists: boolean }>;
  nativeGrants?: () => Promise<NativeGrantProbe>;
  ensureChromium: () => Promise<boolean>;
  requestAccessibility?: () => Promise<void>;
  openScreenRecordingSettings?: () => Promise<void>;
  mobileSimulator?: () => Promise<VerifyProbeRow>;
};

/** Keys whose explicit `undefined` must leave the key ABSENT, not present-and-undefined. */
const OPTIONAL_PROBE_KEYS = [
  'nativeGrants',
  'requestAccessibility',
  'openScreenRecordingSettings',
  'mobileSimulator',
] as const;

function probeStub(overrides: ProbeOverrides = {}): ProbeStub {
  const merged: Record<string, unknown> = {
    resolveNode: async () => '/usr/bin/node',
    resolveChromium: async () => '/chromium',
    probeDriverCli: async () => ({ path: '/driver/cli.js', exists: true }),
    nativeGrants: async () => ({ kind: 'ok', screenRecording: true, accessibility: true }),
    ensureChromium: async () => true,
    requestAccessibility: async () => {},
    openScreenRecordingSettings: async () => {},
    mobileSimulator: async (): Promise<VerifyProbeRow> => ({
      id: 'mobile-simulator',
      state: 'ok',
      detail: 'Xcode 26.2 · iOS 26.2 · maestro /opt/homebrew/bin/maestro',
      fix: null,
    }),
    ...overrides,
  };
  // An explicit `undefined` means "not wired on this host" — the router
  // branches on `=== undefined`, which a present-but-undefined key would also
  // satisfy, but `in`-based checks elsewhere would not.
  for (const key of OPTIONAL_PROBE_KEYS) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as ProbeStub;
}

/** Pull one row out of a report by id, failing loudly rather than silently probing `undefined`. */
function probeRow(report: VerifyHostProbeReport, id: VerifyProbeId): VerifyProbeRow {
  const row = report.probes.find((p) => p.id === id);
  if (row === undefined) throw new Error(`no ${id} row in the report`);
  return row;
}

describe('verificationRequests.hostProbes', () => {
  const cleanups: Database.Database[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.close();
  });

  /** A caller whose context carries stub probes + a 095/096-capable DB. */
  function setup(opts: { probes?: ProbeOverrides; declareNativeScreen?: boolean } = {}): {
    caller: ReturnType<typeof appRouter.createCaller>;
    db: Database.Database;
  } {
    const db = buildDb([...MIGRATIONS, '096_verify_runbook_local.sql']);
    cleanups.push(db);
    if (opts.declareNativeScreen === true) {
      db.prepare(
        `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, status)
         VALUES (1, 'native-screen', 'h1', '{}', 'proven')`,
      ).run();
    }
    const caller = appRouter.createCaller(
      createContext({ db: dbAdapter(db), verifyHostProbes: probeStub(opts.probes) }),
    );
    return { caller, db };
  }

  it('reports exactly the four actionable rows on a healthy host', async () => {
    const { caller } = setup();
    const report = await caller.cyboflow.verificationRequests.hostProbes();

    expect(report.probes.map((p) => p.id)).toEqual([
      'browser-driving',
      'screen-recording',
      'accessibility',
      'mobile-simulator',
    ]);
    expect(report.probes.every((p) => p.state === 'ok')).toBe(true);
  });

  it('reports the grants identically whether or not a runbook declares native-screen', async () => {
    // The old behaviour hid the rows until some runbook declared the modality,
    // which withheld the answer at exactly the moment it was needed: you
    // cannot decide whether to use screen capture without being told whether
    // it works on this host. Reporting them but calling them optional had the
    // same defect more quietly, so nothing about these rows depends on what
    // the current projects happen to need.
    const grants = {
      nativeGrants: async (): Promise<NativeGrantProbe> => ({
        kind: 'ok' as const,
        screenRecording: false,
        accessibility: false,
      }),
    };
    for (const declareNativeScreen of [false, true]) {
      const { caller } = setup({ probes: grants, declareNativeScreen });
      const report = await caller.cyboflow.verificationRequests.hostProbes();

      expect(probeRow(report, 'screen-recording').state).toBe('missing');
      expect(probeRow(report, 'accessibility').state).toBe('missing');
      expect(probeRow(report, 'accessibility').fix).toBe('request-accessibility');
    }
  });

  it('rolls node, chromium and the driver CLI into ONE browser-driving row', async () => {
    const { caller } = setup();
    const report = await caller.cyboflow.verificationRequests.hostProbes();

    expect(report.probes.map((p) => p.id)).not.toContain('node');
    expect(report.probes.map((p) => p.id)).not.toContain('chromium');
    expect(report.probes.map((p) => p.id)).not.toContain('driver-cli');
    // On success the detail is the chromium path — the part that varies per host.
    expect(probeRow(report, 'browser-driving').detail).toBe('/chromium');
  });

  it('names EVERY failing part of browser-driving, not just the first', async () => {
    // A host missing two of the three would otherwise send the user round the
    // loop twice.
    const { caller } = setup({
      probes: {
        resolveChromium: async () => null,
        probeDriverCli: async () => ({ path: '/driver/cli.js', exists: false }),
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'browser-driving');

    expect(row.state).toBe('missing');
    expect(row.detail).toMatch(/chromium/);
    expect(row.detail).toMatch(/driver CLI/);
    // The only part with a remedy still offers it.
    expect(row.fix).toBe('provision-chromium');
  });

  it('maps a REJECTING chromium probe to inconclusive, never to missing', async () => {
    // The fail-open rule from preflight.ts: a probe that could not answer is
    // not evidence of absence, and rendering it as "missing" would send a user
    // chasing a binary that is already installed.
    const { caller } = setup({ probes: { resolveChromium: async () => { throw new Error('EPERM'); } } });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'browser-driving');

    expect(row.state).toBe('inconclusive');
    expect(row.fix).toBeNull();
  });

  it('lets an affirmative absence outweigh an unanswerable part', async () => {
    // 'missing' is the stronger fact AND the one with an action attached —
    // degrading the row to 'inconclusive' would hide the install button.
    const { caller } = setup({
      probes: {
        resolveChromium: async () => null,
        probeDriverCli: async () => { throw new Error('EIO'); },
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'browser-driving');

    expect(row.state).toBe('missing');
    expect(row.fix).toBe('provision-chromium');
  });

  it('treats an unresolvable node as affirmative evidence (preflight\'s one exception)', async () => {
    const { caller } = setup({ probes: { resolveNode: async () => { throw new Error('no node on PATH'); } } });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'browser-driving');

    expect(row.state).toBe('missing');
    expect(row.detail).toMatch(/no node on PATH/);
  });

  it('reports the two grants SEPARATELY rather than as one verdict', async () => {
    // Holding one grant and not the other is the common case; a conjunction
    // could only say "something is wrong" and send the user through both panes.
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'ok', screenRecording: true, accessibility: false }),
      },
    });
    const report = await caller.cyboflow.verificationRequests.hostProbes();

    expect(probeRow(report, 'screen-recording').state).toBe('ok');
    expect(probeRow(report, 'accessibility').state).toBe('missing');
    expect(probeRow(report, 'accessibility').fix).toBe('request-accessibility');
  });

  it('offers the settings pane for a declined screen-recording grant', async () => {
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'ok', screenRecording: false, accessibility: true }),
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'screen-recording');

    expect(row.state).toBe('missing');
    expect(row.fix).toBe('open-screen-recording-settings');
  });

  it('keeps the §8 drive disclosure on the accessibility row rather than as a fake probe', async () => {
    // The old 'native-drive' row probed nothing about the host — it reported
    // that OUR machinery is unbuilt. It rides the grant it would need instead.
    const { caller } = setup();
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'accessibility');

    expect(row.state).toBe('ok');
    expect(row.detail).toMatch(/no drive API/i);
  });

  it('reports an absent native backend as inconclusive on BOTH grants, with no fix offered', async () => {
    const { caller } = setup({ declareNativeScreen: true, probes: { nativeGrants: undefined } });
    const report = await caller.cyboflow.verificationRequests.hostProbes();

    // "Nothing asked" is not "permission denied" — offering a grant CTA here
    // would ask the user to fix something that is not broken.
    for (const id of ['screen-recording', 'accessibility'] as const) {
      expect(probeRow(report, id).state).toBe('inconclusive');
      expect(probeRow(report, id).fix).toBeNull();
    }
  });

  it('maps an unanswerable grant probe to inconclusive, carrying its reason', async () => {
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'inconclusive', detail: 'peekaboo exited 64' }),
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'screen-recording');

    expect(row.state).toBe('inconclusive');
    expect(row.detail).toMatch(/exited 64/);
  });

  it('treats a MISSING capture binary as inconclusive about the grants, not as a denial', async () => {
    // No binary means no observation of the grant either way. Telling the user
    // to go grant a permission would not fix a binary that is not there.
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'binary-missing', detail: 'the peekaboo binary could not be run' }),
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'accessibility');

    expect(row.state).toBe('inconclusive');
    expect(row.fix).toBeNull();
    expect(row.detail).toMatch(/peekaboo/);
  });

  it('honours the fail-open rule even when nativeGrants violates its no-throw contract', async () => {
    const { caller } = setup({
      probes: { nativeGrants: async () => { throw new Error('probe exploded'); } },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'screen-recording');

    expect(row.state).toBe('inconclusive');
    expect(row.detail).toMatch(/probe exploded/);
  });

  // -------------------------------------------------------------------------
  // The 'mobile-simulator' row (mobile-verification-tier.md §10, T15)
  // -------------------------------------------------------------------------

  it('reports the composed mobile row verbatim, detail bounded, on a capable host', async () => {
    const { caller } = setup();
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'mobile-simulator');

    expect(row.state).toBe('ok');
    expect(row.detail).toMatch(/Xcode 26\.2/);
    expect(row.detail).toMatch(/iOS 26\.2/);
    expect(row.detail).toMatch(/maestro/);
    // Nothing about the Xcode MCP: Stage 1 runs on Apple's own CLI tools, and
    // the MCP grant is design-only (§11).
    expect(row.detail.toLowerCase()).not.toMatch(/mcpbridge/);
    expect(row.fix).toBeNull();
  });

  it('passes an AFFIRMATIVE absence through as missing, still with no fix', async () => {
    const { caller } = setup({
      probes: {
        mobileSimulator: async () => ({
          id: 'mobile-simulator' as const,
          state: 'missing' as const,
          detail: 'Xcode 26.2 · no available iOS runtime · maestro not found',
          fix: null,
        }),
      },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'mobile-simulator');

    expect(row.state).toBe('missing');
    // The app can install neither Xcode nor Maestro, so no state of this row
    // has an action behind it.
    expect(row.fix).toBeNull();
  });

  it('forces fix to null even when a composition offers one', async () => {
    const { caller } = setup({
      probes: {
        mobileSimulator: async () => ({
          id: 'mobile-simulator' as const,
          state: 'missing' as const,
          detail: 'no Xcode',
          // A fix the panel would render as a button with nothing behind it.
          fix: 'provision-chromium' as const,
        }),
      },
    });

    expect(
      probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'mobile-simulator').fix,
    ).toBeNull();
  });

  it('reports inconclusive — never missing — when no mobile composition is wired', async () => {
    const { caller } = setup({ probes: { mobileSimulator: undefined } });
    const report = await caller.cyboflow.verificationRequests.hostProbes();
    const row = probeRow(report, 'mobile-simulator');

    // The row is UNCONDITIONAL: an unwired probe still reports, honestly.
    expect(report.probes.map((p) => p.id)).toContain('mobile-simulator');
    expect(row.state).toBe('inconclusive');
    expect(row.detail).toMatch(/no mobile toolchain probe wired/);
    expect(row.fix).toBeNull();
  });

  it('honours the fail-open rule when the mobile probe violates its no-throw contract', async () => {
    const { caller } = setup({
      probes: { mobileSimulator: async () => { throw new Error('simctl exploded'); } },
    });
    const row = probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'mobile-simulator');

    // A contract violation is not evidence that this host has no Xcode.
    expect(row.state).toBe('inconclusive');
    expect(row.detail).toMatch(/simctl exploded/);
    expect(row.fix).toBeNull();
  });

  it('does not let a thrown mobile probe take down the other three rows', async () => {
    const { caller } = setup({
      probes: { mobileSimulator: async () => { throw new Error('boom'); } },
    });
    const report = await caller.cyboflow.verificationRequests.hostProbes();

    expect(report.probes.map((p) => p.id)).toEqual([
      'browser-driving',
      'screen-recording',
      'accessibility',
      'mobile-simulator',
    ]);
    expect(probeRow(report, 'browser-driving').state).toBe('ok');
  });

  it('PRECONDITION_FAILEDs when probes are unwired instead of reporting a bare host', async () => {
    const db = buildDb();
    cleanups.push(db);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    // A host that was never asked is not a host with nothing installed.
    await expect(caller.cyboflow.verificationRequests.hostProbes()).rejects.toThrow(TRPCError);
    await expect(caller.cyboflow.verificationRequests.requestAccessibility()).rejects.toThrow(TRPCError);
    await expect(
      caller.cyboflow.verificationRequests.openScreenRecordingSettings(),
    ).rejects.toThrow(TRPCError);
  });

  it('requestAccessibility fires the action and returns the RE-PROBED report', async () => {
    let prompted = 0;
    let granted = false;
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'ok', screenRecording: true, accessibility: granted }),
        requestAccessibility: async () => {
          prompted += 1;
          granted = true;
        },
      },
    });

    expect(probeRow(await caller.cyboflow.verificationRequests.hostProbes(), 'accessibility').state).toBe(
      'missing',
    );
    const after = await caller.cyboflow.verificationRequests.requestAccessibility();
    expect(prompted).toBe(1);
    expect(probeRow(after, 'accessibility').state).toBe('ok');
  });

  it('still re-probes when a grant action is unwired or THROWS, rather than failing the mutation', async () => {
    // The user's real answer is the re-probed report; a failed mutation would
    // just leave the panel on its pre-attempt rows.
    const { caller: unwired } = setup({ probes: { openScreenRecordingSettings: undefined } });
    const a = await unwired.cyboflow.verificationRequests.openScreenRecordingSettings();
    expect(probeRow(a, 'screen-recording').state).toBe('ok');

    const { caller: throwing } = setup({
      probes: { requestAccessibility: async () => { throw new Error('no such settings pane'); } },
    });
    const b = await throwing.cyboflow.verificationRequests.requestAccessibility();
    expect(probeRow(b, 'accessibility').state).toBe('ok');
  });

  it('a grant action that changed nothing reports the row STILL missing, not an error', async () => {
    // The user has not flipped the switch yet. That is the honest reading of
    // the host at that instant.
    const { caller } = setup({
      probes: {
        nativeGrants: async () => ({ kind: 'ok', screenRecording: false, accessibility: true }),
      },
    });
    const after = await caller.cyboflow.verificationRequests.openScreenRecordingSettings();
    expect(probeRow(after, 'screen-recording').state).toBe('missing');
  });

  it('provisionChromium re-probes and returns the fresh report, soft-failing on a failed install', async () => {
    let installed = false;
    const { caller } = setup({
      probes: {
        resolveChromium: async () => (installed ? '/chromium' : null),
        ensureChromium: async () => {
          installed = true;
          return true;
        },
      },
    });

    const before = await caller.cyboflow.verificationRequests.hostProbes();
    expect(probeRow(before, 'browser-driving').state).toBe('missing');

    // Returns the RE-PROBED report, so the panel never renders a stale
    // "missing" beside the success it just caused.
    const after = await caller.cyboflow.verificationRequests.provisionChromium();
    expect(probeRow(after, 'browser-driving').state).toBe('ok');
  });

  it('provisionChromium reports a still-missing binary rather than throwing', async () => {
    const { caller } = setup({
      probes: { resolveChromium: async () => null, ensureChromium: async () => false },
    });

    const after = await caller.cyboflow.verificationRequests.provisionChromium();
    expect(probeRow(after, 'browser-driving').state).toBe('missing');
  });

  it('provisionChromium still re-probes when the installer THROWS its contract', async () => {
    // A rejection is a contract violation (provisioning is documented to
    // resolve false), but the re-probe is the authority on whether chromium is
    // now present — and it answers just as well after a throwing installer.
    // Failing the mutation would leave the panel on its pre-attempt rows.
    let installed = false;
    const { caller } = setup({
      probes: {
        resolveChromium: async () => (installed ? '/chromium' : null),
        ensureChromium: async () => {
          installed = true;
          throw new Error('installer exploded after succeeding');
        },
      },
    });

    const after = await caller.cyboflow.verificationRequests.provisionChromium();
    expect(probeRow(after, 'browser-driving').state).toBe('ok');
  });
});

describe('verificationRequests.setupByProject', () => {
  const cleanups: Database.Database[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.close();
  });

  /**
   * `verifyRunbookStatus` stands in for the live conjunction the ENGINE
   * resolves (portable file present in the probed tree + input hash + host
   * fingerprint). It defaults to echoing the stored column, which is the
   * "nothing has drifted" case; a test that wants drift overrides it.
   *
   * Passing a resolver at all is the point: without one the router reports every
   * record as unproven, so a test that forgot to inject it cannot accidentally
   * assert a green badge.
   */
  function setup(
    migrations: readonly string[] = [...MIGRATIONS, '096_verify_runbook_local.sql'],
    verifyRunbookStatus: VerifyRunbookStatusLike = async () => ({ status: 'proven', reason: 'proven' }),
  ): {
    caller: ReturnType<typeof appRouter.createCaller>;
    db: Database.Database;
  } {
    const db = buildDb(migrations);
    cleanups.push(db);
    return {
      caller: appRouter.createCaller(createContext({ db: dbAdapter(db), verifyRunbookStatus })),
      db,
    };
  }

  function seedRunbook(
    db: Database.Database,
    projectId: number,
    modality: string,
    status: 'proven' | 'unproven-draft',
    hash = `h-${projectId}-${modality}`,
  ): void {
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, status)
       VALUES (?, ?, ?, '{}', ?)`,
    ).run(projectId, modality, hash, status);
  }

  it('separates a project with a PROVEN runbook from one whose drafts are all unproven', async () => {
    // The distinction the panel exists to draw: an all-unproven project looks
    // configured while the degrade gate skips every single check.
    const { caller, db } = setup();
    seedRunbook(db, 1, 'web', 'proven');
    seedRunbook(db, 2, 'web', 'unproven-draft');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows).toEqual([
      { projectId: 1, status: 'proven', provenModalities: ['web'], hasLaneDerivedRunbook: false },
      { projectId: 2, status: 'unproven', provenModalities: [], hasLaneDerivedRunbook: false },
    ]);
  });

  it('lists only the PROVEN modalities of a project that has both', async () => {
    const { caller, db } = setup();
    seedRunbook(db, 1, 'web', 'proven');
    seedRunbook(db, 1, 'native-screen', 'unproven-draft');
    seedRunbook(db, 1, 'cdp-app', 'proven');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    // VERIFICATION_MODALITIES order, not insertion order.
    expect(rows).toEqual([
      { projectId: 1, status: 'proven', provenModalities: ['web', 'cdp-app'], hasLaneDerivedRunbook: false },
    ]);
  });

  it('omits a project with no runbook row at all — absence IS the answer', async () => {
    // The caller holds the project list and reads an absent id as `none`, so
    // emitting a row per project would duplicate a fact it already has.
    const { caller, db } = setup();
    seedRunbook(db, 2, 'web', 'proven');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows.map((r) => r.projectId)).toEqual([2]);
  });

  it('degrades to an empty list on a pre-096 DB rather than throwing', async () => {
    // The table is absent before 096. Every project then reads `not set up` in
    // the panel, which is the truth on a host that has never run setup.
    const { caller } = setup(MIGRATIONS);

    await expect(caller.cyboflow.verificationRequests.setupByProject()).resolves.toEqual([]);
  });

  it('ignores a runbook row whose modality is not one we know', async () => {
    // Forward-compat: a newer build's modality must not be counted as proven by
    // an older one that cannot run it.
    const { caller, db } = setup();
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, status)
       VALUES (1, 'holodeck', 'h', '{}', 'proven')`,
    ).run();

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows).toEqual([{ projectId: 1, status: 'unproven', provenModalities: [], hasLaneDerivedRunbook: false }]);
  });

  it('a record marked proven whose runbook is NOT in the project checkout reads `unproven`', async () => {
    // THE REGRESSION. The setup flow commits the portable half on its own
    // branch; until that merges, the project checkout does not carry
    // `.cyboflow/verify-runbook.json`, so VerifyRunbookStore.status() answers
    // 'unproven-draft' (its documented pre-merge case, which deliberately does
    // NOT demote the record) and the §3.2 gate skips every build/serve request
    // with "no proven verification runbook".
    //
    // Reading `verify_runbook_local.status` directly showed "Set up" through all
    // of that — a green badge over precisely the failure it exists to warn
    // about. Observed for real: a project whose proof lived on an unmerged
    // branch showed as set up while every verification it queued was refused.
    const { caller, db } = setup(undefined, async () => ({ status: 'unproven-draft', reason: 'draft' }));
    seedRunbook(db, 1, 'web', 'proven');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows).toEqual([{ projectId: 1, status: 'unproven', provenModalities: [], hasLaneDerivedRunbook: false }]);
  });

  it('reports `unproven` when no resolver is wired — never a spurious `proven`', async () => {
    // The store's invariant ("no failure mode may produce a spurious 'proven'")
    // extends to its consumers: an unwired resolver is a wiring bug, and the
    // reassuring answer is the one that must not survive it.
    const db = buildDb([...MIGRATIONS, '096_verify_runbook_local.sql']);
    cleanups.push(db);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, status)
       VALUES (1, 'web', 'h', '{}', 'proven')`,
    ).run();

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows).toEqual([{ projectId: 1, status: 'unproven', provenModalities: [], hasLaneDerivedRunbook: false }]);
  });

  it('a THROWING resolver degrades that modality rather than failing the query', async () => {
    const { caller, db } = setup(undefined, async () => {
      throw new Error('probe blew up');
    });
    seedRunbook(db, 1, 'web', 'proven');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(rows).toEqual([{ projectId: 1, status: 'unproven', provenModalities: [], hasLaneDerivedRunbook: false }]);
  });

  it('does not probe a record already stored unproven — the conjunction can only demote', async () => {
    // The stored column is one conjunct: a record that is not proven cannot be
    // promoted by re-checking the others. Probing it would burn a file read and
    // an input hash to reach the answer already in hand.
    const probed: string[] = [];
    const { caller, db } = setup(undefined, async (projectId, modality) => {
      probed.push(`${projectId}:${modality}`);
      return { status: 'proven', reason: 'proven' } as const;
    });
    seedRunbook(db, 1, 'web', 'unproven-draft');
    seedRunbook(db, 1, 'cdp-app', 'proven');

    const rows = await caller.cyboflow.verificationRequests.setupByProject();

    expect(probed).toEqual(['1:cdp-app']);
    expect(rows).toEqual([{ projectId: 1, status: 'proven', provenModalities: ['cdp-app'], hasLaneDerivedRunbook: false }]);
  });
});
