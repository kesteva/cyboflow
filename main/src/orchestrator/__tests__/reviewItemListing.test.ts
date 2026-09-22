/**
 * B2 — reviewItemListing selectors (the sanctioned co-write exception's readers).
 *
 * reviewItemFold.test.ts covers the co-write + resolve happy paths end-to-end via
 * the routers. This file targets the listing/guard helpers directly:
 *  - hasReviewItemsTable WeakMap memoization (probe runs at most once per handle);
 *  - resolvePermissionReviewItem returns null on no approvalId match;
 *  - resolveReviewItemById returns null (not throw) on a double-resolve;
 *  - count / selectPendingBlockingReviewItems / selectFindingForSeed empty-safe
 *    defaults (0 / [] / null) when the review_items table is absent.
 */
import { describe, it, expect } from 'vitest';
import type { DatabaseLike } from '../types';
import {
  hasReviewItemsTable,
  resolvePermissionReviewItem,
  resolveReviewItemById,
  dismissReviewItemById,
  countPendingBlockingReviewItems,
  selectPendingBlockingItemRows,
  selectPendingBlockingReviewItems,
  selectFindingForSeed,
  selectRunFindings,
  selectRunFindingsForRuns,
} from '../reviewItemListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import {
  buildReviewInboxDb,
  seedInboxRun,
  seedBlockingReviewItem,
} from '../__test_fixtures__/reviewInboxTestDb';

describe('hasReviewItemsTable — WeakMap memoization', () => {
  it('probes sqlite_master at most once per db handle', () => {
    const raw = buildReviewInboxDb();
    let probeCount = 0;
    // Adapter that counts the table-existence probe prepares.
    const counting: DatabaseLike = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master') && sql.includes('review_items')) probeCount += 1;
        return raw.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        raw.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
    };

    expect(hasReviewItemsTable(counting)).toBe(true);
    expect(hasReviewItemsTable(counting)).toBe(true);
    expect(hasReviewItemsTable(counting)).toBe(true);
    // Memoized per handle — the probe ran exactly once despite three calls.
    expect(probeCount).toBe(1);
  });

  it('returns false for a handle with no review_items table', () => {
    const raw = createTestDb();
    expect(hasReviewItemsTable(dbAdapter(raw))).toBe(false);
  });
});

describe('resolvePermissionReviewItem', () => {
  it('returns null when no pending permission item matches the approvalId', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    // A permission item exists but for a DIFFERENT approvalId.
    seedBlockingReviewItem(db, {
      id: 'rvw_x',
      runId: 'run-1',
      kind: 'permission',
      payloadJson: JSON.stringify({ kind: 'permission', toolName: 'Bash', approvalId: 'other-approval' }),
    });

    const result = resolvePermissionReviewItem(
      dbAdapter(db),
      'missing-approval',
      'user',
      'approved',
      new Date().toISOString(),
    );
    expect(result).toBeNull();
    // The non-matching item is untouched.
    expect(
      (db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_x') as { status: string }).status,
    ).toBe('pending');
  });

  it('resolves the matching pending item and is idempotent on a second call', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    seedBlockingReviewItem(db, {
      id: 'rvw_match',
      runId: 'run-1',
      kind: 'permission',
      payloadJson: JSON.stringify({ kind: 'permission', toolName: 'Bash', approvalId: 'appr-1' }),
    });

    const first = resolvePermissionReviewItem(dbAdapter(db), 'appr-1', 'user', 'approved', new Date().toISOString());
    expect(first).toBe('rvw_match');
    // Second resolve finds no pending row → null (guarded no-op).
    const second = resolvePermissionReviewItem(dbAdapter(db), 'appr-1', 'user', 'approved', new Date().toISOString());
    expect(second).toBeNull();
  });
});

describe('resolveReviewItemById — double-resolve', () => {
  it('returns the id on first resolve and null (not throw) on a second', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_d', runId: 'run-1', kind: 'decision' });

    const first = resolveReviewItemById(dbAdapter(db), 'rvw_d', 'user', 'approved', new Date().toISOString(), 'run-1');
    expect(first).toBe('rvw_d');

    const second = resolveReviewItemById(dbAdapter(db), 'rvw_d', 'user', 'approved', new Date().toISOString(), 'run-1');
    expect(second).toBeNull();
    expect(
      (db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_d') as { status: string }).status,
    ).toBe('resolved');
  });

  it('returns null when the row id does not exist', () => {
    const db = buildReviewInboxDb();
    expect(
      resolveReviewItemById(dbAdapter(db), 'nope', 'user', null, new Date().toISOString()),
    ).toBeNull();
  });
});

