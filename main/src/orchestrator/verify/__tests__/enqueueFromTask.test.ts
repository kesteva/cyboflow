/**
 * enqueueTaskVerification — the main-process, MCP-free enqueue seam the
 * programmatic controller uses for the agentless visual-verify step
 * (verification-agent redesign §5.3/§5.4). Mirrors the MCP handler's dual-format
 * enqueue: reads the run's immutable verify stamps + project id, resolves the
 * chain, captures the snapshot sha, FORCES the lane ref onto both persisted
 * columns, keys idempotency on runId:ref:attempt, and returns enqueued/skipped.
 *
 * The DB is a minimal in-memory pair of tables (workflow_runs + the migration-078
 * verification_requests) — the only rows this seam reads/writes; the scheduler's
 * backends/judge are empty/fake (nothing is drained during the test).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerificationScheduler } from '../verificationScheduler';
import {
  declaredWebModality,
  enqueueTaskVerification,
  prepareVerificationEnqueue,
  resolveEnqueueModality,
  FORBIDDEN_DEP_COMMAND_ERROR,
} from '../enqueueFromTask';
import { VerifyRunbookStore } from '../runbookStore';
import { checkRunbookPin } from '../verificationAgentRunner';
import { parseVerificationTaskV1 } from '../../../../../shared/types/visualVerification';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { VerificationModality, VerificationTaskV1, ResolvedVisualVerifyConfig, VlmJudge } from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry, VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';
import type { ProvenRunbookRevision } from '../verificationScheduler';

const fakeJudge: VlmJudge = {
  judge: async () => ({
    status: 'pass',
    confidence: 1,
    issues: [],
    feedback: '',
    judgedFileNames: [],
    baselineUsed: false,
    model: 'fake',
  }),
};

const baseConfig: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [5173],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
  autoBootstrapRunbook: false,
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER,
      status         TEXT NOT NULL DEFAULT 'running',
      verify_enabled INTEGER,
      verify_type    TEXT,
      verify_chain   TEXT
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
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      report_json      TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT,
      -- migration 095 (docs/proposals/verification-setup-flow.md §3/§3.6): the
      -- modality stamp this seam delegates to scheduler.enqueue, and the
      -- setup-proof flag it threads through.
      modality         TEXT,
      setup_proof      INTEGER NOT NULL DEFAULT 0,
      -- migration 096 (§5.2 seam 3): the content-addressed runbook PIN.
      runbook_hash          TEXT,
      runbook_local_version INTEGER,
      -- migration 107 (docs/proposals/lane-runbook-bootstrap.md §5): the
      -- lane-driven bootstrap proof kind.
      bootstrap_proof       INTEGER NOT NULL DEFAULT 0
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
  `);
  return db;
}

/**
 * A minimal portable runbook declaring the `web` modality with a build + serve
 * form deliberately DIFFERENT from what the composer guesses below, so the merge
 * is observable in the persisted `task_json`.
 */
const RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build:web'],
      serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/', timeoutMs: 30_000 } },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    },
  },
};

/**
 * A store over the in-memory DB with FAKE IO — the three injected probes are the
 * store's only filesystem contact, so faking them keeps this suite about the
 * enqueue seam rather than about disk. `readPortableFile` always answers the
 * runbook above, which is what makes `status()` able to reach `'proven'`.
 */
function buildRunbookStore(db: Database.Database): VerifyRunbookStore {
  return new VerifyRunbookStore(dbAdapter(db), {
    readPortableFile: async () => JSON.stringify(RUNBOOK),
    computeInputHash: async () => 'input-hash-1',
    hostFingerprint: async () => 'host-fingerprint-1',
  });
}

function seedRun(
  db: Database.Database,
  opts: { runId: string; enabled?: boolean; type?: string | null; chain?: string; projectId?: number },
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, status, verify_enabled, verify_type, verify_chain)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.projectId ?? 1,
    opts.enabled === false ? 0 : 1,
    opts.type === undefined ? 'static-render-snapshot' : opts.type,
    opts.chain ?? JSON.stringify(['capturePage', 'playwright']),
  );
}

function initScheduler(
  db: Database.Database,
  runbookStore?: VerifyRunbookStore,
  over: Partial<Parameters<typeof VerificationScheduler.initialize>[0]> = {},
): void {
  VerificationScheduler.initialize({
    db: dbAdapter(db),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => '/tmp/a',
    config: baseConfig,
    ...(runbookStore ? { runbookStore } : {}),
    ...over,
  });
}

const task: VerificationTaskV1 = {
  version: 1,
  summary: 'Check the login form renders',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
};

/** A real throwaway git repo so captureSnapshotSha resolves a real HEAD sha. */
let gitRepo: string;
beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), 'enqueue-from-task-git-'));
  const run = (...args: string[]): void => void execFileSync('git', args, { cwd: gitRepo });
  run('init', '-q');
  run('config', 'user.email', 't@t.dev');
  run('config', 'user.name', 'T');
  writeFileSync(join(gitRepo, 'f.txt'), 'hi');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
});
afterAll(() => rmSync(gitRepo, { recursive: true, force: true }));

let db: Database.Database;
beforeEach(() => {
  VerificationScheduler._resetForTesting();
  db = buildDb();
});
afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
});

function readRow(id: string): {
  deliverable_json: string;
  task_json: string | null;
  snapshot_sha: string | null;
  enqueue_key: string | null;
  verify_type: string;
  chain_json: string | null;
} {
  return db
    .prepare(
      'SELECT deliverable_json, task_json, snapshot_sha, enqueue_key, verify_type, chain_json FROM verification_requests WHERE id = ?',
    )
    .get(id) as ReturnType<typeof readRow>;
}

