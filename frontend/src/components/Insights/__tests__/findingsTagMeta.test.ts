/**
 * Unit tests for the load-bearing pure logic of the findings-triage redesign
 * (findingsTagMeta.ts). No React / store — these exercise the bucketing,
 * allocation, sort, meta-compose, tally, and exhaustive display maps directly.
 *
 * Time-relative assertions (composeUntriagedMeta age) pin Date.now() via fake
 * timers so they are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINDING_PRIORITIES,
  type FindingPriority,
  type FindingTagBucket,
  type ReviewItem,
  type ReviewItemSeverity,
} from '../../../../../shared/types/reviews';
import {
  BUCKET_LABEL,
  BUCKET_SWATCH,
  BUCKET_TEXT_CLASS,
  PRIORITY_BADGE,
  PRIORITY_BADGE_UNSET,
  READY_BUCKETS,
  SEVERITY_DOT,
  allocateReadyRows,
  composeUntriagedMeta,
  findingBucket,
  pluralizeTally,
  priorityBadge,
  sortWithinBucket,
  type RowsByBucket,
} from '../findingsTagMeta';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A minimal ReviewItem for meta-compose tests. */
function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rv_1',
    project_id: 1,
    run_id: 'run_1',
    entity_type: null,
    entity_id: null,
    kind: 'finding',
    status: 'pending',
    blocking: false,
    title: 'A finding',
    body: null,
    severity: 'warning',
    priority: null,
    staged_at: null,
    selected: false,
    source: 'agent:executor',
    payload: { kind: 'finding' },
    created_at: '2026-06-22T12:00:00.000Z',
    updated_at: '2026-06-22T12:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

/** A minimal sortable/allocatable ready row. */
interface Row {
  id: string;
  priority: FindingPriority | null;
  created_at: string;
}
function row(id: string, priority: FindingPriority | null, created_at = '2026-06-22T12:00:00.000Z'): Row {
  return { id, priority, created_at };
}

function emptyBuckets(): RowsByBucket<Row> {
  return { quick: [], doc: [], task: [] };
}

// ---------------------------------------------------------------------------
// findingBucket — canonical mapping reused (not redefined)
// ---------------------------------------------------------------------------

describe('findingBucket', () => {
  it("maps 'fix' -> quick, 'backlog' -> task, 'docs'/'prompt'/null -> doc", () => {
    expect(findingBucket('fix')).toBe('quick');
    expect(findingBucket('backlog')).toBe('task');
    expect(findingBucket('docs')).toBe('doc');
    expect(findingBucket('prompt')).toBe('doc');
    expect(findingBucket(null)).toBe('doc');
    expect(findingBucket(undefined)).toBe('doc');
  });
});

// ---------------------------------------------------------------------------
// allocateReadyRows — greedy global 5-budget
// ---------------------------------------------------------------------------

