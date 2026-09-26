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
