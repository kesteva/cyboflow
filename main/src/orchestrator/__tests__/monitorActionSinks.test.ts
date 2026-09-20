/**
 * Unit tests for monitorActionSinks — the composition-root sinks for the
 * supervisor's autonomous actions. A fake router captures every create op, so
 * the suite pins the SHAPE of what reaches the review queue (actor, source,
 * title, category, severity) without a DB, a router singleton, or Electron.
 *
 * The set-aside sink's shape is the load-bearing one: it must be byte-compatible
 * with the accepted-risk finding `gateSideEffects` files for the same `AR-n`
 * entry, or the gate stops deduping and one defect reaches the human twice.
 *
 * The escalation READ is the other load-bearing one, for the opposite reason:
 * it is wrapped in a catch that returns `[]`, so a misspelled column or a
 * mis-bound parameter would silently deliver an EMPTY queue to every gate
 * consult forever with the whole suite still green. Its SQL text and bound
 * arguments are therefore asserted directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildGateEscalationSinks,
  buildLaneTriageActions,
  buildMonitorFindingSink,
  buildSetAsideFindingSink,
  type MonitorActionSinkDeps,
} from '../monitorActionSinks';
import { ADVERSARIAL_FINDING_SOURCE } from '../gateSideEffects';
import { ESCALATION_REVIEW_ITEM_CAP } from '../programmatic/programmaticRunHost';
import type { AdversarialFinding } from '../../../../shared/types/adversarialReview';
import { SUPERVISOR_RECOMMENDATION_HEADING } from '../../../../shared/types/reviews';
import type { DatabaseLike, LoggerLike } from '../types';
import type { TaskMutationDeps } from '../taskMutationHandler';

/** The change is captured as a plain record so a test can read any field off it. */
type CreateOp = { projectId: number; change: Record<string, unknown> };

function makeDeps(overrides: Partial<MonitorActionSinkDeps> = {}): {
  deps: MonitorActionSinkDeps;
  ops: CreateOp[];
} {
  const ops: CreateOp[] = [];
  const db = { prepare: vi.fn(), transaction: vi.fn() } as unknown as DatabaseLike;
  const deps: MonitorActionSinkDeps = {
    db,
    runProjectId: () => 7,
    applyReviewItem: async (projectId, change) => {
      ops.push({ projectId, change: { ...(change as object) } as Record<string, unknown> });
      return { reviewItemId: 'ri-1', event: { id: 1, seq: 1 } };
    },
    taskMutations: {} as TaskMutationDeps,
    describeTaskFailure: () => 'refused',
    ...overrides,
  };
  return { deps, ops };
}

/**
 * A DB whose `review_items` probe reflects what the fake router has already
 * accepted — the same round trip the real sink makes (router create → a row the
 * next call's dedupe probe reads back).
 */
function filedTitlesDb(ops: CreateOp[]): DatabaseLike {
  return {
    prepare: () => ({ all: () => ops.map((op) => ({ title: op.change.title })) }),
    transaction: vi.fn(),
  } as unknown as DatabaseLike;
}

const ENTRY: AdversarialFinding = {
  id: 'AR-3',
  title: 'Copy nit',
  severity: 'advisory',
  what: 'the button says Submit',
  why: 'the rest of the app says Save',
  fix: 'rename it',
  area: 'prototype',
};

