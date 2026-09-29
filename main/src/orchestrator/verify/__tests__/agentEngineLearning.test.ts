/**
 * AgentEngine — §A5 "learn from success" end to end over a REAL
 * VerifyRunbookStore (docs/proposals/runbook-optional-verification.md §A5):
 *
 *   - the learning trigger: only a terminal `passed` EXPLORE request with a
 *     harness-validated recipe learns, and only on an eligible record
 *     (first writer wins; a committed entry gets a suggestion instead);
 *   - the kill switch: on ⇒ nothing is learned and no learned pin is honoured.
 *
 * The runner is a stub returning a result as the real runner shapes it; the
 * engine, the delivery chokepoint and the store are real.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { AgentEngine } from '../agentEngine';
import type { AgentEngineDeps } from '../agentEngine';
import { TerminalDelivery } from '../terminalDelivery';
import { ResourceLeasePool } from '../verificationLeases';
import type { OnVerdict } from '../verificationSchedulerContracts';
import type { VerificationRequestRow } from '../verificationRequestRows';
import { VerifyRunbookStore } from '../runbookStore';
import { probeLearnedPinSurface } from '../learnedRunbook';
import type { RunbookLearningFinding } from '../learnedRunbook';
import type { VerificationAgentRequest, VerificationAgentRunResult } from '../verificationAgentRunner';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';
import type {
  ResolvedVisualVerifyConfig,
  VerificationModality,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry } from '../../../../../shared/types/verifyRunbook';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PORT = 5173;
const WORKTREE = '/wt/run-1';
const SERVE = 'pnpm run preview --port ${PORT}';
const HTTP = { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' } as const;
const INPUT: VerificationRequestInput = { intent: 'the page renders', taskRef: 'TASK-3' };
const TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'the page renders',
  serve: { cmd: SERVE },
  attestation: HTTP,
  behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
};
const ENTRY: VerifyRunbookModalityEntry = { build: ['pnpm run build'], serve: { cmd: SERVE }, attestation: HTTP };

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

function report(over: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'page' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'ok',
    issues: [],
    ...over,
  };
}

/** A passing explore result carrying a runner-validated recipe. */
function passedWithRecipe(entry: VerifyRunbookModalityEntry = ENTRY): VerificationAgentRunResult {
  return {
    status: 'passed',
    fileNames: ['s.png'],
    deployed: true,
    provisionMode: 'snapshot',
    report: report(),
    learnedRecipe: { ok: true, entry },
  };
}

interface Harness {
  db: Database.Database;
  store: VerifyRunbookStore;
  engine: AgentEngine;
  run: ReturnType<typeof vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>>;
  findings: RunbookLearningFinding[];
  files: Map<string, string>;
  live: { requireProvenRunbook: boolean };
  gate: { modality: VerificationModality | null; setupProof: boolean; bootstrapProof: boolean };
  nudge: ReturnType<typeof vi.fn<() => void>>;
  onVerdict: ReturnType<typeof vi.fn<OnVerdict>>;
}

