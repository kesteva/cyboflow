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
  parseApproveDesignsRefs,
  renderApproveDesignsDecisions,
  readApproveIdeasDecisionLines,
  APPROVE_DESIGNS_DECISIONS_HEADING,
  type ResolveReviewItemDeps,
  type ResolveReviewItemInput,
} from '../resolveReviewItemHandler';
import {
  parseIdeaVerdictMap,
  serializeIdeaVerdictMap,
  RESOLUTION_PREFIX_IDEA_VERDICTS,
  parseDesignVerdictMap,
  serializeDesignVerdictMap,
  RESOLUTION_PREFIX_DESIGN_VERDICTS,
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
    // TASK-222: an explicit outcome also stamps resolutionMeta (gate-resolution
    // provenance) — surface is null here (baseInput supplies no surface).
    expect(deps.applyReviewItemResolve).toHaveBeenCalledWith(1, {
      reviewItemId: 'rvw_ap',
      actor: 'user',
      resolution: 'approve',
      resolutionMeta: { outcome: 'approve', surface: null },
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
      resolutionMeta: { outcome: 'approve', surface: null },
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

  it('derives the batch refs from the run for a payload-less human-step gate (legacy mint fallback)', async () => {
    const db = buildDb();
    // The run's owned-ideas projection the fallback derives refs from: ideas +
    // entity_events 'created' rows (workflow_runs here has no seed columns —
    // the per-source fail-soft skips those and the created-union still resolves).
    db.exec(`
      CREATE TABLE ideas (
        id      TEXT PRIMARY KEY,
        ref     TEXT NOT NULL,
        title   TEXT NOT NULL,
        summary TEXT,
        body    TEXT,
        scope   TEXT
      );
      CREATE TABLE entity_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        actor       TEXT NOT NULL,
        run_id      TEXT
      );
    `);
    const insertIdea = db.prepare("INSERT INTO ideas (id, ref, title, body) VALUES (?, ?, ?, 'spec')");
    insertIdea.run('ide_1', 'IDEA-1', 'First');
    insertIdea.run('ide_2', 'IDEA-2', 'Second');
    const insertCreated = db.prepare(
      "INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id) VALUES ('idea', ?, 1, 'created', 'orchestrator', 'run-fb')",
    );
    insertCreated.run('ide_1');
    insertCreated.run('ide_2');
    // A pre-payload-stamp programmatic mint: human-step source, NO payload at all.
    seedItem(db, {
      id: 'rvw_fb',
      kind: 'decision',
      source: 'gate:human-step:approve-ideas',
      blocking: true,
      runId: 'run-fb',
      payloadJson: null,
    });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_fb', verdicts }), deps);

    expect(result).toMatchObject({ ok: true, gateStepId: 'approve-ideas' });
    expect(parseIdeaVerdictMap(resolvedWith(deps))).toEqual(verdicts);
    expect(itemStatus(db, 'rvw_fb')).toBe('resolved');

    // The derived refs still validate strictly: a map missing one derived ref is refused.
    seedItem(db, {
      id: 'rvw_fb_partial',
      kind: 'decision',
      source: 'gate:human-step:approve-ideas',
      blocking: true,
      runId: 'run-fb',
      runStatus: 'awaiting_review',
      payloadJson: null,
    });
    const partial = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_fb_partial', verdicts: { 'IDEA-1': 'approve' } }),
      deps,
    );
    expect(partial).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('readApproveIdeasDecisionLines reads the resolved gate fold back as verdict lines', () => {
    const db = buildDb();
    const insert = db.prepare(
      `INSERT INTO review_items (id, project_id, run_id, kind, source, blocking, status, resolution)
       VALUES (?, 1, ?, 'decision', 'gate:human-step:approve-ideas', 1, ?, ?)`,
    );

    // Resolved fold → one line per ref.
    insert.run(
      'rvw_read',
      'run-read',
      'resolved',
      serializeIdeaVerdictMap({ 'IDEA-1': 'approve', 'IDEA-2': 'deny' }),
    );
    expect(readApproveIdeasDecisionLines(dbAdapter(db), 'run-read')).toBe(
      '- IDEA-1: approve\n- IDEA-2: deny',
    );

    // A still-PENDING gate contributes nothing.
    insert.run('rvw_pend', 'run-pend', 'pending', null);
    expect(readApproveIdeasDecisionLines(dbAdapter(db), 'run-pend')).toBeUndefined();

    // A resolved gate whose resolution is not a serialized fold contributes nothing.
    insert.run('rvw_scalar_res', 'run-scalar-res', 'resolved', 'approve');
    expect(readApproveIdeasDecisionLines(dbAdapter(db), 'run-scalar-res')).toBeUndefined();

    // No gate at all / fail-soft on a bare DB.
    expect(readApproveIdeasDecisionLines(dbAdapter(db), 'run-none')).toBeUndefined();
    expect(readApproveIdeasDecisionLines(dbAdapter(new Database(':memory:')), 'run-x')).toBeUndefined();
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
// Approve-designs batch gate — the design-approval sibling of approve-ideas
// ---------------------------------------------------------------------------

/** Seed an approve-designs BATCH gate (design sibling of seedApproveIdeasGate). */
function seedApproveDesignsGate(
  db: Database.Database,
  opts: { id: string; runId: string; designRefs: string[]; source?: string },
): void {
  seedItem(db, {
    id: opts.id,
    kind: 'decision',
    source: opts.source ?? 'gate:human-step:approve-designs',
    blocking: true,
    runId: opts.runId,
    payloadJson: JSON.stringify({ kind: 'decision', gate: 'approve-designs', designRefs: opts.designRefs }),
  });
}

describe('resolveReviewItem — approve-designs verdict fold', () => {
  it('folds a mixed map into the resolution under the DESIGN prefix, resolves once, resumes', async () => {
    const db = buildDb();
    seedApproveDesignsGate(db, { id: 'rvw_ad', runId: 'run-ad', designRefs: ['IDEA-1', 'IDEA-2', 'IDEA-3'] });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny', 'IDEA-3': 'approve' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ad', verdicts }), deps);

    expect(deps.applyReviewItemResolve).toHaveBeenCalledTimes(1);
    const resolution = resolvedWith(deps);
    // Serialized under the DESIGN prefix (NOT the idea prefix), so a resumed
    // planner reads design decisions separately from idea decisions.
    expect(resolution).toEqual(expect.stringContaining(RESOLUTION_PREFIX_DESIGN_VERDICTS));
    expect(parseDesignVerdictMap(resolution)).toEqual(verdicts);
    expect(parseIdeaVerdictMap(resolution)).toBeNull(); // not readable as an idea verdict map
    expect(result).toMatchObject({ ok: true, resumed: true, gateStepId: 'approve-designs' });
    expect(itemStatus(db, 'rvw_ad')).toBe('resolved');
  });

  const malformed: Array<[string, Record<string, string>]> = [
    ['unknown ref', { 'IDEA-1': 'approve', 'IDEA-9': 'deny' }],
    ['bad value', { 'IDEA-1': 'approve', 'IDEA-2': 'maybe' }],
    ['empty map', {}],
    ['incomplete coverage', { 'IDEA-1': 'approve' }],
  ];
  it.each(malformed)('rejects a malformed map (%s) → invalid_payload, gate stays pending', async (_l, bad) => {
    const db = buildDb();
    seedApproveDesignsGate(db, { id: 'rvw_bad', runId: 'run-bad', designRefs: ['IDEA-1', 'IDEA-2'] });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_bad', verdicts: bad as IdeaVerdictMap }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_bad')).toBe('pending');
  });

  it('REFUSES a scalar outcome on a pending approve-designs gate', async () => {
    const db = buildDb();
    seedApproveDesignsGate(db, { id: 'rvw_scalar', runId: 'run-scalar', designRefs: ['IDEA-1', 'IDEA-2'] });
    const deps = makeDeps(db);

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_scalar', outcome: 'approve' }), deps);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
    expect(deps.applyReviewItemResolve).not.toHaveBeenCalled();
    expect(itemStatus(db, 'rvw_scalar')).toBe('pending');
  });

  it('folds an AGENT-minted approve-designs gate (payload-keyed, source agent:planner)', async () => {
    const db = buildDb();
    seedApproveDesignsGate(db, {
      id: 'rvw_agent',
      runId: 'run-agent',
      designRefs: ['IDEA-1', 'IDEA-2'],
      source: 'agent:planner',
    });
    const deps = makeDeps(db);
    const verdicts: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny' };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_agent', verdicts }), deps);

    expect(parseDesignVerdictMap(resolvedWith(deps))).toEqual(verdicts);
    expect(result).toMatchObject({ ok: true, resumed: true, gateStepId: null });
  });

  it('does NOT confuse a design gate for an idea gate (distinct fold prefixes)', async () => {
    const db = buildDb();
    seedApproveDesignsGate(db, { id: 'rvw_d', runId: 'run-d', designRefs: ['IDEA-1'] });
    const deps = makeDeps(db);

    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_d', verdicts: { 'IDEA-1': 'approve' } }), deps);

    // The design gate serialized with the DESIGN prefix — an idea-verdict parse misses it.
    expect(resolvedWith(deps)?.startsWith(RESOLUTION_PREFIX_DESIGN_VERDICTS)).toBe(true);
  });
});

