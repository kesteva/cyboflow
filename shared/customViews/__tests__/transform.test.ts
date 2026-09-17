import { describe, expect, it } from 'vitest';
import type { Scalar, TransformStep } from '../../types/customViews';
import { applyTransform } from '../transform';

type Row = Record<string, Scalar>;

describe('applyTransform — filter', () => {
  const rows: Row[] = [
    { id: 1, tokens: 100, name: 'Alpha' },
    { id: 2, tokens: 200, name: 'Beta' },
    { id: 3, tokens: null, name: null },
  ];

  it('eq / ne compare directly, including against null', () => {
    expect(applyTransform(rows, [{ op: 'filter', field: 'tokens', cmp: 'eq', value: null }])).toEqual([rows[2]]);
    expect(applyTransform(rows, [{ op: 'filter', field: 'id', cmp: 'ne', value: 1 }])).toEqual([rows[1], rows[2]]);
  });

  it('ordering comparators never match a null row value', () => {
    expect(applyTransform(rows, [{ op: 'filter', field: 'tokens', cmp: 'gt', value: 50 }])).toEqual([rows[0], rows[1]]);
    expect(applyTransform(rows, [{ op: 'filter', field: 'tokens', cmp: 'lte', value: 100 }])).toEqual([rows[0]]);
  });

  it('in takes an array', () => {
    expect(applyTransform(rows, [{ op: 'filter', field: 'id', cmp: 'in', value: [1, 3] }])).toEqual([rows[0], rows[2]]);
  });

  it('in never matches a null row value, even when null is in the array', () => {
    const withNullId: Row[] = [{ id: null }, { id: 1 }];
    expect(applyTransform(withNullId, [{ op: 'filter', field: 'id', cmp: 'in', value: [1, null] }])).toEqual([{ id: 1 }]);
  });

  it('contains is a case-insensitive substring match on strings', () => {
    expect(applyTransform(rows, [{ op: 'filter', field: 'name', cmp: 'contains', value: 'ETA' }])).toEqual([rows[1]]);
  });

  it('throws for an unresolved SettingRef', () => {
    const step = { op: 'filter', field: 'id', cmp: 'eq', value: { setting: 'x' } } as unknown as TransformStep;
    expect(() => applyTransform(rows, [step])).toThrow(/SettingRef/);
  });
});