describe('enqueueTaskVerification — the snapshot sha is captured AFTER the bootstrap', () => {
  // The bootstrap writes up to TWO commits onto the lane's branch: the rung-1
  // config edit and the runbook. Capturing the sha before them pinned the request
  // to a tree where the runbook's own enabling edit does not exist — live-observed
  // as a `failed`/`ambiguous` terminal for a deliverable that was fine, because
  // the exported `portEnv` was read by a config that had not been edited yet.
  it('pins the sha the bootstrap left behind, not the one it started from', async () => {
    seedRun(db, { runId: 'run-snap', enabled: true });
    initScheduler(db);

    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).toString().trim();
    const spy = vi
      .spyOn(VerificationScheduler.getInstance(), 'maybeBootstrapRunbook')
      .mockImplementation(async () => {
        // Stands in for §8.1's config-edit commit + the runbook commit.
        writeFileSync(join(gitRepo, 'app.config.mjs'), 'export default { port: Number(process.env.PORT ?? 4320) };\n');
        execFileSync('git', ['add', '.'], { cwd: gitRepo });
        execFileSync('git', ['commit', '-q', '-m', 'chore: port-from-env'], { cwd: gitRepo });
        return { kind: 'not-attempted' } as Awaited<ReturnType<VerificationScheduler['maybeBootstrapRunbook']>>;
      });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-snap',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('enqueued');
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).toString().trim();
    expect(after).not.toBe(before);
    expect(result.outcome === 'enqueued' && readRow(result.requestId).snapshot_sha).toBe(after);
    spy.mockRestore();
  });
});

describe('enqueueTaskVerification', () => {
  it('a disabled run → skipped(verification-disabled), enqueues nothing', async () => {
    seedRun(db, { runId: 'run-1', enabled: false });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a missing run → skipped(no-run-row)', async () => {
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'nope',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'no-run-row' });
  });

  it('an enabled run → enqueued: dual-writes deliverable_json + task_json, forces the lane ref, keys on runId:ref:attempt, captures the sha', async () => {
    seedRun(db, { runId: 'run-1', chain: JSON.stringify(['capturePage', 'peekaboo']) });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      // task carries a DIFFERENT taskRef — the lane ref must win on BOTH columns.
      task: { ...task, taskRef: 'WRONG-REF' },
      laneTaskRef: 'TASK-007',
      attempt: 2,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    const requestId = result.outcome === 'enqueued' ? result.requestId : '';
    const row = readRow(requestId);

    // Dual-write: legacy deliverable_json (derived) + verbatim task_json, BOTH
    // carrying the forced lane ref.
    expect(JSON.parse(row.deliverable_json)).toEqual({ intent: task.summary, taskRef: 'TASK-007' });
    expect(JSON.parse(row.task_json as string).taskRef).toBe('TASK-007');
    // Idempotency key = runId:laneTaskRef:attempt.
    expect(row.enqueue_key).toBe('run-1:TASK-007:2');
    // A real git worktree → a real 40-hex snapshot sha.
    expect(row.snapshot_sha).toMatch(/^[0-9a-f]{40}$/);
    // Chain = FALLBACK_CHAINS[type] ∩ stamped chain, in FALLBACK order.
    expect(JSON.parse(row.chain_json as string)).toEqual(['capturePage', 'peekaboo']);
    expect(row.verify_type).toBe('static-render-snapshot');
  });

  it('threads setupProof through to setup_proof, and lets scheduler.enqueue own the modality stamp (§3.6)', async () => {
    seedRun(db, { runId: 'run-proof' });
    initScheduler(db);

    const proof = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
    });
    const lane = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(proof.outcome).toBe('enqueued');
    expect(lane.outcome).toBe('enqueued');
    const flags = (id: string): { setup_proof: number; modality: string | null } =>
      db
        .prepare('SELECT setup_proof, modality FROM verification_requests WHERE id = ?')
        .get(id) as { setup_proof: number; modality: string | null };

    expect(flags(proof.outcome === 'enqueued' ? proof.requestId : '').setup_proof).toBe(1);
    expect(flags(lane.outcome === 'enqueued' ? lane.requestId : '').setup_proof).toBe(0);
    // The task has no attach:'cdp' serve, so both resolve to the web modality —
    // derived ONCE, inside scheduler.enqueue, not duplicated in this seam.
    expect(flags(lane.outcome === 'enqueued' ? lane.requestId : '').modality).toBe('web');
  });

  it('a sha-capture failure (non-git worktree) → null snapshot_sha but STILL enqueues', async () => {
    seedRun(db, { runId: 'run-1' });
    initScheduler(db);
    const notARepo = mkdtempSync(join(tmpdir(), 'enqueue-not-git-'));
    try {
      const result = await enqueueTaskVerification({
        db: dbAdapter(db),
        runId: 'run-1',
        task,
        laneTaskRef: 'TASK-001',
        attempt: 1,
        worktreePath: notARepo,
      });
      expect(result.outcome).toBe('enqueued');
      const requestId = result.outcome === 'enqueued' ? result.requestId : '';
      expect(readRow(requestId).snapshot_sha).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('the SAME runId:ref:attempt key is idempotent (a crash re-walk reuses the existing request)', async () => {
    seedRun(db, { runId: 'run-1' });
    initScheduler(db);
    const args = {
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    };
    const a = await enqueueTaskVerification(args);
    const b = await enqueueTaskVerification(args);
    expect(a.outcome).toBe('enqueued');
    expect(b).toEqual(a); // same requestId
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 1 });
  });

  it('an uninitialized scheduler → skipped(scheduler-unavailable), never throws', async () => {
    seedRun(db, { runId: 'run-1' });
    // Deliberately NOT initialized.
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'scheduler-unavailable' });
  });

  it('an unstamped verify_type → skipped(verification-disabled)', async () => {
    seedRun(db, { runId: 'run-1', type: null });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
  });
});

// ---------------------------------------------------------------------------
// §7.2 — the ENQUEUE half of the dependency guard
// ---------------------------------------------------------------------------