describe('DesignVerdictMap serialize/parse + parseApproveDesignsRefs + render', () => {
  it('serialize → parse round-trips a design verdict map', () => {
    const map: IdeaVerdictMap = { 'IDEA-1': 'approve', 'IDEA-2': 'deny' };
    expect(parseDesignVerdictMap(serializeDesignVerdictMap(map))).toEqual(map);
    // An idea-prefixed note is NOT readable as a design map, and vice-versa.
    expect(parseDesignVerdictMap(serializeIdeaVerdictMap(map))).toBeNull();
  });

  it('parseApproveDesignsRefs lifts a clean string ref list off designRefs, else empty', () => {
    expect(parseApproveDesignsRefs(JSON.stringify({ designRefs: ['IDEA-1', 'IDEA-2'] }))).toEqual([
      'IDEA-1',
      'IDEA-2',
    ]);
    expect(parseApproveDesignsRefs(JSON.stringify({ designRefs: ['IDEA-1', 3, '', 'IDEA-2'] }))).toEqual([
      'IDEA-1',
      'IDEA-2',
    ]);
    // The idea gate's ref key is ignored — a design gate reads designRefs only.
    expect(parseApproveDesignsRefs(JSON.stringify({ ideaRefs: ['IDEA-1'] }))).toEqual([]);
    expect(parseApproveDesignsRefs(null)).toEqual([]);
  });

  it('renderApproveDesignsDecisions leads with the heading contract + one line per ref in batch order', () => {
    const text = renderApproveDesignsDecisions(['IDEA-2', 'IDEA-1'], { 'IDEA-1': 'deny', 'IDEA-2': 'approve' });
    expect(text.startsWith(APPROVE_DESIGNS_DECISIONS_HEADING)).toBe(true);
    expect(text).toContain('- IDEA-2: approve');
    expect(text).toContain('- IDEA-1: deny');
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

// ---------------------------------------------------------------------------
// P20 — approve-plan REJECT unwinds the run's ideas' epics/stories ledger
// components back to `incomplete`. The draft delete was already CODE; the ledger
// rows the decomposition steps stamped `complete` are a SEPARATE store with no
// foreign key to them, so a leftover `complete` over an idea that now has no
// epics and no tasks makes the NEXT run skip exactly the decomposition the reject
// asked for.
// ---------------------------------------------------------------------------

describe('resolveReviewItem — approve-plan reject unwinds the plan ledger', () => {
  /** Add the entity/lineage tables listRunDecomposedIdeaIds reads. */
  function seedDecomposition(
    db: Database.Database,
    runId: string,
    rows: Array<{ ideaId: string; epicId?: string; taskId?: string }>,
  ): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_events (
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL,
        actor TEXT, run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    `);
    db.prepare('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT').run();
    db.prepare('ALTER TABLE workflow_runs ADD COLUMN seed_idea_ids TEXT').run();
    db.prepare('UPDATE workflow_runs SET seed_idea_ids = ? WHERE id = ?').run(
      JSON.stringify(rows.map((r) => r.ideaId)),
      runId,
    );
    for (const r of rows) {
      if (r.epicId) {
        db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run(r.epicId, r.ideaId);
        db.prepare(
          "INSERT INTO entity_events (entity_type, entity_id, kind, run_id) VALUES ('epic', ?, 'created', ?)",
        ).run(r.epicId, runId);
      }
      if (r.taskId) {
        db.prepare('INSERT INTO tasks (id, originating_idea_id) VALUES (?, ?)').run(r.taskId, r.ideaId);
        db.prepare(
          "INSERT INTO entity_events (entity_type, entity_id, kind, run_id) VALUES ('task', ?, 'created', ?)",
        ).run(r.taskId, runId);
      }
    }
  }

  it('sets epics + stories back to incomplete for every DECOMPOSED idea', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_unwind',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-unwind',
    });
    // Two seeded ideas; only IDEA-1 actually got children this run.
    seedDecomposition(db, 'run-unwind', [
      { ideaId: 'idea-1', epicId: 'epic-1', taskId: 'task-1' },
      { ideaId: 'idea-2' },
    ]);
    const setIdeaComponentState = vi.fn().mockResolvedValue(undefined);
    const deps = { ...makeDeps(db), setIdeaComponentState };

    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_unwind', outcome: 'reject' }), deps);

    expect(setIdeaComponentState).toHaveBeenCalledTimes(2);
    for (const component of ['epics', 'stories']) {
      expect(setIdeaComponentState).toHaveBeenCalledWith(1, {
        op: 'set-component-state',
        ideaId: 'idea-1',
        component,
        state: 'incomplete',
        source: 'flow',
        sourceRunId: 'run-unwind',
      });
    }
    // A seeded-but-never-decomposed idea is left alone — nothing claimed it was done.
    expect(
      setIdeaComponentState.mock.calls.some(([, change]) => change.ideaId === 'idea-2'),
    ).toBe(false);
  });

  it('never touches idea-spec / architecture / prototype — the reject declined the PLAN', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_scope',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-scope',
    });
    seedDecomposition(db, 'run-scope', [{ ideaId: 'idea-1', taskId: 'task-1' }]);
    const setIdeaComponentState = vi.fn().mockResolvedValue(undefined);
    const deps = { ...makeDeps(db), setIdeaComponentState };

    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_scope', outcome: 'reject' }), deps);

    const touched = setIdeaComponentState.mock.calls.map(([, change]) => change.component);
    expect(new Set(touched)).toEqual(new Set(['epics', 'stories']));
  });

  it('resolves the idea set BEFORE the delete, and unwinds BEFORE the item resolves', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_order',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-order',
    });
    seedDecomposition(db, 'run-order', [{ ideaId: 'idea-1', taskId: 'task-1' }]);
    const setIdeaComponentState = vi.fn().mockResolvedValue(undefined);
    // The delete tears down the very lineage the projection reads, so a read
    // AFTER it would always come back empty and the ledger would stay complete.
    const deps = { ...makeDeps(db), setIdeaComponentState };
    deps.deleteRunCreatedEntities.mockImplementation(async () => {
      db.prepare('DELETE FROM entity_events').run();
      db.prepare('DELETE FROM tasks').run();
    });

    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_order', outcome: 'reject' }), deps);

    expect(setIdeaComponentState).toHaveBeenCalledTimes(2);
    // Same ordering guarantee the delete has: before the resolve, so it beats
    // the controller advancing off the gate.
    expect(setIdeaComponentState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.applyReviewItemResolve.mock.invocationCallOrder[0],
    );
  });

  it('does not unwind on approve, on a non-approve-plan gate, or on a bare finding', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_ok',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-ok',
    });
    seedItem(db, {
      id: 'rvw_other',
      kind: 'decision',
      source: 'gate:human-step:approve-idea',
      blocking: true,
      runId: 'run-other',
    });
    seedItem(db, { id: 'rvw_find', kind: 'finding', source: 'agent:code-review', runId: 'run-find' });
    seedDecomposition(db, 'run-ok', [{ ideaId: 'idea-1', taskId: 'task-1' }]);
    const setIdeaComponentState = vi.fn().mockResolvedValue(undefined);
    const deps = { ...makeDeps(db), setIdeaComponentState };

    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_ok', outcome: 'approve' }), deps);
    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_other', outcome: 'reject' }), deps);
    await resolveReviewItem(baseInput({ reviewItemId: 'rvw_find', resolution: 'done' }), deps);

    expect(setIdeaComponentState).not.toHaveBeenCalled();
  });

  it('is fail-soft — a throwing ledger write never blocks the resolve', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_soft',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-soft',
    });
    seedDecomposition(db, 'run-soft', [{ ideaId: 'idea-1', taskId: 'task-1' }]);
    const setIdeaComponentState = vi.fn().mockRejectedValue(new Error('ledger exploded'));
    const deps = { ...makeDeps(db), setIdeaComponentState };

    const result = await resolveReviewItem(baseInput({ reviewItemId: 'rvw_soft', outcome: 'reject' }), deps);

    // Both components attempted, and the resolve still landed.
    expect(setIdeaComponentState).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, gateStepId: 'approve-plan', outcome: 'reject' });
  });

  it('un-booted (no dep, no router) is a silent no-op, not a throw', async () => {
    const db = buildDb();
    seedItem(db, {
      id: 'rvw_unbooted',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      blocking: true,
      runId: 'run-unbooted',
    });
    seedDecomposition(db, 'run-unbooted', [{ ideaId: 'idea-1', taskId: 'task-1' }]);
    // No setIdeaComponentState override ⇒ the singleton default, which is un-booted here.
    const result = await resolveReviewItem(
      baseInput({ reviewItemId: 'rvw_unbooted', outcome: 'reject' }),
      makeDeps(db),
    );
    expect(result).toMatchObject({ ok: true, outcome: 'reject' });
  });
});
