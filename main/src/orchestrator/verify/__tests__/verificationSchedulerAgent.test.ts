/**
 * VerificationScheduler — verification-AGENT dispatch (redesign §5.4/§5.7/§5.8).
 *
 * Focus: a run stamped verify_chain=['agent'] routes its requests to the injected
 * VerificationAgentRunner (NOT the capture-backend waterfall), the runner's mapped
 * verdict + report are persisted in the terminal write (report_json), a LEGACY stamp
 * still selects backends, and the agent deadline is honored via the existing
 * per-request abort machinery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  VerificationScheduler,
  ResourceLeasePool,
  type OnVerdict,
} from '../verificationScheduler';
import { Mutex } from '../../../utils/mutex';
import { setSeamErrorSink } from '../../telemetrySink';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type {
  VerificationAgentRunnerLike,
  VerificationAgentRequest,
  VerificationAgentRunResult,
} from '../verificationAgentRunner';
import type {
  CaptureResult,
  ResolvedVisualVerifyConfig,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
  VerdictV1,
} from '../../../../../shared/types/visualVerification';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
      judge_calls_used INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seedRun(
  db: Database.Database,
  runId: string,
  verifyChain: string | null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
     VALUES (?, 1, ?, '/live/worktree', 'claude', 'claude-sonnet-5')`,
  ).run(runId, verifyChain);
}

const CONFIG: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [29260, 29262],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
};

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'agent says pass',
  judgedFileNames: ['s.png'],
  baselineUsed: false,
  model: 'claude-x',
};

const fakeJudge: VlmJudge = { judge: async () => PASS_VERDICT };

function fakeBackend(capture: ReturnType<typeof vi.fn>): VisualBackend {
  return {
    id: 'capturePage' as VisualBackendId,
    rung: 0,
    requiredLease: () => null,
    healthCheck: async () => true,
    capture: capture as unknown as VisualBackend['capture'],
  };
}

async function flushDrain(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

let db: Database.Database;

beforeEach(() => {
  setSeamErrorSink(() => {});
  db = buildDb();
  VerificationScheduler._resetForTesting();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
});

describe("VerificationScheduler — ['agent'] stamp dispatch", () => {
  it('routes an agent-stamped run to the runner, persists report_json + a passed verdict, never touches backends', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));

    const report = {
      version: 1 as const,
      behaviors: [{ id: 'b1', result: 'pass' as const, evidence: { screenshots: ['s.png'], notes: 'ok' } }],
      screenshots: [{ fileName: 's.png', caption: 'c' }],
      outcome: 'pass' as const,
      confidence: 0.9,
      feedback: 'good',
      issues: [],
    };
    const runResult: VerificationAgentRunResult = {
      status: 'passed',
      verdict: PASS_VERDICT,
      report,
      fileNames: ['s.png'],
    };
    const run = vi.fn(async (_req: VerificationAgentRequest) => runResult);
    const agentRunner: VerificationAgentRunnerLike = { run };

    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);
    const verdicts: Array<{ status: string }> = [];
    const onVerdict: OnVerdict = (args) => {
      verdicts.push({ status: args.status });
    };

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      agentRunner,
    });

    scheduler.enqueue({
      runId: 'run-agent',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'verify the widget', taskRef: 'TASK-1' },
      chain: [],
      task: {
        version: 1,
        summary: 'verify the widget',
        behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
        serve: { cmd: 'pnpm dev --port ${PORT}' },
      },
      snapshotSha: 'sha-1',
    });
    await flushDrain();

    // The runner was deployed; the backend was NOT.
    expect(run).toHaveBeenCalledTimes(1);
    expect(captureSpy).not.toHaveBeenCalled();

    // The runner received the composed task + snapshot sha + a leased port (serve implies a server).
    const req = run.mock.calls[0][0];
    expect(req.task.summary).toBe('verify the widget');
    expect(req.snapshotSha).toBe('sha-1');
    expect(req.verifyPort).not.toBeNull();
    expect(req.verifyDriverPort).toBe((req.verifyPort as number) + 1);

    // Terminal status + report_json persisted in the SAME row.
    const row = db
      .prepare('SELECT status, report_json, verdict_json FROM verification_requests LIMIT 1')
      .get() as { status: string; report_json: string | null; verdict_json: string | null };
    expect(row.status).toBe('passed');
    expect(JSON.parse(row.report_json ?? 'null').outcome).toBe('pass');
    expect(JSON.parse(row.verdict_json ?? 'null').status).toBe('pass');
    expect(verdicts).toEqual([{ status: 'passed' }]);
  });

  it('leaves the LEGACY-stamped run on the backend path (runner untouched)', async () => {
    seedRun(db, 'run-legacy', JSON.stringify(['capturePage']));

    const run = vi.fn(async (_req: VerificationAgentRequest): Promise<VerificationAgentRunResult> => ({
      status: 'passed',
      fileNames: [],
    }));
    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: { run },
    });

    scheduler.enqueue({
      runId: 'run-legacy',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM verification_requests LIMIT 1').get() as { status: string };
    expect(row.status).toBe('passed');
  });

  it("skips (fail-open) an agent-stamped run when no runner is configured", async () => {
    seedRun(db, 'run-agent-2', JSON.stringify(['agent']));
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      // no agentRunner injected
    });
    scheduler.enqueue({
      runId: 'run-agent-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    const row = db
      .prepare('SELECT status, error_message FROM verification_requests LIMIT 1')
      .get() as { status: string; error_message: string | null };
    expect(row.status).toBe('skipped');
    expect(row.error_message).toContain('not configured');
  });

  it('honors the agent deadline (a runner that never settles → timeout)', async () => {
    seedRun(db, 'run-agent-3', JSON.stringify(['agent']));
    const run = vi.fn(
      (_req: VerificationAgentRequest) => new Promise<VerificationAgentRunResult>(() => {}), // never resolves
    );
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: { run },
      agentRequestTimeoutMs: 20, // tiny deadline
      agentRequestCeilingMs: 1000,
    });
    scheduler.enqueue({
      runId: 'run-agent-3',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    // Wait past the 20ms deadline, then flush.
    await new Promise((r) => setTimeout(r, 60));
    await flushDrain();
    const row = db.prepare('SELECT status FROM verification_requests LIMIT 1').get() as { status: string };
    expect(row.status).toBe('timeout');
  });
});

describe('VerificationScheduler — legacy kill-switch boot terminalization (§5.8)', () => {
  /** Insert a row directly at `status`, attributed to `runId`, for boot-recovery tests. */
  function insertRow(
    dbX: Database.Database,
    opts: { id: string; runId: string; status: 'queued' | 'leased' | 'running'; taskRef?: string },
  ): void {
    dbX
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
         VALUES (?, ?, 1, ?, 'static-render-snapshot', ?, '[]', 0, CURRENT_TIMESTAMP)`,
      )
      .run(
        opts.id,
        opts.runId,
        opts.status,
        JSON.stringify({ intent: 'x', ...(opts.taskRef ? { taskRef: opts.taskRef } : {}) }),
      );
  }

  it('flag SET: terminalizes queued/leased/running agent-stamped rows as skipped + delivers, legacy-stamped rows untouched', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    seedRun(db, 'run-legacy', JSON.stringify(['capturePage']));

    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued', taskRef: 'TASK-1' });
    insertRow(db, { id: 'vr_a_leased', runId: 'run-agent', status: 'leased' });
    insertRow(db, { id: 'vr_a_running', runId: 'run-agent', status: 'running' });
    insertRow(db, { id: 'vr_l_queued', runId: 'run-legacy', status: 'queued' });

    const verdicts: Array<{ requestId: string; status: string }> = [];
    const onVerdict: OnVerdict = (a) => void verdicts.push({ requestId: a.requestId, status: a.status });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      legacyKillSwitch: () => true,
    });

    const n = await scheduler.runRecovery();
    expect(n).toBe(3); // the three agent-stamped rows

    const agentRows = db
      .prepare(`SELECT id, status, error_message AS error FROM verification_requests WHERE run_id = 'run-agent' ORDER BY id`)
      .all() as Array<{ id: string; status: string; error: string | null }>;
    for (const row of agentRows) {
      expect(row.status).toBe('skipped');
      expect(row.error).toContain('agent engine disabled');
      expect(row.error).toContain('CYBOFLOW_VERIFY_LEGACY');
    }

    // legacy-stamped row is completely untouched by the kill switch — still queued
    // (the pre-existing recovery only terminalizes leased/running orphans + stale
    // queued rows past the age ceiling; a fresh queued row is left queued either way).
    const legacyRow = db
      .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_l_queued'`)
      .get() as { status: string };
    expect(legacyRow.status).toBe('queued');

    // The lane advanced through the normal delivery path (non-blocking finding raised).
    expect(verdicts.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual(
      [
        { requestId: 'vr_a_leased', status: 'skipped' },
        { requestId: 'vr_a_queued', status: 'skipped' },
        { requestId: 'vr_a_running', status: 'skipped' },
      ].sort((a, b) => a.requestId.localeCompare(b.requestId)),
    );
  });

  it('flag UNSET (default posture): byte-identical recovery — agent rows keep their pre-existing fate, not the kill-switch reason', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued' });
    insertRow(db, { id: 'vr_a_leased', runId: 'run-agent', status: 'leased' });

    const verdicts: string[] = [];
    const onVerdict: OnVerdict = (a) => void verdicts.push(a.status);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      legacyKillSwitch: () => false,
    });

    const n = await scheduler.runRecovery();
    // Only the pre-existing orphan sweep fires (the leased row → timeout); the
    // fresh queued row is untouched (not over the age ceiling).
    expect(n).toBe(1);

    const leased = db
      .prepare(`SELECT status, error_message AS error FROM verification_requests WHERE id = 'vr_a_leased'`)
      .get() as { status: string; error: string | null };
    expect(leased.status).toBe('timeout');
    expect(leased.error).toBe('orphaned by process restart');
    expect(leased.error).not.toContain('CYBOFLOW_VERIFY_LEGACY');

    const queued = db
      .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_a_queued'`)
      .get() as { status: string };
    expect(queued.status).toBe('queued');
    expect(verdicts).toEqual(['timeout']);
  });

  it('defaults to reading process.env.CYBOFLOW_VERIFY_LEGACY when no legacyKillSwitch dep is injected', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued' });

    const prior = process.env.CYBOFLOW_VERIFY_LEGACY;
    process.env.CYBOFLOW_VERIFY_LEGACY = '1';
    try {
      const scheduler = VerificationScheduler.initialize({
        db: dbAdapter(db),
        backends: {},
        judge: fakeJudge,
        artifactsDirResolver: () => '/artifacts',
        config: CONFIG,
        leasePool: new ResourceLeasePool(new Mutex()),
        // no legacyKillSwitch injected — must fall back to process.env
      });
      const n = await scheduler.runRecovery();
      expect(n).toBe(1);
      const row = db
        .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_a_queued'`)
        .get() as { status: string };
      expect(row.status).toBe('skipped');
    } finally {
      if (prior === undefined) delete process.env.CYBOFLOW_VERIFY_LEGACY;
      else process.env.CYBOFLOW_VERIFY_LEGACY = prior;
    }
  });
});

describe('ResourceLeasePool.quarantine (§5.4 step 6)', () => {
  it('holds a leaked lease until its re-probe reports the resource free', async () => {
    const pool = new ResourceLeasePool(new Mutex());
    const handle = await pool.tryAcquire('verify:port:29260');
    expect(handle).not.toBeNull();

    let free = false;
    pool.quarantine(handle!, async () => free, 'leaked port');
    expect(pool.isQuarantined('verify:port:29260')).toBe(true);

    // Still bound ⇒ a later acquisition of the quarantined slot is refused.
    expect(await pool.tryAcquireOneOf(['verify:port:29260'])).toBeNull();

    // The resource frees ⇒ the re-probe clears the quarantine and hands the slot out.
    free = true;
    const reacquired = await pool.tryAcquireOneOf(['verify:port:29260']);
    expect(reacquired).not.toBeNull();
    expect(pool.isQuarantined('verify:port:29260')).toBe(false);
  });
});
