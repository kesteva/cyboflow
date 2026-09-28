/**
 * VerificationScheduler — modality-aware concurrency + drain priority
 * (docs/proposals/verification-setup-flow.md §4 footnote ¹ / §5.4).
 *
 * Focus: the BOUNDED agent-slot pool that replaced the single count-1
 * `verify:agent` lease (two web/cdp requests run concurrently in ONE drain pass,
 * the (N+1)th stays 'queued' and is picked up when a slot frees), the count-1
 * screen lease a `native-screen` row additionally takes (§4 "screen
 * exclusivity"), the probe-conditional native-screen gate, the modality threaded
 * onto the runner request, and the pure two-class drain ordering with its
 * anti-starvation promotion.
 *
 * Every test drives the REAL drain loop with a runner whose completion is a
 * DEFERRED promise, because the property under test — "both rows are running
 * before either settles" — is invisible to a runner that resolves immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  VerificationScheduler,
  ResourceLeasePool,
  VERIFY_SCREEN_LEASE,
  SETUP_PROOF_PROMOTION_MS,
  orderAgentDrainRows,
  verifyAgentSlot,
  verifyPortLease,
} from '../verificationScheduler';
import { VerifyCapabilityStore } from '../capabilityStore';
import {
  MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL,
  MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
  verifyMobileSlot,
} from '../mobileGates';
import { Mutex } from '../../../utils/mutex';
import { setSeamErrorSink } from '../../telemetrySink';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type {
  VerificationAgentRunnerLike,
  VerificationAgentRequest,
  VerificationAgentRunResult,
} from '../verificationAgentRunner';
import type {
  ResolvedVisualVerifyConfig,
  VerificationType,
  VerdictV1,
  VlmJudge,
} from '../../../../../shared/types/visualVerification';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id                        INTEGER PRIMARY KEY,
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
      setup_proof           INTEGER NOT NULL DEFAULT 0
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

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
     VALUES (?, 1, ?, '/live/worktree', 'claude', 'claude-sonnet-5')`,
  ).run(runId, JSON.stringify(['agent']));
}

const CONFIG: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  // Four ports so the port pool can never be the thing that limits concurrency
  // in these tests — the agent-slot pool is what is under test.
  devServerPorts: [29260, 29262, 29264, 29266],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
  mobileSimSlots: VISUAL_VERIFY_DEFAULTS.mobileSimSlots,
  mobileSimDeviceType: VISUAL_VERIFY_DEFAULTS.mobileSimDeviceType,
  mobileSimRuntime: VISUAL_VERIFY_DEFAULTS.mobileSimRuntime,
  mobileDeadlineFloorMs: VISUAL_VERIFY_DEFAULTS.mobileDeadlineFloorMs,
  autoBootstrapRunbook: false,
  requireProvenRunbook: VISUAL_VERIFY_DEFAULTS.requireProvenRunbook,
  exploreDeadlineFloorMs: VISUAL_VERIFY_DEFAULTS.exploreDeadlineFloorMs,
  mobileDriveEngine: VISUAL_VERIFY_DEFAULTS.mobileDriveEngine,
};

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'agent says pass',
  judgedFileNames: [],
  baselineUsed: false,
  model: 'claude-x',
};

const fakeJudge: VlmJudge = { judge: async () => PASS_VERDICT };

const PASS_RESULT: VerificationAgentRunResult = {
  status: 'passed',
  verdict: PASS_VERDICT,
  fileNames: [],
  deployed: true,
  provisionMode: 'snapshot',
};

/** A promise plus its resolver — the handle a test uses to hold a deployment open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A runner whose every deployment blocks until `releaseAll()` (or the per-request
 * gate) resolves. This is what makes "two rows leased DISTINCT slots in ONE pass"
 * observable: with an immediately-resolving runner the first row settles and frees
 * its slot before the second row is even probed, so a count-1 pool would look
 * identical to an N-slot one.
 */
