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
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
  AWAIT_TERMINAL_TIMEOUT_MESSAGE,
  VERIFY_NO_RUNBOOK_REASON,
  VERIFY_RUNBOOK_DRIFTED_REASON,
  VERIFY_RUNBOOK_ELSEWHERE_REASON,
  VERIFY_RUNBOOK_UNREADABLE_REASON,
  VERIFY_UNPROVEN_SKIP_BLOCKED,
  type OnVerdict,
} from '../verificationScheduler';
import { VerifyCapabilityStore, CAPABILITY_BREAKER_THRESHOLD } from '../capabilityStore';
import { VerifyRunbookStore } from '../runbookStore';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';
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
  VerificationTaskV1,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
  VerdictV1,
} from '../../../../../shared/types/visualVerification';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id                        INTEGER PRIMARY KEY,
      path                      TEXT,
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
      -- migration 095 (docs/proposals/verification-setup-flow.md §3)
      failure_class         TEXT,
      failure_evidence_json TEXT,
      modality              TEXT,
      preflight_json        TEXT,
      setup_proof           INTEGER NOT NULL DEFAULT 0,
      -- migration 107 (docs/proposals/lane-runbook-bootstrap.md §5)
      bootstrap_proof       INTEGER NOT NULL DEFAULT 0,
      -- migration 096 (§5.2 seam 3): the content-addressed runbook PIN.
      runbook_hash          TEXT,
      runbook_local_version INTEGER
    );
    CREATE TABLE verify_runbook_local (
      project_id            INTEGER NOT NULL,
      modality              TEXT NOT NULL,
      portable_hash         TEXT NOT NULL,
      portable_json         TEXT NOT NULL,
      version               INTEGER NOT NULL DEFAULT 1,
      status                TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
      bindings_json         TEXT,
      proof_json            TEXT,
      input_hash            TEXT,
      host_fingerprint_json TEXT,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, modality)
    );
    CREATE TABLE verify_capability_state (
      project_id               INTEGER NOT NULL,
      modality                 TEXT NOT NULL,
      runbook_hash             TEXT NOT NULL DEFAULT '',
      status                   TEXT NOT NULL CHECK (status IN ('active','suppressed','unsupported')),
      reason                   TEXT NOT NULL DEFAULT '',
      consecutive_env_failures INTEGER NOT NULL DEFAULT 0,
      host_generation          INTEGER NOT NULL DEFAULT 0,
      suppressed_until         DATETIME,
      updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, modality, runbook_hash)
    );
    CREATE TABLE verify_host_state (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      capability_generation INTEGER NOT NULL DEFAULT 0,
      fingerprint_json      TEXT,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, visual_verify_budget_calls) VALUES (1, NULL)').run();
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
  agentSlots: 2,
  autoBootstrapRunbook: false,
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
      deployed: true,
      provisionMode: 'snapshot',
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
      // The composed task below has a serve step, so the §3.2 degrade gate would
      // skip it on the default 'absent' runbook status. This test is about the
      // dispatch path, so it stands in for a project phase 2 has already proven.
      runbookStatus: async () => ({ status: 'proven', reason: 'proven' }),
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
        // Above the 10-min query default, below the 20-min ceiling — proves the
        // extended deadline threads through to the runner request.
        timeoutMs: 900_000,
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
    // The scheduler's effective deadline (task.timeoutMs capped by the ceiling)
    // rides on the request so the query boundary uses the SAME bound.
    expect(req.timeoutMs).toBe(900_000);

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
      deployed: true,
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
    const row = db
      .prepare('SELECT status, judge_calls_used FROM verification_requests LIMIT 1')
      .get() as { status: string; judge_calls_used: number };
    expect(row.status).toBe('timeout');
    // §3.6: a deadline expiry IS charged — the deadline is minutes long while
    // preflight settles in under a second, so a timed-out runner was past its
    // pre-deploy gate and an SDK session was spent (the runner's own `deployed`
    // flag is unobservable on this path because raceWithAbort rejects).
    expect(row.judge_calls_used).toBe(1);
  });
});

/**
 * F2 (RC5) — the composed `task.timeoutMs` may RAISE the agent deadline, never
 * lower it below the harness default.
 *
 * The outer `timeoutMs` is documented on no composer-facing surface (only the
 * nested `serve.readyWhen.timeoutMs` is), and a task-verify composer that
 * guessed `180000` had a healthy prove run killed at 180s mid-attestation —
 * build passed, app booted — while the identical task at `1200000` passed in
 * 7m18s. The floor makes a low guess inert; the ceiling is unchanged.
 *
 * Deliberately run against the PRODUCTION constants (no injected
 * agentRequestTimeoutMs), because the bug was about the real 10-minute default.
 */
