/**
 * AgentEngine — a `mobile` row's simulator lease outlives an ABORTED runner
 * until that runner's own teardown settles (adversarial-review X-1,
 * docs/proposals/runbook-optional-verification.md §B3/§B4.8).
 *
 * The runner here ignores its abort signal and settles only when the test says
 * so — the shape of a real runner still inside its `finally` (EndSession, the
 * bridge kill, `simctl delete`) when the scheduler's deadline fires. The engine,
 * the lease pool (over a private mutex, so the test can read which names are
 * held), the delivery chokepoint and the runbook store are real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { AgentEngine } from '../agentEngine';
import type { AgentEngineDeps } from '../agentEngine';
import { TerminalDelivery } from '../terminalDelivery';
import { ResourceLeasePool } from '../verificationLeases';
import { verifyMobileSlot } from '../mobileGates';
import { Mutex } from '../../../utils/mutex';
import { VerifyRunbookStore } from '../runbookStore';
import type { VerificationRequestRow } from '../verificationRequestRows';
import type { VerificationAgentRequest, VerificationAgentRunResult } from '../verificationAgentRunner';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';
import type {
  ResolvedVisualVerifyConfig,
  VerificationModality,
  VerificationRequestInput,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry } from '../../../../../shared/types/verifyRunbook';

const INPUT: VerificationRequestInput = { intent: 'the list renders', taskRef: 'TASK-9' };
const APP = { platform: 'ios-simulator' as const, bundleId: 'com.acme.ios', scheme: 'Acme' };
const TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'the list renders',
  app: APP,
  attestation: { kind: 'bundle-identity', bundleId: APP.bundleId },
  behaviors: [{ id: 'b1', description: 'renders', expected: 'the list is visible' }],
};
const MOBILE_ENTRY: VerifyRunbookModalityEntry = {
  build: ['xcodebuild -scheme Acme -destination "id=$VERIFY_SIM_UDID" -derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO build'],
  app: APP,
  attestation: { kind: 'bundle-identity', bundleId: APP.bundleId },
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE verification_requests (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', verify_type TEXT NOT NULL, deliverable_json TEXT NOT NULL,
      chain_json TEXT, current_backend TEXT, attempt INTEGER NOT NULL DEFAULT 0, verdict_json TEXT,
      report_json TEXT, error_message TEXT, enqueued_at DATETIME DEFAULT CURRENT_TIMESTAMP, leased_at DATETIME,
      ended_at DATETIME, task_json TEXT, snapshot_sha TEXT, delivery_state TEXT, failure_class TEXT,
      failure_evidence_json TEXT, preflight_json TEXT, modality TEXT, runbook_hash TEXT,
      runbook_local_version INTEGER, setup_proof INTEGER NOT NULL DEFAULT 0, bootstrap_proof INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE verify_runbook_local (
      project_id INTEGER NOT NULL, modality TEXT NOT NULL, portable_hash TEXT NOT NULL, portable_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
      bindings_json TEXT, proof_json TEXT, input_hash TEXT, host_fingerprint_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, origin TEXT, PRIMARY KEY (project_id, modality)
    );
  `);
  return db;
}

function insertRow(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, task_json, snapshot_sha, modality)
     VALUES (?, 'run-1', 1, 'queued', 'mobile-flow', ?, '["agent"]', ?, 'abc123', 'mobile')`,
  ).run(id, JSON.stringify(INPUT), JSON.stringify(TASK));
}

function row(id: string): VerificationRequestRow {
  return {
    id,
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: 'mobile-flow',
    deliverable_json: JSON.stringify(INPUT),
    chain_json: '["agent"]',
    current_backend: null,
    attempt: 0,
    enqueued_at: '',
  };
}

function statusOf(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM verification_requests WHERE id = ?').get(id) as { status: string }).status;
}

/** A runner that ignores abort and settles only when the test releases its teardown. */
function detachedRunner(): {
  run: ReturnType<typeof vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>>;
  finishTeardown(): void;
} {
  const pending: Array<() => void> = [];
  const run = vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>(
    () =>
      new Promise<VerificationAgentRunResult>((resolve) => {
        pending.push(() => resolve({ status: 'timeout', deployed: true, fileNames: [], errorMessage: 'aborted' }));
      }),
  );
  return {
    run,
    finishTeardown: () => {
      for (const done of pending.splice(0)) done();
    },
  };
}

interface Harness {
  db: Database.Database;
  mutex: Mutex;
  engine: AgentEngine;
  store: VerifyRunbookStore;
  nudge: ReturnType<typeof vi.fn<() => void>>;
  warn: ReturnType<typeof vi.fn>;
}