function harness(opts: { pin?: { hash: string; version: number }; snapshotSha?: string | null; task?: VerificationTaskV1 } = {}, over: Partial<AgentEngineDeps> = {}): Harness {
  const db = buildDb();
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, task_json, snapshot_sha, runbook_hash, runbook_local_version, modality)
     VALUES ('r1', 'run-1', 1, 'queued', 'interactive-web-behavior', ?, '["agent"]', ?, ?, ?, ?, 'web')`,
  ).run(
    JSON.stringify(INPUT),
    JSON.stringify(opts.task ?? TASK),
    opts.snapshotSha === undefined ? 'abc123' : opts.snapshotSha,
    opts.pin?.hash ?? null,
    opts.pin?.version ?? null,
  );
  const files = new Map<string, string>();
  const store = new VerifyRunbookStore(dbAdapter(db), {
    readPortableFile: async (dir) => files.get(dir) ?? null,
    computeInputHash: async () => 'inputs-v1',
    hostFingerprint: async () => 'host-v1',
    hasPackageJson: async () => true,
  });
  const findings: RunbookLearningFinding[] = [];
  const live = { requireProvenRunbook: false };
  const config: ResolvedVisualVerifyConfig = { ...VISUAL_VERIFY_DEFAULTS, agentSlots: 1, devServerPorts: [PORT] };
  const run = vi.fn<(req: VerificationAgentRequest) => Promise<VerificationAgentRunResult>>(async () => passedWithRecipe());
  const gate: Harness['gate'] = { modality: 'web', setupProof: false, bootstrapProof: false };
  const nudge = vi.fn<() => void>();
  const onVerdict = vi.fn<OnVerdict>(async () => undefined);
  const engine = new AgentEngine({
    db: dbAdapter(db),
    config,
    liveConfig: () => ({ ...config, requireProvenRunbook: live.requireProvenRunbook }),
    runbookStore: store,
    runbookStatus: (projectId, modality, probePath) => store.statusDetail(projectId, probePath ?? '/wt', modality),
    learningFinding: (f) => {
      findings.push(f);
    },
    leasePool: new ResourceLeasePool(),
    artifactsDirResolver: (runId) => `/artifacts/${runId}`,
    agentRunner: { run },
    agentRequestTimeoutMs: 60_000,
    agentRequestCeilingMs: 120_000,
    portFreeProbe: async () => true,
    delivery: new TerminalDelivery({ db: dbAdapter(db), onVerdict }),
    inFlight: new Map(),
    agentGateColumnsForRow: () => gate,
    worktreePathForRun: () => WORKTREE,
    projectPathFor: () => '/wt',
    acquireBatchMutex: async () => null,
    isProjectBudgetExhausted: () => false,
    incrementJudgeCallsUsed: () => {},
    portFromLease: (name) => (name?.startsWith('verify:port:') ? Number(name.slice('verify:port:'.length)) : null),
    nudge,
    ...over,
  });
  return { db, store, engine, run, findings, files, live, gate, nudge, onVerdict };
}

async function drain(h: Harness): Promise<void> {
  const { work } = await h.engine.processAgentRow(row(), INPUT);
  await work;
}

function record(db: Database.Database): { status: string; version: number; origin: string | null; portable_json: string } | undefined {
  return db
    .prepare("SELECT status, version, origin, portable_json FROM verify_runbook_local WHERE project_id = 1 AND modality = 'web'")
    .get() as ReturnType<typeof record>;
}

function requestRow(db: Database.Database): { status: string; runbook_hash: string | null; runbook_local_version: number | null; task_json: string } {
  return db
    .prepare('SELECT status, runbook_hash, runbook_local_version, task_json FROM verification_requests WHERE id = ?')
    .get('r1') as ReturnType<typeof requestRow>;
}

// ---------------------------------------------------------------------------
// The learning trigger
// ---------------------------------------------------------------------------

describe('AgentEngine — §A5 learning trigger', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  it('a passed explore request with a validated recipe is LEARNED as an unproven learned draft, and a finding names the commands + source', async () => {
    h = harness();
    await drain(h);
    expect(h.run.mock.calls[0][0].executionMode).toBe('explore');
    expect(requestRow(h.db).status).toBe('passed');
    const r = record(h.db);
    expect(r).toMatchObject({ status: 'unproven-draft', origin: 'learned', version: 1 });
    const stored = JSON.parse(r?.portable_json ?? '{}') as { modalities: { web: VerifyRunbookModalityEntry } };
    expect(stored.modalities.web.serve?.cmd).toBe(SERVE);
    expect(stored.modalities.web.notes).toContain('verification request r1');
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0].title).toMatch(/learned/i);
    expect(h.findings[0].body).toContain('pnpm run build');
    expect(h.findings[0].body).toContain(SERVE);
    expect(h.findings[0].body).toContain('r1');
  });

  it('nothing is learned from a non-passed explore terminal, even carrying a recipe', async () => {
    for (const status of ['low_confidence', 'failed', 'skipped'] as const) {
      h = harness();
      h.run.mockResolvedValue({ ...passedWithRecipe(), status });
      await drain(h);
      expect(record(h.db)).toBeUndefined();
      expect(h.findings).toEqual([]);
      h.db.close();
    }
    h = harness();
  });

  it('nothing is learned from a rejected recipe, a dirty-fallback run, or a pass without a recipe', async () => {
    h = harness();
    h.run.mockResolvedValue({ ...passedWithRecipe(), learnedRecipe: { ok: false, reason: 'no' } });
    await drain(h);
    expect(record(h.db)).toBeUndefined();
    h.db.close();

    h = harness({ snapshotSha: null });
    await drain(h);
    expect(record(h.db)).toBeUndefined();
    h.db.close();

    h = harness();
    const noRecipe = passedWithRecipe();
    delete noRecipe.learnedRecipe;
    h.run.mockResolvedValue(noRecipe);
    await drain(h);
    expect(record(h.db)).toBeUndefined();
    expect(requestRow(h.db).status).toBe('passed');
  });

  it('nothing is learned from a PINNED pass (a proven record is already pinned)', async () => {
    h = harness();
    h.files.set('/wt', JSON.stringify({ version: 1, modalities: { web: ENTRY } }));
    const reg = await h.store.registerDraft(1, '/wt', 'web');
    if ('error' in reg) throw new Error(reg.error);
    h.store.markProven(1, 'web', reg.hash, reg.version, '{}', { inputHash: 'inputs-v1', hostFingerprint: 'host-v1' });
    h.db.prepare('UPDATE verification_requests SET runbook_hash = ?, runbook_local_version = ?').run(reg.hash, reg.version);
    h.run.mockResolvedValue(passedWithRecipe({ ...ENTRY, build: ['pnpm run build:other'] }));
    await drain(h);
    expect(h.run.mock.calls[0][0].executionMode).toBe('pinned');
    expect(record(h.db)).toMatchObject({ status: 'proven', version: reg.version, origin: null });
    expect(h.findings).toEqual([]);
  });

  it('first writer wins: an existing learned draft is never overwritten', async () => {
    h = harness();
    const first = await h.store.registerLearnedDraft(1, 'web', { ...ENTRY, build: ['pnpm run build:first'] }, undefined, '/wt', null);
    if ('error' in first) throw new Error(first.error);
    await drain(h);
    const r = record(h.db);
    expect(r?.version).toBe(1);
    expect(r?.portable_json).toContain('build:first');
    expect(h.findings).toEqual([]);
  });

  it('a committed file declaring the modality (file-only) gets a SUGGESTED entry finding, not a learned record', async () => {
    h = harness();
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: { ...ENTRY, build: ['pnpm run build:committed'] } } }));
    await drain(h);
    expect(record(h.db)).toBeUndefined();
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0].title).toMatch(/suggested/i);
    expect(h.findings[0].body).toContain('"pnpm run build"');
  });

  it('KILL SWITCH ON: the row runs legacy/skips as before and nothing is learned', async () => {
    h = harness();
    h.live.requireProvenRunbook = true;
    await drain(h);
    // A serve task with no proven runbook skips at gate 3 — today's behaviour.
    expect(h.run).not.toHaveBeenCalled();
    expect(requestRow(h.db).status).toBe('skipped');
    expect(record(h.db)).toBeUndefined();
  });

  it('KILL SWITCH flipped on mid-run: an explore pass settles, but nothing is learned', async () => {
    h = harness();
    h.run.mockImplementation(async () => {
      h.live.requireProvenRunbook = true;
      return passedWithRecipe();
    });
    await drain(h);
    expect(requestRow(h.db).status).toBe('passed');
    expect(record(h.db)).toBeUndefined();
    expect(h.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Promotion via a learned pin — the exits
// ---------------------------------------------------------------------------

/** Seed a learned draft and pin the row to it, as `prepareVerificationEnqueue` would have. */
async function pinToLearnedDraft(h: Harness): Promise<{ hash: string; version: number }> {
  const out = await h.store.registerLearnedDraft(1, 'web', ENTRY, undefined, '/wt', null);
  if ('error' in out) throw new Error(out.error);
  h.db.prepare('UPDATE verification_requests SET runbook_hash = ?, runbook_local_version = ? WHERE id = ?').run(out.hash, out.version, 'r1');
  return out;
}

function failedBehaviourReport(): VerificationReportV1 {
  return report({
    outcome: 'fail',
    behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: ['s.png'], notes: 'wrong' } }],
  });
}

describe('AgentEngine — §A5 promotion via a learned pin', () => {
  let h: Harness;
  afterEach(() => h.db.close());

  it('the row runs PINNED as an ordinary request (no proof flag) and a pass PROMOTES the draft, then delivers + files the promotion finding', async () => {
    h = harness();
    const pin = await pinToLearnedDraft(h);
    h.run.mockResolvedValue({ status: 'passed', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: report() });
    await drain(h);

    const req = h.run.mock.calls[0][0];
    expect(req).toMatchObject({ executionMode: 'pinned', runbookHash: pin.hash, runbookLocalVersion: pin.version });
    expect(req).not.toHaveProperty('setupProof');
    expect(record(h.db)).toMatchObject({ status: 'proven', origin: 'learned', version: pin.version });
    expect(requestRow(h.db).status).toBe('passed');
    expect(h.onVerdict).toHaveBeenCalledTimes(1);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0].title).toMatch(/promoted/);
    expect(h.findings[0].body).toContain('pnpm run build');
    expect(h.findings[0].body).toContain('r1');
  });

  it('KILL SWITCH flipped on mid-run: the pass is delivered, but the draft is NOT promoted and no finding is filed (review F4)', async () => {
    h = harness();
    const pin = await pinToLearnedDraft(h);
    h.run.mockImplementation(async () => {
      h.live.requireProvenRunbook = true;
      return { status: 'passed', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: report() };
    });
    await drain(h);

    expect(h.run.mock.calls[0][0]).toMatchObject({ executionMode: 'pinned', runbookHash: pin.hash });
    expect(requestRow(h.db).status).toBe('passed');
    expect(h.onVerdict).toHaveBeenCalledTimes(1);
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft', origin: 'learned', version: pin.version });
    expect(h.findings).toEqual([]);
  });

  it('a HARNESS-verified stood-up surface with a FAILING behaviour delivers normally and KEEPS the draft', async () => {
    h = harness();
    await pinToLearnedDraft(h);
    h.run.mockResolvedValue({
      status: 'failed',
      fileNames: ['s.png'],
      deployed: true,
      provisionMode: 'snapshot',
      report: failedBehaviourReport(),
      surfaceVerified: true,
    });
    await drain(h);
    expect(requestRow(h.db).status).toBe('failed');
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft', origin: 'learned' });
    expect(h.nudge).not.toHaveBeenCalled();
    expect(h.findings).toEqual([]);
  });

  it('a pre-deploy harness skip (the recipe never ran) delivers normally and keeps the draft', async () => {
    h = harness();
    await pinToLearnedDraft(h);
    h.run.mockResolvedValue({ status: 'skipped', fileNames: [], deployed: false, errorMessage: 'preflight: chromium absent' });
    await drain(h);
    expect(requestRow(h.db).status).toBe('skipped');
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft' });
  });

  const DISCARDS: Array<[string, VerificationAgentRunResult]> = [
    [
      'build_failed',
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        report: report({ outcome: 'build_failed', behaviors: [] }),
        errorMessage: 'tsc exploded',
      },
    ],
    ['low_confidence', { status: 'low_confidence', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: report() }],
    ['an identity failure', { status: 'failed', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: report(), foreignSurface: true }],
    // Codex A5 review F3: a behaviour fail the harness never saw stand up is not a "kept" fail.
    [
      'a behaviour fail on an UNVERIFIED surface',
      { status: 'failed', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: failedBehaviourReport(), surfaceVerified: false },
    ],
    [
      'a behaviour fail with NO surface fact',
      { status: 'failed', fileNames: ['s.png'], deployed: true, provisionMode: 'snapshot', report: failedBehaviourReport() },
    ],
    ['a runbook mismatch', { status: 'skipped', fileNames: [], deployed: false, runbookMismatch: true, errorMessage: 'runbook/sha mismatch' }],
    [
      'wrong_environment',
      {
        status: 'low_confidence',
        fileNames: [],
        deployed: true,
        report: report({ outcome: 'wrong_environment', neededModality: 'mobile', diagnosis: 'iOS app' }),
        redispatch: { modality: 'mobile', diagnosis: 'iOS app' },
      },
    ],
  ];

  it.each(DISCARDS)('%s: the draft is DISCARDED, the pin cleared, and the SAME row re-dispatched once in explore', async (_name, result) => {
    h = harness();
    await pinToLearnedDraft(h);
    h.run.mockResolvedValueOnce(result);
    await drain(h);

    expect(record(h.db)).toBeUndefined();
    const r = requestRow(h.db);
    expect(r).toMatchObject({ status: 'queued', runbook_hash: null, runbook_local_version: null });
    expect(JSON.parse(r.task_json)).toMatchObject({ _redispatchedFrom: 'web', serve: { cmd: SERVE } });
    expect(h.nudge).toHaveBeenCalledTimes(1);
    expect(h.onVerdict).not.toHaveBeenCalled();

    // The re-drain explores, and the lane gets THAT verdict (here a pass that learns afresh).
    h.run.mockResolvedValueOnce(passedWithRecipe());
    await drain(h);
    expect(h.run.mock.calls[1][0].executionMode).toBe('explore');
    expect(h.run.mock.calls[1][0]).not.toHaveProperty('runbookHash');
    expect(requestRow(h.db).status).toBe('passed');
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft', origin: 'learned' });
  });

  it('the one-shot budget is SHARED with wrong_environment: the explore re-run cannot be re-dispatched again', async () => {
    h = harness();
    await pinToLearnedDraft(h);
    h.run.mockResolvedValueOnce({ status: 'low_confidence', fileNames: [], deployed: true, report: report() });
    await drain(h);
    expect(requestRow(h.db).status).toBe('queued');

    h.run.mockResolvedValueOnce({
      status: 'low_confidence',
      fileNames: [],
      deployed: true,
      report: report({ outcome: 'wrong_environment', neededModality: 'mobile', diagnosis: 'iOS app' }),
      redispatch: { modality: 'mobile', diagnosis: 'iOS app', app: { platform: 'ios-simulator', bundleId: 'a.b', scheme: 'A' } },
    });
    await drain(h);
    const r = h.db.prepare('SELECT status, error_message FROM verification_requests WHERE id = ?').get('r1') as {
      status: string;
      error_message: string;
    };
    expect(r.status).toBe('low_confidence');
    expect(r.error_message).toContain('already re-dispatched once');
  });

  it('a learned recipe that runs out the DEADLINE is discarded and the row explores', async () => {
    h = harness({}, { agentRequestTimeoutMs: 20, agentRequestCeilingMs: 20 });
    await pinToLearnedDraft(h);
    h.run.mockImplementationOnce(() => new Promise<VerificationAgentRunResult>(() => {}));
    await drain(h);
    expect(record(h.db)).toBeUndefined();
    expect(requestRow(h.db)).toMatchObject({ status: 'queued', runbook_hash: null });
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it('the discard is SKIPPED while another live request pins the same draft; the row still explores', async () => {
    h = harness();
    const pin = await pinToLearnedDraft(h);
    h.db
      .prepare(
        `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, runbook_hash, runbook_local_version)
         VALUES ('r2', 'run-2', 1, 'queued', 'interactive-web-behavior', '{}', ?, ?)`,
      )
      .run(pin.hash, pin.version);
    h.run.mockResolvedValueOnce({ status: 'low_confidence', fileNames: [], deployed: true, report: report() });
    await drain(h);
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft', origin: 'learned' });
    expect(requestRow(h.db)).toMatchObject({ status: 'queued', runbook_hash: null });
  });

  it("KILL SWITCH ON: a learned pin is not honoured — the row meets today's gate 3 and the draft is untouched", async () => {
    h = harness();
    await pinToLearnedDraft(h);
    h.live.requireProvenRunbook = true;
    await drain(h);
    expect(h.run).not.toHaveBeenCalled();
    expect(requestRow(h.db).status).toBe('skipped');
    expect(record(h.db)).toMatchObject({ status: 'unproven-draft', origin: 'learned' });
  });

  it('a pin to a NON-learned draft is not a learned pin (it explores, as a stale pin always has)', async () => {
    h = harness();
    h.files.set('/wt', JSON.stringify({ version: 1, modalities: { web: ENTRY } }));
    const reg = await h.store.registerDraft(1, '/wt', 'web');
    if ('error' in reg) throw new Error(reg.error);
    h.store.setOrigin(1, 'web', 'setup-flow');
    h.db.prepare('UPDATE verification_requests SET runbook_hash = ?, runbook_local_version = ?').run(reg.hash, reg.version);
    await drain(h);
    expect(h.run.mock.calls[0][0].executionMode).toBe('explore');
  });
});

// ---------------------------------------------------------------------------
// Codex A5 review F3 — the harness-owned "surface stood up" fact
// ---------------------------------------------------------------------------

describe('probeLearnedPinSurface', () => {
  const base = { requestId: 'r1', degenerateFileTarget: false };

  it('true only for a verified floor', async () => {
    const verified = async () => ({ kind: 'verified' as const, channel: 'http-endpoint' as const, detail: 'nonce' });
    expect(await probeLearnedPinSurface({ ...base, probe: verified })).toBe(true);
    for (const kind of ['missing', 'uncapped', 'foreign'] as const) {
      expect(await probeLearnedPinSurface({ ...base, probe: async () => ({ kind, detail: 'x' }) })).toBe(false);
    }
  });

  it('file-identity counts only on the bare htmlPath shape it holds by construction for', async () => {
    const fileIdentity = async () => ({ kind: 'verified' as const, channel: 'file-identity' as const, detail: 'by construction' });
    expect(await probeLearnedPinSurface({ ...base, probe: fileIdentity })).toBe(false);
    expect(await probeLearnedPinSurface({ ...base, degenerateFileTarget: true, probe: fileIdentity })).toBe(true);
  });

  it('a throwing probe reads as unverified', async () => {
    const probe = async (): Promise<never> => {
      throw new Error('boom');
    };
    expect(await probeLearnedPinSurface({ ...base, probe })).toBe(false);
  });
});
