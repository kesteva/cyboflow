/**
 * Unit tests for the landingStore PURE reducers (no live subscriptions).
 *
 * Exercises:
 *   - upsertReviewItem: replace by id / append / remove-on-resolve.
 *   - flattenPendingReviewItems: keeps pending decision + human_task + notification across
 *     multiple projects; drops findings, permission, and non-pending items.
 *
 * The tRPC client is mocked at module level so importing landingStore.ts does
 * not require a live Electron IPC bridge. Path is relative to this test file:
 * ../../trpc/client → frontend/src/trpc/client.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReviewItem, ReviewItemKind, ReviewItemStatus } from '../../../../shared/types/reviews';

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        list: { query: vi.fn() },
        onReviewItemChanged: { subscribe: vi.fn() },
      },
      events: {
        onRunStatusChanged: { subscribe: vi.fn() },
        onApprovalCreated: { subscribe: vi.fn() },
        onApprovalDecided: { subscribe: vi.fn() },
      },
    },
  },
}));

// API import path is relative to this test file: ../../utils/api.
vi.mock('../../utils/api', () => ({
  API: { projects: { getAll: vi.fn() } },
}));

import { upsertReviewItem, flattenPendingReviewItems } from '../landingStore';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ReviewItem> & { id: string }): ReviewItem {
  const kind: ReviewItemKind = overrides.kind ?? 'decision';
  const status: ReviewItemStatus = overrides.status ?? 'pending';
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id ?? null,
    entity_type: overrides.entity_type ?? null,
    entity_id: overrides.entity_id ?? null,
    kind,
    status,
    blocking: overrides.blocking ?? false,
    title: overrides.title ?? `item ${overrides.id}`,
    body: overrides.body ?? null,
    severity: overrides.severity ?? null,
    priority: overrides.priority ?? null,
    staged_at: overrides.staged_at ?? null,
    selected: overrides.selected ?? false,
    source: overrides.source ?? null,
    payload: overrides.payload ?? null,
    created_at: overrides.created_at ?? '2026-06-05T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-05T00:00:00.000Z',
    resolved_by: overrides.resolved_by ?? null,
    resolution: overrides.resolution ?? null,
  };
}

// ---------------------------------------------------------------------------
// upsertReviewItem
// ---------------------------------------------------------------------------

describe('upsertReviewItem', () => {
  it('appends a new pending item and returns a new array reference', () => {
    const a = makeItem({ id: 'a' });
    const b = makeItem({ id: 'b' });
    const input = [a];
    const next = upsertReviewItem(input, b);
    expect(next).toHaveLength(2);
    expect(next.map((i) => i.id)).toEqual(['a', 'b']);
    // returns a NEW array (immutability) — does not mutate the input.
    expect(next).not.toBe(input);
    expect(input).toHaveLength(1);
  });

  it('replaces an existing item by id in place', () => {
    const a = makeItem({ id: 'a', title: 'old' });
    const b = makeItem({ id: 'b' });
    const updated = makeItem({ id: 'a', title: 'new' });
    const next = upsertReviewItem([a, b], updated);
    expect(next).toHaveLength(2);
    expect(next[0].title).toBe('new');
    expect(next[1].id).toBe('b');
  });

  it('removes an item when it is no longer pending (resolved)', () => {
    const a = makeItem({ id: 'a' });
    const b = makeItem({ id: 'b' });
    const resolved = makeItem({ id: 'a', status: 'resolved' });
    const next = upsertReviewItem([a, b], resolved);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('b');
  });

  it('removes an item when it is dismissed', () => {
    const a = makeItem({ id: 'a' });
    const dismissed = makeItem({ id: 'a', status: 'dismissed' });
    const next = upsertReviewItem([a], dismissed);
    expect(next).toEqual([]);
  });

  it('is a no-op-removal when a non-pending item is not present', () => {
    const a = makeItem({ id: 'a' });
    const resolved = makeItem({ id: 'ghost', status: 'resolved' });
    const next = upsertReviewItem([a], resolved);
    expect(next.map((i) => i.id)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// flattenPendingReviewItems
// ---------------------------------------------------------------------------

describe('flattenPendingReviewItems', () => {
  it('keeps pending decision + human_task + notification across multiple projects', () => {
    const byProject: Record<number, ReviewItem[]> = {
      1: [
        makeItem({ id: 'd1', kind: 'decision', project_id: 1 }),
        makeItem({ id: 'h1', kind: 'human_task', project_id: 1 }),
        makeItem({ id: 'n1', kind: 'notification', project_id: 1 }),
      ],
      2: [makeItem({ id: 'd2', kind: 'decision', project_id: 2 })],
    };
    const out = flattenPendingReviewItems(byProject);
    expect(out.map((i) => i.id).sort()).toEqual(['d1', 'd2', 'h1', 'n1']);
  });

  it('drops findings and permission items but keeps notifications', () => {
    const byProject: Record<number, ReviewItem[]> = {
      1: [
        makeItem({ id: 'f1', kind: 'finding' }),
        makeItem({ id: 'p1', kind: 'permission' }),
        makeItem({ id: 'd1', kind: 'decision' }),
        makeItem({ id: 'n1', kind: 'notification' }),
      ],
    };
    const out = flattenPendingReviewItems(byProject);
    expect(out.map((i) => i.id).sort()).toEqual(['d1', 'n1']);
  });

  it('drops non-pending decision/human_task items', () => {
    const byProject: Record<number, ReviewItem[]> = {
      1: [
        makeItem({ id: 'd1', kind: 'decision', status: 'resolved' }),
        makeItem({ id: 'h1', kind: 'human_task', status: 'dismissed' }),
        makeItem({ id: 'd2', kind: 'decision', status: 'pending' }),
      ],
    };
    const out = flattenPendingReviewItems(byProject);
    expect(out.map((i) => i.id)).toEqual(['d2']);
  });

  it('returns an empty array for an empty map', () => {
    expect(flattenPendingReviewItems({})).toEqual([]);
  });
});