describe('dismissReviewItemById — event parity', () => {
  it('dismisses the pending item and records a dismissed entity_event', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_cancel', runId: 'run-1', kind: 'decision' });

    const dismissed = dismissReviewItemById(
      dbAdapter(db),
      'rvw_cancel',
      'system',
      'canceled',
      new Date().toISOString(),
      'run-1',
    );

    expect(dismissed).toBe('rvw_cancel');
    expect(
      (db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_cancel') as { status: string }).status,
    ).toBe('dismissed');
    const event = db
      .prepare(
        `SELECT kind, actor, run_id AS runId, changes_json AS changesJson
           FROM entity_events
          WHERE entity_type = 'review_item' AND entity_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get('rvw_cancel') as { kind: string; actor: string; runId: string | null; changesJson: string };
    expect(event.kind).toBe('dismissed');
    expect(event.actor).toBe('orchestrator');
    expect(event.runId).toBe('run-1');
    expect(JSON.parse(event.changesJson)).toEqual([
      { field: 'status', from: 'pending', to: 'dismissed' },
      { field: 'resolution', from: null, to: 'canceled' },
    ]);
  });
});

describe('empty-safe defaults when the review_items table is absent', () => {
  it('count / selectPending / selectFinding return 0 / [] / null on a GATE_SCHEMA DB', () => {
    const db = dbAdapter(createTestDb());
    expect(countPendingBlockingReviewItems(db, 'run-x')).toBe(0);
    expect(selectPendingBlockingReviewItems(db, 'run-x')).toEqual([]);
    expect(selectPendingBlockingItemRows(db, 'run-x')).toEqual([]);
    expect(selectFindingForSeed(db, 'rvw_x')).toBeNull();
    expect(selectRunFindings(db, 'run-x')).toEqual([]);
  });
});

describe('selectPendingBlockingReviewItems / count with the table present', () => {
  it('counts and shapes only pending blocking items for the run', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    seedInboxRun(db, 'run-2', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_1', runId: 'run-1', kind: 'permission' });
    seedBlockingReviewItem(db, { id: 'rvw_2', runId: 'run-1', kind: 'decision' });
    // Resolved item does not count.
    seedBlockingReviewItem(db, { id: 'rvw_3', runId: 'run-1', kind: 'decision', status: 'resolved' });
    // Other run's item is out of scope.
    seedBlockingReviewItem(db, { id: 'rvw_4', runId: 'run-2', kind: 'permission' });

    expect(countPendingBlockingReviewItems(dbAdapter(db), 'run-1')).toBe(2);
    const shaped = selectPendingBlockingReviewItems(dbAdapter(db), 'run-1');
    expect(shaped.map((r) => r.id).sort()).toEqual(['rvw_1', 'rvw_2']);
  });
});

describe('selectFindingForSeed', () => {
  it('returns null when the row exists but is not a finding', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_perm', runId: 'run-1', kind: 'permission' });
    // kind='permission', not 'finding' → filtered out.
    expect(selectFindingForSeed(dbAdapter(db), 'rvw_perm')).toBeNull();
  });

  it('shapes a finding row, lifting proposedTarget/suggestedFix/locations off the payload', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'awaiting_review');
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, title, body, severity, priority, source, payload_json, created_at, updated_at)
       VALUES ('rvw_find', 1, 'run-1', 'finding', 'pending', 0, 'A finding', 'body text', 'warning', 'P1', 'agent:executor', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        proposedTarget: 'backlog',
        suggestedFix: 'do the thing',
        locations: [{ path: 'a.ts', line: 5 }, { path: 'b.ts' }, { path: 42 }],
      }),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const seed = selectFindingForSeed(dbAdapter(db), 'rvw_find');
    expect(seed).not.toBeNull();
    expect(seed).toMatchObject({
      id: 'rvw_find',
      title: 'A finding',
      body: 'body text',
      severity: 'warning',
      priority: 'P1',
      source: 'agent:executor',
      proposedTarget: 'backlog',
      suggestedFix: 'do the thing',
    });
    // Malformed location entry (path: 42) is dropped; valid ones survive.
    expect(seed?.locations).toEqual([{ path: 'a.ts', line: 5 }, { path: 'b.ts' }]);
  });
});

describe('selectRunFindingsForRuns — the session-widened read', () => {
  /** Seed one pending agent-reported finding on `runId`. */
  const seed = (db: ReturnType<typeof buildReviewInboxDb>, id: string, runId: string, source: string) => {
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, severity,
          priority, source, created_at, updated_at)
       VALUES (?, 1, ?, 'finding', 'pending', 0, 'human', ?, 'b', 'warning', 'P1', ?, ?, ?)`,
    ).run(id, runId, `title ${id}`, source, `2026-08-26T10:00:0${id.slice(-1)}Z`, 'x');
  };

  it("unions several runs' findings, oldest first across the whole set", () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-flow', 'completed');
    seedInboxRun(db, 'run-sentinel', 'running');
    seedInboxRun(db, 'run-other', 'running');

    seed(db, 'rvw_2', 'run-flow', 'agent:code-review');
    seed(db, 'rvw_1', 'run-sentinel', 'agent:sprint-review');
    seed(db, 'rvw_9', 'run-other', 'agent:code-review');

    // The chat sentinel + the flow run its session owns — but NOT a third run.
    const found = selectRunFindingsForRuns(dbAdapter(db), ['run-sentinel', 'run-flow']);
    expect(found.map((f) => f.id)).toEqual(['rvw_1', 'rvw_2']);
    // runId is projected so a triaging agent can tell the two apart.
    expect(found.map((f) => f.runId)).toEqual(['run-sentinel', 'run-flow']);
  });

  it("includes the eval jury's findings — 'agent:eval' is inside the allow-list", () => {
    // The whole point of the D4 half of this fix: the jury writes source
    // 'agent:eval', which matches 'agent:%', so it was ALWAYS returned. Only the
    // tool's own description implied otherwise. Pin the behavior so a later
    // narrowing of the allow-list has to break a test.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-flow', 'completed');
    seed(db, 'rvw_1', 'run-flow', 'agent:eval');

    expect(selectRunFindingsForRuns(dbAdapter(db), ['run-flow']).map((f) => f.source)).toEqual([
      'agent:eval',
    ]);
  });

  it('returns [] for an empty run set rather than preparing an empty IN ()', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-flow', 'running');
    seed(db, 'rvw_1', 'run-flow', 'agent:code-review');

    expect(selectRunFindingsForRuns(dbAdapter(db), [])).toEqual([]);
  });
});

