/**
 * Unit tests for the shared read-only SQL executor (readOnlyQuery.ts,
 * docs/proposals/CUSTOM-VIEWS.md §4.1 / §10 "Read-only guarantee").
 *
 * The pre-extraction behaviour of the AGENT profile is pinned end-to-end by
 * mcpServer/__tests__/mcpDbQuery.test.ts, which is unchanged by the move. What
 * this file covers is the module's own surface: the widget profile's two extra
 * refusals, parameter binding and its error mapping, `maxRowBytes`, and the
 * readonly connection refusing a write that reaches it.
 *
 * A FILE-BACKED sqlite database is required — a readonly sibling connection is
 * opened against `db.name`, which a ':memory:' handle does not have.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  AGENT_QUERY_LIMITS,
  closeReadonlySiblings,
  coerceBindParams,
  collectQueryPlan,
  openReadonlySibling,
  runReadonlyQuery,
  validateReadonlySql,
} from '../readOnlyQuery';

let tmpDir: string;
let dbPath: string;
let rawDb: Database.Database;
let handle: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-readonly-query-'));
  dbPath = join(tmpDir, 'test.db');
  rawDb = new Database(dbPath);
  rawDb.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)');
  rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, ?)').run(1, 'alpha', 1);
  rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, ?)').run(2, 'beta', 0);
  handle = openReadonlySibling(dbAdapter(rawDb));
});

afterEach(() => {
  closeReadonlySiblings();
  rawDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe('validateReadonlySql — widget profile', () => {
  const rejections: Array<{ label: string; sql: string; reason: string }> = [
    { label: 'a leading EXPLAIN', sql: 'EXPLAIN SELECT * FROM widgets', reason: 'explain_not_allowed' },
    { label: 'EXPLAIN QUERY PLAN', sql: 'EXPLAIN QUERY PLAN SELECT * FROM widgets', reason: 'explain_not_allowed' },
    {
      label: 'a recursive CTE',
      sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c',
      reason: 'recursive_not_allowed',
    },
    {
      label: 'a recursive CTE in mixed case',
      sql: 'with recursive c(n) AS (SELECT 1) SELECT n FROM c',
      reason: 'recursive_not_allowed',
    },
    { label: 'PRAGMA', sql: 'PRAGMA table_info(widgets)', reason: 'not_a_select' },
    { label: 'PRAGMA mid-statement', sql: 'SELECT 1 /* pragma writable_schema */', reason: 'forbidden_keyword' },
    { label: 'multiple statements', sql: 'SELECT 1; SELECT 2', reason: 'multiple_statements' },
    { label: 'an UPDATE', sql: "UPDATE widgets SET name = 'x'", reason: 'not_a_select' },
    { label: 'empty sql', sql: '   ', reason: 'empty_sql' },
  ];

  for (const { label, sql, reason } of rejections) {
    it(`rejects ${label} with '${reason}'`, () => {
      const result = validateReadonlySql(sql, { profile: 'widget' });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe(reason);
    });
  }

  it('accepts a non-recursive WITH', () => {
    expect(validateReadonlySql('WITH x AS (SELECT 1 AS n) SELECT n FROM x', { profile: 'widget' }).ok).toBe(true);
  });
});