function gatedRunner(): {
  runner: VerificationAgentRunnerLike;
  run: ReturnType<typeof vi.fn>;
  /** Per-requestId gate, created lazily on first deployment of that request. */
  gateFor(requestId: string): { promise: Promise<void>; resolve: () => void };
  releaseAll(): void;
} {
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gateFor = (requestId: string): { promise: Promise<void>; resolve: () => void } => {
    let gate = gates.get(requestId);
    if (!gate) {
      gate = deferred();
      gates.set(requestId, gate);
    }
    return gate;
  };
  const run = vi.fn(async (req: VerificationAgentRequest) => {
    await gateFor(req.requestId).promise;
    return PASS_RESULT;
  });
  return {
    runner: { run },
    run,
    gateFor,
    releaseAll: () => {
      for (const gate of gates.values()) gate.resolve();
    },
  };
}

/**
 * Let the scheduler's setImmediate drain loop run. Deliberately generous: after a
 * gate resolves, the settle → lease-release → re-nudge → next pass chain spans
 * several turns, and a too-small flush would assert on a half-drained world.
 */
async function flushDrain(ticks = 16): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}

let db: Database.Database;
let mutex: Mutex;

function initScheduler(
  opts: Partial<Parameters<typeof VerificationScheduler.initialize>[0]> = {},
): VerificationScheduler {
  return VerificationScheduler.initialize({
    db: dbAdapter(db),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => '/artifacts',
    config: CONFIG,
    leasePool: new ResourceLeasePool(mutex),
    capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
    ...opts,
  });
}

function enqueueOne(
  scheduler: VerificationScheduler,
  runId: string,
  type: VerificationType = 'static-render-snapshot',
): string {
  return scheduler.enqueue({
    runId,
    projectId: 1,
    type,
    input: { intent: 'x' },
    chain: [],
  });
}

function statusOf(id: string): string {
  return (db.prepare('SELECT status FROM verification_requests WHERE id = ?').get(id) as { status: string })
    .status;
}

function rowOf(id: string): { status: string; error_message: string | null; failure_class: string | null; modality: string | null } {
  return db
    .prepare('SELECT status, error_message, failure_class, modality FROM verification_requests WHERE id = ?')
    .get(id) as ReturnType<typeof rowOf>;
}

beforeEach(() => {
  setSeamErrorSink(() => {});
  db = buildDb();
  mutex = new Mutex();
  VerificationScheduler._resetForTesting();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
});

describe('VerificationScheduler — bounded agent-slot pool (§4 fn.¹)', () => {
  it('leases DISTINCT slots for two requests in ONE drain pass and runs them concurrently', async () => {
    seedRun(db, 'run-pool');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({ agentRunner: runner });

    const a = enqueueOne(scheduler, 'run-pool');
    const b = enqueueOne(scheduler, 'run-pool');
    await flushDrain();

    // BOTH are running before EITHER settles — the property a count-1 lease made
    // impossible. Their slots are distinct names on the shared mutex.
    expect(statusOf(a)).toBe('running');
    expect(statusOf(b)).toBe('running');
    expect(run).toHaveBeenCalledTimes(2);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(true);
    expect(mutex.isLocked(verifyAgentSlot(1))).toBe(true);
    // Distinct PORTS too — the port pool is per-request, unchanged by this work.
    expect(mutex.isLocked(verifyPortLease(29260))).toBe(true);
    expect(mutex.isLocked(verifyPortLease(29262))).toBe(true);

    releaseAll();
    await flushDrain();
    expect(statusOf(a)).toBe('passed');
    expect(statusOf(b)).toBe('passed');
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(false);
    expect(mutex.isLocked(verifyAgentSlot(1))).toBe(false);
  });

  it("leaves the (N+1)th request 'queued' while every slot is held, then drains it when one frees", async () => {
    seedRun(db, 'run-pool-full');
    const { runner, run, gateFor } = gatedRunner();
    const scheduler = initScheduler({ agentRunner: runner });

    const ids = [
      enqueueOne(scheduler, 'run-pool-full'),
      enqueueOne(scheduler, 'run-pool-full'),
      enqueueOne(scheduler, 'run-pool-full'),
    ];
    await flushDrain();

    // agentSlots = 2: exactly two rows deploy and the third never even reaches the
    // runner — it stays queued exactly as it did behind the old count-1 lease (the
    // LANE is never held). WHICH row is the odd one out is deliberately not
    // asserted: the drain's FIFO tiebreak is `id ASC` over random uuids within the
    // same enqueue second, so identity here would be a flake, the COUNT is the
    // property.
    const running = ids.filter((id) => statusOf(id) === 'running');
    const queued = ids.filter((id) => statusOf(id) === 'queued');
    expect(running).toHaveLength(2);
    expect(queued).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);

    // Free the slots: the released-lease re-nudge picks the queued row up on the
    // next pass. Both in-flight rows are resolved because a drain pass awaits ALL
    // of its detached work before it can re-scan (verificationScheduler.drain —
    // "we await all detached captures before the pass returns so a rescan pass
    // sees a settled world"); that is pre-existing scheduler behavior, unchanged
    // by the slot pool.
    gateFor(running[0]).resolve();
    gateFor(running[1]).resolve();
    await flushDrain();
    expect(statusOf(running[0])).toBe('passed');
    expect(statusOf(running[1])).toBe('passed');
    expect(statusOf(queued[0])).toBe('running');
    expect(run).toHaveBeenCalledTimes(3);
    // It took a slot from the SAME pool the two settled rows released.
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(true);

    gateFor(queued[0]).resolve();
    await flushDrain();
    expect(statusOf(queued[0])).toBe('passed');
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(false);
  });

  it('honors an agentSlots of 1 (a config-pinned serial pool)', async () => {
    seedRun(db, 'run-serial');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      config: { ...CONFIG, agentSlots: 1 },
    });

    enqueueOne(scheduler, 'run-serial');
    enqueueOne(scheduler, 'run-serial');
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(true);
    expect(mutex.isLocked(verifyAgentSlot(1))).toBe(false);
    releaseAll();
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('floors a nonsense agentSlots of 0 to one slot rather than wedging the whole engine', async () => {
    seedRun(db, 'run-zero');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      config: { ...CONFIG, agentSlots: 0 },
    });

    enqueueOne(scheduler, 'run-zero');
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    releaseAll();
    await flushDrain();
  });
});

