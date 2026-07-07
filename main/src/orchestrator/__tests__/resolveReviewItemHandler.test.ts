/**
 * Unit tests for resolveReviewItem — the SHARED, injectable gate-resolution core
 * behind both the reviewItems.resolve tRPC mutation AND the monitor's
 * resolveReviewItem action.
 *
 * Covers: the Q1 reveal branch (approve-plan approve -> promotePendingDraftsForRun
 * BEFORE the resolve; approve-plan reject -> deleteRunCreatedEntities + NO resume),
 * a non-approve-plan gate (verdict only, no reveal), a bare finding/permission
 * resolve, the drained-rest strand guard (wouldStrandEndedWalk=true suppresses the
 * trailing resume), the maybeResumeRun-refused diagnostic, and the not-found /
 * already-terminal discriminated refusals.
 *
 * Standalone: no electron / services imports. A tiny in-memory SQLite (review_items
 * + workflow_runs only) backs the two READS the handler owns; every chokepoint
 * collaborator is a vi.fn spy. Style mirrors retryRunHandler.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { ReviewItemError } from '../reviewItemRouter';
import {
  resolveReviewItem,
  type ResolveReviewItemDeps,
  type ResolveReviewItemInput,
} from '../resolveReviewItemHandler';

// ---------------------------------------------------------------------------
// Minimal DB — only the two tables the handler READS from.
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      source TEXT,
      blocking INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  return db;
}

interface SeedItemOpts {
  id: string;
  kind: string;
  source?: string | null;
  blocking?: boolean;
  runId?: string | null;
  runStatus?: string;
}

/** Seed one review_items row (+ its bound run, when runId given) into the fake DB. */
function seedItem(db: Database.Database, opts: SeedItemOpts): void {
  if (opts.runId) {
    db.prepare('INSERT OR IGNORE INTO workflow_runs (id, status) VALUES (?, ?)').run(
      opts.runId,
      opts.runStatus ?? 'awaiting_review',
    );
  }
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, source, blocking, status)
     VALUES (?, 1, ?, ?, ?, ?, 'pending')`,
  ).run(opts.id, opts.runId ?? null, opts.kind, opts.source ?? null, opts.blocking ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Spied deps — the chokepoint collaborators, backed by the fake DB where they
// would mutate row state (resolve flips status; maybeResumeRun flips run status).
// ---------------------------------------------------------------------------

type SpiedDeps = ResolveReviewItemDeps & {
  applyReviewItemResolve: ReturnType<typeof vi.fn>;
  promotePendingDraftsForRun: ReturnType<typeof vi.fn>;
  deleteRunCreatedEntities: ReturnType<typeof vi.fn>;
  maybeResumeRun: ReturnType<typeof vi.fn>;
};

function makeDeps(
  db: Database.Database,
  overrides?: Partial<Pick<ResolveReviewItemDeps, 'wouldStrandEndedWalk'>>,
): SpiedDeps {
  const applyReviewItemResolve = vi
    .fn<ResolveReviewItemDeps['applyReviewItemResolve']>()
    .mockImplementation(async (_projectId, args) => {
      const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(args.reviewItemId) as
        | { status: string }
        | undefined;
      if (!row) throw new ReviewItemError('not_found', `review item ${args.reviewItemId} not found`);
      if (row.status !== 'pending') {
        throw new ReviewItemError('invalid_status', `review item ${args.reviewItemId} is already '${row.status}'`);
      }
      db.prepare('UPDATE review_items SET status = ? WHERE id = ?').run('resolved', args.reviewItemId);
      return { reviewItemId: args.reviewItemId };
    });

  const promotePendingDraftsForRun = vi
    .fn<ResolveReviewItemDeps['promotePendingDraftsForRun']>()
    .mockResolvedValue(undefined);
  const deleteRunCreatedEntities = vi
    .fn<ResolveReviewItemDeps['deleteRunCreatedEntities']>()
    .mockResolvedValue(undefined);

  const maybeResumeRun = vi
    .fn<ResolveReviewItemDeps['maybeResumeRun']>()
    .mockImplementation(async (runId) => {
      // Mirror HumanStepManager.maybeResumeRun's guarded awaiting_review -> running flip.
      const info = db
        .prepare(`UPDATE workflow_runs SET status = 'running' WHERE id = ? AND status = 'awaiting_review'`)
        .run(runId) as { changes: number };
      return info.changes > 0;
    });

  return {
    db: dbAdapter(db),
    applyReviewItemResolve,
    promotePendingDraftsForRun,
    deleteRunCreatedEntities,
    maybeResumeRun,
    ...overrides,
  };
}

function runStatus(db: Database.Database, runId: string): string {
  return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
}

function baseInput(over: Partial<ResolveReviewItemInput> & { reviewItemId: string }): ResolveReviewItemInput {
  return { projectId: 1, ...over };
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Q1 reveal — approve-plan gate
// ---------------------------------------------------------------------------

describe('resolveReviewItem — approve-plan Q1 reveal', () => {
  it('approve reveals drafts (promote BEFORE resolve) + resumes the blocking run', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_ap',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-ap',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ap', outcome: 'approve' }), deps);

    expect(deps.promotePendingDraftsForRun).toHaveBeenCalledWith('run-ap');
    expect(deps.deleteRunCreatedEntities).not.toHaveBeenCalled();
    // reveal runs BEFORE the resolve so it beats the controller advancing.
    expect(deps.promotePendingDraftsForRun.mock.invocationCallOrder[0]).toBeLessThan(
      deps.applyReviewItemResolve.mock.invocationCallOrder[0],
    );
    // outcome wins over free text → resolution 'approve' (deterministic verdict).
    expect(deps.applyReviewItemResolve).toHaveBeenCalledWith(1, {
      reviewItemId: 'rvw_ap',
      actor: 'user',
      resolution: 'approve',
    });
    expect(result).toEqual({
      ok: true,
      reviewItemId: 'rvw_ap',
      resumed: true,
      gateStepId: 'approve-plan',
      outcome: 'approve',
    });
    expect(runStatus(db, 'run-ap')).toBe('running');
  });

  it('reject deletes drafts + does NOT resume (controller owns terminal rejected)', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_rj',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-rj',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_rj', outcome: 'reject' }), deps);

    expect(deps.deleteRunCreatedEntities).toHaveBeenCalledWith(1, 'run-rj');
    expect(deps.promotePendingDraftsForRun).not.toHaveBeenCalled();
    expect(deps.maybeResumeRun).not.toHaveBeenCalled(); // reject never auto-resumes
    expect(result).toMatchObject({ ok: true, resumed: false, gateStepId: 'approve-plan', outcome: 'reject' });
    expect(runStatus(db, 'run-rj')).toBe('awaiting_review');
  });
});

// ---------------------------------------------------------------------------
// Non-approve-plan gate — verdict only, no reveal
// ---------------------------------------------------------------------------

describe('resolveReviewItem — non-approve-plan gate', () => {
  it('approve-idea approve threads the verdict + resumes but does NOT reveal', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_ai',
      kind: 'decision',
      source: 'gate:human-step:approve-idea',
      blocking: true,
      runId: 'run-ai',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ai', outcome: 'approve' }), deps);

    expect(deps.promotePendingDraftsForRun).not.toHaveBeenCalled();
    expect(deps.deleteRunCreatedEntities).not.toHaveBeenCalled();
    expect(deps.applyReviewItemResolve).toHaveBeenCalledWith(1, {
      reviewItemId: 'rvw_ai',
      actor: 'user',
      resolution: 'approve',
    });
    expect(result).toMatchObject({ ok: true, resumed: true, gateStepId: 'approve-idea', outcome: 'approve' });
    expect(runStatus(db, 'run-ai')).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Bare finding / permission resolve
// ---------------------------------------------------------------------------

describe('resolveReviewItem — non-gate items', () => {
  it('blocking finding: bare resolve (no reveal) + guarded resume', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_f', kind: 'finding', source: 'agent:executor', blocking: true, runId: 'run-f' });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_f', resolution: 'done' }), deps);

    expect(deps.promotePendingDraftsForRun).not.toHaveBeenCalled();
    expect(deps.deleteRunCreatedEntities).not.toHaveBeenCalled();
    expect(deps.applyReviewItemResolve).toHaveBeenCalledWith(1, {
      reviewItemId: 'rvw_f',
      actor: 'user',
      resolution: 'done',
    });
    expect(result).toEqual({ ok: true, reviewItemId: 'rvw_f', resumed: true, gateStepId: null });
    expect(runStatus(db, 'run-f')).toBe('running');
  });

  it('non-blocking, unbound finding: resolve only, no resume attempted', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_nb', kind: 'finding', source: 'agent:executor', blocking: false });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_nb', resolution: 'done' }), deps);

    expect(deps.maybeResumeRun).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, reviewItemId: 'rvw_nb', resumed: false, gateStepId: null });
  });
});

// ---------------------------------------------------------------------------
// Drained-rest strand guard
// ---------------------------------------------------------------------------

describe('resolveReviewItem — drained-rest strand guard', () => {
  it('wouldStrandEndedWalk=true SKIPS the resume — the ended walk stays awaiting_review', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_end', kind: 'finding', source: 'agent:executor', blocking: true, runId: 'run-end' });
    const deps = makeDeps(db, { wouldStrandEndedWalk: () => true });

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_end' }), deps);

    expect(deps.maybeResumeRun).not.toHaveBeenCalled(); // resume skipped entirely
    expect(result).toMatchObject({ ok: true, resumed: false, runStatus: 'awaiting_review', gateStepId: null });
    expect(runStatus(db, 'run-end')).toBe('awaiting_review'); // NOT revived to 'running'
  });

  it('wouldStrandEndedWalk unset (default false) RESUMES — legacy behavior preserved', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_legacy', kind: 'finding', source: 'agent:executor', blocking: true, runId: 'run-legacy' });
    const deps = makeDeps(db); // no wouldStrandEndedWalk override

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_legacy' }), deps);

    expect(deps.maybeResumeRun).toHaveBeenCalledWith('run-legacy');
    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(runStatus(db, 'run-legacy')).toBe('running');
  });

  it('maybeResumeRun refused (run not awaiting_review) surfaces runStatus + resumed=false', async () => {
    const db = buildDb();
    // The run is already 'running' (a sibling blocking item, or a zombie) — the
    // guarded awaiting_review -> running UPDATE no-ops.
    seedItem(db, {
      id: 'rvw_ref',
      kind: 'finding',
      source: 'agent:executor',
      blocking: true,
      runId: 'run-ref',
      runStatus: 'running',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ref' }), deps);

    expect(deps.maybeResumeRun).toHaveBeenCalledWith('run-ref');
    expect(result).toMatchObject({ ok: true, resumed: false, runStatus: 'running' });
  });
});

// ---------------------------------------------------------------------------
// Discriminated refusals
// ---------------------------------------------------------------------------

describe('resolveReviewItem — refusals', () => {
  it('unknown item -> { ok:false, reason:not_found }', async () => {
    const db = buildDb();
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_missing' }), deps);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    if (!result.ok) expect(typeof result.message).toBe('string');
  });

  it('already-terminal item -> { ok:false, reason:invalid_status }', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_term', kind: 'finding', source: 'agent:executor', blocking: false });
    db.prepare('UPDATE review_items SET status = ? WHERE id = ?').run('resolved', 'rvw_term');
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_term' }), deps);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_status' });
  });

  it('a non-ReviewItemError propagates unchanged (caller catches)', async () => {
    const db = buildDb();
    seedItem(db, { id: 'rvw_boom', kind: 'finding', source: 'agent:executor', blocking: false });
    const deps = makeDeps(db);
    deps.applyReviewItemResolve.mockRejectedValueOnce(new Error('unexpected'));

    await expect(resolveReviewItem(baseInput({ reviewItemId: 'rvw_boom' }), deps)).rejects.toThrow('unexpected');
  });
});
