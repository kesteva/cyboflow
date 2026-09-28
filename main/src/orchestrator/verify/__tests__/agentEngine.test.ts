/**
 * AgentEngine — unit tests over the verification-agent engine extracted from
 * VerificationScheduler (issue #19 step 8). verificationSchedulerAgent.test.ts
 * still drives this path end-to-end through drain with a real request row and
 * runs/projects tables; these pin the engine's OWN contract with every
 * scheduler-owned helper stubbed as the closure it is injected as: the
 * pre-lease gates in precedence order, the slot → screen → port lease ladder,
 * the request the runner receives, budget/deadline/throw attribution, and the
 * lease + in-flight cleanup on every exit.
 *
 * The runbook-optional half (docs/proposals/runbook-optional-verification.md
 * §A1/§A3/§A11) lives in the later describes: gate (3) as a mode SELECTOR
 * under the kill switch, the explore request shape, report-less provenance,
 * the one-shot wrong-environment re-dispatch, and the breaker reset.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { Mutex } from '../../../utils/mutex';
import { AgentEngine } from '../agentEngine';
import type { AgentEngineDeps } from '../agentEngine';
import { TerminalDelivery } from '../terminalDelivery';
import { ResourceLeasePool, VERIFY_SCREEN_LEASE, verifyAgentSlot, verifyPortLease } from '../verificationLeases';
import type { OnVerdict } from '../verificationSchedulerContracts';
import type { VerificationRequestRow } from '../verificationRequestRows';
import type { VerifyCapabilityStore } from '../capabilityStore';
import type { VerifyRunbookStore, VerifyRunbookStatusDetail } from '../runbookStore';
import type {
  ExploreRunbookRecord,
  VerificationAgentRequest,
  VerificationAgentRunResult,
} from '../verificationAgentRunner';
import { VERIFY_NO_RUNBOOK_REASON, VERIFY_RUNBOOK_DRIFTED_REASON } from '../verificationSkipReasons';
import { VISUAL_VERIFY_DEFAULTS, parseVerificationTaskV1, taskJsonHasInferredApp } from '../../../../../shared/types/visualVerification';
import type {
  MobileAppSpec,
  ResolvedVisualVerifyConfig,
  VerificationModality,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

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
      preflight_json         TEXT,
      modality               TEXT,
      runbook_hash           TEXT,
      runbook_local_version  INTEGER
    );
  `);
  return db;
}

const INPUT: VerificationRequestInput = { intent: 'the page renders', url: 'https://staging.example.test/', taskRef: 'TASK-3' };
const PORT = 5173;

function row(verifyType = 'interactive-web-behavior'): VerificationRequestRow {
  return {
    id: 'r1',
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: verifyType,
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
  /** The pool's own mutex — lets a SYNCHRONOUS callback (the nudge) ask whether a lease is still held. */
  mutex: Mutex;
  run: ReturnType<typeof vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>>;
  onVerdict: ReturnType<typeof vi.fn<OnVerdict>>;
  inFlight: Map<string, AbortController>;
  judgeCalls: string[];
  gate: { modality: VerificationModality | null; setupProof: boolean; bootstrapProof: boolean };
  budgetExhausted: { value: boolean };
  nudge: ReturnType<typeof vi.fn<() => void>>;
}

interface HarnessOpts {
  task?: VerificationTaskV1;
  /** A RAW `task_json` string, for the engine-only keys the task parser drops. Wins over `task`. */
  rawTaskJson?: string;
  runner?: false;
  /** The row's migration-096 pin columns. */
  pin?: { hash: string; version: number };
  /** `config.requireProvenRunbook` — the runbook-optional kill switch (§A1). */
  killSwitch?: boolean;
  /** Config fields layered over the harness defaults. */
  config?: Partial<ResolvedVisualVerifyConfig>;
  /** What `runbookStore.getCurrent` holds per modality (the explore lever source, §A1.3). */
  records?: Partial<Record<VerificationModality, ExploreRunbookRecord>>;
}

/** A `runbookStore` whose `getCurrent` answers from `records` — the only store method the gate reads. */
function fakeRunbookStore(records: Partial<Record<VerificationModality, ExploreRunbookRecord>>): VerifyRunbookStore {
  return {
    getCurrent: (_projectId: number, modality: VerificationModality) => {
      const record = records[modality];
      return record ? { ...record, version: 1 } : null;
    },
  } as unknown as VerifyRunbookStore;
}