describe('buildMonitorFindingSink', () => {
  it('files a non-blocking finding as the MONITOR, carrying the category', async () => {
    const { deps, ops } = makeDeps();

    await buildMonitorFindingSink(deps)('run-1', {
      title: 'Review loop — adversarial-review round 2: loop',
      body: 'because',
      category: 'review-loop',
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].projectId).toBe(7);
    expect(ops[0].change).toEqual({
      op: 'create',
      // The supervisor accounting for its OWN judgement, not a mechanical
      // orchestrator write.
      actor: 'monitor',
      kind: 'finding',
      title: 'Review loop — adversarial-review round 2: loop',
      body: 'because',
      severity: 'info',
      blocking: false,
      source: 'monitor',
      runId: 'run-1',
      payload: { kind: 'finding', category: 'review-loop' },
    });
  });

  it('omits the payload entirely when no category is given', async () => {
    const { deps, ops } = makeDeps();
    await buildMonitorFindingSink(deps)('run-1', { title: 't', body: 'b' });
    expect(ops[0].change.payload).toBeUndefined();
  });

  it('files nothing for a run with no resolvable project', async () => {
    const { deps, ops } = makeDeps({ runProjectId: () => undefined });
    await buildMonitorFindingSink(deps)('run-gone', { title: 't', body: 'b' });
    expect(ops).toHaveLength(0);
  });
});

describe('buildSetAsideFindingSink', () => {
  it('files the entry exactly as the approve-design gate would, prefixed with the reason', async () => {
    const { deps, ops } = makeDeps();

    await buildSetAsideFindingSink(deps)('run-1', { entry: ENTRY, reason: 'not worth a design lap', round: 2 });

    const change = ops[0].change;
    // The title prefix IS the idempotence key gateSideEffects.filedAdversarialIds
    // reads back — it must be the `AR-n — title` shape, character for character.
    expect(change.title).toBe('AR-3 — Copy nit');
    expect(change.source).toBe(ADVERSARIAL_FINDING_SOURCE);
    expect(change.actor).toBe('orchestrator');
    expect(change.blocking).toBe(false);
    // advisory → info, via the shared severity mapping.
    expect(change.severity).toBe('info');
    expect(change.payload).toEqual({
      kind: 'finding',
      category: 'design-review',
      suggestedFix: 'rename it',
      proposedTarget: 'backlog',
    });
    const body = change.body as string;
    expect(body.startsWith('Set aside by the supervisor on round 2: not worth a design lap')).toBe(true);
    // …then the reviewer's own words, from the SHARED renderer.
    expect(body).toContain('the button says Submit');
    expect(body).toContain('**Why it matters:** the rest of the app says Save');
    expect(body).toContain('**Fix:** rename it');
  });

  it('maps a blocking entry’s severity up and omits suggestedFix when the entry has none', async () => {
    const { deps, ops } = makeDeps();

    await buildSetAsideFindingSink(deps)('run-1', {
      entry: { id: 'AR-1', title: 'Real defect', severity: 'blocker' },
      reason: 'a product call',
      round: 1,
    });

    const change = ops[0].change;
    expect(change.severity).toBe('error');
    expect(change.payload).toEqual({ kind: 'finding', category: 'design-review', proposedTarget: 'backlog' });
  });

  it('files a repeated set-aside entry ONCE — the run’s filed ids are the key', async () => {
    // The supervisor votes once per round and may set the same entry aside on
    // every one of them; without the dedupe a three-lap loop files one deferral
    // three times. Keyed on the `AR-n` PREFIX, so a reworded title is still the
    // same entry.
    const { deps, ops } = makeDeps();
    const sink = buildSetAsideFindingSink({ ...deps, db: filedTitlesDb(ops) });

    await sink('run-1', { entry: ENTRY, reason: 'not worth a design lap', round: 2 });
    await sink('run-1', { entry: { ...ENTRY, title: 'Copy nit (reworded)' }, reason: 'still not', round: 3 });

    expect(ops).toHaveLength(1);
    expect(ops[0].change.title).toBe('AR-3 — Copy nit');
  });

  it('a different entry still files while one is deduped', async () => {
    const { deps, ops } = makeDeps();
    const sink = buildSetAsideFindingSink({ ...deps, db: filedTitlesDb(ops) });

    await sink('run-1', { entry: ENTRY, reason: 'a', round: 1 });
    await sink('run-1', { entry: { id: 'AR-1', title: 'Real defect', severity: 'blocker' }, reason: 'b', round: 2 });

    expect(ops.map((op) => op.change.title)).toEqual(['AR-3 — Copy nit', 'AR-1 — Real defect']);
  });

  it('an unreadable history files rather than drops — a duplicate is recoverable', async () => {
    // makeDeps' bare `prepare: vi.fn()` returns undefined, so the probe throws
    // and reads as "nothing filed".
    const { deps, ops } = makeDeps();
    const sink = buildSetAsideFindingSink(deps);

    await sink('run-1', { entry: ENTRY, reason: 'a', round: 1 });

    expect(ops).toHaveLength(1);
  });
});