describe('enqueueTaskVerification — §7.2 forbidden dependency commands', () => {
  it('a build step that installs is REJECTED — no row is written', async () => {
    seedRun(db, { runId: 'run-guard' });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-guard',
      task: { ...task, build: ['pnpm install --frozen-lockfile', 'pnpm run build'] },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('skipped');
    const reason = result.outcome === 'skipped' ? result.reason : '';
    expect(reason).toContain(FORBIDDEN_DEP_COMMAND_ERROR);
    // The offending command is named VERBATIM so the loopback can fix it.
    expect(reason).toContain('pnpm install --frozen-lockfile');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a serve command that installs before serving is REJECTED', async () => {
    seedRun(db, { runId: 'run-guard-2' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-guard-2',
      task: { ...task, serve: { cmd: 'pnpm install && pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a clean build/serve is untouched', async () => {
    seedRun(db, { runId: 'run-clean' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-clean',
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
  });
});

// ---------------------------------------------------------------------------
// §5.2 seam 3 — pinned compose-time injection
// ---------------------------------------------------------------------------

describe('enqueueTaskVerification — §5.2 seam 3 pinned runbook injection', () => {
  /** The composer's own (wrong) guess at how to stand the project up. */
  const guessedTask: VerificationTaskV1 = {
    ...task,
    build: ['pnpm run build'],
    serve: { cmd: 'pnpm dev --port ${PORT}' },
    viewports: [{ width: 1280, height: 800, label: 'desktop' }],
  };

  function readPersisted(id: string): {
    task_json: string | null;
    runbook_hash: string | null;
    runbook_local_version: number | null;
    deliverable_json: string;
  } {
    return db
      .prepare(
        'SELECT task_json, runbook_hash, runbook_local_version, deliverable_json FROM verification_requests WHERE id = ?',
      )
      .get(id) as ReturnType<typeof readPersisted>;
  }

  it('a PROVEN runbook replaces build/serve/attestation, keeps summary/behaviors/viewports/ref, and stamps the pin', async () => {
    seedRun(db, { runId: 'run-inject' });
    const store = buildRunbookStore(db);
    const registered = await store.registerDraft(1, gitRepo, 'web');
    expect('hash' in registered).toBe(true);
    const { hash, version } = registered as { hash: string; version: number };
    expect(store.markProven(1, 'web', hash, version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-inject',
      task: guessedTask,
      laneTaskRef: 'TASK-042',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');

    const persisted = JSON.parse(row.task_json as string) as VerificationTaskV1;
    // REPLACED by the runbook — the composer's guess is exactly the part §1 says
    // has never once been right.
    expect(persisted.build).toEqual(['pnpm run build:web']);
    expect(persisted.serve?.cmd).toBe('pnpm run preview -- --port ${PORT}');
    expect(persisted.attestation).toEqual({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' });
    // KEPT from the composed task — what is being checked this time.
    expect(persisted.summary).toBe(task.summary);
    expect(persisted.behaviors).toEqual(task.behaviors);
    expect(persisted.viewports).toEqual([{ width: 1280, height: 800, label: 'desktop' }]);
    expect(persisted.taskRef).toBe('TASK-042');
    // The PIN — both halves, on the row the runner will read.
    expect(row.runbook_hash).toBe(hash);
    expect(row.runbook_local_version).toBe(version);
  });

  it('ROUND-TRIPS: the persisted task re-parses into something the runner accepts against the same pin', async () => {
    // The load-bearing end-to-end invariant of §5.2 seam 3. The merged task is
    // JSON-persisted, then re-parsed by `parseVerificationTaskV1` before the
    // runner compares it to the entry `parseVerifyRunbookV1` produced. If those
    // two validators ever rebuild build/serve/attestation differently, EVERY
    // pinned request would self-reject at execution with a mismatch — a total,
    // silent outage that no unit test on either parser alone would catch.
    seedRun(db, { runId: 'run-roundtrip' });
    const store = buildRunbookStore(db);
    const reg = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', reg.hash, reg.version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-roundtrip',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');

    const reparsed = parseVerificationTaskV1(JSON.parse(row.task_json as string));
    expect(reparsed.ok).toBe(true);
    const record = store.getByHash(1, 'web', row.runbook_hash as string);
    expect(record).not.toBeNull();
    expect(
      checkRunbookPin(record, 'web', reparsed.ok ? reparsed.task : guessedTask, row.runbook_hash as string),
    ).toEqual({ ok: true });
  });

  it('an UNPROVEN draft injects nothing and stamps no pin (the degrade gate speaks downstream)', async () => {
    seedRun(db, { runId: 'run-draft' });
    const store = buildRunbookStore(db);
    await store.registerDraft(1, gitRepo, 'web'); // registered, never proven
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-draft',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');
    expect(JSON.parse(row.task_json as string).build).toEqual(['pnpm run build']);
    expect(row.runbook_hash).toBeNull();
    expect(row.runbook_local_version).toBeNull();
  });

  it('NO store wired at all → unpinned, byte-identical to the pre-phase-2 enqueue', async () => {
    seedRun(db, { runId: 'run-nostore' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-nostore',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');
    expect(JSON.parse(row.task_json as string).serve.cmd).toBe('pnpm dev --port ${PORT}');
    expect(row.runbook_hash).toBeNull();
  });

  it('a SETUP-PROOF request pins its OWN draft verbatim, without needing a proven record', async () => {
    seedRun(db, { runId: 'run-proof-pin' });
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof-pin',
      // The setup flow composed this task FROM the draft, so no merge should happen.
      task: {
        ...task,
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
      },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });

    expect(result.outcome).toBe('enqueued');
    const id = result.outcome === 'enqueued' ? result.requestId : '';
    const row = readPersisted(id);
    expect(row.runbook_hash).toBe(registered.hash);
    expect(row.runbook_local_version).toBe(registered.version);
    // Verbatim: the caller's pin is authoritative, and the draft it pins is by
    // definition not proven yet (requiring 'proven' here would deadlock setup).
    const flags = db
      .prepare('SELECT setup_proof FROM verification_requests WHERE id = ?')
      .get(id) as { setup_proof: number };
    expect(flags.setup_proof).toBe(1);
  });

  it('the §7.2 guard still fires on a setup-proof request (a pin is not an exemption)', async () => {
    seedRun(db, { runId: 'run-proof-guard' });
    initScheduler(db, buildRunbookStore(db));
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof-guard',
      task: { ...task, build: ['pnpm install'] },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
      runbookHash: 'deadbeef',
      runbookLocalVersion: 1,
    });
    expect(result.outcome).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a runbook that smuggles an install through the MERGE is rejected too (§7.2 covers both sources)', async () => {
    seedRun(db, { runId: 'run-bad-runbook' });
    const badRunbook: VerifyRunbookV1 = {
      version: 1,
      modalities: {
        web: {
          build: ['pnpm install --frozen-lockfile', 'pnpm run build'],
          attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
        },
      },
    };
    const store = new VerifyRunbookStore(dbAdapter(db), {
      readPortableFile: async () => JSON.stringify(badRunbook),
      computeInputHash: async () => 'input-hash-1',
      hostFingerprint: async () => 'host-fingerprint-1',
    });
    const reg = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', reg.hash, reg.version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-bad-runbook',
      // The COMPOSED task is clean — only the runbook is not.
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('skipped');
    const reason = result.outcome === 'skipped' ? result.reason : '';
    expect(reason).toContain(FORBIDDEN_DEP_COMMAND_ERROR);
    expect(reason).toContain("committed verification runbook");
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  // ---------------------------------------------------------------------------
  // Migration 107 — the LANE-DRIVEN bootstrap proof
  // (docs/proposals/lane-runbook-bootstrap.md §5 + §9)
  // ---------------------------------------------------------------------------

  it('gives a bootstrap proof its own enqueue generation, so a prior SKIPPED row cannot dedup it', async () => {
    // THE DEFECT THIS PINS. `findLiveRequestByEnqueueKey` counts ANY non-canceled
    // row — terminals included, and 'skipped' explicitly — as a live dedup hit.
    // A lane that was just skipped for want of a runbook therefore already owns
    // `${runId}:${ref}:${attempt}`. Firing the proof under that same key would
    // hand back the SKIPPED row's id and deploy nothing at all, while every
    // caller read it as an enqueued request: a silent, total no-op.
    seedRun(db, { runId: 'run_bs' });
    initScheduler(db);

    const ordinary = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(ordinary.outcome).toBe('enqueued');
    const skippedId = ordinary.outcome === 'enqueued' ? ordinary.requestId : '';
    // Terminalize it exactly as the §3.2 degrade gate does.
    db.prepare("UPDATE verification_requests SET status = 'skipped', error_message = ? WHERE id = ?").run(
      'no proven verification runbook for this project (run verification setup)',
      skippedId,
    );

    const proof = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });

    expect(proof.outcome).toBe('enqueued');
    const proofId = proof.outcome === 'enqueued' ? proof.requestId : '';
    expect(proofId).not.toBe(skippedId);

    const row = db
      .prepare('SELECT enqueue_key AS key, bootstrap_proof AS flag FROM verification_requests WHERE id = ?')
      .get(proofId) as { key: string; flag: number };
    expect(row.key).toBe('run_bs:TASK-001:1:bootstrap:1');
    expect(row.flag).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 2 });
  });

  it('still dedups a re-fired bootstrap round, so crash recovery re-runs nothing', async () => {
    // The generation must be UNIQUE PER ROUND, not per call: "resume at the first
    // incomplete step" after a restart depends on re-firing round N returning the
    // same request rather than a duplicate deployment.
    seedRun(db, { runId: 'run_bs2' });
    initScheduler(db);

    const first = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });
    const again = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });
    expect(first.outcome).toBe('enqueued');
    expect(again).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 1 });

    // …but a SECOND draft round is a genuinely different proof and must deploy.
    const round2 = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 2,
    });
    expect(round2.outcome).toBe('enqueued');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 2 });
  });

  it('leaves an ordinary request unflagged and on the plain key', async () => {
    seedRun(db, { runId: 'run_bs3' });
    initScheduler(db);

    const res = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs3',
      task,
      laneTaskRef: 'TASK-003',
      attempt: 2,
      worktreePath: gitRepo,
    });
    const id = res.outcome === 'enqueued' ? res.requestId : '';
    const row = db
      .prepare('SELECT enqueue_key AS key, bootstrap_proof AS flag FROM verification_requests WHERE id = ?')
      .get(id) as { key: string; flag: number };
    expect(row.key).toBe('run_bs3:TASK-003:2');
    expect(row.flag).toBe(0);
  });
});