function harness(over: Partial<AgentEngineDeps> = {}, opts: HarnessOpts = {}): Harness {
  const db = buildDb();
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, task_json, snapshot_sha, runbook_hash, runbook_local_version)
     VALUES ('r1', 'run-1', 1, 'queued', 'interactive-web-behavior', ?, '["agent"]', ?, 'abc123', ?, ?)`,
  ).run(
    JSON.stringify(INPUT),
    opts.rawTaskJson ?? (opts.task ? JSON.stringify(opts.task) : null),
    opts.pin?.hash ?? null,
    opts.pin?.version ?? null,
  );
  const onVerdict = vi.fn<OnVerdict>(async () => undefined);
  const run = vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>(async () => PASSED);
  const mutex = new Mutex();
  const pool = new ResourceLeasePool(mutex);
  const inFlight = new Map<string, AbortController>();
  const judgeCalls: string[] = [];
  const gate: Harness['gate'] = { modality: 'web', setupProof: false, bootstrapProof: false };
  const budgetExhausted = { value: false };
  const nudge = vi.fn<() => void>();
  const engine = new AgentEngine({
    db: dbAdapter(db),
    config: {
      ...VISUAL_VERIFY_DEFAULTS,
      agentSlots: 1,
      devServerPorts: [PORT],
      ...(opts.killSwitch ? { requireProvenRunbook: true } : {}),
      ...opts.config,
    },
    ...(opts.records ? { runbookStore: fakeRunbookStore(opts.records) } : {}),
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
    nudge,
    ...over,
  });
  return { db, engine, pool, mutex, run, onVerdict, inFlight, judgeCalls, gate, budgetExhausted, nudge };
}

function terminal(db: Database.Database): { status: string; error: string | null; delivery: string | null; failureClass: string | null } {
  const r = db
    .prepare('SELECT status, error_message, delivery_state, failure_class FROM verification_requests WHERE id = ?')
    .get('r1') as { status: string; error_message: string | null; delivery_state: string | null; failure_class: string | null };
  return { status: r.status, error: r.error_message, delivery: r.delivery_state, failureClass: r.failure_class };
}

/** The persisted failure evidence, parsed (`[]` when the column is NULL). */
function evidence(db: Database.Database): Array<{ source: string; check?: string; detail: string }> {
  const r = db.prepare('SELECT failure_evidence_json FROM verification_requests WHERE id = ?').get('r1') as {
    failure_evidence_json: string | null;
  };
  return JSON.parse(r.failure_evidence_json ?? '[]') as Array<{ source: string; check?: string; detail: string }>;
}

/** The §A1.1 report-less provenance entry for `mode`. */
function modeEntry(mode: string): { source: string; check: string; detail: string } {
  return { source: 'runner', check: 'execution-mode', detail: mode };
}

/** The one request the runner was handed. */
function onlyRequest(h: Harness): VerificationAgentRequest {
  expect(h.run).toHaveBeenCalledTimes(1);
  return h.run.mock.calls[0][0];
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

    it('gate 3 (kill switch on): a task that derives an environment needs a PROVEN runbook — unless it IS the proof', async () => {
      const serving: VerificationTaskV1 = { version: 1, summary: 'serve then check', serve: { cmd: 'npm run dev' }, behaviors: [] };
      h = harness({}, { task: serving, killSwitch: true });

      await h.engine.processAgentRow(row(), INPUT);
      expect(h.run).not.toHaveBeenCalled();
      expect(terminal(h.db)).toMatchObject({ status: 'skipped', failureClass: 'env' });

      h.db.close();
      h = harness({}, { task: serving, killSwitch: true });
      h.gate.setupProof = true;
      const { work } = await h.engine.processAgentRow(row(), INPUT);
      await work;
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ setupProof: true, verifyPort: PORT }));
      expect(terminal(h.db).status).toBe('passed');
    });

    it('gate 3a (kill switch on): a composed web task with no build, serve, target or app skips before any lease', async () => {
      // shiny-eagle 9/22: an iOS lane composed `native-screen` with nothing to
      // stand up, stamped `web`, and burned an agent that had nothing to open.
      const empty: VerificationTaskV1 = { version: 1, summary: 'banned apps list', modality: 'native-screen', behaviors: [] };
      h = harness({}, { task: empty, killSwitch: true });

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
          // No pin + web ⇒ explore (§A1): the agent may have to stand the page
          // up itself, so it gets the leased port even for a live url, and the
          // explore floor (15 min default) is clipped by this harness's ceiling.
          executionMode: 'explore',
          exploreRecord: null,
          verifyPort: PORT,
          verifyDriverPort: PORT + 1,
          timeoutMs: 120_000,
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
      // Kill switch on ⇒ legacy: the deadline is the injected default, unfloored.
      h = harness({ agentRequestTimeoutMs: 1_000, agentRequestCeilingMs: 2_000 }, { killSwitch: true });
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
      // §A1.1 — no report, so the mode rides on the evidence.
      expect(evidence(h.db)).toEqual([modeEntry('legacy')]);
      await expectLeasesFree(h.pool);
    });
  });
});

// ---------------------------------------------------------------------------
// Runbook-optional verification (docs/proposals/runbook-optional-verification.md)
// ---------------------------------------------------------------------------

const BUILD_TASK: VerificationTaskV1 = { version: 1, summary: 'build then check', build: ['pnpm build'], behaviors: [] };
const SERVE_TASK: VerificationTaskV1 = { version: 1, summary: 'serve then check', serve: { cmd: 'npm run dev' }, behaviors: [] };
const TARGET_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'live page',
  target: { url: 'https://staging.example.test/' },
  behaviors: [],
};
const SURFACELESS_TASK: VerificationTaskV1 = { version: 1, summary: 'names nothing', behaviors: [] };
const IOS_APP: MobileAppSpec = { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'App' };
const MOBILE_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'the iOS list renders',
  build: ['xcodebuild -scheme App build'],
  app: IOS_APP,
  behaviors: [],
};
const CDP_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'the desktop panel renders',
  serve: { cmd: 'electron .', attach: 'cdp' },
  behaviors: [],
};

function runbookWith(levers?: VerifyRunbookV1['levers']): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: { serve: { cmd: 'pnpm dev --port ${PORT}' }, attestation: { kind: 'http-endpoint', urlPath: '/__v' } },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
    },
    ...(levers ? { levers } : {}),
  };
}

/** A registered-but-unproven record the agent itself learned (A5) — a draft like any other. */
const LEARNED_DRAFT: ExploreRunbookRecord = {
  hash: 'l'.repeat(64),
  status: 'unproven-draft',
  origin: 'learned',
  runbook: runbookWith(),
};
/** A cdp-app draft that knows how to confine the app's state dir (§A1.3). */
const CDP_DRAFT_WITH_LEVERS: ExploreRunbookRecord = {
  hash: 'd'.repeat(64),
  status: 'unproven-draft',
  origin: 'lane-bootstrap',
  runbook: runbookWith({ dataDirEnv: 'CYBOFLOW_DIR' }),
};
const CDP_DRAFT_NO_LEVERS: ExploreRunbookRecord = { ...CDP_DRAFT_WITH_LEVERS, runbook: runbookWith() };

const PIN = { hash: 'p'.repeat(64), version: 3 };
const DRAFT_STATUS: VerifyRunbookStatusDetail = { status: 'unproven-draft', reason: 'draft' };
const DRIFTED_STATUS: VerifyRunbookStatusDetail = { status: 'unproven-draft', reason: 'drifted' };
const PROVEN_STATUS: VerifyRunbookStatusDetail = { status: 'proven', reason: 'proven' };

/** How the kill switch is engaged for one row — each is an independent route to "on" (§A1, RS-11). */
type SwitchRoute = 'config' | 'env' | 'live config' | 'off';

/** The live-config reader the `'live config'` route injects: boot config OFF, live config ON. */
function liveOn(): ResolvedVisualVerifyConfig {
  return { ...VISUAL_VERIFY_DEFAULTS, agentSlots: 1, devServerPorts: [PORT], requireProvenRunbook: true };
}

type Outcome = { skip: string } | { mode: 'legacy' | 'explore'; exploreRecord?: ExploreRunbookRecord };

interface GateCase {
  name: string;
  modality: VerificationModality;
  task: VerificationTaskV1;
  records?: Partial<Record<VerificationModality, ExploreRunbookRecord>>;
  status?: VerifyRunbookStatusDetail;
  on: Outcome;
  off: Outcome;
}

const NOTHING_TO_STAND_UP = 'names nothing to stand up';

/**
 * THE KILL-SWITCH TABLE (runbook-optional-verification.md §A1 "Kill switch" +
 * its Test paragraph). With the switch ON — whichever of its three routes turns
 * it on — every case keeps TODAY's gate outcome: the skips skip with today's
 * reason, and what ran still runs, as `legacy`. With it OFF, the same rows
 * explore wherever the modality can (web, mobile, cdp-app with a data-dir
 * lever), and the pinned-only / lever-less ones still skip.
 */
const GATE_CASES: GateCase[] = [
  { name: 'a build task', modality: 'web', task: BUILD_TASK, on: { skip: VERIFY_NO_RUNBOOK_REASON }, off: { mode: 'explore' } },
  { name: 'a serve task', modality: 'web', task: SERVE_TASK, on: { skip: VERIFY_NO_RUNBOOK_REASON }, off: { mode: 'explore' } },
  { name: 'a degenerate target-only task', modality: 'web', task: TARGET_TASK, on: { mode: 'legacy' }, off: { mode: 'explore' } },
  { name: 'a surfaceless web task', modality: 'web', task: SURFACELESS_TASK, on: { skip: NOTHING_TO_STAND_UP }, off: { mode: 'explore' } },
  {
    name: 'a mobile-flow run with no runbook',
    modality: 'mobile',
    task: MOBILE_TASK,
    on: { skip: VERIFY_NO_RUNBOOK_REASON },
    off: { mode: 'explore' },
  },
  {
    name: 'a present learned draft',
    modality: 'web',
    task: SERVE_TASK,
    records: { web: LEARNED_DRAFT },
    status: DRAFT_STATUS,
    // A learned draft is just a draft: it never unlocks gate 3 by itself.
    on: { skip: VERIFY_NO_RUNBOOK_REASON },
    off: { mode: 'explore', exploreRecord: LEARNED_DRAFT },
  },
  {
    name: 'a cdp-app task with no levers anywhere',
    modality: 'cdp-app',
    task: CDP_TASK,
    records: { 'cdp-app': CDP_DRAFT_NO_LEVERS },
    status: DRAFT_STATUS,
    on: { skip: VERIFY_NO_RUNBOOK_REASON },
    off: { skip: VERIFY_NO_RUNBOOK_REASON },
  },
  {
    name: 'a cdp-app task whose draft declares a dataDirEnv lever',
    modality: 'cdp-app',
    task: CDP_TASK,
    records: { 'cdp-app': CDP_DRAFT_WITH_LEVERS },
    status: DRAFT_STATUS,
    on: { skip: VERIFY_NO_RUNBOOK_REASON },
    off: { mode: 'explore', exploreRecord: CDP_DRAFT_WITH_LEVERS },
  },
  // A declared dataDirEnv the runner's binder DROPS confines nothing, so the
  // row cannot explore on its promise (RS-8, F8).
  ...(['cyboflow_dir', 'HOME', 'VERIFY_PORT'] as const).map(
    (dataDirEnv): GateCase => ({
      name: `a cdp-app task whose draft declares an unbindable dataDirEnv (${dataDirEnv})`,
      modality: 'cdp-app',
      task: CDP_TASK,
      records: { 'cdp-app': { ...CDP_DRAFT_WITH_LEVERS, runbook: runbookWith({ dataDirEnv }) } },
      status: DRAFT_STATUS,
      on: { skip: VERIFY_NO_RUNBOOK_REASON },
      off: { skip: VERIFY_NO_RUNBOOK_REASON },
    }),
  ),
  {
    name: 'a native-screen build task with no runbook',
    modality: 'native-screen',
    task: BUILD_TASK,
    on: { skip: VERIFY_NO_RUNBOOK_REASON },
    off: { skip: VERIFY_NO_RUNBOOK_REASON },
  },
];

describe('AgentEngine — gate (3) is an execution-mode selector (§A1)', () => {
  let h: Harness;
  afterEach(() => {
    vi.unstubAllEnvs();
    h.db.close();
  });

  async function drive(c: GateCase, route: SwitchRoute): Promise<void> {
    if (route === 'env') vi.stubEnv('CYBOFLOW_VERIFY_REQUIRE_RUNBOOK', '1');
    h = harness(
      {
        ...(c.status ? { runbookStatus: async () => c.status as VerifyRunbookStatusDetail } : {}),
        nativeCaptureProbe: async () => true,
        mobileToolchainProbe: async () => true,
        ...(route === 'live config' ? { liveConfig: liveOn } : {}),
      },
      { task: c.task, killSwitch: route === 'config', records: c.records ?? {} },
    );
    h.gate.modality = c.modality;
    const { work } = await h.engine.processAgentRow(row(), INPUT);
    await work;
  }

  function expectOutcome(expected: Outcome): void {
    if ('skip' in expected) {
      expect(h.run).not.toHaveBeenCalled();
      const t = terminal(h.db);
      expect(t).toMatchObject({ status: 'skipped', failureClass: 'env' });
      expect(t.error).toContain(expected.skip);
      return;
    }
    const req = onlyRequest(h);
    expect(req.executionMode).toBe(expected.mode);
    if (expected.mode === 'explore') {
      expect(req.exploreRecord).toEqual(expected.exploreRecord ?? null);
      expect(req.runbookHash).toBeUndefined();
    } else {
      expect(req).not.toHaveProperty('exploreRecord');
    }
  }

  const onRoutes: SwitchRoute[] = ['config', 'env', 'live config'];
  describe.each(onRoutes)('kill switch ON via %s: today’s gate outcomes hold', (route) => {
    it.each(GATE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      await drive(c, route);
      expectOutcome(c.on);
    });
  });

  describe('kill switch OFF (the default)', () => {
    it.each(GATE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      await drive(c, 'off');
      expectOutcome(c.off);
    });
  });

  it('the switch is read LIVE per row, not from the boot snapshot', async () => {
    let engaged = true;
    h = harness(
      { liveConfig: () => ({ ...VISUAL_VERIFY_DEFAULTS, requireProvenRunbook: engaged }) },
      { task: SERVE_TASK },
    );
    await (await h.engine.processAgentRow(row(), INPUT)).work;
    expect(h.run).not.toHaveBeenCalled();
    expect(terminal(h.db).error).toBe(VERIFY_NO_RUNBOOK_REASON);

    // Same engine, same boot config, switch flipped off in Settings.
    h.db.prepare(`UPDATE verification_requests SET status = 'queued', error_message = NULL`).run();
    engaged = false;
    await (await h.engine.processAgentRow(row(), INPUT)).work;
    expect(onlyRequest(h).executionMode).toBe('explore');
  });

  it('a valid pin stays pinned: its revision rides to the runner and nothing explores', async () => {
    let statusReads = 0;
    h = harness(
      {
        runbookStatus: async () => {
          statusReads += 1;
          return PROVEN_STATUS;
        },
      },
      { task: SERVE_TASK, pin: PIN, records: { web: LEARNED_DRAFT } },
    );
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const req = onlyRequest(h);
    expect(req).toMatchObject({ executionMode: 'pinned', runbookHash: PIN.hash, runbookLocalVersion: PIN.version });
    expect(req).not.toHaveProperty('exploreRecord');
    // Pinned keeps today's deadline — no explore floor.
    expect(req.timeoutMs).toBe(60_000);
    // The selector's read of the pin IS gate 3's read — one probe of the tree
    // per row, so the two can never disagree about it.
    expect(statusReads).toBe(1);
  });

  it('a valid pin keeps gate 3a too: a pinned task with no surface still skips with the switch off', async () => {
    // A runbook entry may declare neither build nor serve (both optional), so
    // the merge can pin a web task that names nothing to open. "Pinned: today's
    // contract, unchanged" (§A1) includes 3a — explore alone bypasses it.
    h = harness({ runbookStatus: async () => PROVEN_STATUS }, { task: SURFACELESS_TASK, pin: PIN });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(h.run).not.toHaveBeenCalled();
    expect(terminal(h.db)).toMatchObject({ status: 'skipped', failureClass: 'env' });
    expect(terminal(h.db).error).toContain(NOTHING_TO_STAND_UP);
  });

  it('a pin whose record now reads drifted EXPLORES with the switch off — the stale pin is dropped', async () => {
    h = harness({ runbookStatus: async () => DRIFTED_STATUS }, { task: SERVE_TASK, pin: PIN, records: { web: LEARNED_DRAFT } });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const req = onlyRequest(h);
    expect(req.executionMode).toBe('explore');
    expect(req).not.toHaveProperty('runbookHash');
    expect(req).not.toHaveProperty('runbookLocalVersion');
    expect(req.exploreRecord).toEqual(LEARNED_DRAFT);
  });

  it('…and SKIPS with the drift reason with the switch on', async () => {
    h = harness({ runbookStatus: async () => DRIFTED_STATUS }, { task: SERVE_TASK, pin: PIN, killSwitch: true });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(h.run).not.toHaveBeenCalled();
    expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: VERIFY_RUNBOOK_DRIFTED_REASON });
  });

  it('a proof row is pinned whatever the switch says', async () => {
    h = harness({}, { task: SERVE_TASK });
    h.gate.bootstrapProof = true;
    await (await h.engine.processAgentRow(row(), INPUT)).work;
    expect(onlyRequest(h)).toMatchObject({ executionMode: 'pinned', setupProof: true });
  });
});

describe('AgentEngine — the explore request (§A1.1)', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  const LONG_CEILING = 20 * 60 * 1000;

  it('always exports VERIFY_PORT on web and takes the LIVE explore floor', async () => {
    h = harness(
      {
        agentRequestCeilingMs: LONG_CEILING,
        liveConfig: () => ({ ...VISUAL_VERIFY_DEFAULTS, exploreDeadlineFloorMs: 900_000 }),
      },
      // A build-only task implies no server: pinned/legacy would NOT export the port.
      { task: BUILD_TASK, config: { exploreDeadlineFloorMs: 1 } },
    );
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const req = onlyRequest(h);
    expect(req.executionMode).toBe('explore');
    expect(req.verifyPort).toBe(PORT);
    // The floor came from the LIVE config (900s), not the boot snapshot (1ms).
    expect(req.timeoutMs).toBe(900_000);
  });

  it('the same task under legacy keeps today’s port and deadline', async () => {
    h = harness({ agentRequestCeilingMs: LONG_CEILING }, { task: TARGET_TASK, killSwitch: true });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const req = onlyRequest(h);
    expect(req.executionMode).toBe('legacy');
    expect(req.verifyPort).toBeNull();
    expect(req.timeoutMs).toBe(60_000);
  });

  it('a mobile explore stays portless and is floored at the larger of the two floors', async () => {
    h = harness(
      { agentRequestCeilingMs: LONG_CEILING, mobileToolchainProbe: async () => true },
      { task: MOBILE_TASK, config: { mobileDeadlineFloorMs: 300_000, exploreDeadlineFloorMs: 600_000 } },
    );
    h.gate.modality = 'mobile';
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const req = onlyRequest(h);
    expect(req).toMatchObject({ executionMode: 'explore', modality: 'mobile', verifyPort: null, verifyDriverPort: null });
    expect(req.timeoutMs).toBe(600_000);
  });
});

describe('AgentEngine — report-less terminals record the execution mode (§A1.1)', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  it('a runner throw', async () => {
    h = harness({}, { task: SERVE_TASK });
    h.run.mockRejectedValueOnce(new Error('sdk spawn failed'));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(terminal(h.db)).toMatchObject({ status: 'skipped', error: 'sdk spawn failed' });
    expect(evidence(h.db)).toEqual([modeEntry('explore')]);
  });

  it('an exhausted budget', async () => {
    h = harness({}, { task: SERVE_TASK });
    h.budgetExhausted.value = true;
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(evidence(h.db)).toEqual([modeEntry('explore')]);
  });

  it('a runner result that carries no report — and a pinned one says pinned', async () => {
    h = harness({ runbookStatus: async () => PROVEN_STATUS }, { task: SERVE_TASK, pin: PIN });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(terminal(h.db).status).toBe('passed');
    expect(evidence(h.db)).toEqual([modeEntry('pinned')]);
  });

  it('a result WITH a report leaves the evidence to the classifier (the report carries its own provenance)', async () => {
    h = harness({}, { task: SERVE_TASK });
    const report: VerificationReportV1 = {
      version: 1,
      behaviors: [],
      screenshots: [],
      outcome: 'pass',
      confidence: 0.9,
      feedback: 'ok',
      issues: [],
      provenance: { executionMode: 'explore' },
    };
    h.run.mockResolvedValueOnce({ ...PASSED, report });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(terminal(h.db).status).toBe('passed');
    expect(evidence(h.db)).toEqual([]);
  });
});

/** A runner result carrying the §A3 channel: the agent reported `wrong_environment`. */
function wrongEnvironment(
  modality: VerificationModality,
  app?: MobileAppSpec,
): VerificationAgentRunResult {
  const report: VerificationReportV1 = {
    version: 1,
    behaviors: [],
    screenshots: [],
    outcome: 'wrong_environment',
    diagnosis: 'this is an iOS app, not a web page',
    neededModality: modality,
    ...(app ? { app } : {}),
    confidence: 0.2,
    feedback: 'needs a simulator',
    issues: [],
  };
  return {
    status: 'low_confidence',
    report,
    fileNames: [],
    deployed: true,
    provisionMode: 'snapshot',
    redispatch: { modality, ...(app ? { app } : {}), diagnosis: 'this is an iOS app, not a web page' },
  };
}

interface RequestRowState {
  status: string;
  modality: string | null;
  task_json: string | null;
  leased_at: string | null;
  enqueued_at: string | null;
  attempt: number;
  ended_at: string | null;
  delivery_state: string | null;
  error_message: string | null;
  failure_class: string | null;
}

function rowState(db: Database.Database): RequestRowState {
  return db
    .prepare(
      `SELECT status, modality, task_json, leased_at, enqueued_at, attempt, ended_at, delivery_state, error_message, failure_class
         FROM verification_requests WHERE id = 'r1'`,
    )
    .get() as RequestRowState;
}

/**
 * A host that CAN run every modality — the re-dispatch declines a needed
 * modality gate (1) would refuse on the re-drain, so a requeue test must say
 * the host supports it.
 */
const CAPABLE_HOST: Partial<AgentEngineDeps> = {
  mobileToolchainProbe: async () => true,
  nativeCaptureProbe: async () => true,
};

describe('AgentEngine — wrong environment: one automatic re-dispatch (§A3)', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  function ledger(): { store: VerifyCapabilityStore; recordEnvFailure: ReturnType<typeof vi.fn>; recordHealthyOutcome: ReturnType<typeof vi.fn> } {
    const recordEnvFailure = vi.fn(() => ({ tripped: false }));
    const recordHealthyOutcome = vi.fn();
    const store = {
      markUnsupported: vi.fn(),
      getActiveSuppression: () => null,
      recordEnvFailure,
      recordHealthyOutcome,
    } as unknown as VerifyCapabilityStore;
    return { store, recordEnvFailure, recordHealthyOutcome };
  }

  it('an explore row is REQUEUED under the needed modality — no terminal, no delivery, no ledger, nudged after release', async () => {
    const l = ledger();
    h = harness({ capabilityStore: l.store, ...CAPABLE_HOST }, { task: SERVE_TASK });
    // Backdate the enqueue so the reset to SQLite's own clock is observable.
    h.db.prepare(`UPDATE verification_requests SET enqueued_at = '2020-01-01 00:00:00'`).run();
    const heldAtNudge: Array<{ slot: boolean; port: boolean; inFlight: boolean }> = [];
    h.nudge.mockImplementation(() => {
      heldAtNudge.push({
        slot: h.mutex.isLocked(verifyAgentSlot(0)),
        port: h.mutex.isLocked(verifyPortLease(PORT)),
        inFlight: h.inFlight.has('r1'),
      });
    });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile', IOS_APP));

    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state).toMatchObject({
      status: 'queued',
      modality: 'mobile',
      leased_at: null,
      attempt: 0,
      ended_at: null,
      delivery_state: null,
      error_message: null,
    });
    expect(state.enqueued_at).not.toBe('2020-01-01 00:00:00');
    // SQLite's own `YYYY-MM-DD HH:MM:SS` shape — never a JS ISO string (A9).
    expect(state.enqueued_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(JSON.parse(state.task_json ?? '{}')).toEqual({
      ...SERVE_TASK,
      modality: 'mobile',
      app: IOS_APP,
      _redispatchedFrom: 'web',
    });
    expect(h.onVerdict).not.toHaveBeenCalled();
    expect(l.recordEnvFailure).not.toHaveBeenCalled();
    expect(l.recordHealthyOutcome).not.toHaveBeenCalled();
    // Charged for the deploy it did spend; the redeploy is charged again.
    expect(h.judgeCalls).toEqual(['r1']);
    expect(heldAtNudge).toEqual([{ slot: false, port: false, inFlight: false }]);
  });

  it("a mobile re-dispatch falls back to the TASK's own app when the report names none", async () => {
    h = harness(CAPABLE_HOST, { task: { ...SERVE_TASK, app: IOS_APP } });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile'));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state.status).toBe('queued');
    expect(JSON.parse(state.task_json ?? '{}')).toMatchObject({ modality: 'mobile', app: IOS_APP, _redispatchedFrom: 'web' });
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it('a stored task_json that fails validation is requeued as the task that RAN, so the new app survives the re-drain', async () => {
    // The engine ran the degenerate task (the stored one has no `version`).
    // Round-tripping the invalid object would fail the parser again on the
    // second drain, drop the `app` with it, and land on the env-classed
    // MOBILE_NO_APP_BLOCK skip that feeds the breaker (§A2).
    h = harness(CAPABLE_HOST, { rawTaskJson: JSON.stringify({ summary: 'no version field', behaviors: [] }) });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile', IOS_APP));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state.status).toBe('queued');
    const raw = JSON.parse(state.task_json ?? '{}') as Record<string, unknown>;
    expect(raw._redispatchedFrom).toBe('web');
    const reparsed = parseVerificationTaskV1(raw);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.task).toMatchObject({ modality: 'mobile', app: IOS_APP, summary: INPUT.intent });
  });

  it('native-screen is re-dispatched on a native-desktop run', async () => {
    h = harness(CAPABLE_HOST, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce(wrongEnvironment('native-screen'));
    await (await h.engine.processAgentRow(row('native-desktop'), INPUT)).work;

    expect(rowState(h.db)).toMatchObject({ status: 'queued', modality: 'native-screen' });
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it('a cancel that won the race keeps the row — no requeue, no nudge, no delivery', async () => {
    h = harness({}, { task: SERVE_TASK });
    h.run.mockImplementationOnce(async () => {
      h.db.prepare(`UPDATE verification_requests SET status = 'timeout', error_message = 'canceled'`).run();
      return wrongEnvironment('mobile', IOS_APP);
    });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state).toMatchObject({ status: 'timeout', error_message: 'canceled', modality: null });
    expect(JSON.parse(state.task_json ?? '{}')).toEqual(SERVE_TASK);
    expect(h.nudge).not.toHaveBeenCalled();
    expect(h.onVerdict).not.toHaveBeenCalled();
  });

  interface TerminalCase {
    name: string;
    opts: HarnessOpts;
    over?: Partial<AgentEngineDeps>;
    result: VerificationAgentRunResult;
    verifyType?: string;
    declined: string;
  }
  const TERMINAL_CASES: TerminalCase[] = [
    {
      name: 'a second mismatch (the engine-only marker is already set)',
      opts: { rawTaskJson: JSON.stringify({ ...SERVE_TASK, _redispatchedFrom: 'cdp-app' }) },
      result: wrongEnvironment('mobile', IOS_APP),
      declined: 'already re-dispatched once, from cdp-app',
    },
    {
      // It explored (the pin reads drifted), but a requeue would re-drain it
      // with a hash that names the OLD modality's record.
      name: 'an explore row that still carries a stale pin',
      opts: { task: SERVE_TASK, pin: PIN },
      over: { runbookStatus: async () => DRIFTED_STATUS },
      result: wrongEnvironment('mobile', IOS_APP),
      declined: 'this row still carries a runbook pin',
    },
    {
      name: 'a legacy row (kill switch on)',
      opts: { task: TARGET_TASK, killSwitch: true },
      result: wrongEnvironment('mobile', IOS_APP),
      declined: 'this one ran legacy',
    },
    {
      name: 'native-screen on a run that is not native-desktop',
      opts: { task: SERVE_TASK },
      result: wrongEnvironment('native-screen'),
      declined: 'native-screen is honoured only on a native-desktop run',
    },
    {
      name: 'mobile with no app on the report or the task',
      opts: { task: SERVE_TASK },
      result: wrongEnvironment('mobile'),
      declined: 'no iOS app',
    },
    {
      name: 'the modality it already ran under',
      opts: { task: SERVE_TASK },
      result: wrongEnvironment('web'),
      declined: 'it already ran as web',
    },
    {
      // The re-drain would hit gate (1): a pre-lease "unsupported modality"
      // skip that advances the lane, writes the ledger, and drops the diagnosis.
      name: 'mobile on a host with no iOS toolchain',
      opts: { task: SERVE_TASK },
      over: { mobileToolchainProbe: async () => false },
      result: wrongEnvironment('mobile', IOS_APP),
      declined: 'mobile is unsupported on this host',
    },
    {
      name: 'native-screen on a native-desktop run whose host cannot capture',
      opts: { task: SERVE_TASK },
      over: { nativeCaptureProbe: async () => false },
      result: wrongEnvironment('native-screen'),
      verifyType: 'native-desktop',
      declined: 'native-screen is unsupported on this host',
    },
    {
      // The re-drain could not explore and would land on the legacy
      // "no proven runbook" pre-lease skip.
      name: 'cdp-app with no registered record',
      opts: { task: SERVE_TASK },
      result: wrongEnvironment('cdp-app'),
      declined: 'cdp-app cannot explore here',
    },
    {
      name: 'cdp-app whose record declares no dataDirEnv lever',
      opts: { task: SERVE_TASK, records: { 'cdp-app': CDP_DRAFT_NO_LEVERS } },
      result: wrongEnvironment('cdp-app'),
      declined: 'cdp-app cannot explore here',
    },
    {
      name: 'cdp-app whose dataDirEnv lever the binder would drop',
      opts: {
        task: SERVE_TASK,
        records: { 'cdp-app': { ...CDP_DRAFT_WITH_LEVERS, runbook: runbookWith({ dataDirEnv: 'HOME' }) } },
      },
      result: wrongEnvironment('cdp-app'),
      declined: 'cdp-app cannot explore here',
    },
  ];

  it.each(TERMINAL_CASES.map((c) => [c.name, c] as const))(
    'terminal as unverifiable: %s',
    async (_name, c) => {
      const l = ledger();
      h = harness({ capabilityStore: l.store, ...CAPABLE_HOST, ...c.over }, c.opts);
      h.run.mockResolvedValueOnce(c.result);
      await (await h.engine.processAgentRow(row(c.verifyType), INPUT)).work;

      const state = rowState(h.db);
      expect(state.status).toBe('low_confidence');
      expect(state.failure_class).toBeNull();
      expect(state.delivery_state).toBe('delivered');
      const needed = c.result.redispatch?.modality ?? '';
      expect(state.error_message?.startsWith(`unverifiable (wrong environment: needs ${needed}`)).toBe(true);
      expect(state.error_message).toContain(c.declined);
      expect(state.error_message).toContain('this is an iOS app, not a web page');
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ status: 'low_confidence' }));
      expect(h.nudge).not.toHaveBeenCalled();
      // Never fed to the breaker, in either direction — nor marked unsupported.
      expect(l.recordEnvFailure).not.toHaveBeenCalled();
      expect(l.recordHealthyOutcome).not.toHaveBeenCalled();
      expect(l.store.markUnsupported).not.toHaveBeenCalled();
    },
  );

  it('cdp-app IS re-dispatched when its record declares an exportable dataDirEnv lever', async () => {
    h = harness(CAPABLE_HOST, { task: SERVE_TASK, records: { 'cdp-app': CDP_DRAFT_WITH_LEVERS } });
    h.run.mockResolvedValueOnce(wrongEnvironment('cdp-app'));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(rowState(h.db)).toMatchObject({ status: 'queued', modality: 'cdp-app' });
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  /**
   * §A4's pinned row. A declined `wrong_environment` on a PINNED row must not
   * become A3's advancing `low_confidence`: that would let an agent that could
   * not stand a proven recipe up dodge the blocking uncorroborated-unverifiable
   * rule by labelling its report differently — even naming the modality it
   * already ran. The runner no longer emits the channel for a pinned row; this
   * is the engine's backstop.
   */
  describe('a pinned row terminates under §A4, never as an advancing low_confidence', () => {
    const PINNED_CASES: Array<{ name: string; needed: VerificationModality; proof?: 'setupProof' | 'bootstrapProof' }> = [
      { name: 'a real mismatch', needed: 'mobile' },
      { name: 'the modality it already ran under', needed: 'web' },
      { name: 'a setup-proof row', needed: 'mobile', proof: 'setupProof' },
      { name: 'a bootstrap-proof row', needed: 'web', proof: 'bootstrapProof' },
    ];

    it.each(PINNED_CASES.map((c) => [c.name, c] as const))(
      'snapshot: verdict-less blocking failed, classed ambiguous — %s',
      async (_name, c) => {
        const l = ledger();
        h = harness(
          { capabilityStore: l.store, ...CAPABLE_HOST, runbookStatus: async () => PROVEN_STATUS },
          { task: SERVE_TASK, pin: PIN },
        );
        if (c.proof) h.gate[c.proof] = true;
        h.run.mockResolvedValueOnce(wrongEnvironment(c.needed, c.needed === 'mobile' ? IOS_APP : undefined));
        await (await h.engine.processAgentRow(row(), INPUT)).work;

        expect(onlyRequest(h).executionMode).toBe('pinned');
        const state = rowState(h.db);
        expect(state.status).toBe('failed');
        expect(state.failure_class).toBe('ambiguous');
        expect(state.modality).toBeNull();
        expect(state.error_message).toContain('unverifiable on a pinned runbook with no harness corroboration');
        expect(state.error_message).toContain(`needs ${c.needed}`);
        expect(state.error_message).toContain('this is an iOS app, not a web page');
        const stored = h.db.prepare(`SELECT verdict_json, report_json FROM verification_requests WHERE id = 'r1'`).get() as {
          verdict_json: string | null;
          report_json: string | null;
        };
        expect(stored.verdict_json).toBeNull();
        expect(JSON.parse(stored.report_json ?? '{}')).toMatchObject({ outcome: 'unverifiable' });
        expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
        expect(h.nudge).not.toHaveBeenCalled();
        // 'ambiguous' touches neither side of the breaker.
        expect(l.recordEnvFailure).not.toHaveBeenCalled();
        expect(l.recordHealthyOutcome).not.toHaveBeenCalled();
      },
    );

    it('dirty-worktree fallback: skipped, exactly like the runner\'s unattributable unverifiable', async () => {
      h = harness({ ...CAPABLE_HOST, runbookStatus: async () => PROVEN_STATUS }, { task: SERVE_TASK, pin: PIN });
      h.run.mockResolvedValueOnce({ ...wrongEnvironment('web'), provisionMode: 'fallback' });
      await (await h.engine.processAgentRow(row(), INPUT)).work;

      const state = rowState(h.db);
      expect(state.status).toBe('skipped');
      expect(state.error_message).toMatch(/^unattributable shared-worktree unverifiable: wrong environment: needs web/);
    });
  });
});

describe('AgentEngine — A11 breaker reset', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  function lowConfidence(results: Array<'pass' | 'fail' | 'not_testable'>): VerificationAgentRunResult {
    return {
      status: 'low_confidence',
      deployed: true,
      provisionMode: 'snapshot',
      fileNames: [],
      report: {
        version: 1,
        behaviors: results.map((result, i) => ({ id: `b${i}`, result, evidence: { screenshots: [], notes: '' } })),
        screenshots: [],
        outcome: 'pass',
        confidence: 0.5,
        feedback: '',
        issues: [],
      },
    };
  }

  it.each([
    ['one behaviour passed', true, ['pass', 'not_testable'] as const],
    ['one behaviour failed', true, ['fail'] as const],
    ['nothing was exercised', false, ['not_testable', 'not_testable'] as const],
    ['no behaviours at all', false, [] as const],
  ])('a deployed low_confidence where %s resets the breaker: %s', async (_label, resets, results) => {
    const recordHealthyOutcome = vi.fn();
    const store = {
      markUnsupported: vi.fn(),
      getActiveSuppression: () => null,
      recordEnvFailure: vi.fn(() => ({ tripped: false })),
      recordHealthyOutcome,
    } as unknown as VerifyCapabilityStore;
    h = harness({ capabilityStore: store }, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce(lowConfidence([...results]));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(terminal(h.db).status).toBe('low_confidence');
    expect(recordHealthyOutcome).toHaveBeenCalledTimes(resets ? 1 : 0);
    if (resets) expect(recordHealthyOutcome).toHaveBeenCalledWith(1, 'web', '');
  });

  it('an UNDEPLOYED low_confidence never resets it', async () => {
    const recordHealthyOutcome = vi.fn();
    const store = {
      markUnsupported: vi.fn(),
      getActiveSuppression: () => null,
      recordEnvFailure: vi.fn(() => ({ tripped: false })),
      recordHealthyOutcome,
    } as unknown as VerifyCapabilityStore;
    h = harness({ capabilityStore: store }, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce({ ...lowConfidence(['pass']), deployed: false });
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    expect(recordHealthyOutcome).not.toHaveBeenCalled();
  });
});

describe('AgentEngine — a mobile re-dispatch infers its app from the project (§A2/§A3)', () => {
  let h: Harness;
  let root: string;
  afterEach(() => {
    h.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function iosProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'engine-redispatch-ios-'));
    writeFileSync(
      join(dir, 'project.yml'),
      'targets:\n  Distractodo:\n    type: application\n    platform: iOS\n    settings:\n      PRODUCT_BUNDLE_IDENTIFIER: com.example.distractodo\n',
    );
    return dir;
  }

  it('no app on the report or the task: the surface probe over the run worktree supplies a TAGGED one, and the row requeues', async () => {
    root = iosProject();
    h = harness({ ...CAPABLE_HOST, worktreePathForRun: () => root }, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile'));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state).toMatchObject({ status: 'queued', modality: 'mobile' });
    expect(JSON.parse(state.task_json ?? '{}')).toMatchObject({
      modality: 'mobile',
      app: { platform: 'ios-simulator', bundleId: 'com.example.distractodo', scheme: 'Distractodo' },
      _redispatchedFrom: 'web',
    });
    // The engine-only tag rides the requeued task_json, so the re-drain knows the block is a guess.
    expect(taskJsonHasInferredApp(state.task_json)).toBe(true);
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it('a probe miss keeps the terminal unverifiable path', async () => {
    root = mkdtempSync(join(tmpdir(), 'engine-redispatch-web-'));
    writeFileSync(join(root, 'package.json'), '{}');
    h = harness({ ...CAPABLE_HOST, worktreePathForRun: () => root }, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile'));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(state.status).toBe('low_confidence');
    expect(state.error_message).toContain('no iOS app');
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it('an app the report names wins over the probe (the probe never overrides one)', async () => {
    root = iosProject();
    h = harness({ ...CAPABLE_HOST, worktreePathForRun: () => root }, { task: SERVE_TASK });
    h.run.mockResolvedValueOnce(wrongEnvironment('mobile', IOS_APP));
    await (await h.engine.processAgentRow(row(), INPUT)).work;

    const state = rowState(h.db);
    expect(JSON.parse(state.task_json ?? '{}')).toMatchObject({ app: IOS_APP });
    expect(taskJsonHasInferredApp(state.task_json)).toBe(false);
  });
});