describe('applyTransform — sort', () => {
  it('sorts numbers numerically, stably, with nulls last', () => {
    const rows: Row[] = [
      { id: 'a', n: 3 },
      { id: 'b', n: null },
      { id: 'c', n: 1 },
      { id: 'd', n: 1 },
      { id: 'e', n: null },
    ];
    const sorted = applyTransform(rows, [{ op: 'sort', field: 'n', dir: 'asc' }]);
    expect(sorted.map((r) => r.id)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('sorts strings with localeCompare and honours desc', () => {
    const rows: Row[] = [{ id: 1, name: 'banana' }, { id: 2, name: 'Apple' }, { id: 3, name: 'cherry' }];
    const asc = applyTransform(rows, [{ op: 'sort', field: 'name', dir: 'asc' }]).map((r) => r.id);
    const desc = applyTransform(rows, [{ op: 'sort', field: 'name', dir: 'desc' }]).map((r) => r.id);
    expect(asc).toEqual([2, 1, 3]);
    expect(desc).toEqual([3, 1, 2]);
  });
});

describe('applyTransform — limit', () => {
  it('keeps only the first n rows', () => {
    const rows: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(applyTransform(rows, [{ op: 'limit', n: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('applyTransform — bucketDate', () => {
  it('buckets by day for an ISO datetime', () => {
    const rows: Row[] = [{ ts: '2026-03-14T15:09:26Z' }];
    expect(applyTransform(rows, [{ op: 'bucketDate', field: 'ts', unit: 'day', as: 'bucket' }])[0].bucket).toBe('2026-03-14');
  });

  it('buckets by week (Monday, UTC) across a year boundary', () => {
    // 2026-01-01 is a Thursday; its ISO week starts Monday 2025-12-29.
    const rows: Row[] = [{ ts: '2026-01-01 00:00:00' }];
    expect(applyTransform(rows, [{ op: 'bucketDate', field: 'ts', unit: 'week', as: 'bucket' }])[0].bucket).toBe('2025-12-29');
  });

  it('buckets by month', () => {
    const rows: Row[] = [{ ts: '2026-07-20' }];
    expect(applyTransform(rows, [{ op: 'bucketDate', field: 'ts', unit: 'month', as: 'bucket' }])[0].bucket).toBe('2026-07-01');
  });

  it('parses a naive SQLite datetime string as UTC', () => {
    const rows: Row[] = [{ ts: '2026-06-30 23:30:00' }];
    // Day bucket must NOT roll over due to a local-timezone misparse.
    expect(applyTransform(rows, [{ op: 'bucketDate', field: 'ts', unit: 'day', as: 'bucket' }])[0].bucket).toBe('2026-06-30');
  });

  it('yields null for an unparsable or non-string value', () => {
    const rows: Row[] = [{ ts: 'not-a-date' }, { ts: null }];
    const out = applyTransform(rows, [{ op: 'bucketDate', field: 'ts', unit: 'day', as: 'bucket' }]);
    expect(out.map((r) => r.bucket)).toEqual([null, null]);
  });
});

describe('applyTransform — group', () => {
  it('groups by keys and computes multiple aggregates, preserving first-seen order', () => {
    const rows: Row[] = [
      { team: 'b', tokens: 10 },
      { team: 'a', tokens: 5 },
      { team: 'b', tokens: 20 },
      { team: 'a', tokens: null },
    ];
    const out = applyTransform(rows, [
      {
        op: 'group',
        by: ['team'],
        aggregates: [
          { fn: 'sum', field: 'tokens', as: 'total' },
          { fn: 'count', as: 'rows' },
          { fn: 'avg', field: 'tokens', as: 'avg' },
          { fn: 'min', field: 'tokens', as: 'min' },
          { fn: 'max', field: 'tokens', as: 'max' },
        ],
      },
    ]);
    expect(out).toEqual([
      { team: 'b', total: 30, rows: 2, avg: 15, min: 10, max: 20 },
      { team: 'a', total: 5, rows: 2, avg: 5, min: 5, max: 5 },
    ]);
  });

  it('count with a field counts non-null occurrences; sum/avg/min/max ignore non-numeric values', () => {
    const rows: Row[] = [{ k: 'x', v: 'not-a-number' }, { k: 'x', v: 7 }, { k: 'x', v: null }];
    const out = applyTransform(rows, [
      {
        op: 'group',
        by: ['k'],
        aggregates: [
          { fn: 'count', field: 'v', as: 'nonNullCount' },
          { fn: 'sum', field: 'v', as: 'sum' },
          { fn: 'avg', field: 'v', as: 'avg' },
        ],
      },
    ]);
    expect(out).toEqual([{ k: 'x', nonNullCount: 2, sum: 7, avg: 7 }]);
  });
});

describe('applyTransform — derive', () => {
  const rows: Row[] = [{ a: 10, b: 4 }, { a: 10, b: 0 }, { a: 'nope', b: 5 }];

  it('add/sub/mul over numeric fields', () => {
    expect(applyTransform([rows[0]], [{ op: 'derive', as: 'sum', expr: { add: [{ field: 'a' }, { field: 'b' }] } }])[0].sum).toBe(14);
    expect(applyTransform([rows[0]], [{ op: 'derive', as: 'diff', expr: { sub: [{ field: 'a' }, { literal: 3 }] } }])[0].diff).toBe(7);
    expect(applyTransform([rows[0]], [{ op: 'derive', as: 'prod', expr: { mul: [{ field: 'a' }, { field: 'b' }] } }])[0].prod).toBe(40);
  });

  it('division by zero yields null', () => {
    expect(applyTransform([rows[1]], [{ op: 'derive', as: 'ratio', expr: { div: [{ field: 'a' }, { field: 'b' }] } }])[0].ratio).toBeNull();
  });

  it('a non-numeric operand yields null, except for coalesce', () => {
    expect(applyTransform([rows[2]], [{ op: 'derive', as: 'sum', expr: { add: [{ field: 'a' }, { field: 'b' }] } }])[0].sum).toBeNull();
    expect(
      applyTransform([rows[2]], [{ op: 'derive', as: 'first', expr: { coalesce: [{ field: 'a' }, { field: 'b' }] } }])[0].first
    ).toBe('nope');
  });

  it('coalesce returns the first non-null operand', () => {
    const row: Row = { a: null, b: 9 };
    expect(applyTransform([row], [{ op: 'derive', as: 'first', expr: { coalesce: [{ field: 'a' }, { field: 'b' }] } }])[0].first).toBe(9);
  });
});

describe('applyTransform — pipeline', () => {
  it('applies steps in order', () => {
    const rows: Row[] = [{ id: 1, n: 5 }, { id: 2, n: 1 }, { id: 3, n: 3 }];
    const out = applyTransform(rows, [
      { op: 'sort', field: 'n', dir: 'asc' },
      { op: 'limit', n: 2 },
    ]);
    expect(out.map((r) => r.id)).toEqual([2, 3]);
  });
});