/**
 * The runbook BOOTSTRAP at the enqueue seam (lane-runbook-bootstrap.md §12).
 *
 * Two contracts, and the second is the one that could break something silently:
 *
 *  1. WITH NO RUNNER WIRED — every unit test, and any deployment where the
 *     toggle can never be on — the enqueue is byte-for-byte what it always was.
 *     A feature that quietly altered the enqueue on projects that never opted
 *     into it would be the worst possible outcome, because nobody would be
 *     looking for it.
 *  2. THE PROOF MUST NOT RE-ENTER. The bootstrap fires its own attestation-only
 *     request through THIS SAME function; consulting the bootstrap for that
 *     request would start a second one while the first is mid-flight, and the
 *     run-scoped stamp would read the recursion as its own owner re-entering —
 *     the one shape the single-flight cannot distinguish from a restart.
 */
describe('enqueueTaskVerification — the runbook bootstrap', () => {
  const serveTask: VerificationTaskV1 = {
    ...task,
    serve: { cmd: 'pnpm dev --port ${PORT}' },
  };

  it('enqueues exactly as before when the toggle is ON but no runner is wired', async () => {
    // The bootstrap-eligible case with the acting half absent. Indistinguishable
    // from the toggle being off, which is what makes every other test in this
    // file — and every deployment that never opts in — unaffected.
    seedRun(db, { runId: 'run-pf1' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf1',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // Unchanged key: no `:bootstrap:` generation, because no bootstrap ran.
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf1:TASK-1:1');
  });

  it('the scheduler reports the decision it would act on', async () => {
    seedRun(db, { runId: 'run-pf2' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf2',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task: serveTask,
        probePath: gitRepo,
      }),
    // `mode` since F4 stage 2 (Codex #2): a proceed now says WHICH action —
    // 'derive' authors a runbook, 'reprove' re-proves a drifted record and writes
    // nothing.
    ).resolves.toEqual({ proceed: true, mode: 'derive', adopt: false });
  });

  it('declines with the toggle OFF, which is the shipped default', async () => {
    seedRun(db, { runId: 'run-pf3' });
    initScheduler(db);
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf3',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task: serveTask,
        probePath: gitRepo,
      }),
    ).resolves.toEqual({ proceed: false, reason: 'disabled' });
  });

  it('runs the bootstrap when a runner IS wired, and enqueues afterwards either way', async () => {
    // The acting path. The lane's own request is still enqueued — the bootstrap
    // has no channel to fail a lane and must not grow one — and on a decline the
    // §3.2 gate is what speaks, exactly as it did before this feature existed.
    const calls: Array<{ runId: string; laneTaskRef: string }> = [];
    seedRun(db, { runId: 'run-pf5' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ runId, laneTaskRef }) => {
        calls.push({ runId, laneTaskRef });
        return { kind: 'declined', reason: 'not-possible', detail: 'no dev server' };
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf5',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(calls).toEqual([{ runId: 'run-pf5', laneTaskRef: 'TASK-1' }]);
    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // Still the lane's ORDINARY key — the bootstrap generation belongs to the
    // proof, never to the lane request that triggered it.
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf5:TASK-1:1');
  });

  it('does NOT consult the bootstrap for the bootstrap PROOF itself', async () => {
    // The recursion guard. Without it, the proof's own enqueue would start a
    // second bootstrap while the first is mid-flight — and because the stamp is
    // keyed on (run, project, modality) with the SAME owner ref, that second
    // claim reads as the owner resuming rather than as a collision.
    const calls: string[] = [];
    seedRun(db, { runId: 'run-pf6' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ laneTaskRef }) => {
        calls.push(laneTaskRef);
        return { kind: 'declined', reason: 'not-possible', detail: 'x' };
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf6',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });

    expect(calls).toEqual([]);
    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf6:TASK-1:1:bootstrap:1');
  });

  it('does NOT consult it for a SETUP proof either', async () => {
    // The verify-setup flow is proving a draft a human already reviewed; a
    // bootstrap there would derive a rival over the very record being proven.
    const calls: string[] = [];
    seedRun(db, { runId: 'run-pf7' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ laneTaskRef }) => {
        calls.push(laneTaskRef);
        return { kind: 'declined', reason: 'not-possible', detail: 'x' };
      },
    });

    await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf7',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
    });

    expect(calls).toEqual([]);
  });

  it('a THROWING bootstrap runner still enqueues — the seam never crashes a lane', async () => {
    seedRun(db, { runId: 'run-pf8' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async () => {
        throw new Error('the bootstrap exploded');
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf8',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
  });

  it('the kill switch overrides the toggle', async () => {
    // The lever for "this is misbehaving on THIS host, stop now" — it must beat
    // a persisted preference that may have been set on another machine.
    const prior = process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP;
    process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP = '1';
    try {
      seedRun(db, { runId: 'run-pf4' });
      initScheduler(db, undefined, {
        config: { ...baseConfig, autoBootstrapRunbook: true },
      });
      await expect(
        VerificationScheduler.getInstance().evaluateRunbookBootstrap({
          projectId: 1,
          runId: 'run-pf4',
          laneTaskRef: 'TASK-1',
          modality: 'web',
          task: serveTask,
          probePath: gitRepo,
        }),
      ).resolves.toEqual({ proceed: false, reason: 'disabled' });
    } finally {
      if (prior === undefined) delete process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP;
      else process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP = prior;
    }
  });

  it('a task that derives no environment is never a bootstrap candidate', async () => {
    seedRun(db, { runId: 'run-pf5' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf5',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task,
        probePath: gitRepo,
      }),
    ).resolves.toEqual({ proceed: false, reason: 'no-environment' });
  });
});