describe('allocateReadyRows', () => {
  it('fills in order quick -> doc -> task until the budget is consumed', () => {
    const buckets: RowsByBucket<Row> = {
      quick: [row('q1', 'P0'), row('q2', 'P1'), row('q3', 'P2')],
      doc: [row('d1', 'P0'), row('d2', 'P1')],
      task: [row('t1', 'P0'), row('t2', 'P1')],
    };
    const out = allocateReadyRows(buckets, 5);

    expect(out.visibleByBucket.quick?.map((r) => r.id)).toEqual(['q1', 'q2', 'q3']);
    expect(out.visibleByBucket.doc?.map((r) => r.id)).toEqual(['d1', 'd2']);
    // budget exhausted before task
    expect(out.visibleByBucket.task).toBeUndefined();
    expect(out.visibleRows).toBe(5);
  });

  it('omits a budget-starved bucket entirely (it appears only with >=1 row)', () => {
    const buckets: RowsByBucket<Row> = {
      quick: [row('q1', 'P0'), row('q2', 'P0'), row('q3', 'P0'), row('q4', 'P0'), row('q5', 'P0')],
      doc: [row('d1', 'P0')],
      task: [row('t1', 'P0')],
    };
    const out = allocateReadyRows(buckets, 5);

    expect(out.visibleByBucket.quick).toHaveLength(5);
    expect('doc' in out.visibleByBucket).toBe(false);
    expect('task' in out.visibleByBucket).toBe(false);
  });

  it('reports full counts (totalRows) independent of the allocation budget', () => {
    const buckets: RowsByBucket<Row> = {
      quick: [row('q1', 'P0'), row('q2', 'P0'), row('q3', 'P0')],
      doc: [row('d1', 'P0'), row('d2', 'P0'), row('d3', 'P0')],
      task: [row('t1', 'P0'), row('t2', 'P0')],
    };
    const out = allocateReadyRows(buckets, 5);

    expect(out.totalRows).toBe(8);
    expect(out.visibleRows).toBe(5);
  });

  it('computes hiddenCount = totalRows - visibleRows and anyHidden', () => {
    const buckets: RowsByBucket<Row> = {
      quick: [row('q1', 'P0'), row('q2', 'P0'), row('q3', 'P0'), row('q4', 'P0')],
      doc: [row('d1', 'P0'), row('d2', 'P0'), row('d3', 'P0')],
      task: [row('t1', 'P0')],
    };
    const out = allocateReadyRows(buckets, 5);

    expect(out.totalRows).toBe(8);
    expect(out.visibleRows).toBe(5);
    expect(out.hiddenCount).toBe(3);
    expect(out.anyHidden).toBe(true);
  });

  it('expanded (budget=Infinity) shows all rows with no hidden remainder', () => {
    const buckets: RowsByBucket<Row> = {
      quick: [row('q1', 'P0'), row('q2', 'P0'), row('q3', 'P0'), row('q4', 'P0')],
      doc: [row('d1', 'P0'), row('d2', 'P0'), row('d3', 'P0')],
      task: [row('t1', 'P0')],
    };
    const out = allocateReadyRows(buckets, Infinity);

    expect(out.visibleByBucket.quick).toHaveLength(4);
    expect(out.visibleByBucket.doc).toHaveLength(3);
    expect(out.visibleByBucket.task).toHaveLength(1);
    expect(out.visibleRows).toBe(8);
    expect(out.hiddenCount).toBe(0);
    expect(out.anyHidden).toBe(false);
  });

  it('handles an all-empty partition (no visible buckets, zero counts)', () => {
    const out = allocateReadyRows(emptyBuckets(), 5);
    expect(out.visibleByBucket).toEqual({});
    expect(out.totalRows).toBe(0);
    expect(out.visibleRows).toBe(0);
    expect(out.hiddenCount).toBe(0);
    expect(out.anyHidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortWithinBucket — P0 -> P1 -> P2 stable, null LAST, created_at tiebreak
// ---------------------------------------------------------------------------

describe('sortWithinBucket', () => {
  it('orders P0 -> P1 -> P2 with null priority LAST (OD-8)', () => {
    const rows = [row('a', 'P2'), row('b', null), row('c', 'P0'), row('d', 'P1')];
    expect(sortWithinBucket(rows).map((r) => r.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('is stable for equal priority (input order preserved when no tiebreak applies)', () => {
    const rows = [
      row('x', 'P1', '2026-06-22T12:00:00.000Z'),
      row('y', 'P1', '2026-06-22T12:00:00.000Z'),
      row('z', 'P1', '2026-06-22T12:00:00.000Z'),
    ];
    expect(sortWithinBucket(rows).map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });

  it('breaks equal-priority ties by created_at (oldest first)', () => {
    const rows = [
      row('newer', 'P1', '2026-06-22T13:00:00.000Z'),
      row('older', 'P1', '2026-06-22T11:00:00.000Z'),
    ];
    expect(sortWithinBucket(rows).map((r) => r.id)).toEqual(['older', 'newer']);
  });

  it('does not mutate the input array', () => {
    const rows = [row('a', 'P2'), row('b', 'P0')];
    const before = rows.map((r) => r.id);
    sortWithinBucket(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// composeUntriagedMeta — 'path:line · source-tail · age'
// ---------------------------------------------------------------------------

describe('composeUntriagedMeta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 14 minutes after the fixture created_at
    vi.setSystemTime(new Date('2026-06-22T12:14:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins location, source-tail (agent: stripped), and age with " · "', () => {
    const item = makeItem({
      source: 'agent:executor',
      payload: { kind: 'finding', locations: [{ path: 'execute/runner.ts', line: 142 }] },
    });
    expect(composeUntriagedMeta(item)).toBe('execute/runner.ts:142 · executor · 14m');
  });

  it('omits the location part entirely when there are no locations', () => {
    const item = makeItem({ source: 'agent:executor', payload: { kind: 'finding' } });
    expect(composeUntriagedMeta(item)).toBe('executor · 14m');
  });

  it('renders a location without a line as just the path', () => {
    const item = makeItem({
      source: 'agent:reviewer',
      payload: { kind: 'finding', locations: [{ path: 'docs/ARCHITECTURE.md' }] },
    });
    expect(composeUntriagedMeta(item)).toBe('docs/ARCHITECTURE.md · reviewer · 14m');
  });

  it('uses the first location when several are present', () => {
    const item = makeItem({
      source: 'agent:executor',
      payload: {
        kind: 'finding',
        locations: [
          { path: 'a.ts', line: 1 },
          { path: 'b.ts', line: 2 },
        ],
      },
    });
    expect(composeUntriagedMeta(item)).toBe('a.ts:1 · executor · 14m');
  });

  it('passes a non agent-prefixed source through unchanged', () => {
    const item = makeItem({ source: 'user', payload: { kind: 'finding' } });
    expect(composeUntriagedMeta(item)).toBe('user · 14m');
  });

  it('omits the source part when source is null (still renders age)', () => {
    const item = makeItem({ source: null, payload: { kind: 'finding' } });
    expect(composeUntriagedMeta(item)).toBe('14m');
  });
});

// ---------------------------------------------------------------------------
// pluralizeTally — singular / plural / 'nothing selected'
// ---------------------------------------------------------------------------

describe('pluralizeTally', () => {
  it('renders the full plural breakdown', () => {
    expect(pluralizeTally({ count: 6, quick: 2, doc: 2, task: 2 })).toBe(
      'Compounding 6 findings → 2 quick fixes · 2 doc updates · 2 tasks',
    );
  });

  it('uses singular nouns for a count of 1 in each bucket', () => {
    expect(pluralizeTally({ count: 3, quick: 1, doc: 1, task: 1 })).toBe(
      'Compounding 3 findings → 1 quick fix · 1 doc update · 1 task',
    );
  });

  it("uses singular 'finding' when the total is 1", () => {
    expect(pluralizeTally({ count: 1, quick: 1, doc: 0, task: 0 })).toBe(
      'Compounding 1 finding → 1 quick fix',
    );
  });

  it('omits zero-count buckets from the breakdown', () => {
    expect(pluralizeTally({ count: 4, quick: 0, doc: 1, task: 3 })).toBe(
      'Compounding 4 findings → 1 doc update · 3 tasks',
    );
  });

  it("returns 'nothing selected' when nothing is selected", () => {
    expect(pluralizeTally({ count: 0, quick: 0, doc: 0, task: 0 })).toBe('nothing selected');
  });
});

// ---------------------------------------------------------------------------
// PRIORITY_BADGE — including the explicit UNSET state for null (OD-8)
// ---------------------------------------------------------------------------

describe('priority badges', () => {
  it('renders the explicit UNSET em-dash for a null priority (never a fake P2)', () => {
    expect(priorityBadge(null)).toBe(PRIORITY_BADGE_UNSET);
    expect(PRIORITY_BADGE_UNSET.label).toBe('—');
    // crucially NOT 'P2'
    expect(PRIORITY_BADGE_UNSET.label).not.toBe('P2');
  });

  it('renders the matching badge for each concrete priority', () => {
    expect(priorityBadge('P0')).toBe(PRIORITY_BADGE.P0);
    expect(priorityBadge('P1')).toBe(PRIORITY_BADGE.P1);
    expect(priorityBadge('P2')).toBe(PRIORITY_BADGE.P2);
    expect(PRIORITY_BADGE.P0.label).toBe('P0');
    expect(PRIORITY_BADGE.P1.label).toBe('P1');
    expect(PRIORITY_BADGE.P2.label).toBe('P2');
  });
});

// ---------------------------------------------------------------------------
// Exhaustive display maps
// ---------------------------------------------------------------------------

describe('exhaustive display maps', () => {
  const buckets: readonly FindingTagBucket[] = READY_BUCKETS;
  const severities: readonly ReviewItemSeverity[] = ['error', 'warning', 'info'];

  it('READY_BUCKETS is the fixed render order quick, doc, task', () => {
    expect(READY_BUCKETS).toEqual(['quick', 'doc', 'task']);
  });

  it('every bucket has a label, swatch, and text class', () => {
    for (const bucket of buckets) {
      expect(BUCKET_LABEL[bucket]).toBeTruthy();
      expect(BUCKET_SWATCH[bucket]).toBeTruthy();
      expect(BUCKET_TEXT_CLASS[bucket]).toBeTruthy();
    }
  });

  it('every severity has a dot color, with error tokenized to --severity-error (OD-2)', () => {
    for (const severity of severities) {
      expect(SEVERITY_DOT[severity]).toBeTruthy();
    }
    expect(SEVERITY_DOT.error).toBe('var(--severity-error)');
    expect(SEVERITY_DOT.warning).toBe('var(--amber-accent)');
  });

  it('every concrete priority has a badge spec', () => {
    for (const priority of FINDING_PRIORITIES) {
      expect(PRIORITY_BADGE[priority].label).toBe(priority);
      expect(PRIORITY_BADGE[priority].class).toBeTruthy();
    }
  });
});