describe('buildLaneTriageActions', () => {
  it('files the rescue audit note through the SAME chokepoint, non-blocking', async () => {
    const { deps, ops } = makeDeps();

    await buildLaneTriageActions(deps).fileFinding('run-1', { title: 'rescued TASK-014', body: 'why' });

    expect(ops[0].change).toEqual({
      op: 'create',
      actor: 'orchestrator',
      kind: 'finding',
      title: 'rescued TASK-014',
      body: 'why',
      severity: 'info',
      blocking: false,
      source: 'monitor',
      runId: 'run-1',
    });
  });

  it('reports a refused task adjust as ok:false with the injected message, never a throw', async () => {
    const { deps } = makeDeps({ describeTaskFailure: () => 'the lane is already running' });
    // adjustRunTaskForLaneTriage refuses before touching the router when the run
    // row cannot be loaded, which a bare fake DB guarantees.
    const failingDb = {
      prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
      transaction: (fn: (...a: unknown[]) => unknown) => fn,
    } as unknown as DatabaseLike;

    const result = await buildLaneTriageActions({
      ...deps,
      taskMutations: { ...deps.taskMutations, db: failingDb } as TaskMutationDeps,
    }).adjustTask('run-1', { taskRef: 'TASK-014', body: '## New' });

    expect(result).toEqual({ ok: false, reason: 'the lane is already running' });
  });
});

/**
 * A DB that records the SQL text and the bound arguments of every `.all()`, and
 * replays a fixed row set. This is the only guard the escalation read has: its
 * catch turns a misspelled column into `[]`, which no consumer can tell from
 * "this run has no review items".
 */
