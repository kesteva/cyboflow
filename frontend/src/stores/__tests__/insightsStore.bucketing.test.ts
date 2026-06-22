/**
 * Pure-selector unit tests for the findings-triage view model in insightsStore.
 *
 * These exercise the EXPORTED pure selectors (selectUntriaged / selectReadyBuckets
 * / selectGreedyReadyRows / selectTallyParts / selectSelectedFindingIds /
 * selectFindingsCounters) directly — no store instance, no tRPC. They mirror the
 * selectFanoutWorkflows/filterPendingFindings pure-helper pattern in
 * insightsStore.test.ts. The store ACTIONS (optimistic mutations, subscription)
 * are covered in insightsStore.test.ts; this file owns the bucketing/sort/tally
 * logic the UI slice consumes.
 *
 * The selectors delegate the canonical target→bucket mapping + the within-bucket
 * sort + the greedy allocator to findingsTagMeta.ts (separately unit-tested in
 * findingsTagMeta.test.ts), so the assertions here focus on the store-level
 * composition (untriaged vs ready partition, selected-only tally, stable id order).
 */
import { describe, it, expect } from 'vitest';
import {
  selectUntriaged,
  selectReadyBuckets,
  selectGreedyReadyRows,
  selectTallyParts,
  selectSelectedFindingIds,
  selectFindingsCounters,
  type TriageFinding,
} from '../insightsStore';
import type {
  FindingPriority,
  FindingProposedTarget,
  ReviewItem,
} from '../../../../shared/types/reviews';
import type { QualityFinding, ReviewItemSummary } from '../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TriageOverrides {
  id: string;
  triageState?: 'untriaged' | 'ready';
  priority?: FindingPriority | null;
  selected?: boolean;
  proposedTarget?: FindingProposedTarget | null;
  created_at?: string;
  staged_at?: string | null;
}

