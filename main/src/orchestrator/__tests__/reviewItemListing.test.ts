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
  selectPendingBlockingReviewItems,
  selectFindingForSeed,
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
    expect(selectFindingForSeed(db, 'rvw_x')).toBeNull();
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
