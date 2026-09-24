/**
 * AgentEngine — unit tests over the verification-agent engine extracted from
 * VerificationScheduler (issue #19 step 8). verificationSchedulerAgent.test.ts
 * still drives this path end-to-end through drain with a real request row and
 * runs/projects tables; these pin the engine's OWN contract with every
 * scheduler-owned helper stubbed as the closure it is injected as: the
 * pre-lease gates in precedence order, the slot → screen → port lease ladder,
 * the request the runner receives, budget/deadline/throw attribution, and the
 * lease + in-flight cleanup on every exit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { Mutex } from '../../../utils/mutex';
import { AgentEngine } from '../agentEngine';
import type { AgentEngineDeps } from '../agentEngine';
import { TerminalDelivery } from '../terminalDelivery';
import { ResourceLeasePool, VERIFY_SCREEN_LEASE, verifyAgentSlot, verifyPortLease } from '../verificationLeases';
import type { OnVerdict } from '../verificationSchedulerContracts';
import type { VerificationRequestRow } from '../verificationRequestRows';
import type { VerifyCapabilityStore } from '../capabilityStore';
import type { VerificationAgentRequest, VerificationAgentRunResult } from '../verificationAgentRunner';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';
import type { VerificationRequestInput, VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

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
      report_json      TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      snapshot_sha     TEXT,
      delivery_state   TEXT,
      failure_class          TEXT,
      failure_evidence_json  TEXT,
      preflight_json         TEXT
    );
  `);
  return db;
}

const INPUT: VerificationRequestInput = { intent: 'the page renders', url: 'https://staging.example.test/', taskRef: 'TASK-3' };
const PORT = 5173;

function row(): VerificationRequestRow {
  return {
    id: 'r1',
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: 'interactive-web-behavior',
    deliverable_json: JSON.stringify(INPUT),
    chain_json: '["agent"]',
    current_backend: null,
    attempt: 0,
    enqueued_at: '',
  };
}

const PASSED: VerificationAgentRunResult = { status: 'passed', fileNames: ['shot.png'], deployed: true };

interface Harness {
  db: Database.Database;
  engine: AgentEngine;
  pool: ResourceLeasePool;
  run: ReturnType<typeof vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>>;
  onVerdict: ReturnType<typeof vi.fn<OnVerdict>>;
  inFlight: Map<string, AbortController>;
  judgeCalls: string[];
  gate: { modality: 'web' | 'native-screen' | 'mobile' | null; setupProof: boolean; bootstrapProof: boolean };
  budgetExhausted: { value: boolean };
}

function harness(over: Partial<AgentEngineDeps> = {}, opts: { task?: VerificationTaskV1; runner?: false } = {}): Harness {
  const db = buildDb();
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, task_json, snapshot_sha)
     VALUES ('r1', 'run-1', 1, 'queued', 'interactive-web-behavior', ?, '["agent"]', ?, 'abc123')`,
  ).run(JSON.stringify(INPUT), opts.task ? JSON.stringify(opts.task) : null);
  const onVerdict = vi.fn<OnVerdict>(async () => undefined);
  const run = vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>(async () => PASSED);
  const pool = new ResourceLeasePool(new Mutex());
  const inFlight = new Map<string, AbortController>();
  const judgeCalls: string[] = [];
  const gate: Harness['gate'] = { modality: 'web', setupProof: false, bootstrapProof: false };
  const budgetExhausted = { value: false };
  const engine = new AgentEngine({
    db: dbAdapter(db),
    config: { ...VISUAL_VERIFY_DEFAULTS, agentSlots: 1, devServerPorts: [PORT] },
    leasePool: pool,
    artifactsDirResolver: (runId) => `/artifacts/${runId}`,
    agentRunner: opts.runner === false ? undefined : { run },
    agentRequestTimeoutMs: 60_000,
    agentRequestCeilingMs: 120_000,
    portFreeProbe: async () => true,
    runbookStatus: async () => ({ status: 'absent', reason: 'no-record' }),
    delivery: new TerminalDelivery({ db: dbAdapter(db), onVerdict }),
    inFlight,
    agentGateColumnsForRow: () => gate,
    worktreePathForRun: () => '/wt/run-1',
    projectPathFor: () => '/wt',
    acquireBatchMutex: async () => null,
    isProjectBudgetExhausted: () => budgetExhausted.value,
    incrementJudgeCallsUsed: (id) => judgeCalls.push(id),
    portFromLease: (name) => (name?.startsWith('verify:port:') ? Number(name.slice('verify:port:'.length)) : null),
    ...over,
  });
  return { db, engine, pool, run, onVerdict, inFlight, judgeCalls, gate, budgetExhausted };
}

function terminal(db: Database.Database): { status: string; error: string | null; delivery: string | null; failureClass: string | null } {
  const r = db
    .prepare('SELECT status, error_message, delivery_state, failure_class FROM verification_requests WHERE id = ?')
    .get('r1') as { status: string; error_message: string | null; delivery_state: string | null; failure_class: string | null };
  return { status: r.status, error: r.error_message, delivery: r.delivery_state, failureClass: r.failure_class };
}

/** Every pooled lease the engine could hold is free again. */
async function expectLeasesFree(pool: ResourceLeasePool): Promise<void> {
  for (const name of [verifyAgentSlot(0), verifyPortLease(PORT), VERIFY_SCREEN_LEASE]) {
    const held = await pool.tryAcquire(name);
    expect(held, `${name} should be free`).not.toBeNull();
    held?.release();
  }
}