describe('validateReadonlySql — agent profile keeps EXPLAIN and non-recursive CTEs', () => {
  it('accepts EXPLAIN', () => {
    expect(validateReadonlySql('EXPLAIN SELECT * FROM widgets', { profile: 'agent' }).ok).toBe(true);
  });

  it('accepts EXPLAIN when no profile is given at all (the default)', () => {
    expect(validateReadonlySql('EXPLAIN SELECT * FROM widgets').ok).toBe(true);
  });

  it('accepts a recursive CTE, which only the widget profile refuses', () => {
    const sql = 'WITH RECURSIVE c(n) AS (SELECT 1) SELECT n FROM c';
    expect(validateReadonlySql(sql, { profile: 'agent' }).ok).toBe(true);
    expect(validateReadonlySql(sql, { profile: 'widget' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parameter binding
// ---------------------------------------------------------------------------

describe('coerceBindParams', () => {
  it('maps booleans to 1/0 and passes strings, numbers and null through', () => {
    expect(coerceBindParams({ t: true, f: false, s: 'x', n: 3, z: null })).toEqual({
      t: 1,
      f: 0,
      s: 'x',
      n: 3,
      z: null,
    });
  });

  it('throws unbindable_param for a value SQLite cannot bind', () => {
    expect(() => coerceBindParams({ bad: { nested: 1 } })).toThrow('unbindable_param:bad');
    expect(() => coerceBindParams({ arr: [1, 2] })).toThrow('unbindable_param:arr');
  });
});

describe('runReadonlyQuery — parameters', () => {
  it('binds a coerced boolean as 1 and selects the matching row', () => {
    const params = coerceBindParams({ flag: true });
    const result = runReadonlyQuery(handle, 'SELECT id, name FROM widgets WHERE flag = :flag', params, AGENT_QUERY_LIMITS);
    expect(result.rows).toEqual([{ id: 1, name: 'alpha' }]);
  });

  it('binds a coerced false as 0', () => {
    const params = coerceBindParams({ flag: false });
    const result = runReadonlyQuery(handle, 'SELECT id FROM widgets WHERE flag = :flag', params, AGENT_QUERY_LIMITS);
    expect(result.rows).toEqual([{ id: 2 }]);
  });

  it("re-raises better-sqlite3's missing-parameter error as missing_param:<name>", () => {
    expect(() =>
      runReadonlyQuery(handle, 'SELECT id FROM widgets WHERE flag = :flag', {}, AGENT_QUERY_LIMITS),
    ).toThrow('missing_param:flag');
  });

  it('ignores an extra param better-sqlite3 tolerates', () => {
    const result = runReadonlyQuery(
      handle,
      'SELECT :a AS a',
      coerceBindParams({ a: 1, unused: 'x' }),
      AGENT_QUERY_LIMITS,
    );
    expect(result.rows).toEqual([{ a: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

describe('runReadonlyQuery — caps', () => {
  it('fails the whole query with row_too_large when a single row exceeds maxRowBytes', () => {
    rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, ?)').run(3, 'y'.repeat(500), 1);
    expect(() =>
      runReadonlyQuery(handle, 'SELECT name FROM widgets ORDER BY id', {}, {
        maxRows: 500,
        maxPayloadBytes: 250_000,
        maxStringLen: 2000,
        maxRowBytes: 100,
      }),
    ).toThrow('row_too_large');
  });

  it('does not apply a row-size cap when maxRowBytes is absent (the agent profile)', () => {
    rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, ?)').run(3, 'y'.repeat(500), 1);
    const result = runReadonlyQuery(handle, 'SELECT name FROM widgets ORDER BY id', {}, AGENT_QUERY_LIMITS);
    expect(result.rows).toHaveLength(3);
  });

  it('stops at maxRows and reports truncated', () => {
    const insert = rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, 1)');
    rawDb.transaction(() => {
      for (let i = 10; i < 30; i++) insert.run(i, `row-${i}`);
    })();
    const result = runReadonlyQuery(handle, 'SELECT id FROM widgets', {}, { ...AGENT_QUERY_LIMITS, maxRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('truncates long strings at maxStringLen', () => {
    rawDb.prepare('INSERT INTO widgets (id, name, flag) VALUES (?, ?, 1)').run(3, 'z'.repeat(50));
    const result = runReadonlyQuery(handle, 'SELECT name FROM widgets WHERE id = 3', {}, {
      ...AGENT_QUERY_LIMITS,
      maxStringLen: 10,
    });
    expect(result.rows[0].name).toBe(`${'z'.repeat(10)}…[truncated]`);
  });

  it('short-circuits a non-reader statement to an empty result carrying a note', () => {
    const result = runReadonlyQuery(
      handle,
      "WITH x AS (SELECT 'smuggled' AS n) INSERT INTO widgets (id, name) SELECT 9, n FROM x",
      {},
      AGENT_QUERY_LIMITS,
    );
    expect(result.rows).toEqual([]);
    expect(result.note).toBe('statement returned no rows');
    expect((rawDb.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number }).n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Readonly by construction
// ---------------------------------------------------------------------------

describe('openReadonlySibling', () => {
  it('refuses a write that reaches the handle, whatever the validator did', () => {
    expect(() => handle.prepare("UPDATE widgets SET name = 'smuggled'").run()).toThrow(
      /readonly database/i,
    );
    expect((rawDb.prepare("SELECT COUNT(*) AS n FROM widgets WHERE name = 'smuggled'").get() as { n: number }).n).toBe(0);
  });

  it('throws db_query_unavailable for an in-memory DatabaseLike', () => {
    const memory = new Database(':memory:');
    try {
      expect(() => openReadonlySibling(dbAdapter(memory))).toThrow(/db_query_unavailable/);
    } finally {
      memory.close();
    }
  });

  it('returns one cached handle per path', () => {
    expect(openReadonlySibling(dbAdapter(rawDb))).toBe(handle);
  });

  it('reopens rather than returning a handle a caller closed', () => {
    handle.close();
    const reopened = openReadonlySibling(dbAdapter(rawDb));
    expect(reopened.open).toBe(true);
    expect(reopened).not.toBe(handle);
  });
});

// ---------------------------------------------------------------------------
// Query plan
// ---------------------------------------------------------------------------

describe('collectQueryPlan', () => {
  it('returns the planner detail lines for a table scan', () => {
    const plan = collectQueryPlan(handle, 'SELECT name FROM widgets', {});
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.join(' ')).toContain('SCAN');
  });

  it('returns [] for SQL the planner refuses rather than throwing', () => {
    expect(collectQueryPlan(handle, 'SELECT * FROM no_such_table', {})).toEqual([]);
  });
});