describe('VerificationScheduler — native-screen lane (§4 screen exclusivity)', () => {
  it('takes the count-1 screen lease with a capable host and SERIALIZES two native rows', async () => {
    seedRun(db, 'run-native');
    const { runner, run, gateFor } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      nativeCaptureProbe: async () => true,
    });

    const ids = [
      enqueueOne(scheduler, 'run-native', 'native-desktop'),
      enqueueOne(scheduler, 'run-native', 'native-desktop'),
    ];
    await flushDrain();

    // ONE row is running and holds the screen; the other found the screen held and
    // went back to 'queued' WITHOUT retaining the agent slot it probed first —
    // both slots were free, so only the count-1 screen lease can explain this.
    // (Which of the two won is the drain's uuid tiebreak — not a property.)
    const first = ids.filter((id) => statusOf(id) === 'running');
    const second = ids.filter((id) => statusOf(id) === 'queued');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(true);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(true);
    expect(mutex.isLocked(verifyAgentSlot(1))).toBe(false);

    gateFor(first[0]).resolve();
    await flushDrain();
    expect(statusOf(first[0])).toBe('passed');
    expect(statusOf(second[0])).toBe('running');
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(true); // now held by the second

    gateFor(second[0]).resolve();
    await flushDrain();
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
  });

  it('never takes the screen lease for a web request (parallel modalities stay parallel)', async () => {
    seedRun(db, 'run-web');
    const { runner, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      nativeCaptureProbe: async () => true,
    });

    enqueueOne(scheduler, 'run-web');
    enqueueOne(scheduler, 'run-web');
    await flushDrain();
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
    releaseAll();
    await flushDrain();
  });

  it('a native-screen request runs CONCURRENTLY with a web request (one screen, two slots)', async () => {
    seedRun(db, 'run-mixed');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      nativeCaptureProbe: async () => true,
    });

    const nativeId = enqueueOne(scheduler, 'run-mixed', 'native-desktop');
    const webId = enqueueOne(scheduler, 'run-mixed');
    await flushDrain();

    expect(statusOf(nativeId)).toBe('running');
    expect(statusOf(webId)).toBe('running');
    expect(run).toHaveBeenCalledTimes(2);
    releaseAll();
    await flushDrain();
  });

  it('an INCAPABLE host (probe false) skips as unsupported with the actionable grant-pair reason', async () => {
    seedRun(db, 'run-nogrants');
    const { runner, run } = gatedRunner();
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const markUnsupported = vi.spyOn(store, 'markUnsupported');
    const probe = vi.fn(async () => false);
    const scheduler = initScheduler({
      agentRunner: runner,
      capabilityStore: store,
      nativeCaptureProbe: probe,
    });

    const id = enqueueOne(scheduler, 'run-nogrants', 'native-desktop');
    await flushDrain();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const row = rowOf(id);
    // Structurally identical to the phase-0 skip: same terminal, same class, same
    // ledger write, same 'unsupported modality' prefix — only the DETAIL differs,
    // and it names the two grants a human can actually go and fix.
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('native-screen');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain("unsupported modality 'native-screen'");
    expect(row.error_message).toContain('Screen Recording');
    expect(row.error_message).toContain('Accessibility');
    expect(markUnsupported).toHaveBeenCalledWith(
      1,
      'native-screen',
      expect.stringContaining('Screen Recording'),
      // The ledger's runbook-hash key — '' for this unpinned row (Codex finding 7).
      '',
    );
    // The gate runs BEFORE any lease — a host that cannot capture never holds the
    // screen (nor a deployment slot) even momentarily.
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(false);
  });

  it('a THROWING probe fails closed (treated as incapable), never onto the real screen', async () => {
    seedRun(db, 'run-throw');
    const { runner, run } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      nativeCaptureProbe: async () => {
        throw new Error('peekaboo exploded');
      },
    });

    const id = enqueueOne(scheduler, 'run-throw', 'native-desktop');
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    expect(rowOf(id).status).toBe('skipped');
    expect(rowOf(id).error_message).toContain('Screen Recording');
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
  });

  it('with NO probe wired the phase-0 skip reason is preserved byte-for-byte', async () => {
    seedRun(db, 'run-noprobe');
    const { runner, run } = gatedRunner();
    const scheduler = initScheduler({ agentRunner: runner });

    const id = enqueueOne(scheduler, 'run-noprobe', 'native-desktop');
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toBe(
      "unsupported modality 'native-screen': native-screen capture/drive not yet wired on the agent path (proposal §4)",
    );
  });

  // ── mobile: the same four shapes as native-screen above. The modality used to
  //    be an unconditional table skip; the iOS-Simulator tier made it a HOST
  //    question, answered by its own probe (mobile-verification-tier §10).
  it("with NO mobile probe wired a 'mobile' row skips with the table detail byte-for-byte", async () => {
    seedRun(db, 'run-mobile-noprobe');
    const { runner, run } = gatedRunner();
    const nativeProbe = vi.fn(async () => true);
    const scheduler = initScheduler({ agentRunner: runner, nativeCaptureProbe: nativeProbe });

    const id = enqueueOne(scheduler, 'run-mobile-noprobe', 'mobile-flow');
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    expect(nativeProbe).not.toHaveBeenCalled(); // that probe is native-screen's alone
    const row = rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('mobile');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toBe(
      `unsupported modality 'mobile': ${MOBILE_TOOLCHAIN_UNPROBED_DETAIL}`,
    );
  });

  it('a CAPABLE host deploys the mobile row, takes a verify:mobile slot and leases NO port', async () => {
    seedRun(db, 'run-mobile-ok');
    const { runner, run, releaseAll } = gatedRunner();
    const probe = vi.fn(async () => true);
    const scheduler = initScheduler({ agentRunner: runner, mobileToolchainProbe: probe });

    const id = enqueueOne(scheduler, 'run-mobile-ok', 'mobile-flow');
    await flushDrain();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(statusOf(id)).toBe('running');
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(true);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(true);
    // M1: mobile serves nothing over HTTP and drives no CDP endpoint.
    expect(mutex.isLocked(VERIFY_SCREEN_LEASE)).toBe(false);
    for (const port of CONFIG.devServerPorts) expect(mutex.isLocked(verifyPortLease(port))).toBe(false);
    const req = run.mock.calls[0][0] as VerificationAgentRequest;
    expect(req.modality).toBe('mobile');
    expect(req.verifyPort).toBeNull();
    expect(req.verifyDriverPort).toBeNull();

    releaseAll();
    await flushDrain();
    expect(statusOf(id)).toBe('passed');
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(false);
  });

  it('an INCAPABLE host (probe false) skips as unsupported, naming the three separable facts', async () => {
    seedRun(db, 'run-mobile-nohost');
    const { runner, run } = gatedRunner();
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const markUnsupported = vi.spyOn(store, 'markUnsupported');
    const scheduler = initScheduler({
      agentRunner: runner,
      capabilityStore: store,
      mobileToolchainProbe: async () => false,
    });

    const id = enqueueOne(scheduler, 'run-mobile-nohost', 'mobile-flow');
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toBe(
      `unsupported modality 'mobile': ${MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL}`,
    );
    expect(markUnsupported).toHaveBeenCalledWith(
      1,
      'mobile',
      expect.stringContaining('command-line tools'),
      '',
    );
    // Pre-lease: an incapable host never holds a simulator slot even momentarily.
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(false);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(false);
  });

  it('a THROWING mobile probe fails closed — never onto a simulator create + boot', async () => {
    seedRun(db, 'run-mobile-throw');
    const { runner, run } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      mobileToolchainProbe: async () => {
        throw new Error('xcrun exploded');
      },
    });

    const id = enqueueOne(scheduler, 'run-mobile-throw', 'mobile-flow');
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    expect(rowOf(id).status).toBe('skipped');
    expect(rowOf(id).error_message).toContain(MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL);
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(false);
  });

  it('leaves the (N+1)th mobile row QUEUED and releases its agent slot when every simulator slot is held', async () => {
    seedRun(db, 'run-mobile-full');
    const { runner, run, gateFor } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      mobileToolchainProbe: async () => true,
      // One simulator, two agent slots: the pool under test is the MOBILE one.
      config: { ...CONFIG, mobileSimSlots: 1 },
    });

    const ids = [
      enqueueOne(scheduler, 'run-mobile-full', 'mobile-flow'),
      enqueueOne(scheduler, 'run-mobile-full', 'mobile-flow'),
    ];
    await flushDrain();

    const running = ids.filter((id) => statusOf(id) === 'running');
    const queued = ids.filter((id) => statusOf(id) === 'queued');
    expect(running).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    // The agent slot the queued row briefly held was GIVEN BACK — otherwise a
    // full simulator pool would also strangle every web lane.
    expect(mutex.isLocked(verifyAgentSlot(1))).toBe(false);

    gateFor(running[0]).resolve();
    await flushDrain();
    expect(statusOf(queued[0])).toBe('running');
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(true);
  });

  it('clamps mobileSimSlots into [1,4] — 0 yields one slot, 9 yields four', async () => {
    for (const [configured, expectedSlots] of [
      [0, 1],
      [9, 4],
    ] as const) {
      db.close();
      db = buildDb();
      mutex = new Mutex();
      VerificationScheduler._resetForTesting();
      seedRun(db, 'run-clamp');
      const { runner, releaseAll } = gatedRunner();
      const scheduler = initScheduler({
        agentRunner: runner,
        mobileToolchainProbe: async () => true,
        config: { ...CONFIG, mobileSimSlots: configured, agentSlots: 8 },
      });

      for (let i = 0; i < 5; i++) enqueueOne(scheduler, 'run-clamp', 'mobile-flow');
      await flushDrain();

      const held = [0, 1, 2, 3, 4].filter((i) => mutex.isLocked(verifyMobileSlot(i)));
      expect(held).toEqual(Array.from({ length: expectedSlots }, (_, i) => i));
      releaseAll();
      await flushDrain();
    }
  });

  it('runs a mobile row on a port-EXHAUSTED pool (it needs no port at all)', async () => {
    seedRun(db, 'run-mobile-noports');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      mobileToolchainProbe: async () => true,
      config: { ...CONFIG, devServerPorts: [] },
    });

    const id = enqueueOne(scheduler, 'run-mobile-noports', 'mobile-flow');
    await flushDrain();

    // An empty port pool makes tryAcquireOneOf answer null forever — which is
    // exactly why the mobile path must not consult it.
    expect(statusOf(id)).toBe('running');
    expect(run).toHaveBeenCalledTimes(1);
    releaseAll();
    await flushDrain();
  });

  it('releases the simulator slot when the runner THROWS', async () => {
    seedRun(db, 'run-mobile-boom');
    const scheduler = initScheduler({
      agentRunner: {
        run: vi.fn(async () => {
          throw new Error('simctl exploded');
        }),
      },
      mobileToolchainProbe: async () => true,
    });

    const id = enqueueOne(scheduler, 'run-mobile-boom', 'mobile-flow');
    await flushDrain();

    expect(statusOf(id)).toBe('skipped');
    expect(mutex.isLocked(verifyMobileSlot(0))).toBe(false);
    expect(mutex.isLocked(verifyAgentSlot(0))).toBe(false);
  });
});

