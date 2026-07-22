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
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerificationScheduler } from '../verificationScheduler';
import { enqueueTaskVerification } from '../enqueueFromTask';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { VerificationTaskV1, ResolvedVisualVerifyConfig, VlmJudge } from '../../../../../shared/types/visualVerification';

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
      enqueue_key      TEXT
    );
  `);
  return db;
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

function initScheduler(db: Database.Database): void {
  VerificationScheduler.initialize({
    db: dbAdapter(db),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => '/tmp/a',
    config: baseConfig,
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

  it('a missing run → skipped(verification-disabled)', async () => {
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'nope',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
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
