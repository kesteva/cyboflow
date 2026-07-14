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
  parseApproveIdeasRefs,
  type ResolveReviewItemDeps,
  type ResolveReviewItemInput,
} from '../resolveReviewItemHandler';
import {
  parseIdeaVerdictMap,
  serializeIdeaVerdictMap,
  RESOLUTION_PREFIX_IDEA_VERDICTS,
  type IdeaVerdictMap,
} from '../../../../shared/types/reviews';

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
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT,
      resolution TEXT
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
  payloadJson?: string | null;
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
    `INSERT INTO review_items (id, project_id, run_id, kind, source, blocking, status, payload_json)
     VALUES (?, 1, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    opts.id,
    opts.runId ?? null,
    opts.kind,
    opts.source ?? null,
    opts.blocking ? 1 : 0,
    opts.payloadJson ?? null,
  );
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
// Approve-ideas BATCH gate — per-idea verdict fold (IDEA-009)
// ---------------------------------------------------------------------------

/**
 * Seed a parked approve-ideas gate carrying `ideaRefs` in its decision payload.
 * `source` defaults to the programmatic runner's 'gate:human-step:approve-ideas';
 * pass an 'agent:*' source to seed the default ORCHESTRATED planner's mint, which
 * is discoverable ONLY via the payload gate discriminant.
 */
function seedApproveIdeasGate(
  db: Database.Database,
  opts: { id: string; runId: string; ideaRefs: string[]; source?: string },
): void {
  seedItem(db, {
    id: opts.id,
    kind: 'decision',
    source: opts.source ?? 'gate:human-step:approve-ideas',
    blocking: true,
    runId: opts.runId,
    payloadJson: JSON.stringify({ kind: 'decision', gate: 'approve-ideas', ideaRefs: opts.ideaRefs }),
  });
}

/** The resolution string the handler passed to the resolve chokepoint spy. */
function resolvedWith(deps: SpiedDeps): string | null | undefined {
  const call = deps.applyReviewItemResolve.mock.calls[0];
  return call?.[1]?.resolution;
}

function itemStatus(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM review_items WHERE id = ?').get(id) as { status: string }).status;
}

describe('resolveReviewItem — approve-ideas verdict fold', () => {
  it('folds a mixed map (2 approve / 1 deny) into the resolution, resolves once, resumes', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_ai', runId: 'run-ai', ideaRefs: ['IDEA-1', 'IDEA-2', 'IDEA-3'] });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny', 'IDEA-3': 'approve' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ai', verdicts }), deps);

    // Resolved exactly once, with the serialized verdict map as the resolution.
    expect(deps.applyReviewItemResolve).toHaveBeenCalledTimes(1);
    const resolution = resolvedWith(deps);
    expect(resolution).toEqual(expect.stringContaining(RESOLUTION_PREFIX_IDEA_VERDICTS));
    // The map round-trips out of the resolution the resumed planner reads.
    expect(parseIdeaVerdictMap(resolution)).toEqual(verdicts);
    // Not a reject/reveal path — no draft promote/delete side effects.
    expect(deps.promotePendingDraftsForRun).not.toHaveBeenCalled();
    expect(deps.deleteRunCreatedEntities).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, resumed: true, gateStepId: 'approve-ideas' });
    expect(runStatus(db, 'run-ai')).toBe('running'); // aggregate-unblock resumed it
    expect(itemStatus(db, 'rvw_ai')).toBe('resolved');
  });

  it('an all-deny map still resolves the batch gate (denied ideas just stay on the backlog)', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_all_deny', runId: 'run-ad', ideaRefs: ['IDEA-1', 'IDEA-2'] });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'deny', 'IDEA-2': 'deny' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_all_deny', verdicts }), deps);

    // 'deny' (never 'reject') keeps parseGateVerdict on the approve-to-proceed path.
    expect(parseIdeaVerdictMap(resolvedWith(deps))).toEqual(verdicts);
    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(runStatus(db, 'run-ad')).toBe('running');
  });

  const malformedMaps: Array<[string, Record<string, string>]> = [
    ['unknown ref', { 'IDEA-1': 'approve', 'IDEA-2': 'approve', 'IDEA-99': 'deny' }],
    ['bad value', { 'IDEA-1': 'approve', 'IDEA-2': 'maybe' }],
    ['empty map', {}],
    ['incomplete coverage', { 'IDEA-1': 'approve' }],
  ];
  it.each(malformedMaps)('rejects a malformed map (%s) → invalid_payload, gate stays pending', async (_label, badMap) => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_bad', runId: 'run-bad', ideaRefs: ['IDEA-1', 'IDEA-2'] });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_bad', verdicts: badMap as IdeaVerdictMap }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled(); // never reached the resolve
    expect(itemStatus(db, 'rvw_bad')).toBe('pending'); // gate untouched
    expect(runStatus(db, 'run-bad')).toBe('awaiting_review');
  });

  it('REFUSES a scalar outcome on a pending approve-ideas gate (no verdicts → nothing to fold or deliver)', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_scalar', runId: 'run-scalar', ideaRefs: ['IDEA-1', 'IDEA-2'] });
    const deps = makeDeps(db);

    // The generic queue card's "Approve & resume" sends exactly this — it would
    // clear the batch gate while recording no per-idea decision.
    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_scalar', outcome: 'approve' }), deps);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(deps.maybeResumeRun).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_scalar')).toBe('pending'); // gate survives to be submitted properly
    expect(runStatus(db, 'run-scalar')).toBe('awaiting_review');
  });

  it('REFUSES a scalar resolve on the AGENT-minted gate too (payload-only discriminant)', async () => {
    const db = buildDb();
    // The orchestrated planner's mint: source 'agent:<label>' — the gate is
    // discoverable ONLY via payload_json, so a source-keyed guard would miss it.
    seedApproveIdeasGate(db, {
      id: 'rvw_scalar_agent',
      runId: 'run-sa',
      ideaRefs: ['IDEA-1'],
      source: 'agent:planner',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_scalar_agent', resolution: 'looks fine' }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_scalar_agent')).toBe('pending');
  });

  it('an already-terminal approve-ideas gate still surfaces invalid_status, not the scalar guard', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_done', runId: 'run-done', ideaRefs: ['IDEA-1'] });
    db.prepare("UPDATE review_items SET status = 'resolved' WHERE id = ?").run('rvw_done');
    const deps = makeDeps(db);

    // The scalar guard is pending-only — a terminal item falls through to the
    // chokepoint, whose own refusal names the real problem.
    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_done', outcome: 'approve' }), deps);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_status' });
  });

  it('rejects a verdict map on a gate whose payload carries no batch ideaRefs', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_norefs',
      kind: 'decision',
      source: 'gate:human-step:approve-ideas',
      blocking: true,
      runId: 'run-norefs',
      payloadJson: JSON.stringify({ kind: 'decision', gate: 'approve-ideas' }),
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_norefs', verdicts: { 'IDEA-1': 'approve' } }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_norefs')).toBe('pending');
  });

  it('mid-fold resolve failure leaves the gate unresolved (all-or-nothing)', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, { id: 'rvw_boom', runId: 'run-boom', ideaRefs: ['IDEA-1'] });
    const deps = makeDeps(db);
    // The atomic resolve write throws AFTER a valid fold — nothing must persist.
    deps.applyReviewItemResolve.mockRejectedValueOnce(new Error('db locked mid-fold'));

    await expect(
      resolveReviewItem(baseInput({ reviewItemId: 'rvw_boom', verdicts: { 'IDEA-1': 'approve' } }), deps),
    ).rejects.toThrow('db locked mid-fold');

    expect(itemStatus(db, 'rvw_boom')).toBe('pending'); // gate stays pending
    expect(deps.maybeResumeRun).not.toHaveBeenCalled(); // no resume on a failed fold
  });

  it('ignores `verdicts` for a NON-approve-ideas gate (scalar path unaffected)', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_plan',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-plan',
    });
    const deps = makeDeps(db);

    // A stray verdict map on an approve-plan gate must be ignored — the scalar
    // outcome drives the resolution byte-for-byte as before.
    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_plan', outcome: 'approve', verdicts: { 'IDEA-1': 'approve' } }),
      deps,
    );

    expect(resolvedWith(deps)).toBe('approve'); // NOT a serialized verdict map
    expect(deps.promotePendingDraftsForRun).toHaveBeenCalledWith('run-plan'); // approve-plan reveal ran
    expect(result).toMatchObject({ ok: true, gateStepId: 'approve-plan', outcome: 'approve' });
  });

  it('folds an AGENT-minted gate (source agent:planner, payload-keyed) identically', async () => {
    const db = buildDb();
    // Default ORCHESTRATED planner mint: source is 'agent:planner', so the gate is
    // recognized ONLY via the payload's gate discriminant (humanGateStepId is null).
    seedApproveIdeasGate(db, {
      id: 'rvw_agent',
      runId: 'run-agent',
      ideaRefs: ['IDEA-1', 'IDEA-2'],
      source: 'agent:planner',
    });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_agent', verdicts }), deps);

    expect(deps.applyReviewItemResolve).toHaveBeenCalledTimes(1);
    expect(parseIdeaVerdictMap(resolvedWith(deps))).toEqual(verdicts);
    // gateStepId is null for an agent-minted item (source is not 'gate:human-step:*').
    expect(result).toMatchObject({ ok: true, resumed: true, gateStepId: null });
    expect(itemStatus(db, 'rvw_agent')).toBe('resolved');
  });

  it('rejects a malformed map on an AGENT-minted gate (invalid_payload, gate pending)', async () => {
    const db = buildDb();
    seedApproveIdeasGate(db, {
      id: 'rvw_agent_bad',
      runId: 'run-agent-bad',
      ideaRefs: ['IDEA-1', 'IDEA-2'],
      source: 'agent:planner',
    });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_agent_bad', verdicts: { 'IDEA-1': 'approve' } }), // incomplete coverage
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_agent_bad')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Shared serialize/parse helpers (round-trip + payload ref parse)
// ---------------------------------------------------------------------------

describe('IdeaVerdictMap serialize/parse + parseApproveIdeasRefs', () => {
  it('serialize → parse round-trips a verdict map', () => {
    const map: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny' };
    expect(parseIdeaVerdictMap(serializeIdeaVerdictMap(map))).toEqual(map);
  });

  it('parseIdeaVerdictMap returns null for a non-verdict resolution and drops garbage entries', () => {
    expect(parseIdeaVerdictMap('approve')).toBeNull();
    expect(parseIdeaVerdictMap(null)).toBeNull();
    expect(parseIdeaVerdictMap(`${RESOLUTION_PREFIX_IDEA_VERDICTS}not-json`)).toBeNull();
    // A verdict-prefixed object with only garbage values parses to null.
    expect(parseIdeaVerdictMap(`${RESOLUTION_PREFIX_IDEA_VERDICTS}{"IDEA-1":"maybe"}`)).toBeNull();
    // Mixed: valid entries kept, garbage dropped.
    expect(parseIdeaVerdictMap(`${RESOLUTION_PREFIX_IDEA_VERDICTS}{"IDEA-1":"deny","IDEA-2":7}`)).toEqual({
      'IDEA-1': 'deny',
    });
  });

  it('parseApproveIdeasRefs lifts a clean string ref list, else empty', () => {
    expect(parseApproveIdeasRefs(JSON.stringify({ ideaRefs: ['IDEA-1', 'IDEA-2'] }))).toEqual(['IDEA-1', 'IDEA-2']);
    expect(parseApproveIdeasRefs(JSON.stringify({ ideaRefs: ['IDEA-1', 3, '', 'IDEA-2'] }))).toEqual([
      'IDEA-1',
      'IDEA-2',
    ]);
    expect(parseApproveIdeasRefs(null)).toEqual([]);
    expect(parseApproveIdeasRefs('not-json')).toEqual([]);
    expect(parseApproveIdeasRefs(JSON.stringify({ gate: 'approve-ideas' }))).toEqual([]);
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