describe('VerificationScheduler — modality on the runner request', () => {
  it('threads the row\'s resolved modality (the SAME one the gates used) onto the request', async () => {
    seedRun(db, 'run-thread');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({
      agentRunner: runner,
      nativeCaptureProbe: async () => true,
    });

    enqueueOne(scheduler, 'run-thread');
    enqueueOne(scheduler, 'run-thread', 'native-desktop');
    await flushDrain();

    const modalities = run.mock.calls.map((call) => (call[0] as VerificationAgentRequest).modality);
    expect(modalities).toContain('web');
    expect(modalities).toContain('native-screen');
    releaseAll();
    await flushDrain();
  });

  it("threads 'cdp-app' for an attach:'cdp' task", async () => {
    seedRun(db, 'run-cdp');
    const { runner, run, releaseAll } = gatedRunner();
    const scheduler = initScheduler({ agentRunner: runner });

    scheduler.enqueue({
      runId: 'run-cdp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: {
        version: 1,
        summary: 'verify the app',
        behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
        serve: { cmd: 'electron .', attach: 'cdp' },
      },
      // A serve step would hit the §3.2 degrade gate without a proven runbook —
      // the setup-proof exemption is what lets this reach the runner at all.
      setupProof: true,
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as VerificationAgentRequest).modality).toBe('cdp-app');
    releaseAll();
    await flushDrain();
  });
});