describe('selectRunFindings', () => {
  /** Insert one review_items row with explicit kind/status/audience/payload. */
  const seedFinding = (
    db: ReturnType<typeof buildReviewInboxDb>,
    opts: {
      id: string;
      runId: string;
      kind?: string;
      status?: string;
      audience?: string;
      blocking?: number;
      createdAt?: string;
      payload?: unknown;
    },
  ): void => {
    const stamp = opts.createdAt ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, severity,
          priority, source, payload_json, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'body', 'warning', 'P1', 'agent:code-review', ?, ?, ?)`,
    ).run(
      opts.id,
      opts.runId,
      opts.kind ?? 'finding',
      opts.status ?? 'pending',
      opts.blocking ?? 0,
      opts.audience ?? 'human',
      `title ${opts.id}`,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      stamp,
      stamp,
    );
  };

  it('returns only this run\'s pending human-audience findings, oldest first', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'running');
    seedInboxRun(db, 'run-2', 'running');

    seedFinding(db, { id: 'rvw_b', runId: 'run-1', createdAt: '2026-08-09T10:00:02Z' });
    seedFinding(db, { id: 'rvw_a', runId: 'run-1', createdAt: '2026-08-09T10:00:01Z' });
    // Excluded: already resolved, a non-finding kind, the orchestrator's machine
    // mailbox, and another run's finding.
    seedFinding(db, { id: 'rvw_done', runId: 'run-1', status: 'resolved' });
    seedFinding(db, { id: 'rvw_kind', runId: 'run-1', kind: 'decision' });
    seedFinding(db, { id: 'rvw_mach', runId: 'run-1', audience: 'machine' });
    seedFinding(db, { id: 'rvw_other', runId: 'run-2' });

    const found = selectRunFindings(dbAdapter(db), 'run-1');
    expect(found.map((f) => f.id)).toEqual(['rvw_a', 'rvw_b']);
  });

  it('keeps only agent-reported findings — system-minted ones are never triaged', () => {
    // The audience filter alone is NOT enough: verdictDelivery stamps its
    // merge-gate `loopback-implement` record audience:'machine' ONLY on a
    // PROGRAMMATIC run — on the orchestrated plane the same record is
    // audience:'human' AND blocking. Without the source allow-list it would land
    // in the triage pass, which could close a run-park record the human needed.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'running');

    seedFinding(db, { id: 'rvw_agent', runId: 'run-1' }); // source 'agent:code-review'
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, source, created_at, updated_at)
       VALUES (?, 1, 'run-1', 'finding', 'pending', ?, 'human', ?, 'b', 'visual-verify', ?, ?)`,
    ).run('rvw_gate', 1, 'loopback-implement', '2026-08-09T10:00:00Z', '2026-08-09T10:00:00Z');
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, source, created_at, updated_at)
       VALUES (?, 1, 'run-1', 'finding', 'pending', 0, 'human', ?, 'b', NULL, ?, ?)`,
    ).run('rvw_nosrc', 'no source at all', '2026-08-09T10:00:00Z', '2026-08-09T10:00:00Z');

    const found = selectRunFindings(dbAdapter(db), 'run-1');
    expect(found.map((f) => f.id)).toEqual(['rvw_agent']);
  });

  it('lifts category off the payload and normalizes the blocking bit', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'running');
    seedFinding(db, {
      id: 'rvw_cat',
      runId: 'run-1',
      blocking: 1,
      payload: {
        category: 'security',
        suggestedFix: 'validate the input',
        locations: [{ path: 'a.ts', line: 5 }],
      },
    });
    // A finding with no payload at all still shapes cleanly (all extras null).
    seedFinding(db, { id: 'rvw_bare', runId: 'run-1' });

    const byId = new Map(selectRunFindings(dbAdapter(db), 'run-1').map((f) => [f.id, f]));
    const withPayload = byId.get('rvw_cat')!;
    const bare = byId.get('rvw_bare')!;
    expect(withPayload).toMatchObject({
      id: 'rvw_cat',
      category: 'security',
      suggestedFix: 'validate the input',
      blocking: true,
    });
    expect(withPayload.locations).toEqual([{ path: 'a.ts', line: 5 }]);
    expect(bare).toMatchObject({ id: 'rvw_bare', category: null, blocking: false });
    expect(bare.locations).toBeNull();
  });
});

describe('selectPendingBlockingItemRows (the escalation review\'s list)', () => {
  /** Insert one blocking row with explicit kind/status/audience/body. */
  const seed = (
    db: ReturnType<typeof buildReviewInboxDb>,
    opts: {
      id: string;
      runId: string;
      kind?: string;
      status?: string;
      audience?: string;
      blocking?: number;
      createdAt?: string;
    },
  ): void => {
    const stamp = opts.createdAt ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, severity,
          source, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'error', 'agent:code-review', ?, ?)`,
    ).run(
      opts.id,
      opts.runId,
      opts.kind ?? 'finding',
      opts.status ?? 'pending',
      opts.blocking ?? 1,
      opts.audience ?? 'human',
      `title ${opts.id}`,
      `body ${opts.id}`,
      stamp,
      stamp,
    );
  };

  it('returns exactly the rows the aggregate-unblock COUNT sees, with their bodies, oldest first', () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-1', 'running');
    seedInboxRun(db, 'run-2', 'running');
    seed(db, { id: 'rvw_a', runId: 'run-1', createdAt: '2026-09-01T00:00:00.000Z' });
    seed(db, { id: 'rvw_b', runId: 'run-1', kind: 'decision', createdAt: '2026-09-02T00:00:00.000Z' });
    // Out of scope, each for a different reason — and each also invisible to the
    // count, which is the invariant that matters: the supervisor must never be
    // offered an item that is not holding the walk.
    seed(db, { id: 'rvw_resolved', runId: 'run-1', status: 'resolved' });
    seed(db, { id: 'rvw_nonblocking', runId: 'run-1', blocking: 0 });
    seed(db, { id: 'rvw_machine', runId: 'run-1', audience: 'machine' });
    seed(db, { id: 'rvw_other', runId: 'run-2' });

    const rows = selectPendingBlockingItemRows(dbAdapter(db), 'run-1');

    expect(rows.map((r) => r.id)).toEqual(['rvw_a', 'rvw_b']);
    expect(rows.length).toBe(countPendingBlockingReviewItems(dbAdapter(db), 'run-1'));
    expect(rows[0]).toEqual({
      id: 'rvw_a',
      kind: 'finding',
      source: 'agent:code-review',
      severity: 'error',
      title: 'title rvw_a',
      body: 'body rvw_a',
    });
    expect(rows[1].kind).toBe('decision');
  });
});