/**
 * F5 / RC3 — the modality is resolved ONCE, from the DECLARATION first and the
 * project's PROVEN RECORD second (docs/proposals/visual-verification-brittleness-fixes.md).
 *
 * The defect these pin: `resolveTaskModality` answers from the task's SHAPE
 * alone, so an undeclared task on a project whose only proven runbook entry is
 * `cdp-app` (cyboflow itself) asked for `web`, found no record, and was skipped
 * by the degrade gate against a perfect proof — while the bootstrap, which ran
 * FIRST on that same guess, derived and proved a rival `web` runbook over the
 * shared file (Codex #3).
 */
describe('declaredWebModality — the pure precedence table', () => {
  const cases: Array<{
    name: string;
    type: Parameters<typeof declaredWebModality>[0];
    task: Parameters<typeof declaredWebModality>[1];
    expected: VerificationModality | null;
  }> = [
    // (1) The run's TYPE owns the two modalities a task shape cannot express,
    // and it outranks everything the composer wrote.
    { name: 'native-desktop → native-screen', type: 'native-desktop', task: null, expected: 'native-screen' },
    {
      name: 'native-desktop beats a task-declared web',
      type: 'native-desktop',
      task: { modality: 'web' },
      expected: 'native-screen',
    },
    { name: 'mobile-flow → mobile', type: 'mobile-flow', task: null, expected: 'mobile' },
    // (2) The composer's own declaration, which resolveTaskModality ignores.
    {
      name: 'task.modality cdp-app wins over an absent attach',
      type: 'interactive-web-behavior',
      task: { modality: 'cdp-app' },
      expected: 'cdp-app',
    },
    {
      name: 'task.modality web wins over an attach:cdp shape',
      type: 'interactive-web-behavior',
      task: { modality: 'web', serve: { cmd: 'x', attach: 'cdp' } },
      expected: 'web',
    },
    // A task-declared native-screen on a web-shaped run is NOT honoured: the
    // run's type owns that axis, and the row's stamp is re-derived from it.
    {
      name: 'task.modality native-screen is not a web-axis declaration',
      type: 'interactive-web-behavior',
      task: { modality: 'native-screen' },
      expected: null,
    },
    // (3) The legacy shape discriminant, still authoritative.
    {
      name: 'serve.attach cdp → cdp-app',
      type: 'interactive-web-behavior',
      task: { serve: { cmd: 'x', attach: 'cdp' } },
      expected: 'cdp-app',
    },
    // Nothing declared at all — the ONLY case that consults the records.
    { name: 'a bare web-shaped task declares nothing', type: 'interactive-web-behavior', task: { serve: { cmd: 'x' } }, expected: null },
    { name: 'a null task declares nothing', type: 'static-render-snapshot', task: null, expected: null },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(declaredWebModality(c.type, c.task)).toBe(c.expected);
    });
  }
});