describe('orderAgentDrainRows — §5.4 priority classes + anti-starvation', () => {
  const NOW = Date.parse('2026-07-30T12:00:00.000Z');
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

  it('drains lane requests before setup proofs regardless of enqueue order', () => {
    const rows = [
      { id: 'proof-old', enqueued_at: at(60_000), setupProof: true },
      { id: 'lane-new', enqueued_at: at(1_000), setupProof: false },
    ];
    expect(orderAgentDrainRows(rows, NOW).map((r) => r.id)).toEqual(['lane-new', 'proof-old']);
  });

  it('preserves the SQL FIFO order within each class', () => {
    const rows = [
      { id: 'lane-1', enqueued_at: at(50_000), setupProof: false },
      { id: 'proof-1', enqueued_at: at(40_000), setupProof: true },
      { id: 'lane-2', enqueued_at: at(30_000), setupProof: false },
      { id: 'proof-2', enqueued_at: at(20_000), setupProof: true },
      { id: 'lane-3', enqueued_at: at(10_000), setupProof: false },
    ];
    expect(orderAgentDrainRows(rows, NOW).map((r) => r.id)).toEqual([
      'lane-1',
      'lane-2',
      'lane-3',
      'proof-1',
      'proof-2',
    ]);
  });

  it('promotes a setup proof older than the promotion window into lane priority', () => {
    const rows = [
      { id: 'lane', enqueued_at: at(1_000), setupProof: false },
      { id: 'proof-starved', enqueued_at: at(SETUP_PROOF_PROMOTION_MS), setupProof: true },
      { id: 'proof-fresh', enqueued_at: at(SETUP_PROOF_PROMOTION_MS - 1), setupProof: true },
    ];
    // The starved proof was BEHIND the lane row in FIFO order, so promotion puts it
    // in class 0 while its original index keeps it after the lane row it followed.
    expect(orderAgentDrainRows(rows, NOW).map((r) => r.id)).toEqual([
      'lane',
      'proof-starved',
      'proof-fresh',
    ]);
  });

  it('does NOT promote a proof whose enqueued_at is unparseable', () => {
    const rows = [
      { id: 'proof-broken-clock', enqueued_at: 'not-a-date', setupProof: true },
      { id: 'lane', enqueued_at: at(1_000), setupProof: false },
    ];
    expect(orderAgentDrainRows(rows, NOW).map((r) => r.id)).toEqual(['lane', 'proof-broken-clock']);
  });

  it('is a no-op for an all-lane backlog (legacy rows report setupProof false)', () => {
    const rows = [
      { id: 'a', enqueued_at: at(3_000), setupProof: false },
      { id: 'b', enqueued_at: at(2_000), setupProof: false },
      { id: 'c', enqueued_at: at(1_000), setupProof: false },
    ];
    expect(orderAgentDrainRows(rows, NOW).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