/** Build a TriageFinding with the fields the selectors read. */
function tf(o: TriageOverrides): TriageFinding {
  const triageState = o.triageState ?? (o.staged_at != null ? 'ready' : 'untriaged');
  const staged_at = o.staged_at ?? (triageState === 'ready' ? '2026-06-06T00:00:00.000Z' : null);
  const proposedTarget = o.proposedTarget;
  const base: ReviewItem = {
    id: o.id,
    project_id: 1,
    run_id: null,
    entity_type: null,
    entity_id: null,
    kind: 'finding',
    status: 'pending',
    blocking: false,
    title: `finding ${o.id}`,
    body: null,
    severity: null,
    priority: o.priority ?? null,
    staged_at,
    selected: o.selected ?? false,
    source: 'agent:executor',
    payload:
      proposedTarget === undefined
        ? null
        : proposedTarget === null
          ? { kind: 'finding' }
          : { kind: 'finding', proposedTarget },
    created_at: o.created_at ?? '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
  return { ...base, triageState };
}

function qf(id: string, status: QualityFinding['status']): QualityFinding {
  return {
    id,
    projectId: 1,
    title: `q ${id}`,
    severity: 'warning',
    status,
    source: 'agent:executor',
    sourceStep: 'executor',
    category: null,
    locations: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    resolution: null,
    runId: null,
    runOutcome: null,
    runEndedAt: null,
    workflowName: null,
  };
}

function summary(findingPending: number): ReviewItemSummary {
  return {
    total: findingPending,
    pending: findingPending,
    resolved: 0,
    dismissed: 0,
    pendingByKind: { finding: findingPending, permission: 0, decision: 0, human_task: 0 },
  };
}

// ---------------------------------------------------------------------------
// selectUntriaged
// ---------------------------------------------------------------------------

describe('selectUntriaged', () => {
  it('keeps only untriaged rows and excludes ready rows', () => {
    const out = selectUntriaged([
      tf({ id: 'u1', triageState: 'untriaged' }),
      tf({ id: 'r1', triageState: 'ready' }),
      tf({ id: 'u2', triageState: 'untriaged' }),
    ]);
    expect(out.map((f) => f.id).sort()).toEqual(['u1', 'u2']);
  });

  it('sorts newest-first by created_at', () => {
    const out = selectUntriaged([
      tf({ id: 'old', created_at: '2026-06-01T00:00:00.000Z' }),
      tf({ id: 'new', created_at: '2026-06-09T00:00:00.000Z' }),
      tf({ id: 'mid', created_at: '2026-06-05T00:00:00.000Z' }),
    ]);
    expect(out.map((f) => f.id)).toEqual(['new', 'mid', 'old']);
  });

  it('tiebreaks equal created_at by P0→P1→P2 then null last', () => {
    const ts = '2026-06-05T00:00:00.000Z';
    const out = selectUntriaged([
      tf({ id: 'none', created_at: ts, priority: null }),
      tf({ id: 'p2', created_at: ts, priority: 'P2' }),
      tf({ id: 'p0', created_at: ts, priority: 'P0' }),
      tf({ id: 'p1', created_at: ts, priority: 'P1' }),
    ]);
    expect(out.map((f) => f.id)).toEqual(['p0', 'p1', 'p2', 'none']);
  });
});

// ---------------------------------------------------------------------------
// selectReadyBuckets
// ---------------------------------------------------------------------------

describe('selectReadyBuckets', () => {
  it('partitions ready rows by canonical target (fix→quick, docs/prompt→doc, backlog→task)', () => {
    const buckets = selectReadyBuckets([
      tf({ id: 'q', triageState: 'ready', proposedTarget: 'fix' }),
      tf({ id: 'd1', triageState: 'ready', proposedTarget: 'docs' }),
      tf({ id: 'd2', triageState: 'ready', proposedTarget: 'prompt' }), // legacy → doc
      tf({ id: 'd3', triageState: 'ready', proposedTarget: null }), // untagged → doc
      tf({ id: 't', triageState: 'ready', proposedTarget: 'backlog' }),
      tf({ id: 'u', triageState: 'untriaged', proposedTarget: 'fix' }), // excluded
    ]);
    expect(buckets.quick.map((f) => f.id)).toEqual(['q']);
    expect(buckets.doc.map((f) => f.id).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(buckets.task.map((f) => f.id)).toEqual(['t']);
  });

  it('sorts each bucket P0→P1→P2 (null last) within itself', () => {
    const buckets = selectReadyBuckets([
      tf({ id: 'none', triageState: 'ready', proposedTarget: 'fix', priority: null }),
      tf({ id: 'p1', triageState: 'ready', proposedTarget: 'fix', priority: 'P1' }),
      tf({ id: 'p0', triageState: 'ready', proposedTarget: 'fix', priority: 'P0' }),
    ]);
    expect(buckets.quick.map((f) => f.id)).toEqual(['p0', 'p1', 'none']);
  });
});

// ---------------------------------------------------------------------------
// selectGreedyReadyRows
// ---------------------------------------------------------------------------

describe('selectGreedyReadyRows', () => {
  function manyReady(): TriageFinding[] {
    const rows: TriageFinding[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(tf({ id: `q${i}`, triageState: 'ready', proposedTarget: 'fix' }));
    }
    for (let i = 0; i < 4; i++) {
      rows.push(tf({ id: `d${i}`, triageState: 'ready', proposedTarget: 'docs' }));
    }
    for (let i = 0; i < 4; i++) {
      rows.push(tf({ id: `t${i}`, triageState: 'ready', proposedTarget: 'backlog' }));
    }
    return rows;
  }

  it('collapsed: fills the 5-row budget in bucket order quick→doc→task', () => {
    const buckets = selectReadyBuckets(manyReady());
    const alloc = selectGreedyReadyRows(buckets, false);
    expect(alloc.visibleRows).toBe(5);
    // quick filled (4), then 1 doc — task starved.
    expect(alloc.visibleByBucket.quick).toHaveLength(4);
    expect(alloc.visibleByBucket.doc).toHaveLength(1);
    expect(alloc.visibleByBucket.task).toBeUndefined();
  });

  it('hiddenCount = totalRows - visibleRows', () => {
    const buckets = selectReadyBuckets(manyReady());
    const alloc = selectGreedyReadyRows(buckets, false);
    expect(alloc.totalRows).toBe(12);
    expect(alloc.hiddenCount).toBe(7);
    expect(alloc.anyHidden).toBe(true);
  });

  it('expanded (showAll): shows everything, no hidden rows', () => {
    const buckets = selectReadyBuckets(manyReady());
    const alloc = selectGreedyReadyRows(buckets, true);
    expect(alloc.visibleRows).toBe(12);
    expect(alloc.hiddenCount).toBe(0);
    expect(alloc.anyHidden).toBe(false);
  });

  it('header full counts come from the RAW buckets, independent of the allocation', () => {
    const buckets = selectReadyBuckets(manyReady());
    selectGreedyReadyRows(buckets, false);
    // The collapsed allocation hides the task bucket entirely, but its full
    // header count is still 4 (the consumer reads buckets[k].length).
    expect(buckets.task).toHaveLength(4);
    expect(buckets.quick).toHaveLength(4);
    expect(buckets.doc).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// selectTallyParts
// ---------------------------------------------------------------------------

describe('selectTallyParts', () => {
  it('counts ONLY selected ready rows, per bucket', () => {
    const tally = selectTallyParts([
      tf({ id: 'q1', triageState: 'ready', proposedTarget: 'fix', selected: true }),
      tf({ id: 'q2', triageState: 'ready', proposedTarget: 'fix', selected: false }),
      tf({ id: 'd1', triageState: 'ready', proposedTarget: 'docs', selected: true }),
      tf({ id: 't1', triageState: 'ready', proposedTarget: 'backlog', selected: true }),
      // selected but untriaged → not counted.
      tf({ id: 'u1', triageState: 'untriaged', proposedTarget: 'fix', selected: true }),
    ]);
    expect(tally).toEqual({ count: 3, quick: 1, doc: 1, task: 1 });
  });

  it('is all-zero when nothing is selected', () => {
    const tally = selectTallyParts([
      tf({ id: 'q1', triageState: 'ready', proposedTarget: 'fix', selected: false }),
    ]);
    expect(tally).toEqual({ count: 0, quick: 0, doc: 0, task: 0 });
  });
});

// ---------------------------------------------------------------------------
// selectSelectedFindingIds
// ---------------------------------------------------------------------------

describe('selectSelectedFindingIds', () => {
  it('returns selected ready ids in stable bucket-then-within-bucket order', () => {
    const ids = selectSelectedFindingIds([
      tf({ id: 't1', triageState: 'ready', proposedTarget: 'backlog', selected: true }),
      tf({ id: 'q1', triageState: 'ready', proposedTarget: 'fix', selected: true, priority: 'P1' }),
      tf({ id: 'q0', triageState: 'ready', proposedTarget: 'fix', selected: true, priority: 'P0' }),
      tf({ id: 'd1', triageState: 'ready', proposedTarget: 'docs', selected: true }),
      tf({ id: 'q2', triageState: 'ready', proposedTarget: 'fix', selected: false }), // unselected
      tf({ id: 'u1', triageState: 'untriaged', proposedTarget: 'fix', selected: true }), // untriaged
    ]);
    // Bucket order quick→doc→task; within quick, P0 before P1.
    expect(ids).toEqual(['q0', 'q1', 'd1', 't1']);
  });

  it('returns empty when nothing selected', () => {
    expect(
      selectSelectedFindingIds([
        tf({ id: 'q1', triageState: 'ready', proposedTarget: 'fix', selected: false }),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectFindingsCounters
// ---------------------------------------------------------------------------

describe('selectFindingsCounters', () => {
  it('Pending = pendingByKind.finding; Resolved/Dismissed client-derived from qualityFindings', () => {
    const counters = selectFindingsCounters(
      [qf('a', 'pending'), qf('b', 'resolved'), qf('c', 'dismissed'), qf('d', 'resolved')],
      summary(3),
    );
    expect(counters).toEqual({ pending: 3, resolved: 2, dismissed: 1 });
  });

  it('is findings-scoped — does NOT use the whole-inbox reviewSummary.pending', () => {
    const wholeInbox: ReviewItemSummary = {
      total: 10,
      pending: 8, // whole-inbox; would inflate the strip if used
      resolved: 1,
      dismissed: 1,
      pendingByKind: { finding: 2, permission: 4, decision: 2, human_task: 0 },
    };
    const counters = selectFindingsCounters([qf('a', 'pending')], wholeInbox);
    // Pending uses the finding-scoped 2, NOT the whole-inbox 8.
    expect(counters.pending).toBe(2);
  });

  it('is resilient to a null summary (pending = 0)', () => {
    expect(selectFindingsCounters([qf('a', 'resolved')], null)).toEqual({
      pending: 0,
      resolved: 1,
      dismissed: 0,
    });
  });
});