describe('resolveEnqueueModality — declaration first, then the proven record', () => {
  /**
   * A task that DERIVES AN ENVIRONMENT (a serve step). Only such a task consults
   * the records at all: a degenerate pre-live one is exempt from the degrade gate
   * and merging a runbook into it would turn it into a different request.
   */
  const envTask: VerificationTaskV1 = { ...task, serve: { cmd: 'pnpm dev --port ${PORT}' } };
  const revision: ProvenRunbookRevision = {
    hash: 'hash-1',
    version: 1,
    entry: {
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm start', attach: 'cdp' },
      attestation: { kind: 'window-identity', titlePattern: 'App', app: 'App' },
    },
  };

  /** A scheduler whose proven records are exactly `proven`, recording what it was asked. */
  function fakeRecords(proven: VerificationModality[]): { asked: VerificationModality[] } {
    const asked: VerificationModality[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        asked.push(modality);
        return proven.includes(modality) ? revision : null;
      },
    );
    return { asked };
  }

  beforeEach(() => {
    seedRun(db, { runId: 'run-mod' });
    initScheduler(db);
  });

  it('cdp-app proven only, nothing declared → cdp-app', async () => {
    const { asked } = fakeRecords(['cdp-app']);
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('cdp-app');
    // Probed in order, and stopped at the first proven one.
    expect(asked).toEqual(['cdp-app']);
  });

  it('web proven only, nothing declared → web', async () => {
    const { asked } = fakeRecords(['web']);
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('web');
    expect(asked).toEqual(['cdp-app', 'web']);
  });

  it('BOTH proven, nothing declared → cdp-app (a project with a proven app entry is an app)', async () => {
    fakeRecords(['cdp-app', 'web']);
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('cdp-app');
  });

  it('nothing proven, nothing declared → web (the pre-F5 default)', async () => {
    fakeRecords([]);
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('web');
  });

  it('a DECLARED web on a web-shaped task never probes at all', async () => {
    // The declaration MATCHES the shape, so the record cannot move the answer and
    // is never read. Declared-but-not-proven then keeps today's behavior
    // downstream: no merge, and the degrade gate skips naming that modality.
    const { asked } = fakeRecords(['cdp-app']);
    await expect(
      resolveEnqueueModality({
        type: 'interactive-web-behavior',
        task: { ...envTask, modality: 'web' },
        projectId: 1,
        runId: 'run-mod',
      }),
    ).resolves.toBe('web');
    expect(asked).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // STAMP CONSISTENCY (fix round, blocker). A declaration the task's own SHAPE
  // does not express can only be adopted when a proven record backs it, because
  // only the resulting merge makes `scheduler.enqueue`'s shape-derived stamp
  // agree with it. Unbacked, it would leave the row stamped with the OTHER
  // modality and the §3.2 degrade gate judging a request that was resolved for
  // something else — and, wherever that other modality is proven, waving an
  // UNPINNED composer-authored build/serve straight through.
  // -------------------------------------------------------------------------

  it('a DECLARED cdp-app on a web-shaped task is adopted when the cdp-app record is PROVEN', async () => {
    const { asked } = fakeRecords(['cdp-app']);
    await expect(
      resolveEnqueueModality({
        type: 'interactive-web-behavior',
        task: { ...envTask, modality: 'cdp-app' },
        projectId: 1,
        runId: 'run-mod',
      }),
    ).resolves.toBe('cdp-app');
    // Exactly one probe: the declaration narrows the candidate list to itself.
    expect(asked).toEqual(['cdp-app']);
  });

  it('a DECLARED cdp-app on a web-shaped task falls back to the SHAPE when nothing backs it', async () => {
    const { asked } = fakeRecords(['web']);
    await expect(
      resolveEnqueueModality({
        type: 'interactive-web-behavior',
        task: { ...envTask, modality: 'cdp-app' },
        projectId: 1,
        runId: 'run-mod',
      }),
    ).resolves.toBe('web');
    // `web` is never probed here — it is the shape, and the injection will look
    // it up itself; the declaration only ever buys ITS own record one read.
    expect(asked).toEqual(['cdp-app']);
  });

  it('a DECLARED web on an attach:cdp task falls back to cdp-app when no web record backs it', async () => {
    // The mirror case, and the one that matters on cyboflow itself: one word
    // would otherwise route the request away from the modality this project has
    // actually proven, while the row still stamped `cdp-app`.
    const { asked } = fakeRecords(['cdp-app']);
    await expect(
      resolveEnqueueModality({
        type: 'interactive-web-behavior',
        task: { ...envTask, modality: 'web', serve: { cmd: 'electron .', attach: 'cdp' } },
        projectId: 1,
        runId: 'run-mod',
      }),
    ).resolves.toBe('cdp-app');
    expect(asked).toEqual(['web']);
  });

  it('a DEGENERATE task (no build, no serve) never consults the records', async () => {
    // It derives no environment, so it is exempt from the degrade gate and there
    // is nothing for a runbook to describe; merging one in would turn the one
    // request shape that passes in production into a build-and-launch run.
    const { asked } = fakeRecords(['cdp-app']);
    const degenerate: VerificationTaskV1 = { ...task, target: { htmlPath: 'dist/index.html' } };
    await expect(
      resolveEnqueueModality({
        type: 'static-render-snapshot',
        task: degenerate,
        projectId: 1,
        runId: 'run-mod',
      }),
    ).resolves.toBe('web');
    expect(asked).toEqual([]);
  });

  it('an undeclared lane follows a DRIFTED/draft record over the shape (F4 ∘ F5): cdp-app present but not proven → cdp-app', async () => {
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockResolvedValue(null);
    const asked: VerificationModality[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'runbookRecordPresent').mockImplementation(async (a) => {
      asked.push(a.modality);
      return a.modality === 'cdp-app';
    });
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('cdp-app');
    expect(asked).toEqual(['cdp-app']);
  });

  it('an undeclared lane with NO record of any kind → web (the shape)', async () => {
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockResolvedValue(null);
    vi.spyOn(VerificationScheduler.getInstance(), 'runbookRecordPresent').mockResolvedValue(false);
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('web');
  });

  it('a THROWING record probe degrades to the shape instead of failing the enqueue', async () => {
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(async () => {
      throw new Error('store exploded');
    });
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('web');
  });

  it('with NO scheduler wired at all → web', async () => {
    VerificationScheduler._resetForTesting();
    await expect(
      resolveEnqueueModality({ type: 'interactive-web-behavior', task: envTask, projectId: 1, runId: 'run-mod' }),
    ).resolves.toBe('web');
  });
});

describe('enqueueTaskVerification — one modality, resolved before the bootstrap', () => {
  const CDP_ENTRY: VerifyRunbookModalityEntry = {
    build: ['pnpm run build:main'],
    serve: { cmd: 'pnpm start --remote-debugging-port=${VERIFY_DRIVER_PORT}', attach: 'cdp' },
    attestation: { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
  };
  const WEB_ENTRY: VerifyRunbookModalityEntry = {
    build: ['pnpm run build:web'],
    serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
    attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
  };

  /**
   * Wire a scheduler whose proven records are exactly `records`, recording the
   * ORDER of every record read and bootstrap call so a test can assert what the
   * bootstrap actually ran on — the fact the reviewer's finding turns on.
   */
  function wireRecords(records: Partial<Record<VerificationModality, ProvenRunbookRevision>>): string[] {
    const order: string[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        order.push(`resolve:${modality}`);
        return records[modality] ?? null;
      },
    );
    vi.spyOn(VerificationScheduler.getInstance(), 'maybeBootstrapRunbook').mockImplementation(
      async ({ modality }) => {
        order.push(`bootstrap:${modality}`);
        return { kind: 'not-attempted' } as Awaited<ReturnType<VerificationScheduler['maybeBootstrapRunbook']>>;
      },
    );
    return order;
  }

  function readModalityRow(id: string): { taskJson: string; modality: string | null; hash: string | null } {
    return db
      .prepare('SELECT task_json AS taskJson, modality, runbook_hash AS hash FROM verification_requests WHERE id = ?')
      .get(id) as { taskJson: string; modality: string | null; hash: string | null };
  }

  it('an undeclared task on a cdp-app-proven project bootstraps and prepares on THE SAME cdp-app', async () => {
    // Codex #3 in one test: before F5 the order was bootstrap(web) → prepare(web),
    // so this project's proven cdp-app record was never consulted and a rival web
    // runbook was derived over the shared file. Now the record decides first, and
    // BOTH consumers read that one answer.
    seedRun(db, { runId: 'run-f5' });
    initScheduler(db);
    const order: string[] = [];

    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        order.push(`resolve:${modality}`);
        return modality === 'cdp-app' ? { hash: 'h-cdp', version: 3, entry: CDP_ENTRY } : null;
      },
    );
    const bootstrap = vi
      .spyOn(VerificationScheduler.getInstance(), 'maybeBootstrapRunbook')
      .mockImplementation(async ({ modality }) => {
        order.push(`bootstrap:${modality}`);
        return { kind: 'not-attempted' } as Awaited<ReturnType<VerificationScheduler['maybeBootstrapRunbook']>>;
      });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      // Neither `modality` nor `serve.attach` — the exact shape RC3 mis-routed.
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      runId: 'run-f5',
      laneTaskRef: 'TASK-009',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // The record is consulted BEFORE the bootstrap, and `web` is never asked for.
    expect(order).toEqual(['resolve:cdp-app', 'bootstrap:cdp-app', 'resolve:cdp-app']);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    const row = db
      .prepare('SELECT task_json AS taskJson, modality, runbook_hash AS hash FROM verification_requests WHERE id = ?')
      .get(result.requestId) as { taskJson: string; modality: string | null; hash: string | null };
    const persisted = JSON.parse(row.taskJson) as VerificationTaskV1;
    // The cdp-app entry was merged, so the persisted task IS an attach task…
    expect(persisted.serve?.attach).toBe('cdp');
    expect(persisted.build).toEqual(['pnpm run build:main']);
    // …and it carries the resolved modality the composer never declared, so the
    // runner's `req.modality ?? task.modality` cross-check agrees with the shape.
    expect(persisted.modality).toBe('cdp-app');
    // The row stamp — re-derived at the INSERT — agrees too.
    expect(row.modality).toBe('cdp-app');
    expect(row.hash).toBe('h-cdp');
  });

  it('a DECLARED web on that same project stays web, unmerged and unpinned', async () => {
    // Declared-but-not-proven: no record for `web`, so no merge and no pin, and
    // the degrade gate downstream skips naming that modality — today's behavior,
    // deliberately unchanged.
    seedRun(db, { runId: 'run-f5b' });
    initScheduler(db);
    const asked: string[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        asked.push(modality);
        return modality === 'cdp-app' ? { hash: 'h-cdp', version: 3, entry: CDP_ENTRY } : null;
      },
    );
    vi.spyOn(VerificationScheduler.getInstance(), 'maybeBootstrapRunbook').mockImplementation(
      async ({ modality }) => {
        asked.push(`bootstrap:${modality}`);
        return { kind: 'not-attempted' } as Awaited<ReturnType<VerificationScheduler['maybeBootstrapRunbook']>>;
      },
    );

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      task: { ...task, modality: 'web', serve: { cmd: 'pnpm dev --port ${PORT}' } },
      runId: 'run-f5b',
      laneTaskRef: 'TASK-010',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    expect(asked).toEqual(['bootstrap:web', 'web']);
    const row = db
      .prepare('SELECT task_json AS taskJson, runbook_hash AS hash FROM verification_requests WHERE id = ?')
      .get(result.requestId) as { taskJson: string; hash: string | null };
    expect((JSON.parse(row.taskJson) as VerificationTaskV1).serve?.cmd).toBe('pnpm dev --port ${PORT}');
    expect(row.hash).toBeNull();
  });

  // -------------------------------------------------------------------------
  // STAMP CONSISTENCY (fix round, blocker). `scheduler.enqueue` re-derives the
  // row's modality from the PERSISTED task's shape, so an off-shape resolution
  // that never merged would leave the gate judging a modality the request was
  // never resolved for — and on a project where THAT modality is proven, the
  // gate lets an unpinned, composer-authored build/serve execute. These three
  // pin the rule: the resolved modality is either backed by a proven record (so
  // the merge makes the shape agree) or it is the shape.
  // -------------------------------------------------------------------------

  it('a DECLARED cdp-app with a web-shaped serve, on a web-proven project, stamps web and pins the WEB runbook', async () => {
    seedRun(db, { runId: 'run-f5d' });
    initScheduler(db);
    const order = wireRecords({ web: { hash: 'h-web', version: 7, entry: WEB_ENTRY } });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      // The composer's one-word declaration, with no `attach` behind it.
      task: { ...task, modality: 'cdp-app', build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      runId: 'run-f5d',
      laneTaskRef: 'TASK-012',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // The declaration bought exactly ONE record read; nothing backed it, so the
    // shape took over BEFORE the bootstrap — which therefore never got the chance
    // to derive a rival cdp-app runbook over this project's proven web one.
    expect(order).toEqual(['resolve:cdp-app', 'bootstrap:web', 'resolve:web']);

    const row = readModalityRow(result.requestId);
    // Stamp, pin and persisted shape all agree — the pre-F5 answer for this task.
    expect(row.modality).toBe('web');
    expect(row.hash).toBe('h-web');
    expect((JSON.parse(row.taskJson) as VerificationTaskV1).build).toEqual(['pnpm run build:web']);
  });

  it('a DECLARED web on an attach:cdp task, on a cdp-app-proven project, stamps cdp-app and pins the CDP runbook', async () => {
    // The mirror, and the one that bites on cyboflow itself: pre-fix, this word
    // routed the injection at `web` (nothing proven ⇒ unpinned) while the row
    // still stamped `cdp-app`, whose record IS proven — so the degrade gate saw
    // a proven project and ran the composer's own launch line unpinned.
    seedRun(db, { runId: 'run-f5e' });
    initScheduler(db);
    const order = wireRecords({ 'cdp-app': { hash: 'h-cdp', version: 3, entry: CDP_ENTRY } });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      task: { ...task, modality: 'web', build: ['pnpm run build'], serve: { cmd: 'electron .', attach: 'cdp' } },
      runId: 'run-f5e',
      laneTaskRef: 'TASK-013',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    expect(order).toEqual(['resolve:web', 'bootstrap:cdp-app', 'resolve:cdp-app']);
    const row = readModalityRow(result.requestId);
    expect(row.modality).toBe('cdp-app');
    expect(row.hash).toBe('h-cdp');
  });

  it('a record whose entry contradicts its own modality falls back to the SHAPE rather than stamping past the skipped injection', async () => {
    // The injection's consistency guard drops a malformed record — and before the
    // fix the resolved modality survived that drop, leaving the row stamped `web`
    // while everything downstream had been resolved for `cdp-app`.
    seedRun(db, { runId: 'run-f5f' });
    initScheduler(db);
    const order = wireRecords({
      // Filed under cdp-app, but its serve form is a plain web one.
      'cdp-app': { hash: 'h-bad', version: 1, entry: { ...WEB_ENTRY } },
      web: { hash: 'h-web', version: 7, entry: WEB_ENTRY },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      runId: 'run-f5f',
      laneTaskRef: 'TASK-014',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    expect(order).toEqual(['resolve:cdp-app', 'bootstrap:cdp-app', 'resolve:cdp-app', 'resolve:web']);
    const row = readModalityRow(result.requestId);
    expect(row.modality).toBe('web');
    expect(row.hash).toBe('h-web');
  });
});

describe('prepareVerificationEnqueue — the MCP/orchestrated plane resolves the modality too', () => {
  // `execution_model` defaults to `orchestrated`, and that plane enqueues through
  // `mcpQueryHandler.handleRequestVerification`, which passes NO modality. If the
  // shared preparation fell back to the shape-only derivation there, the
  // task-verify prompt's promise — declare `modality`, or let the harness resolve
  // an undeclared task against the project's proven runbook — would be false for
  // most runs (fix round, reviewer finding on the prompt).
  const CDP_ENTRY: VerifyRunbookModalityEntry = {
    build: ['pnpm run build:main'],
    serve: { cmd: 'pnpm start --remote-debugging-port=${VERIFY_DRIVER_PORT}', attach: 'cdp' },
    attestation: { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
  };

  it('an undeclared web-shaped task resolves, merges and pins the project’s proven cdp-app runbook', async () => {
    seedRun(db, { runId: 'run-mcp-plane' });
    initScheduler(db);
    const asked: VerificationModality[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        asked.push(modality);
        return modality === 'cdp-app' ? { hash: 'h-cdp', version: 3, entry: CDP_ENTRY } : null;
      },
    );

    const prepared = await prepareVerificationEnqueue({
      projectId: 1,
      runId: 'run-mcp-plane',
      type: 'interactive-web-behavior',
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      // No `modality` — exactly what the MCP handler passes.
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.modality).toBe('cdp-app');
    expect(prepared.pin).toEqual({ hash: 'h-cdp', localVersion: 3 });
    expect(prepared.task?.serve?.attach).toBe('cdp');
    // The record decided it, then the injection re-read it — the same two-step
    // the programmatic seam makes, just without the bootstrap in between.
    expect(asked).toEqual(['cdp-app', 'cdp-app']);
  });

  it('a DEGENERATE pre-live task is left alone even on a cdp-app-proven project', async () => {
    seedRun(db, { runId: 'run-mcp-degenerate' });
    initScheduler(db);
    const asked: VerificationModality[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        asked.push(modality);
        return modality === 'cdp-app' ? { hash: 'h-cdp', version: 3, entry: CDP_ENTRY } : null;
      },
    );

    const prepared = await prepareVerificationEnqueue({
      projectId: 1,
      runId: 'run-mcp-degenerate',
      type: 'static-render-snapshot',
      task: { ...task, target: { htmlPath: 'dist/index.html' } },
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.modality).toBe('web');
    expect(prepared.pin).toBeUndefined();
    // Only the shape's own record was ever asked for — never the cdp-app one,
    // whose entry would have merged a full build + launch into a bare target.
    expect(asked).toEqual(['web']);
    expect(prepared.task?.build).toBeUndefined();
  });
});

describe('enqueueTaskVerification — a proof request never probes the proven records', () => {
  // A request carrying its own pin consults neither the bootstrap (excluded) nor
  // a proven record (`prepareVerificationEnqueue` returns on the caller pin), so
  // an F5 record probe would be pure cost on a proof's critical path — and every
  // extra `status()` read is one that can demote a rival modality's record while
  // the proof is in flight (RC2).
  it('a bootstrap proof resolves from the shape alone', async () => {
    seedRun(db, { runId: 'run-f5c' });
    initScheduler(db);
    const asked: string[] = [];
    vi.spyOn(VerificationScheduler.getInstance(), 'resolveProvenRunbook').mockImplementation(
      async ({ modality }): Promise<ProvenRunbookRevision | null> => {
        asked.push(modality);
        return null;
      },
    );

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      task: { ...task, serve: { cmd: 'pnpm dev --port ${PORT}' } },
      runId: 'run-f5c',
      laneTaskRef: 'TASK-011',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
      runbookHash: 'h-draft',
      runbookLocalVersion: 2,
    });

    expect(result.outcome).toBe('enqueued');
    expect(asked).toEqual([]);
  });
});