function harness(run: AgentEngineDeps['agentRunner'], over: Partial<AgentEngineDeps> = {}, modality: VerificationModality = 'mobile'): Harness {
  const db = buildDb();
  const mutex = new Mutex();
  const store = new VerifyRunbookStore(dbAdapter(db), {
    readPortableFile: async () => null,
    computeInputHash: async () => 'inputs-v1',
    hostFingerprint: async () => 'host-v1',
    hasPackageJson: async () => false,
  });
  const config: ResolvedVisualVerifyConfig = {
    ...VISUAL_VERIFY_DEFAULTS,
    agentSlots: 2,
    mobileSimSlots: 1,
    devServerPorts: [5173, 5175],
  };
  const nudge = vi.fn<() => void>();
  const warn = vi.fn();
  const engine = new AgentEngine({
    db: dbAdapter(db),
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    config,
    liveConfig: () => config,
    runbookStore: store,
    runbookStatus: (projectId, m, probePath) => store.statusDetail(projectId, probePath ?? '/wt', m),
    leasePool: new ResourceLeasePool(mutex),
    artifactsDirResolver: (runId) => `/artifacts/${runId}`,
    agentRunner: run,
    // The deadline under test: a ceiling of 20 ms wins over every floor.
    agentRequestTimeoutMs: 20,
    agentRequestCeilingMs: 20,
    portFreeProbe: async () => true,
    mobileToolchainProbe: async () => true,
    delivery: new TerminalDelivery({ db: dbAdapter(db), onVerdict: async () => undefined }),
    inFlight: new Map(),
    agentGateColumnsForRow: () => ({ modality, setupProof: false, bootstrapProof: false }),
    worktreePathForRun: () => '/wt/run-1',
    projectPathFor: () => '/wt',
    acquireBatchMutex: async () => null,
    isProjectBudgetExhausted: () => false,
    incrementJudgeCallsUsed: () => {},
    portFromLease: (name) => (name?.startsWith('verify:port:') ? Number(name.slice('verify:port:'.length)) : null),
    nudge,
    ...over,
  });
  return { db, mutex, engine, store, nudge, warn };
}

async function drain(h: Harness, id: string): Promise<boolean> {
  const { work } = await h.engine.processAgentRow(row(id), INPUT);
  if (work === null) return false;
  await work;
  return true;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

describe('AgentEngine — X-1: a detached mobile runner keeps its simulator until its teardown settles', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  it('the deadline terminalises the row, but the slot stays held — a second mobile row waits — until the runner settles', async () => {
    const runner = detachedRunner();
    h = harness({ run: runner.run });
    insertRow(h.db, 'r1');
    insertRow(h.db, 'r2');

    expect(await drain(h, 'r1')).toBe(true);
    expect(statusOf(h.db, 'r1')).toBe('timeout');
    // The runner is still tearing down its simulator: the slot is NOT free.
    expect(h.mutex.isLocked(verifyMobileSlot(0))).toBe(true);
    expect(await drain(h, 'r2')).toBe(false);
    expect(statusOf(h.db, 'r2')).toBe('queued');
    expect(h.nudge).not.toHaveBeenCalled();

    runner.finishTeardown();
    await flush();
    expect(h.mutex.isLocked(verifyMobileSlot(0))).toBe(false);
    // The release is what can unblock r2, so it nudges the drain.
    expect(h.nudge).toHaveBeenCalledTimes(1);
    const second = h.engine.processAgentRow(row('r2'), INPUT);
    expect((await second).work).not.toBeNull();
    runner.finishTeardown();
    await (await second).work;
  });

  it('a same-id learned-pin requeue is neither nudged nor re-leased until the old attempt has cleaned up', async () => {
    const runner = detachedRunner();
    h = harness({ run: runner.run });
    insertRow(h.db, 'r1');
    const learned = await h.store.registerLearnedDraft(1, 'mobile', MOBILE_ENTRY, undefined, '/wt', null);
    if ('error' in learned) throw new Error(learned.error);
    h.db
      .prepare('UPDATE verification_requests SET runbook_hash = ?, runbook_local_version = ? WHERE id = ?')
      .run(learned.hash, learned.version, 'r1');

    expect(await drain(h, 'r1')).toBe(true);
    // §A5: the learned recipe ran out the deadline — back to the queue, same id.
    expect(statusOf(h.db, 'r1')).toBe('queued');
    expect(h.nudge).not.toHaveBeenCalled();
    // A drain that reaches it anyway (another row's release) must not lease it:
    // it would share `verify-mobile/r1` with the runner still deleting it.
    expect(await drain(h, 'r1')).toBe(false);
    expect(runner.run).toHaveBeenCalledTimes(1);

    runner.finishTeardown();
    await flush();
    expect(h.nudge).toHaveBeenCalledTimes(1);
    const again = await h.engine.processAgentRow(row('r1'), INPUT);
    expect(again.work).not.toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(2);
    runner.finishTeardown();
    await again.work;
  });

  it('a runner that NEVER settles cannot hold the slot past the bound: it is released with a warning', async () => {
    const runner = detachedRunner();
    h = harness({ run: runner.run }, { mobileTeardownHoldMs: 40 });
    insertRow(h.db, 'r1');
    await drain(h, 'r1');
    expect(h.mutex.isLocked(verifyMobileSlot(0))).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.mutex.isLocked(verifyMobileSlot(0))).toBe(false);
    expect(h.nudge).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not settle within the bound'),
      expect.objectContaining({ requestId: 'r1' }),
    );
    // A late settle after the bound is a no-op: no double release, no second nudge.
    runner.finishTeardown();
    await flush();
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it('a runner that settled normally releases at once — no hold, no extra nudge', async () => {
    h = harness({
      run: async () => ({ status: 'skipped', deployed: false, fileNames: [], errorMessage: 'no simulator' }),
    });
    insertRow(h.db, 'r1');
    await drain(h, 'r1');
    expect(h.mutex.isLocked(verifyMobileSlot(0))).toBe(false);
    expect(h.nudge).not.toHaveBeenCalled();
  });
});
