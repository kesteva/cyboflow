/**
 * Unit tests for the shared-build-break DETECTOR (CD3).
 *
 * Two halves, tested separately because they fail differently: the NORMALIZER
 * (too aggressive fuses unrelated breaks into one misleading card; too timid
 * never reaches the threshold) and the SWEEP (the query shape — `category` lives
 * in `payload_json`, not a column — plus the ≥2 threshold).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeBuildBreak,
  buildBreakGroupKey,
  sweepBuildBreaks,
  BUILD_BREAK_GROUP_MIN,
} from '../buildBreakDetector';
import type { DatabaseLike } from '../../types';

/** A DatabaseLike whose one prepared statement replays `rows` and records the SQL. */
function makeDb(
  rows: unknown[],
  opts: { throws?: boolean } = {},
): DatabaseLike & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    prepare(query: string) {
      sql.push(query);
      return {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: (...args: unknown[]) => {
          params.push(args);
          if (opts.throws === true) throw new Error('no such function: json_extract');
          return rows;
        },
      };
    },
    transaction<T>(fn: (...a: unknown[]) => T) {
      return fn;
    },
  };
}

function row(partial: { id: string; title: string; entityType?: string; entityId?: string }): unknown {
  return {
    id: partial.id,
    title: partial.title,
    entityType: partial.entityType ?? null,
    entityId: partial.entityId ?? null,
  };
}

describe('normalizeBuildBreak', () => {
  it('reduces an absolute path to its basename', () => {
    expect(normalizeBuildBreak('Build break: /Users/x/wt/main/src/a.ts: cannot find name Foo')).toBe(
      normalizeBuildBreak('Build break: a.ts: cannot find name Foo'),
    );
  });

  it('reduces a Windows path (drive letter included) to its basename', () => {
    expect(normalizeBuildBreak('C:\\work\\repo\\src\\a.ts cannot find name Foo')).toBe(
      normalizeBuildBreak('a.ts cannot find name Foo'),
    );
  });

  it('strips :line:col and (line,col) positions, which move as siblings edit the file', () => {
    const a = normalizeBuildBreak('src/a.ts:12:4 - TS2304: Cannot find name Foo');
    const b = normalizeBuildBreak('src/a.ts:88:1 - TS2304: Cannot find name Foo');
    const c = normalizeBuildBreak('a.ts(88,1) - TS2304: Cannot find name Foo');
    expect(a).toBe(b);
    expect(c).toContain('ts2304');
    expect(c).not.toContain('88');
  });

  it('strips long hex ids (build hashes, chunk + request ids)', () => {
    expect(normalizeBuildBreak('chunk 3f9a1bc0e2 failed to load')).toBe(
      normalizeBuildBreak('chunk 91be44ad7f failed to load'),
    );
  });

  it('keeps ordinary numbers and symbol names, so different breaks stay different', () => {
    expect(normalizeBuildBreak('tsc: 4 errors')).not.toBe(normalizeBuildBreak('tsc: 7 errors'));
    expect(normalizeBuildBreak('Cannot find name Foo')).not.toBe(
      normalizeBuildBreak('Cannot find name Bar'),
    );
  });

  it('collapses whitespace and case', () => {
    expect(normalizeBuildBreak('  Cannot   find   NAME Foo \n')).toBe('cannot find name foo');
  });

  it('is empty for an empty title, so a title-less row cannot form a group', () => {
    expect(normalizeBuildBreak('   ')).toBe('');
  });
});

describe('buildBreakGroupKey', () => {
  it('is stable, short and hex', () => {
    expect(buildBreakGroupKey('cannot find name foo')).toBe(buildBreakGroupKey('cannot find name foo'));
    expect(buildBreakGroupKey('cannot find name foo')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('separates different normalized texts', () => {
    expect(buildBreakGroupKey('cannot find name foo')).not.toBe(buildBreakGroupKey('cannot find name bar'));
  });
});

describe('sweepBuildBreaks', () => {
  it('queries `category` out of payload_json (there is no category COLUMN) and scopes to the run + project', () => {
    const db = makeDb([]);
    sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 });
    expect(db.sql[0]).toContain("json_extract(payload_json, '$.category') = 'build-break'");
    expect(db.sql[0]).toContain("kind = 'finding'");
    expect(db.sql[0]).toContain("status = 'pending'");
    expect(db.params[0]).toEqual(['run-1', 3]);
  });

  it('returns NOTHING when only one lane reported the break', () => {
    const db = makeDb([row({ id: 'rv1', title: 'Build break: src/a.ts:1:1 Cannot find name Foo' })]);
    expect(sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 })).toEqual([]);
  });

  it('groups two reports whose titles differ only in path shape and position', () => {
    const db = makeDb([
      row({ id: 'rv1', title: 'Build break: /Users/x/wt/src/a.ts:12:4 Cannot find name Foo' }),
      row({ id: 'rv2', title: 'Build break: src/a.ts:88:1 Cannot find name Foo' }),
    ]);
    const groups = sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].count).toBeGreaterThanOrEqual(BUILD_BREAK_GROUP_MIN);
    expect(groups[0].itemIds).toEqual(['rv1', 'rv2']);
    // The ORIGINAL first-seen title is kept, so the card shows real text.
    expect(groups[0].sampleTitle).toContain('/Users/x/wt/src/a.ts:12:4');
  });

  it('keeps genuinely different breaks in different groups', () => {
    const db = makeDb([
      row({ id: 'rv1', title: 'Build break: Cannot find name Foo' }),
      row({ id: 'rv2', title: 'Build break: Cannot find name Foo' }),
      row({ id: 'rv3', title: 'Build break: Cannot find name Bar' }),
    ]);
    const groups = sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds).toEqual(['rv1', 'rv2']);
  });

  it('recovers lane refs from the rows that carried a task entity link, and tolerates the rest', () => {
    // The build-break contract does not ask for an entity link and
    // `cyboflow_report_finding` stamps `source` as agent:<step>, so lane identity
    // is usually absent — the threshold counts ITEMS, and laneRefs is best-effort.
    const db = makeDb([
      row({ id: 'rv1', title: 'Build break: X', entityType: 'task', entityId: 'TASK-001' }),
      row({ id: 'rv2', title: 'Build break: X' }),
      row({ id: 'rv3', title: 'Build break: X', entityType: 'task', entityId: 'TASK-001' }),
    ]);
    const groups = sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 });
    expect(groups[0].count).toBe(3);
    expect(groups[0].laneRefs).toEqual(['TASK-001']);
  });

  it('ignores title-less rows rather than fusing them into one empty group', () => {
    const db = makeDb([row({ id: 'rv1', title: '' }), row({ id: 'rv2', title: '   ' })]);
    expect(sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 })).toEqual([]);
  });

  it('returns an empty list when the query throws (fail-soft — a detector must not break a run)', () => {
    const db = makeDb([], { throws: true });
    expect(sweepBuildBreaks(db, { runId: 'run-1', projectId: 3 })).toEqual([]);
  });
});