describe('VerificationScheduler — the agent deadline floor (F2)', () => {
  it.each([
    ['a composer guess below the default is RAISED to it', 180_000, DEFAULT_AGENT_REQUEST_TIMEOUT_MS],
    ['a value between the default and the ceiling is honored verbatim', 15 * 60 * 1000, 15 * 60 * 1000],
    ['a value above the ceiling is still capped', 30 * 60 * 1000, AGENT_REQUEST_TIMEOUT_CEILING_MS],
  ])('%s', async (_label, requested, expected) => {
    const runId = `run-deadline-${requested}`;
    seedRun(db, runId, JSON.stringify(['agent']));
    const run = vi.fn(
      async (_req: VerificationAgentRequest): Promise<VerificationAgentRunResult> => ({
        status: 'passed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
      }),
    );
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: { run },
      runbookStatus: async () => ({ status: 'proven', reason: 'proven' }),
    });
    scheduler.enqueue({
      runId,
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      task: { ...SERVE_TASK, timeoutMs: requested },
      snapshotSha: 'sha-deadline',
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    // The deadline rides on the request so the query boundary uses the SAME bound.
    expect(run.mock.calls[0][0].timeoutMs).toBe(expected);
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

// ---------------------------------------------------------------------------
// isAgentEngineRequest — the REQUEST-level dispatch key (b5f25edb, "let quick
// sessions queue visual verifications over MCP").
//
// A `__quick__` chat sentinel's posture is resolved at MCP call time (there is
// no UPDATE path for a run's frozen `verify_chain` stamp), so the MCP handler
// writes the resolved chain verbatim onto the REQUEST row instead. The
// scheduler must therefore consult the request's own chain_json FIRST and only
// fall back to the run stamp when the request carries none — every dispatch
// site (drain, the legacy-kill-switch boot sweep, queued-age expiry
// provenance) goes through this one method, so these cases are written against
// each of those three call sites rather than only the drain path.
// ---------------------------------------------------------------------------
describe('VerificationScheduler — isAgentEngineRequest request-level dispatch key (quick sessions)', () => {
  it("a request whose OWN chain_json is '[\"agent\"]' dispatches to the agent engine even though its RUN is not agent-stamped (the __quick__ case)", async () => {
    // verify_chain NULL — a quick-session run never gets the frozen stamp at all.
    seedRun(db, 'run-quick', null);
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
    });
    scheduler.enqueue({
      runId: 'run-quick',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'verify the widget' },
      chain: ['agent'],
    });
    await flushDrain();

    // Without this rung the row would fall to the legacy waterfall, select no
    // candidate off an empty/foreign backend list, and terminate
    // skipped:'no usable backend' behind a healthy-looking reply — the whole
    // feature would be dead on arrival.
    expect(run).toHaveBeenCalledTimes(1);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(requestRow(db).status).toBe('passed');
  });

  it("REGRESSION: an agent-STAMPED run whose request persists chain_json '[]' (every flow run today) still dispatches to the agent engine via the run-stamp fallback", async () => {
    seedRun(db, 'run-flow', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
    });
    // The FALLBACK_CHAINS ∩ VisualBackendId[] intersection a flow run's MCP
    // handler computes for an 'agent'-stamped run is always empty — 'agent' is
    // not a VisualBackendId, so it never survives the intersection.
    scheduler.enqueue({
      runId: 'run-flow',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'verify the widget' },
      chain: [],
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(requestRow(db).status).toBe('passed');
  });

  it('a legacy-stamped run with a legacy request chain still runs the capture/VLM waterfall, unchanged', async () => {
    seedRun(db, 'run-legacy-2', JSON.stringify(['capturePage']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
    });
    scheduler.enqueue({
      runId: 'run-legacy-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(requestRow(db).status).toBe('passed');
  });

  /**
   * Insert a request row directly at `status` with an explicit `chain_json`,
   * for the boot-sweep / queued-age cases below — mirrors the file's own
   * `insertRow` idiom (§5.8 boot-terminalization describe above) but exposes
   * `chainJson` and `enqueuedAt` since those are exactly what these cases vary.
   */
  function insertQuickStyleRow(
    dbX: Database.Database,
    opts: {
      id: string;
      runId: string;
      status: 'queued' | 'leased' | 'running';
      chainJson: string;
      enqueuedAt?: string;
    },
  ): void {
    dbX
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
         VALUES (?, ?, 1, ?, 'static-render-snapshot', ?, ?, 0, ?)`,
      )
      .run(
        opts.id,
        opts.runId,
        opts.status,
        JSON.stringify({ intent: 'x', taskRef: 'TASK-1' }),
        opts.chainJson,
        opts.enqueuedAt ?? new Date().toISOString(),
      );
  }

  it("the CYBOFLOW_VERIFY_LEGACY boot sweep terminalizes a QUEUED quick-style request (chain_json '[\"agent\"]', run NOT agent-stamped) with the same 'agent engine disabled' provenance a flow run gets", async () => {
    // The run stamp alone says "not agent" — only the request's own chain_json
    // carries the quick session's resolved posture. Without isAgentEngineRequest
    // reading the request row, this row would never match the sweep's
    // isAgentStampedRun(row.run_id) check and would be stranded queued forever.
    seedRun(db, 'run-quick-2', null);
    insertQuickStyleRow(db, {
      id: 'vr_quick_queued',
      runId: 'run-quick-2',
      status: 'queued',
      chainJson: JSON.stringify(['agent']),
    });

    const verdicts: Array<{ requestId: string; status: string; captureOrigin?: string }> = [];
    const onVerdict: OnVerdict = (a) =>
      void verdicts.push({ requestId: a.requestId, status: a.status, captureOrigin: a.captureOrigin });

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
    expect(n).toBe(1);

    const row = db
      .prepare(`SELECT status, error_message AS error FROM verification_requests WHERE id = 'vr_quick_queued'`)
      .get() as { status: string; error: string | null };
    expect(row.status).toBe('skipped');
    expect(row.error).toContain('agent engine disabled');
    expect(row.error).toContain('CYBOFLOW_VERIFY_LEGACY');
    expect(verdicts).toEqual([{ requestId: 'vr_quick_queued', status: 'skipped', captureOrigin: 'agent' }]);
  });

  it("expireOverAgeQueued stamps captureOrigin 'agent' for an over-age quick-style row (chain_json '[\"agent\"]', run NOT agent-stamped)", async () => {
    seedRun(db, 'run-quick-3', null);
    let clock = 50_000_000;
    insertQuickStyleRow(db, {
      id: 'vr_quick_stale',
      runId: 'run-quick-3',
      status: 'queued',
      chainJson: JSON.stringify(['agent']),
      // Enqueued well before the clock — past the ceiling below.
      enqueuedAt: new Date(clock - 3_600_000).toISOString(),
    });

    const verdicts: Array<{ requestId: string; status: string; captureOrigin?: string }> = [];
    const onVerdict: OnVerdict = (a) =>
      void verdicts.push({ requestId: a.requestId, status: a.status, captureOrigin: a.captureOrigin });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: { ...CONFIG, queuedAgeCeilingMs: 5_000 },
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      now: () => clock,
    });
    await scheduler.drain();

    const row = db
      .prepare(`SELECT status, error_message AS error FROM verification_requests WHERE id = 'vr_quick_stale'`)
      .get() as { status: string; error: string | null };
    expect(row.status).toBe('skipped');
    expect(row.error).toMatch(/queued-age deadline exceeded/);
    // captureOrigin: 'agent' is forwarded to onVerdict (not a persisted column —
    // see verificationScheduler.ts's TerminalExtra/deliver) precisely because
    // isAgentEngineRequest, not the run stamp alone, recognized this row.
    expect(verdicts).toEqual([{ requestId: 'vr_quick_stale', status: 'skipped', captureOrigin: 'agent' }]);
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

// ---------------------------------------------------------------------------
// Phase 0 — honest failures (docs/proposals/verification-setup-flow.md §3)
// ---------------------------------------------------------------------------

/** A composed task WITH a serve step — the shape the §3.2 degrade gate acts on. */
const SERVE_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'verify the widget',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
  serve: { cmd: 'pnpm dev --port ${PORT}' },
};

/** The DEGENERATE task — a bare pre-live target, no build and no serve. */
const TARGET_ONLY_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'verify the live page',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
  target: { url: 'https://example.test/page' },
};

/** A runner stub that records every call and returns a caller-supplied result. */
function stubRunner(
  result: VerificationAgentRunResult,
): { runner: VerificationAgentRunnerLike; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_req: VerificationAgentRequest) => result);
  return { runner: { run }, run };
}

function requestRow(dbX: Database.Database): {
  status: string;
  error_message: string | null;
  failure_class: string | null;
  failure_evidence_json: string | null;
  modality: string | null;
  preflight_json: string | null;
  judge_calls_used: number;
} {
  return dbX
    .prepare(
      `SELECT status, error_message, failure_class, failure_evidence_json, modality, preflight_json, judge_calls_used
         FROM verification_requests LIMIT 1`,
    )
    .get() as ReturnType<typeof requestRow>;
}

describe('VerificationScheduler — §3.3 unsupported modality + suppression (pre-lease gates)', () => {
  it("a native-desktop request resolves 'skipped' with an explicit reason, marks the modality unsupported, and NEVER deploys", async () => {
    seedRun(db, 'run-native', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const markUnsupported = vi.spyOn(store, 'markUnsupported');
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: store,
    });
    scheduler.enqueue({
      runId: 'run-native',
      projectId: 1,
      type: 'native-desktop',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('native-screen');
    expect(row.error_message).toContain("unsupported modality 'native-screen'");
    expect(row.error_message).toContain('not yet wired');
    expect(row.failure_class).toBe('env');
    expect(JSON.parse(row.failure_evidence_json ?? '[]')).toHaveLength(1);
    // The 4th argument is the ledger's runbook-hash key: '' for this UNPINNED
    // row (no proven runbook), never omitted — the ledger is keyed
    // (project, modality, runbook_hash) and an omitted key silently pools every
    // revision into one bucket (Codex finding 7).
    expect(markUnsupported).toHaveBeenCalledWith(
      1,
      'native-screen',
      expect.stringContaining('unsupported modality'),
      '',
    );
  });

  it("a mobile-flow request skips with the 'deferred — pending Xcode MCP' reason", async () => {
    seedRun(db, 'run-mobile', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
    });
    scheduler.enqueue({
      runId: 'run-mobile',
      projectId: 1,
      type: 'mobile-flow',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('mobile');
    expect(row.error_message).toContain('Xcode MCP');
    expect(row.failure_class).toBe('env');
  });

  it('an ACTIVE suppression short-circuits the request before any lease', async () => {
    seedRun(db, 'run-suppressed', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    store.markUnsupported(1, 'web', 'no chromium on this host');
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: store,
    });
    scheduler.enqueue({
      runId: 'run-suppressed',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toContain('verification suppressed for web');
    expect(row.error_message).toContain('no chromium on this host');
    expect(row.failure_class).toBe('env');
  });
});

describe('VerificationScheduler — §3.2 degrade path (no proven runbook)', () => {
  /** Initialize a scheduler with a stub runner; returns the run spy. */
  function initWith(
    opts: Partial<Parameters<typeof VerificationScheduler.initialize>[0]> = {},
  ): { scheduler: VerificationScheduler; run: ReturnType<typeof vi.fn> } {
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
      ...opts,
    });
    return { scheduler, run };
  }

  it('a task with a serve step + NO proven runbook → skipped with the setup reason, never deployed', async () => {
    seedRun(db, 'run-degrade', JSON.stringify(['agent']));
    const { scheduler, run } = initWith(); // runbookStatus defaults to 'absent'
    scheduler.enqueue({
      runId: 'run-degrade',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
    expect(row.failure_class).toBe('env');
  });

  it("an 'unproven-draft' runbook is NOT a pass — a written config nobody proved is exactly what already failed", async () => {
    seedRun(db, 'run-draft', JSON.stringify(['agent']));
    const { scheduler, run } = initWith({ runbookStatus: async () => ({ status: 'unproven-draft', reason: 'draft' }) });
    scheduler.enqueue({
      runId: 'run-draft',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    expect(run).not.toHaveBeenCalled();
    expect(requestRow(db).error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
  });

  it('a PROVEN runbook lets the same task through', async () => {
    seedRun(db, 'run-proven', JSON.stringify(['agent']));
    const { scheduler, run } = initWith({ runbookStatus: async () => ({ status: 'proven', reason: 'proven' }) });
    scheduler.enqueue({
      runId: 'run-proven',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('a DEGENERATE target-only task bypasses the gate (it derives no environment)', async () => {
    seedRun(db, 'run-degenerate', JSON.stringify(['agent']));
    const { scheduler, run } = initWith();
    scheduler.enqueue({
      runId: 'run-degenerate',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      task: TARGET_ONLY_TASK,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('a bootstrap_proof row ALSO bypasses the gate — same deadlock, narrower privilege', async () => {
    // The lane bootstrap exists to produce the runbook the gate is complaining
    // about, so gating it is the identical deadlock §3.6 exempts setup_proof for.
    // It buys NOTHING else: the budget still charges it (asserted separately) and
    // it drains at ordinary priority.
    seedRun(db, 'run-bootstrap-proof', JSON.stringify(['agent']));
    const { scheduler, run } = initWith(); // runbookStatus defaults to 'absent'
    scheduler.enqueue({
      runId: 'run-bootstrap-proof',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      bootstrapProof: true,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('a setup_proof row bypasses the gate (proving the runbook is how a project stops being unproven)', async () => {
    seedRun(db, 'run-setup-proof', JSON.stringify(['agent']));
    const { scheduler, run } = initWith();
    scheduler.enqueue({
      runId: 'run-setup-proof',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      setupProof: true,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  /**
   * The gate EXPLAINS ITSELF (lane-runbook-bootstrap.md §4).
   *
   * Every case below skips the request, and every case answers `'unproven-draft'`
   * or `'absent'` — the collapsed status cannot tell them apart. The reason can,
   * and it has to: the remedy for a branch that merely lacks the runbook file is
   * to MERGE, and following the default "run verification setup" CTA there would
   * derive a fresh runbook over the proven singleton record every other branch
   * depends on.
   */
  it.each([
    ['proven-file-absent-here', 'unproven-draft', VERIFY_RUNBOOK_ELSEWHERE_REASON],
    ['drifted', 'unproven-draft', VERIFY_RUNBOOK_DRIFTED_REASON],
    // Both drifts skip with the SAME string on purpose (F4 fix round): they are
    // one fact to a request, and `runbookDeclineForSkipReason` reverse-maps this
    // text. Only the bootstrap tells them apart.
    ['content-drifted', 'unproven-draft', VERIFY_RUNBOOK_DRIFTED_REASON],
    ['indeterminate', 'absent', VERIFY_RUNBOOK_UNREADABLE_REASON],
    // The bootstrappable situations keep the ORIGINAL reason verbatim, so every
    // existing consumer and CTA keeps matching what it always matched.
    ['no-record', 'absent', VERIFY_NO_RUNBOOK_REASON],
    ['draft', 'unproven-draft', VERIFY_NO_RUNBOOK_REASON],
    ['file-only', 'unproven-draft', VERIFY_NO_RUNBOOK_REASON],
  ] as const)('a %s runbook skips with its own reason', async (reason, status, expected) => {
    seedRun(db, `run-reason-${reason}`, JSON.stringify(['agent']));
    const { scheduler, run } = initWith({
      runbookStatus: async () => ({ status, reason }),
    });
    scheduler.enqueue({
      runId: `run-reason-${reason}`,
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toBe(expected);
  });

  /**
   * WHICH TREE the gate asks about (lane-runbook-bootstrap.md §3, decision B).
   *
   * The gate used to pass no path at all, so index.ts probed the PROJECT ROOT —
   * while `resolveProvenRunbook` had always probed the requesting run's
   * worktree. Two seams, two trees, one question. A runbook a run commits to its
   * own branch was therefore invisible to the gate until the branch merged, so
   * every request in that run kept skipping even after a successful proof.
   */
  it("passes the requesting run's worktree as the probe path", async () => {
    seedRun(db, 'run-probe', JSON.stringify(['agent'])); // worktree_path '/live/worktree'
    const probed: Array<string | undefined> = [];
    const { scheduler, run } = initWith({
      runbookStatus: async (_projectId, _modality, probePath) => {
        probed.push(probePath);
        // Proven ONLY in the tree that would actually execute — the exact state
        // a run that just committed its own runbook is in before merging.
        return probePath === '/live/worktree'
          ? { status: 'proven', reason: 'proven' }
          : { status: 'absent', reason: 'no-record' };
      },
    });
    scheduler.enqueue({
      runId: 'run-probe',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();

    expect(probed).toEqual(['/live/worktree']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('passes undefined for a run with no worktree, leaving the project-root fallback intact', async () => {
    db.prepare(
      `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
       VALUES (?, 1, ?, NULL, 'claude', 'claude-sonnet-5')`,
    ).run('run-no-worktree', JSON.stringify(['agent']));
    const probed: Array<string | undefined> = [];
    const { scheduler, run } = initWith({
      runbookStatus: async (_projectId, _modality, probePath) => {
        probed.push(probePath);
        return { status: 'proven', reason: 'proven' };
      },
    });
    scheduler.enqueue({
      runId: 'run-no-worktree',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();

    // `undefined`, not the project path and not a null the store would probe as
    // a directory: resolving the fallback is the THUNK's job, and it is the one
    // place that knows the project row.
    expect(probed).toEqual([undefined]);
    // The gate itself let this through — it skips further down, on the
    // pre-existing "a deployment needs a worktree to snapshot" rule, which is
    // exactly what should still happen and is not this gate's business.
    const row = requestRow(db);
    expect(row.error_message).toBe('run worktree path unavailable');
    expect(row.error_message).not.toBe(VERIFY_NO_RUNBOOK_REASON);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('VerificationScheduler — §3.6 budget accounting', () => {
  function initWith(result: VerificationAgentRunResult): {
    scheduler: VerificationScheduler;
    run: ReturnType<typeof vi.fn>;
  } {
    const { runner, run } = stubRunner(result);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
    });
    return { scheduler, run };
  }

  it('deployed:true → judge_calls_used is incremented', async () => {
    seedRun(db, 'run-budget-1', JSON.stringify(['agent']));
    const { scheduler } = initWith({ status: 'passed', fileNames: [], deployed: true });
    scheduler.enqueue({
      runId: 'run-budget-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    expect(requestRow(db).judge_calls_used).toBe(1);
  });

  it('deployed:false (a §3.5 preflight skip) → judge_calls_used is NOT incremented', async () => {
    seedRun(db, 'run-budget-2', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'skipped',
      fileNames: [],
      deployed: false,
      errorMessage: 'chromium not resolved (absent)',
      preflight: {
        ok: false,
        checks: [{ id: 'chromium', ok: false, detail: 'chromium not resolved (absent)' }],
      },
    });
    scheduler.enqueue({
      runId: 'run-budget-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    const row = requestRow(db);
    expect(row.judge_calls_used).toBe(0);
    expect(row.status).toBe('skipped');
    // The preflight is persisted for the phase-3 health panel either way.
    expect(JSON.parse(row.preflight_json ?? 'null')).toMatchObject({ ok: false });
  });

  it('a bootstrap_proof row is NOT budget-exempt — an exhausted budget still skips it', async () => {
    // THE LINE BETWEEN THE TWO PROOF KINDS. A budget exemption is defensible for a
    // flow a human launches once per project; it is not defensible for something a
    // lane reaches on every sprint, which is exactly the runaway `setup_proof`'s
    // workflow-identity check exists to prevent. So the bootstrap takes the gate
    // exemption and NOT this one.
    seedRun(db, 'run-budget-boot', JSON.stringify(['agent']));
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 1 WHERE id = 1').run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_spent_boot', 'run-budget-boot', 1, 'passed', 'static-render-snapshot', '{}', 1)`,
    ).run();

    const { scheduler, run } = initWith({ status: 'passed', fileNames: [], deployed: true });
    const requestId = scheduler.enqueue({
      runId: 'run-budget-boot',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      bootstrapProof: true,
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT status, error_message AS err FROM verification_requests WHERE id = ?')
      .get(requestId) as { status: string; err: string | null };
    expect(row.status).toBe('skipped');
    expect(row.err).toContain('budget exhausted');
  });

  it('a setup_proof row BYPASSES an exhausted budget and is never counted against it', async () => {
    seedRun(db, 'run-budget-3', JSON.stringify(['agent']));
    // Budget of 1, already fully consumed by a prior request for this project.
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 1 WHERE id = 1').run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_spent', 'run-budget-3', 1, 'passed', 'static-render-snapshot', '{}', 1)`,
    ).run();

    const { scheduler, run } = initWith({ status: 'passed', fileNames: [], deployed: true });
    const requestId = scheduler.enqueue({
      runId: 'run-budget-3',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      setupProof: true,
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1); // NOT short-circuited by the exhausted budget
    const row = db
      .prepare('SELECT status, judge_calls_used AS used FROM verification_requests WHERE id = ?')
      .get(requestId) as { status: string; used: number };
    expect(row.status).toBe('passed');
    expect(row.used).toBe(0); // never charged
  });

  it('an ORDINARY row still fail-opens to skipped on an exhausted budget (unchanged)', async () => {
    seedRun(db, 'run-budget-4', JSON.stringify(['agent']));
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 1 WHERE id = 1').run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_spent2', 'run-budget-4', 1, 'passed', 'static-render-snapshot', '{}', 1)`,
    ).run();

    const { scheduler, run } = initWith({ status: 'passed', fileNames: [], deployed: true });
    const requestId = scheduler.enqueue({
      runId: 'run-budget-4',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT status, error_message AS err FROM verification_requests WHERE id = ?')
      .get(requestId) as { status: string; err: string | null };
    expect(row.status).toBe('skipped');
    expect(row.err).toContain('budget exhausted');
  });
});

describe('VerificationScheduler — §3.1 classification + §3.4 capability feedback', () => {
  const PREFLIGHT_FAIL = {
    ok: false,
    checks: [
      { id: 'port-free' as const, ok: false, detail: 'port 29260 is occupied — a connect probe succeeded (squatter)' },
    ],
  };

  function initWith(
    result: VerificationAgentRunResult,
    opts: {
      store?: VerifyCapabilityStore;
      capabilityFinding?: ReturnType<typeof vi.fn>;
    } = {},
  ): { scheduler: VerificationScheduler; run: ReturnType<typeof vi.fn> } {
    const { runner, run } = stubRunner(result);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: opts.store ?? new VerifyCapabilityStore(dbAdapter(db)),
      ...(opts.capabilityFinding ? { capabilityFinding: opts.capabilityFinding } : {}),
    });
    return { scheduler, run };
  }

  function enqueueOne(scheduler: VerificationScheduler, runId: string): string {
    return scheduler.enqueue({
      runId,
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
  }

  it("a FAILED terminal with harness preflight evidence is CONVERTED to 'skipped' (env class)", async () => {
    seedRun(db, 'run-env', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'failed',
      fileNames: [],
      deployed: true,
      provisionMode: 'snapshot',
      errorMessage: 'build blew up',
      preflight: PREFLIGHT_FAIL,
    });
    enqueueOne(scheduler, 'run-env');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('skipped'); // converted — the lane advances, no retry charged
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain('environment failure (harness-verified)');
    expect(row.error_message).toContain('squatter');
    const evidence = JSON.parse(row.failure_evidence_json ?? '[]') as Array<{ source: string }>;
    expect(evidence[0].source).toBe('port-probe');
  });

  it('a JUDGED snapshot FAIL stays FAILED (deliverable class) and records a HEALTHY outcome', async () => {
    seedRun(db, 'run-deliverable', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const healthy = vi.spyOn(store, 'recordHealthyOutcome');
    const { scheduler } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        report: {
          version: 1,
          behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'missing' } }],
          screenshots: [],
          outcome: 'fail',
          confidence: 0.9,
          feedback: 'broken',
          issues: [],
        },
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-deliverable');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('failed'); // NOT converted — the deliverable is what broke
    expect(row.failure_class).toBe('deliverable');
    // …keyed by the ledger's third component (this row is unpinned ⇒ '').
    expect(healthy).toHaveBeenCalledWith(1, 'web', '');
  });

  it("a model-authored build_failed with NO harness corroboration stays 'ambiguous' AND stays failed", async () => {
    seedRun(db, 'run-ambiguous', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const envFailure = vi.spyOn(store, 'recordEnvFailure');
    const healthy = vi.spyOn(store, 'recordHealthyOutcome');
    const { scheduler } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'EADDRINUSE: port taken',
        report: {
          version: 1,
          behaviors: [],
          screenshots: [],
          outcome: 'build_failed',
          buildLogExcerpt: 'EADDRINUSE: port taken',
          confidence: 0.5,
          feedback: 'could not build',
          issues: [],
        },
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-ambiguous');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('failed'); // blocking, exactly like today
    expect(row.failure_class).toBe('ambiguous');
    // Ambiguity touches NEITHER side of the ledger.
    expect(envFailure).not.toHaveBeenCalled();
    expect(healthy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // §3.1 GATE INTEGRITY — the CHOKEPOINT backstop (Codex finding 1).
  //
  // The runner is where statuses are meant to be right; these rows drive the
  // scheduler with hand-built results the runner does not currently produce,
  // which is exactly the point of a backstop: it must hold for a runner path
  // that regresses or for a new one written without the merge gate in mind.
  // (The runner→scheduler MAPPING itself is covered end-to-end, with a real
  // runner and a fake SDK session, in acceptanceMatrix.test.ts.)
  // -------------------------------------------------------------------------

  it("a DEPLOYED 'skipped' that nothing corroborated is BLOCKED from advancing (converted to failed)", async () => {
    seedRun(db, 'run-unproven-skip', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const envFailure = vi.spyOn(store, 'recordEnvFailure');
    const healthy = vi.spyOn(store, 'recordHealthyOutcome');
    const { scheduler } = initWith(
      {
        // A session that deployed, produced no report, and asked to be skipped —
        // i.e. an ADVANCE on a verification that never happened. Nothing here is
        // harness-corroborated (the preflight is green), so it classifies
        // 'ambiguous' and must not be allowed to advance the lane.
        status: 'skipped',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'the agent could not decide',
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-unproven-skip');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('failed');
    expect(row.failure_class).toBe('ambiguous');
    // The conversion changes the STATUS and keeps the evidence: the runner's own
    // message is still the tail of what a human reads.
    expect(row.error_message).toContain(VERIFY_UNPROVEN_SKIP_BLOCKED);
    expect(row.error_message).toContain('the agent could not decide');
    // Still ambiguous ⇒ still touches NEITHER side of the ledger.
    expect(envFailure).not.toHaveBeenCalled();
    expect(healthy).not.toHaveBeenCalled();
  });

  it('a TRANSPORT-flagged skip is exempt — an API outage must not block a lane', async () => {
    seedRun(db, 'run-transport-skip', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'skipped',
      fileNames: [],
      deployed: true,
      transportFailure: true,
      provisionMode: 'snapshot',
      errorMessage: 'agent deploy error: stream closed',
      preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
    });
    enqueueOne(scheduler, 'run-transport-skip');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toBe('agent deploy error: stream closed');
    expect(row.error_message).not.toContain(VERIFY_UNPROVEN_SKIP_BLOCKED);
  });

  it('the §5.7 dirty-fallback build failure is exempt — attribution there is genuinely unprovable', async () => {
    seedRun(db, 'run-fallback-skip', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'skipped',
      fileNames: [],
      deployed: true,
      provisionMode: 'fallback',
      errorMessage: 'unattributable shared-worktree build_failed: boom',
      report: {
        version: 1,
        behaviors: [],
        screenshots: [],
        outcome: 'build_failed',
        buildLogExcerpt: 'boom',
        confidence: 0.4,
        feedback: 'could not build',
        issues: [],
      },
      preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
    });
    enqueueOne(scheduler, 'run-fallback-skip');
    await flushDrain();

    expect(requestRow(db).status).toBe('skipped');
  });

  it('the SAME shape in SNAPSHOT mode is NOT exempt — the carve-out is about provenance', async () => {
    seedRun(db, 'run-snapshot-skip', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'skipped',
      fileNames: [],
      deployed: true,
      provisionMode: 'snapshot',
      errorMessage: 'build_failed: boom',
      report: {
        version: 1,
        behaviors: [],
        screenshots: [],
        outcome: 'build_failed',
        buildLogExcerpt: 'boom',
        confidence: 0.4,
        feedback: 'could not build',
        issues: [],
      },
      preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
    });
    enqueueOne(scheduler, 'run-snapshot-skip');
    await flushDrain();

    expect(requestRow(db).status).toBe('failed');
  });

  it('a PRE-DEPLOY skip is untouched — the guard is about DEPLOYED sessions only', async () => {
    seedRun(db, 'run-predeploy-skip', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      // The §3.5 preflight exit: nothing ran, nothing was claimed, and the failed
      // check is harness evidence that makes it env-class anyway.
      status: 'skipped',
      fileNames: [],
      deployed: false,
      errorMessage: 'chromium not resolved',
      preflight: PREFLIGHT_FAIL,
    });
    enqueueOne(scheduler, 'run-predeploy-skip');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
  });

  it("a timeout persists 'ambiguous' and is never converted", async () => {
    seedRun(db, 'run-ambiguous-timeout', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const envFailure = vi.spyOn(store, 'recordEnvFailure');
    const { scheduler } = initWith(
      {
        status: 'timeout',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'deadline exceeded',
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-ambiguous-timeout');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('timeout');
    expect(row.failure_class).toBe('ambiguous');
    expect(envFailure).not.toHaveBeenCalled();
  });

  it('K consecutive env failures trip the breaker ONCE, and the NEXT request short-circuits on the suppression', async () => {
    seedRun(db, 'run-breaker', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const capabilityFinding = vi.fn();
    const { scheduler, run } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'boom',
        preflight: PREFLIGHT_FAIL,
      },
      { store, capabilityFinding },
    );

    // Three env-class terminals — the third crosses CAPABILITY_BREAKER_THRESHOLD.
    for (let i = 0; i < CAPABILITY_BREAKER_THRESHOLD; i++) {
      enqueueOne(scheduler, 'run-breaker');
      await flushDrain();
    }
    expect(run).toHaveBeenCalledTimes(CAPABILITY_BREAKER_THRESHOLD);
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
    expect(capabilityFinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, runId: 'run-breaker', modality: 'web' }),
    );

    // The 4th request never reaches the runner — the ledger suppression gates it.
    const fourthId = enqueueOne(scheduler, 'run-breaker');
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(CAPABILITY_BREAKER_THRESHOLD); // unchanged
    const fourth = db
      .prepare('SELECT status, error_message AS err FROM verification_requests WHERE id = ?')
      .get(fourthId) as { status: string; err: string | null };
    expect(fourth.status).toBe('skipped');
    expect(fourth.err).toContain('verification suppressed for web');
    // Still exactly one notice — a suppressed modality must not re-file it.
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
  });
});

describe('VerificationScheduler.enqueue — modality + setup_proof stamping', () => {
  function initBare(): VerificationScheduler {
    return VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      // no agentRunner: rows resolve 'skipped' immediately, which is fine — this
      // block asserts only what the INSERT stamped.
    });
  }

  it("stamps 'cdp-app' for an attach:'cdp' task and 'web' otherwise", () => {
    seedRun(db, 'run-stamp', JSON.stringify(['agent']));
    const scheduler = initBare();
    const cdpId = scheduler.enqueue({
      runId: 'run-stamp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: { ...SERVE_TASK, serve: { cmd: 'electron .', attach: 'cdp' } },
    });
    const webId = scheduler.enqueue({
      runId: 'run-stamp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    const modalityOf = (id: string): string | null =>
      (db.prepare('SELECT modality FROM verification_requests WHERE id = ?').get(id) as { modality: string | null })
        .modality;
    expect(modalityOf(cdpId)).toBe('cdp-app');
    expect(modalityOf(webId)).toBe('web');
  });

  it('stamps setup_proof 0/1 from the option', () => {
    seedRun(db, 'run-stamp-2', JSON.stringify(['agent']));
    const scheduler = initBare();
    const proofId = scheduler.enqueue({
      runId: 'run-stamp-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      setupProof: true,
    });
    const laneId = scheduler.enqueue({
      runId: 'run-stamp-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    const proofOf = (id: string): number =>
      (db.prepare('SELECT setup_proof AS p FROM verification_requests WHERE id = ?').get(id) as { p: number }).p;
    expect(proofOf(proofId)).toBe(1);
    expect(proofOf(laneId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (docs/proposals/verification-setup-flow.md §5.2 seam 3 + §5.3)
// ---------------------------------------------------------------------------

/** The portable half a proof run pins; the entry's content is irrelevant to these tests. */
const PROOF_RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build:web'],
      serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    },
  },
};

/** A store over the test DB with FAKE IO — the store's only filesystem contact. */
function buildRunbookStore(dbX: Database.Database): VerifyRunbookStore {
  return new VerifyRunbookStore(dbAdapter(dbX), {
    readPortableFile: async () => JSON.stringify(PROOF_RUNBOOK),
    computeInputHash: async () => 'input-1',
    hostFingerprint: async () => 'host-1',
  });
}

function runbookRow(dbX: Database.Database): { status: string; version: number; proof_json: string | null } {
  return dbX
    .prepare('SELECT status, version, proof_json FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
    .get('web') as { status: string; version: number; proof_json: string | null };
}

/**
 * The same store with MUTABLE probes, so a test can move the host or the project
 * inputs BETWEEN the draft registration and the proof — which is the exact
 * condition F4's promotion re-stamp exists for (a draft stamped in one place,
 * proven in another).
 */
function buildMutableRunbookStore(
  dbX: Database.Database,
  io: { inputHash: string | null; fingerprint: string; fingerprintThrows?: boolean },
): VerifyRunbookStore {
  return new VerifyRunbookStore(dbAdapter(dbX), {
    readPortableFile: async () => JSON.stringify(PROOF_RUNBOOK),
    computeInputHash: async () => io.inputHash,
    hostFingerprint: async () => {
      if (io.fingerprintThrows === true) throw new Error('fingerprint probe exploded');
      return io.fingerprint;
    },
  });
}

/** The three provenance columns the drift check compares against. */
function runbookProvenance(dbX: Database.Database): {
  portable_hash: string;
  input_hash: string | null;
  host_fingerprint_json: string | null;
} {
  return dbX
    .prepare(
      `SELECT portable_hash, input_hash, host_fingerprint_json
       FROM verify_runbook_local WHERE project_id = 1 AND modality = ?`,
    )
    .get('web') as { portable_hash: string; input_hash: string | null; host_fingerprint_json: string | null };
}

describe('VerificationScheduler — §5.3 engine-enforced proof', () => {
  const PASS_RESULT: VerificationAgentRunResult = {
    status: 'passed',
    verdict: PASS_VERDICT,
    fileNames: [],
    deployed: true,
    provisionMode: 'snapshot',
    preflight: {
      ok: true,
      checks: [
        { id: 'node', ok: true, detail: 'node resolved' },
        { id: 'chromium', ok: true, detail: 'chromium resolved' },
      ],
    },
  };

  function initWith(
    store: VerifyRunbookStore | undefined,
    result: VerificationAgentRunResult = PASS_RESULT,
  ): { scheduler: VerificationScheduler; run: ReturnType<typeof vi.fn> } {
    const { runner, run } = stubRunner(result);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      ...(store ? { runbookStore: store } : {}),
    });
    return { scheduler, run };
  }

  it('a setup_proof row that PASSES with a pin flips the record to proven and records the provenance', async () => {
    seedRun(db, 'run-proof', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };
    expect(runbookRow(db).status).toBe('unproven-draft');

    const { scheduler, run } = initWith(store);
    scheduler.enqueue({
      runId: 'run-proof',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'prove the runbook' },
      chain: [],
      task: SERVE_TASK,
      snapshotSha: 'sha-proof',
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');

    const record = runbookRow(db);
    expect(record.status).toBe('proven');
    const proof = JSON.parse(record.proof_json ?? '{}') as {
      sha: string;
      portableHash: string;
      localVersion: number;
      preflight: { ok: boolean; checks: Array<{ id: string; ok: boolean }> };
      verifiedAt: string;
      requestId: string;
    };
    expect(proof.sha).toBe('sha-proof');
    expect(proof.portableHash).toBe(registered.hash);
    expect(proof.localVersion).toBe(registered.version);
    expect(proof.preflight.ok).toBe(true);
    expect(proof.preflight.checks.map((c) => c.id)).toEqual(['node', 'chromium']);
    expect(typeof proof.verifiedAt).toBe('string');
    expect(proof.requestId).toMatch(/^vr_/);
  });

  /**
   * F4 / Codex #1 — the promotion also RE-STAMPS the drift baseline.
   *
   * `registerDraft` stamps `input_hash`/`host_fingerprint_json` from whatever
   * tree and host were current when the DRAFT was written. A proof taken later
   * (or, for the setup flow, in a different worktree) was therefore born already
   * drifted, and the very first gate read after a successful prove answered
   * 'unproven-draft' — one of the two mechanisms that made cyboflow's own
   * 9/01 proof unusable. The engine now stamps what it observed at promotion
   * time, over the SAME path the gate probes.
   */
  it('promotion re-stamps the provenance over the run worktree — and never the portable hash', async () => {
    seedRun(db, 'run-proof-restamp', JSON.stringify(['agent']));
    const io = { inputHash: 'input-1' as string | null, fingerprint: 'host-1' };
    const store = buildMutableRunbookStore(db, io);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };
    expect(runbookProvenance(db).host_fingerprint_json).toBe('host-1');

    // Both drift conjuncts move between the draft and the proof: an app release
    // (fingerprint) and a lockfile bump (input hash).
    io.fingerprint = 'host-2';
    io.inputHash = 'input-2';

    const { scheduler } = initWith(store);
    scheduler.enqueue({
      runId: 'run-proof-restamp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'prove the runbook' },
      chain: [],
      task: SERVE_TASK,
      snapshotSha: 'sha-proof-restamp',
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();

    expect(runbookRow(db).status).toBe('proven');
    const provenance = runbookProvenance(db);
    expect(provenance.input_hash).toBe('input-2');
    expect(provenance.host_fingerprint_json).toBe('host-2');
    // Codex #1: the content address is the target of every pin and the link to
    // `portable_json`. It is never re-stamped.
    expect(provenance.portable_hash).toBe(registered.hash);
    expect(runbookRow(db).version).toBe(registered.version);

    // The payoff: the proof is live on the VERY NEXT gate read, instead of
    // reading as drifted against a baseline nobody refreshed.
    expect(await store.status(1, '/live/worktree', 'web')).toBe('proven');
  });

  it('a provenance probe that THROWS still promotes — status-only, exactly as before F4', async () => {
    seedRun(db, 'run-proof-probe-throws', JSON.stringify(['agent']));
    const io = { inputHash: 'input-1' as string | null, fingerprint: 'host-1', fingerprintThrows: false };
    const store = buildMutableRunbookStore(db, io);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };
    // The probe breaks only AFTER the draft is stamped, so the failure is
    // isolated to the promotion path.
    io.fingerprintThrows = true;

    const { scheduler } = initWith(store);
    scheduler.enqueue({
      runId: 'run-proof-probe-throws',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'prove the runbook' },
      chain: [],
      task: SERVE_TASK,
      snapshotSha: 'sha-proof-probe-throws',
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();

    // A broken probe must never cost a real proof its promotion.
    expect(requestRow(db).status).toBe('passed');
    expect(runbookRow(db).status).toBe('proven');
    expect(runbookProvenance(db).host_fingerprint_json).toBe('host-1');
  });

  it('a CAS conflict (the record moved mid-flight) is a warn, never a verdict change', async () => {
    seedRun(db, 'run-proof-cas', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };

    const { scheduler } = initWith(store);
    scheduler.enqueue({
      runId: 'run-proof-cas',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'prove the runbook' },
      chain: [],
      task: SERVE_TASK,
      // A real sha, so the §5.3 environment-class guard is satisfied and the CAS
      // is genuinely what declines this flip (see the sha-null test below).
      snapshotSha: 'sha-proof-cas',
      setupProof: true,
      runbookHash: registered.hash,
      // A registerDraft landed between enqueue and terminal: the pin's version is
      // stale, so the double-CAS declines the flip.
      runbookLocalVersion: registered.version + 5,
    });
    await flushDrain();

    // The verification itself still PASSED and is written as such.
    expect(requestRow(db).status).toBe('passed');
    // Only the promotion was declined.
    expect(runbookRow(db).status).toBe('unproven-draft');
    expect(runbookRow(db).proof_json).toBeNull();
  });

  it('a setup_proof pass with NO pin proves nothing (there is no record it attests to)', async () => {
    seedRun(db, 'run-proof-nopin', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    await store.registerDraft(1, '/live/worktree', 'web');
    const { scheduler } = initWith(store);
    scheduler.enqueue({
      runId: 'run-proof-nopin',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      // Present so the ABSENCE OF A PIN is the only thing refusing this proof.
      snapshotSha: 'sha-proof-nopin',
      setupProof: true,
    });
    await flushDrain();
    expect(requestRow(db).status).toBe('passed');
    expect(runbookRow(db).status).toBe('unproven-draft');
  });

  it('a setup_proof pass from the DIRTY-WORKTREE FALLBACK proves nothing — the record stays a draft', async () => {
    // §5.3: "proof runs in the verifier's environment class (detached snapshot +
    // prepared deps) ... a proof obtained in environment X asserted about
    // environment Y is not a proof". A NULL snapshot_sha means the sha capture
    // failed and the runner executed in the live shared worktree, carrying every
    // sibling lane's half-finished edits — precisely the environment class §5.3
    // rejects, and one the provenance blob has no sha to record.
    seedRun(db, 'run-proof-dirty', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };

    const { scheduler } = initWith(store, { ...PASS_RESULT, provisionMode: 'fallback' });
    scheduler.enqueue({
      runId: 'run-proof-dirty',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'prove the runbook' },
      chain: [],
      task: SERVE_TASK,
      // The sha capture failed ⇒ the runner fell back to the live worktree.
      snapshotSha: null,
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();

    // The verification itself still PASSED and is written as such — only the
    // promotion is refused, exactly like the CAS-conflict case.
    expect(requestRow(db).status).toBe('passed');
    expect(runbookRow(db).status).toBe('unproven-draft');
    expect(runbookRow(db).proof_json).toBeNull();
  });

  it('an ORDINARY lane pass with a pin does NOT prove the runbook (only a setup proof may)', async () => {
    seedRun(db, 'run-lane-pass', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };
    // Proven so the §3.2 gate lets the serve task through as ordinary traffic.
    expect(store.markProven(1, 'web', registered.hash, registered.version, '{}')).toEqual({ ok: true });
    // …then demoted, so a wrongful re-proof by the lane would be observable.
    db.prepare(
      "UPDATE verify_runbook_local SET status = 'unproven-draft', proof_json = NULL WHERE project_id = 1",
    ).run();

    const { runner, run } = stubRunner(PASS_RESULT);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      runbookStore: store,
      runbookStatus: async () => ({ status: 'proven', reason: 'proven' }),
    });
    scheduler.enqueue({
      runId: 'run-lane-pass',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
    expect(runbookRow(db).status).toBe('unproven-draft');
  });

  it('a FAILED setup proof leaves the draft a draft', async () => {
    seedRun(db, 'run-proof-fail', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, '/live/worktree', 'web')) as {
      hash: string;
      version: number;
    };
    const { scheduler } = initWith(store, {
      status: 'failed',
      errorMessage: 'the serve command never came up',
      fileNames: [],
      deployed: true,
      provisionMode: 'snapshot',
    });
    scheduler.enqueue({
      runId: 'run-proof-fail',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    await flushDrain();
    expect(runbookRow(db).status).toBe('unproven-draft');
  });
});

describe('VerificationScheduler — §5.2 seam 3 pin threading + mismatch classification', () => {
  it('the stamped pin is handed to the runner on the request', async () => {
    seedRun(db, 'run-pin-thread', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      runbookStatus: async () => ({ status: 'proven', reason: 'proven' }),
    });
    scheduler.enqueue({
      runId: 'run-pin-thread',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      runbookHash: 'c'.repeat(64),
      runbookLocalVersion: 7,
    });
    await flushDrain();

    const req = run.mock.calls[0][0] as VerificationAgentRequest;
    expect(req.runbookHash).toBe('c'.repeat(64));
    expect(req.runbookLocalVersion).toBe(7);
  });

  it("a runner runbookMismatch is classified 'env' with a runner-source evidence entry, and charges nothing", async () => {
    seedRun(db, 'run-mismatch', JSON.stringify(['agent']));
    const { runner } = stubRunner({
      status: 'skipped',
      deployed: false,
      runbookMismatch: true,
      errorMessage: 'runbook/sha mismatch — pinned runbook abc no longer resolves',
      fileNames: [],
    });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      runbookStatus: async () => ({ status: 'proven', reason: 'proven' }),
    });
    scheduler.enqueue({
      runId: 'run-mismatch',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      runbookHash: 'd'.repeat(64),
      runbookLocalVersion: 1,
    });
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain('runbook/sha mismatch');
    const evidence = JSON.parse(row.failure_evidence_json ?? '[]') as Array<{ source: string; check: string }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({ source: 'runner', check: 'runbook-mismatch' }),
    );
    // deployed:false ⇒ no budget charged (§3.6) — a pin rejection is free.
    expect(row.judge_calls_used).toBe(0);
  });
});

describe('VerificationScheduler — §3.2 degrade gate with an ASYNC runbook provider', () => {
  it('awaits a genuinely deferred provider before deciding (never treats a pending Promise as proven)', async () => {
    seedRun(db, 'run-async-gate', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      // Resolves on a later tick — a truthy Promise object would sail through a
      // sync `!== 'proven'` comparison and deploy an unproven project.
      runbookStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { status: 'absent', reason: 'no-record' } as const;
      },
    });
    scheduler.enqueue({
      runId: 'run-async-gate',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(run).not.toHaveBeenCalled();
    expect(requestRow(db).error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
  });

  it('a deferred PROVEN provider lets the same task through', async () => {
    seedRun(db, 'run-async-proven', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      runbookStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { status: 'proven', reason: 'proven' } as const;
      },
    });
    scheduler.enqueue({
      runId: 'run-async-proven',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('VerificationScheduler — resolveProvenRunbook (the ENQUEUE-side resolver)', () => {
  function schedulerWith(store?: VerifyRunbookStore): VerificationScheduler {
    return VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      ...(store ? { runbookStore: store } : {}),
    });
  }

  it('returns the entry + pin for a PROVEN record', async () => {
    seedRun(db, 'run-resolve', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const reg = (await store.registerDraft(1, '/live/worktree', 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', reg.hash, reg.version, '{}')).toEqual({ ok: true });

    const revision = await schedulerWith(store).resolveProvenRunbook({
      projectId: 1,
      runId: 'run-resolve',
      modality: 'web',
    });
    expect(revision?.hash).toBe(reg.hash);
    expect(revision?.version).toBe(reg.version);
    expect(revision?.entry.build).toEqual(['pnpm run build:web']);
  });

  it('returns null for an UNPROVEN record, for another modality, and with no store wired', async () => {
    seedRun(db, 'run-resolve-2', JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    await store.registerDraft(1, '/live/worktree', 'web');

    const sched = schedulerWith(store);
    expect(
      await sched.resolveProvenRunbook({ projectId: 1, runId: 'run-resolve-2', modality: 'web' }),
    ).toBeNull();
    expect(
      await sched.resolveProvenRunbook({ projectId: 1, runId: 'run-resolve-2', modality: 'cdp-app' }),
    ).toBeNull();
    expect(
      await schedulerWith().resolveProvenRunbook({ projectId: 1, runId: 'run-resolve-2', modality: 'web' }),
    ).toBeNull();
  });

  it('falls back to the PROJECT path when the run has no worktree', async () => {
    db.prepare("UPDATE projects SET path = '/project/root' WHERE id = 1").run();
    db.prepare(
      `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
       VALUES ('run-noworktree', 1, ?, NULL, 'claude', 'm')`,
    ).run(JSON.stringify(['agent']));
    const store = buildRunbookStore(db);
    const probed: string[] = [];
    const spy = vi.spyOn(store, 'status').mockImplementation(async (_p, probePath) => {
      probed.push(probePath);
      return 'absent';
    });
    await schedulerWith(store).resolveProvenRunbook({
      projectId: 1,
      runId: 'run-noworktree',
      modality: 'web',
    });
    expect(probed).toEqual(['/project/root']);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// §5.2 seam 2 — the SYNCHRONOUS proof primitive.
//
// Rows are INSERTed directly rather than enqueued: enqueue() nudges the drain,
// and a drain would terminalize these fixtures itself (empty chain ⇒ skipped),
// which is precisely the state transition these tests need to control.
// ---------------------------------------------------------------------------

describe('VerificationScheduler — awaitTerminal (§5.2 seam 2)', () => {
  function bareScheduler(): VerificationScheduler {
    return VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
    });
  }

  function insertRequest(
    id: string,
    row: { status: string; verdictJson?: string | null; errorMessage?: string | null; failureClass?: string | null },
  ): void {
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json,
          verdict_json, error_message, failure_class)
       VALUES (?, 'run-await', 1, ?, 'interactive-web-behavior', '{"intent":"x"}', '[]', ?, ?, ?)`,
    ).run(id, row.status, row.verdictJson ?? null, row.errorMessage ?? null, row.failureClass ?? null);
  }

  it.each(['passed', 'failed', 'low_confidence', 'skipped', 'timeout'])(
    'resolves immediately on a %s row',
    async (status) => {
      insertRequest(`vr-${status}`, { status });
      const outcome = await bareScheduler().awaitTerminal(`vr-${status}`, 5_000, 5);
      expect(outcome.status).toBe(status);
    },
  );

  it('carries the judge feedback, the §3.1 attribution, and the error message', async () => {
    insertRequest('vr-detail', {
      status: 'failed',
      verdictJson: JSON.stringify({ ...PASS_VERDICT, status: 'fail', feedback: 'the toggle never rendered' }),
      errorMessage: 'behavior b1 failed',
      failureClass: 'deliverable',
    });
    const outcome = await bareScheduler().awaitTerminal('vr-detail', 5_000, 5);
    expect(outcome).toEqual({
      status: 'failed',
      errorMessage: 'behavior b1 failed',
      failureClass: 'deliverable',
      feedback: 'the toggle never rendered',
    });
  });

  it('resolves as soon as a still-running row TERMINALIZES (the poll loop, not a fixed sleep)', async () => {
    insertRequest('vr-late', { status: 'running' });
    const pending = bareScheduler().awaitTerminal('vr-late', 5_000, 5);
    setTimeout(() => {
      db.prepare(
        "UPDATE verification_requests SET status = 'passed', verdict_json = ? WHERE id = 'vr-late'",
      ).run(JSON.stringify({ ...PASS_VERDICT, feedback: 'came up green' }));
    }, 20);
    const outcome = await pending;
    expect(outcome.status).toBe('passed');
    expect(outcome.feedback).toBe('came up green');
  });

  it("a deadline returns the request's CURRENT status — the CALLER timed out, the request did not", async () => {
    insertRequest('vr-slow', { status: 'queued' });
    const outcome = await bareScheduler().awaitTerminal('vr-slow', 25, 5);
    expect(outcome.status).toBe('queued');
    expect(outcome.errorMessage).toBe(AWAIT_TERMINAL_TIMEOUT_MESSAGE);
    // Nothing was canceled: the row is untouched and still drainable.
    expect(
      (db.prepare("SELECT status AS s FROM verification_requests WHERE id = 'vr-slow'").get() as { s: string }).s,
    ).toBe('queued');
  });

  it('an unknown request id is a skip with a concrete reason, never an infinite wait', async () => {
    const outcome = await bareScheduler().awaitTerminal('vr-nonexistent', 5_000, 5);
    expect(outcome).toEqual({
      status: 'skipped',
      errorMessage: AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
      failureClass: null,
      feedback: null,
    });
  });

  it('an unparseable verdict_json degrades to no feedback rather than throwing at the awaiting flow', async () => {
    insertRequest('vr-badverdict', { status: 'passed', verdictJson: '{not json' });
    const outcome = await bareScheduler().awaitTerminal('vr-badverdict', 5_000, 5);
    expect(outcome.status).toBe('passed');
    expect(outcome.feedback).toBeNull();
  });
});

describe('VerificationScheduler — the bootstrap toggle is read live', () => {
  it('honours a toggle flipped after boot, in BOTH directions', async () => {
    // `config` is resolved once at boot, which is right for the judge threshold
    // and the port pools and wrong for a Settings checkbox. The OFF direction is
    // the one that matters: unchecking the box mid-incident used to leave the
    // next lane still deriving and committing to the branch until a relaunch,
    // with nothing in the UI saying a restart was required.
    const db = buildDb();
    let enabled = false;
    const attempts: string[] = [];
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(vi.fn(async () => ({ ok: true, fileNames: [] }) satisfies CaptureResult)) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: { ...CONFIG, autoBootstrapRunbook: false },
      liveConfig: () => ({ ...CONFIG, autoBootstrapRunbook: enabled }),
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict: () => {},
      runbookStatus: async () => ({ status: 'unproven-draft', reason: 'draft' }),
      runbookBootstrap: async (args) => {
        attempts.push(args.laneTaskRef);
        return { kind: 'declined', reason: 'unavailable', detail: 'test' };
      },
    });

    const call = () =>
      scheduler.maybeBootstrapRunbook({
        projectId: 1,
        runId: 'run-toggle',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        probePath: '/wt',
        task: {
          version: 1,
          summary: 'verify the widget',
          serve: { cmd: 'pnpm run preview' },
          behaviors: [],
        },
      });

    expect(await call()).toMatchObject({ kind: 'not-attempted' });
    expect(attempts).toHaveLength(0);

    enabled = true;
    expect(await call()).toMatchObject({ kind: 'declined' });
    expect(attempts).toEqual(['TASK-1']);

    enabled = false;
    expect(await call()).toMatchObject({ kind: 'not-attempted' });
    expect(attempts).toHaveLength(1);
    db.close();
  });
});

/**
 * F4 stage 2 / Codex #2 — WHICH of the two bootstraps the decision dispatches.
 *
 * `decideRunbookBootstrap` now answers with a MODE, and this method is the seam
 * that acts on it. Pinned here rather than left to the decision module's own
 * tests because a mis-wire is silent in exactly the direction that costs the
 * most: a DRIFTED record routed to `'derive'` would overwrite a human-authored
 * runbook with a machine-authored rival to fix a proof that expired for
 * environmental reasons — and every lane would still go green afterwards.
 */
describe('VerificationScheduler — which bootstrap MODE the decision dispatches', () => {
  const TASK: VerificationTaskV1 = {
    version: 1,
    summary: 'verify the widget',
    serve: { cmd: 'pnpm run preview' },
    behaviors: [],
  };

  /**
   * A scheduler whose runbook read answers `reason` and whose bootstrap runner
   * only RECORDS what it was handed. `adopt` is captured only off the arm that
   * has one, so a reprove that somehow grew the field would show up as an extra
   * key rather than being read through a cast.
   */
  function dispatcher(
    reason: 'draft' | 'file-only' | 'drifted' | 'content-drifted',
    enabled = true,
  ): {
    seen: Array<{ mode: string; adopt?: boolean }>;
    call: () => Promise<unknown>;
    close: () => void;
  } {
    const own = new Database(':memory:');
    const seen: Array<{ mode: string; adopt?: boolean }> = [];
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(own),
      backends: {
        capturePage: fakeBackend(vi.fn(async () => ({ ok: true, fileNames: [] }) satisfies CaptureResult)),
      },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: { ...CONFIG, autoBootstrapRunbook: enabled },
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict: () => {},
      runbookStatus: async () => ({ status: 'unproven-draft', reason }),
      runbookBootstrap: async (args) => {
        seen.push(args.mode === 'derive' ? { mode: args.mode, adopt: args.adopt } : { mode: args.mode });
        return { kind: 'declined', reason: 'unavailable', detail: 'test' };
      },
    });
    return {
      seen,
      call: () =>
        scheduler.maybeBootstrapRunbook({
          projectId: 1,
          runId: 'run-mode',
          laneTaskRef: 'TASK-1',
          modality: 'web',
          probePath: '/wt',
          task: TASK,
        }),
      close: () => own.close(),
    };
  }

  it("a DRIFTED proof dispatches 'reprove', with no adopt flag at all", async () => {
    // The record is written, committed and registered; only its proof expired.
    // Re-deriving would answer a question nobody asked, and (since F4 stage 1
    // made drift non-writing) declining would strand the project forever.
    const d = dispatcher('drifted');
    expect(await d.call()).toMatchObject({ kind: 'declined' });
    expect(d.seen).toEqual([{ mode: 'reprove' }]);
    d.close();
  });

  it("an ordinary draft still dispatches 'derive', adopt false", async () => {
    const d = dispatcher('draft');
    await d.call();
    expect(d.seen).toEqual([{ mode: 'derive', adopt: false }]);
    d.close();
  });

  it("a committed-but-unproven runbook still dispatches 'derive' with adopt TRUE", async () => {
    // The adopt decision has to survive the mode plumbing: this tree carries a
    // runbook a teammate committed, so the honest action is to prove what is
    // there, not to author a rival — the same §4 rule, one arm over.
    const d = dispatcher('file-only');
    await d.call();
    expect(d.seen).toEqual([{ mode: 'derive', adopt: true }]);
    d.close();
  });

  it('a CONTENT drift dispatches NOTHING — a proof could never clear it', async () => {
    // The loop this closes (F4 fix round): dispatched as a reprove, this record
    // would deploy an agent, build and serve the project, PASS, fail its own
    // `confirmProven` against the same unchanged file-vs-record mismatch — since
    // promotion never re-stamps `portable_hash` — report "still not proven", and
    // do it again on the next run, forever, charging the project's verification
    // budget each time. The gate still skips with the same drift string; the
    // remedy is re-registration, which no bootstrap mode performs.
    const d = dispatcher('content-drifted');
    expect(await d.call()).toEqual({ kind: 'not-attempted', reason: 'stale-proof' });
    expect(d.seen).toEqual([]);
    d.close();
  });

  it('the toggle still beats a drifted record — a reprove spends a deployment too', async () => {
    const d = dispatcher('drifted', false);
    expect(await d.call()).toEqual({ kind: 'not-attempted', reason: 'disabled' });
    expect(d.seen).toEqual([]);
    d.close();
  });
});