function recordingDb(rows: unknown[]): {
  db: DatabaseLike;
  sql: string[];
  args: unknown[][];
} {
  const sql: string[] = [];
  const args: unknown[][] = [];
  const db = {
    prepare: (text: string) => {
      sql.push(text);
      return {
        all: (...params: unknown[]) => {
          args.push(params);
          return rows;
        },
        get: () => undefined,
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    transaction: vi.fn(),
  } as unknown as DatabaseLike;
  return { db, sql, args };
}

/** A LoggerLike whose four methods are spies. */
function makeLogger(): LoggerLike & { warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('buildGateEscalationSinks', () => {
  describe('listRunReviewItems', () => {
    it('selects this run’s PENDING rows plus every monitor-sourced row, newest first, capped', async () => {
      const { db, sql, args } = recordingDb([]);
      const { deps } = makeDeps({ db });

      await buildGateEscalationSinks(deps).listRunReviewItems('run-1');

      const text = sql[0].replace(/\s+/g, ' ').trim();
      // The exact columns the row mapper below reads back.
      expect(text).toContain('SELECT id, kind, source, severity, status, title');
      expect(text).toContain('FROM review_items');
      // CR-9's two-armed predicate: an audit finding a human already triaged
      // still describes something this run did unattended, so the `monitor` arm
      // deliberately ignores status.
      expect(text).toContain("WHERE run_id = ? AND (status = 'pending' OR source = 'monitor')");
      // Newest first so the cap drops the OLDEST context, not the freshest.
      expect(text).toContain('ORDER BY created_at DESC, id DESC');
      // The LIMIT is the ONLY place the cap is enforced.
      expect(text).toContain('LIMIT ?');
      expect(args).toEqual([['run-1', ESCALATION_REVIEW_ITEM_CAP]]);
    });

    it('maps rows to summaries, defaulting a null source/severity and a non-string kind', async () => {
      const { db } = recordingDb([
        { id: 'ri-1', kind: 'decision', source: 'monitor', severity: 'error', status: 'resolved', title: 'Loop stop' },
        // An old row: NULL provenance columns, a kind the DB somehow holds as a
        // number, and a missing title. None of these may become `undefined` on
        // the wire — the consult prompt renders every field verbatim.
        { id: 'ri-2', kind: 7, source: null, severity: null, status: null, title: undefined },
      ]);
      const { deps } = makeDeps({ db });

      const items = await buildGateEscalationSinks(deps).listRunReviewItems('run-1');

      expect(items).toEqual([
        {
          id: 'ri-1',
          kind: 'decision',
          source: 'monitor',
          severity: 'error',
          status: 'resolved',
          title: 'Loop stop',
        },
        { id: 'ri-2', kind: 'finding', source: null, severity: null, status: 'pending', title: '' },
      ]);
    });

    it('treats an empty-string source/severity as absent', async () => {
      const { db } = recordingDb([{ id: 'ri-1', kind: 'finding', source: '', severity: '', status: 'pending', title: 't' }]);
      const { deps } = makeDeps({ db });

      const items = await buildGateEscalationSinks(deps).listRunReviewItems('run-1');

      expect(items[0].source).toBeNull();
      expect(items[0].severity).toBeNull();
    });

    it('fails soft to an empty list and WARNS when the read throws', async () => {
      // makeDeps' bare `prepare: vi.fn()` returns undefined, so `.all` throws —
      // exactly what a wrong column name would do against the real DB.
      const logger = makeLogger();
      const { deps } = makeDeps({ logger });

      const items = await buildGateEscalationSinks(deps).listRunReviewItems('run-1');

      expect(items).toEqual([]);
      // The warn is the ONLY trace a broken query leaves; without it the empty
      // list is indistinguishable from an empty queue.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('escalation review-item read failed');
      expect(logger.warn.mock.calls[0][1]).toMatchObject({ runId: 'run-1' });
    });
  });

  describe('annotate', () => {
    it('upserts the recommendation through the annotate op as the MONITOR', async () => {
      const { deps, ops } = makeDeps();

      await buildGateEscalationSinks(deps).annotate('run-1', {
        reviewItemId: 'ri-gate',
        markdown: 'Recommended: rerun — the review is unaddressed.',
      });

      expect(ops).toHaveLength(1);
      expect(ops[0].projectId).toBe(7);
      expect(ops[0].change).toEqual({
        op: 'annotate',
        actor: 'monitor',
        reviewItemId: 'ri-gate',
        // The closed heading set — writer and parser must never drift.
        heading: SUPERVISOR_RECOMMENDATION_HEADING,
        markdown: 'Recommended: rerun — the review is unaddressed.',
        runId: 'run-1',
      });
    });

    it('writes nothing for a run with no resolvable project', async () => {
      const { deps, ops } = makeDeps({ runProjectId: () => undefined });

      await buildGateEscalationSinks(deps).annotate('run-gone', { reviewItemId: 'ri-gate', markdown: 'x' });

      expect(ops).toHaveLength(0);
    });

    it('PROPAGATES the router’s refusal rather than swallowing it', async () => {
      // The host classifies `invalid_status` (the human answered first) as a
      // debug-level race and everything else as a warn; it can only do that if
      // the error reaches it, so this sink must not catch.
      const err = Object.assign(new Error('item is not pending'), { code: 'invalid_status' });
      const { deps } = makeDeps({
        applyReviewItem: async () => {
          throw err;
        },
      });

      await expect(
        buildGateEscalationSinks(deps).annotate('run-1', { reviewItemId: 'ri-gate', markdown: 'x' }),
      ).rejects.toBe(err);
    });
  });
});