// ---------------------------------------------------------------------------

describe('AgentEngine.processAgentRow', () => {
  let h: Harness;
  afterEach(() => {
    vi.useRealTimers();
    h.db.close();
  });

  describe('pre-lease gates (in precedence order)', () => {
    it('skips fail-open when no runner is configured', async () => {
      h = harness({}, { runner: false });

      const { work } = await h.engine.processAgentRow(row(), INPUT);

      expect(work).toBeNull();
      expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: 'verification agent engine not configured', delivery: 'delivered' });
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ captureOrigin: 'agent' }));
    });

    it('gate 1: an unsupported modality skips as an env failure and is recorded in the ledger', async () => {
      const markUnsupported = vi.fn();
      const store = { markUnsupported, getActiveSuppression: () => null } as unknown as VerifyCapabilityStore;
      h = harness({ capabilityStore: store });
      h.gate.modality = 'mobile';

      const { work } = await h.engine.processAgentRow(row(), INPUT);

      expect(work).toBeNull();
      expect(h.run).not.toHaveBeenCalled();
      const t = terminal(h.db);
      expect(t.status).toBe('skipped');
      expect(t.failureClass).toBe('env');
      expect(t.error).toMatch(/^unsupported modality 'mobile': /);
      expect(markUnsupported).toHaveBeenCalledWith(1, 'mobile', t.error, '');
      await expectLeasesFree(h.pool);
    });

    it('gate 2: an active suppression skips without touching the runner', async () => {
      const store = {
        markUnsupported: vi.fn(),
        getActiveSuppression: () => ({ reason: 'breaker tripped 3x' }),
      } as unknown as VerifyCapabilityStore;
      h = harness({ capabilityStore: store });

      await h.engine.processAgentRow(row(), INPUT);

      expect(h.run).not.toHaveBeenCalled();
      expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: 'verification suppressed for web: breaker tripped 3x' });
    });

    it('gate 3: a task that derives an environment needs a PROVEN runbook — unless it IS the proof', async () => {
      const serving: VerificationTaskV1 = { version: 1, summary: 'serve then check', serve: { cmd: 'npm run dev' }, behaviors: [] };
      h = harness({}, { task: serving });

      await h.engine.processAgentRow(row(), INPUT);
      expect(h.run).not.toHaveBeenCalled();
      expect(terminal(h.db)).toMatchObject({ status: 'skipped', failureClass: 'env' });

      h.db.close();
      h = harness({}, { task: serving });
      h.gate.setupProof = true;
      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ setupProof: true, verifyPort: PORT }));
      expect(terminal(h.db).status).toBe('passed');
    });

    it('gate 3a: a composed web task with no build, serve, target or app skips before any lease', async () => {
      // shiny-eagle 9/22: an iOS lane composed `native-screen` with nothing to
      // stand up, stamped `web`, and burned an agent that had nothing to open.
      const empty: VerificationTaskV1 = { version: 1, summary: 'banned apps list', modality: 'native-screen', behaviors: [] };
      h = harness({}, { task: empty });

      const { work } = await h.engine.processAgentRow(row(), INPUT);

      expect(work).toBeNull();
      expect(h.run).not.toHaveBeenCalled();
      const t = terminal(h.db);
      expect(t).toMatchObject({ status: 'skipped', failureClass: 'env' });
      expect(t.error).toContain('names nothing to stand up');
      expect(t.error).toContain("declared modality 'native-screen', but this request resolved to 'web'");
      // A composer defect, not a missing runbook — must not collapse into the
      // run-level "no verifiable modality" decline.
      expect(t.error).not.toContain('verification runbook');
      await expectLeasesFree(h.pool);
    });

    it('gate 3a: a pre-live target and the legacy intent-only row still run', async () => {
      const live: VerificationTaskV1 = { version: 1, summary: 'live', target: { url: 'https://staging.example.test/' }, behaviors: [] };
      h = harness({}, { task: live });
      const first = await h.engine.processAgentRow(row(), INPUT);
      await first.work;
      expect(h.run).toHaveBeenCalledTimes(1);

      h.db.close();
      h = harness({}, { task: undefined });
      const second = await h.engine.processAgentRow(row(), { intent: 'no url at all' });
      await second.work;
      expect(h.run).toHaveBeenCalledTimes(1);
    });

    it('gate 3a: exempts a setup proof', async () => {
      const empty: VerificationTaskV1 = { version: 1, summary: 'x', behaviors: [] };
      h = harness({}, { task: empty });
      h.gate.setupProof = true;
      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;
      expect(h.run).toHaveBeenCalled();
    });
  });

  describe('lease ladder', () => {
    it('leaves the row queued, with no terminal, while every agent slot is held', async () => {
      h = harness();
      const slot = await h.pool.tryAcquire(verifyAgentSlot(0));

      const { work } = await h.engine.processAgentRow(row(), INPUT);

      expect(work).toBeNull();
      expect(terminal(h.db)).toMatchObject({ status: 'queued', delivery: null });
      expect(h.run).not.toHaveBeenCalled();
      slot?.release();
      // and the slot probe took nothing else: the port is still free
      const port = await h.pool.tryAcquire(verifyPortLease(PORT));
      expect(port).not.toBeNull();
      port?.release();
    });

    it('releases the slot again when no verify port is free', async () => {
      h = harness();
      const port = await h.pool.tryAcquire(verifyPortLease(PORT));

      const { work } = await h.engine.processAgentRow(row(), INPUT);

      expect(work).toBeNull();
      expect(terminal(h.db).status).toBe('queued');
      port?.release();
      await expectLeasesFree(h.pool);
    });

    it('a native-screen row additionally holds the screen lease for the deployment', async () => {
      h = harness({ nativeCaptureProbe: async () => true });
      h.gate.modality = 'native-screen';
      let finish!: (r: VerificationAgentRunResult) => void;
      h.run.mockImplementationOnce(() => new Promise<VerificationAgentRunResult>((resolve) => (finish = resolve)));

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      expect(work).not.toBeNull();
      expect(await h.pool.tryAcquire(VERIFY_SCREEN_LEASE)).toBeNull();
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ modality: 'native-screen' }));

      finish(PASSED);
      await work;
      await expectLeasesFree(h.pool);
    });
  });

  describe('deployment', () => {
    it('transitions queued → running, hands the runner the composed request, settles passed, and cleans up', async () => {
      h = harness();

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      expect(work).not.toBeNull();
      expect(terminal(h.db).status).toBe('running');
      expect(h.inFlight.has('r1')).toBe(true);
      await work;

      expect(h.run).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          requestId: 'r1',
          projectId: 1,
          runWorktreePath: '/wt/run-1',
          snapshotSha: 'abc123',
          artifactsDir: '/artifacts/run-1',
          verifyPort: null, // a degenerate task points at a live url — nothing to bind
          verifyDriverPort: PORT + 1,
          timeoutMs: 60_000,
          modality: 'web',
          task: expect.objectContaining({ summary: INPUT.intent, taskRef: 'TASK-3', target: { url: INPUT.url } }),
        }),
      );
      expect(terminal(h.db)).toMatchObject({ status: 'passed', delivery: 'delivered' });
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ status: 'passed', fileNames: ['shot.png'], captureOrigin: 'agent' }));
      expect(h.judgeCalls).toEqual(['r1']);
      expect(h.inFlight.size).toBe(0);
      await expectLeasesFree(h.pool);
    });

    it('a setup proof deployment is never charged to the budget, and skips the budget gate', async () => {
      h = harness();
      h.gate.setupProof = true;
      h.budgetExhausted.value = true;

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;

      expect(h.run).toHaveBeenCalled();
      expect(h.judgeCalls).toEqual([]);
      expect(terminal(h.db).status).toBe('passed');
    });

    it('an exhausted budget skips before deploying and releases every lease', async () => {
      h = harness();
      h.budgetExhausted.value = true;

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;

      expect(h.run).not.toHaveBeenCalled();
      expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: 'per-project visual-verify budget exhausted' });
      await expectLeasesFree(h.pool);
    });

    it('a runner that throws is a skip (not a failure) carrying its message', async () => {
      h = harness();
      h.run.mockRejectedValueOnce(new Error('sdk spawn failed'));

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;

      expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: 'sdk spawn failed' });
      expect(h.judgeCalls).toEqual([]);
      expect(h.inFlight.size).toBe(0);
      await expectLeasesFree(h.pool);
    });

    it('a deployment past its deadline is aborted, marked timeout, and still charged', async () => {
      vi.useFakeTimers();
      h = harness({ agentRequestTimeoutMs: 1_000, agentRequestCeilingMs: 2_000 });
      let observed: AbortSignal | undefined;
      h.run.mockImplementationOnce((req) => {
        observed = req.signal;
        return new Promise<VerificationAgentRunResult>(() => {});
      });

      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await vi.advanceTimersByTimeAsync(1_000);
      await work;

      expect(observed?.aborted).toBe(true);
      expect(terminal(h.db)).toMatchObject({ status: 'timeout', error: 'request timed out' });
      expect(h.judgeCalls).toEqual(['r1']);
      await expectLeasesFree(h.pool);
    });
  });
});
