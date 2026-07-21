/**
 * Unit tests for the S0.4 global-agent `cyboflow_db_query` tool
 * (mcp-db-query) on McpQueryHandler.
 *
 * Unlike mcpAgentTools.test.ts's in-memory fixture, this tool NEEDS a
 * FILE-BACKED sqlite database — its readonly sibling connection is opened
 * against `this.db.name` (the on-disk file path), which a ':memory:' handle
 * doesn't have. Each test gets its own temp-dir db file so tests never share
 * state or a lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpQueryHandler, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

const AGENT_RUN_ID = 'agent:thread-dbquery-test';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let rawDb: Database.Database;
let handler: McpQueryHandler;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-dbquery-'));
  dbPath = join(tmpDir, 'test.db');
  rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      blob_col BLOB
    );
  `);
  rawDb.prepare('INSERT INTO widgets (name) VALUES (?)').run('alpha');
  rawDb.prepare('INSERT INTO widgets (name) VALUES (?)').run('beta');
  handler = new McpQueryHandler(dbAdapter(rawDb));
});

afterEach(() => {
  rawDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('mcp-db-query — happy path', () => {
  it('returns rows/columns for a plain SELECT', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r1', runId: AGENT_RUN_ID, sql: 'SELECT id, name FROM widgets ORDER BY id' },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean };
    expect(data.columns).toEqual(['id', 'name']);
    expect(data.rows).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    expect(data.rowCount).toBe(2);
    expect(data.truncated).toBe(false);
  });

  it('discovers schema via sqlite_master', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r2', runId: AGENT_RUN_ID, sql: "SELECT name FROM sqlite_master WHERE type='table'" },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { rows: Array<{ name: string }> };
    expect(data.rows.map((r) => r.name)).toContain('widgets');
  });

  it('WITH and EXPLAIN are accepted as reader statements', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-db-query',
        requestId: 'r3',
        runId: AGENT_RUN_ID,
        sql: 'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
      },
      socket,
    );
    expect(parseLastWrite(writes).ok).toBe(true);

    const { socket: socket2, writes: writes2 } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r4', runId: AGENT_RUN_ID, sql: 'EXPLAIN SELECT * FROM widgets' },
      socket2,
    );
    expect(parseLastWrite(writes2).ok).toBe(true);
  });

  it('sanitizes long strings and blobs', async () => {
    rawDb.prepare('UPDATE widgets SET blob_col = ? WHERE id = 1').run(Buffer.from('binary-data'));
    const longName = 'x'.repeat(3000);
    rawDb.prepare('INSERT INTO widgets (name) VALUES (?)').run(longName);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r5', runId: AGENT_RUN_ID, sql: 'SELECT name, blob_col FROM widgets ORDER BY id' },
      socket,
    );
    const resp = parseLastWrite(writes);
    const data = resp.data as { rows: Array<Record<string, unknown>> };
    expect(data.rows[0].blob_col).toBe('<blob 11 bytes>');
    const truncatedRow = data.rows.find((r) => typeof r.name === 'string' && (r.name as string).startsWith('xxx'));
    expect(truncatedRow).toBeDefined();
    expect((truncatedRow!.name as string).length).toBeLessThan(3000);
    expect(truncatedRow!.name).toMatch(/…\[truncated\]$/);
  });
});

// ---------------------------------------------------------------------------
// Validation rejections
// ---------------------------------------------------------------------------

describe('mcp-db-query — validation rejections (never reach the connection)', () => {
  const cases: Array<{ label: string; sql: string; reason: string }> = [
    { label: 'INSERT', sql: "INSERT INTO widgets (name) VALUES ('x')", reason: 'not_a_select' },
    { label: 'UPDATE', sql: "UPDATE widgets SET name = 'x'", reason: 'not_a_select' },
    { label: 'DELETE', sql: 'DELETE FROM widgets', reason: 'not_a_select' },
    { label: 'DROP', sql: 'DROP TABLE widgets', reason: 'not_a_select' },
    { label: 'multiple statements', sql: 'SELECT 1; SELECT 2', reason: 'multiple_statements' },
    // Checked BEFORE the multiple-statement scan, so an ATTACH anywhere in
    // the string (even after a ';') is flagged as forbidden_keyword first —
    // still rejected either way, which is the defense-in-depth point.
    { label: 'ATTACH', sql: "SELECT 1; ATTACH DATABASE 'x' AS y", reason: 'forbidden_keyword' },
    { label: 'ATTACH alone', sql: "ATTACH DATABASE 'x' AS y", reason: 'not_a_select' },
    { label: 'PRAGMA mid-statement', sql: 'SELECT 1 /* pragma writable_schema */', reason: 'forbidden_keyword' },
    { label: 'PRAGMA statement', sql: 'PRAGMA table_info(widgets)', reason: 'not_a_select' },
    { label: 'empty', sql: '   ', reason: 'empty_sql' },
  ];

  for (const { label, sql, reason } of cases) {
    it(`rejects ${label} with reason '${reason}'`, async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-db-query', requestId: 'rx', runId: AGENT_RUN_ID, sql }, socket);
      const resp = parseLastWrite(writes);
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe(reason);
    });
  }

  it('a trailing semicolon with only whitespace/comments after it is NOT multiple_statements', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r6', runId: AGENT_RUN_ID, sql: 'SELECT 1; -- trailing comment\n  ' },
      socket,
    );
    expect(parseLastWrite(writes).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Row / payload cap
// ---------------------------------------------------------------------------

describe('mcp-db-query — row cap', () => {
  it('caps at 200 rows and sets truncated:true for a 300-row table', async () => {
    const insert = rawDb.prepare('INSERT INTO widgets (name) VALUES (?)');
    const insertMany = rawDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`row-${i}`);
    });
    insertMany(300);

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r7', runId: AGENT_RUN_ID, sql: 'SELECT id FROM widgets' },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { rows: unknown[]; rowCount: number; truncated: boolean };
    expect(data.rows.length).toBe(200);
    expect(data.rowCount).toBe(200);
    expect(data.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------

describe('mcp-db-query — scope guard', () => {
  it('rejects a run-scoped (non agent:) runId', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r8', runId: 'not-an-agent-run-id', sql: 'SELECT 1' },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_a_global_agent_run');
  });
});

// ---------------------------------------------------------------------------
// Readonly-by-construction (defense-in-depth beyond validation)
// ---------------------------------------------------------------------------

describe('mcp-db-query — readonly connection refuses writes independent of validation', () => {
  it('a raw readonly:true better-sqlite3 handle throws on an INSERT, proving the enforcement mechanism itself', () => {
    const readonlyHandle = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(() => readonlyHandle.prepare("INSERT INTO widgets (name) VALUES ('smuggled')").run()).toThrow();
    } finally {
      readonlyHandle.close();
    }
    // No row was written — the writer connection still sees only the seeded 2.
    const count = rawDb.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("a WITH-prefixed write ('WITH x AS (SELECT 1) INSERT ...') that slips past validation is never executed (non-reader short-circuit)", async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-db-query',
        requestId: 'r9',
        runId: AGENT_RUN_ID,
        sql: "WITH x AS (SELECT 'smuggled' AS n) INSERT INTO widgets (name) SELECT n FROM x",
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { rows: unknown[]; note?: string };
    expect(data.rows).toEqual([]);
    expect(data.note).toBe('statement returned no rows');

    const count = rawDb.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number };
    expect(count.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// db_query_unavailable — no on-disk file (e.g. :memory: fixtures)
// ---------------------------------------------------------------------------

describe('mcp-db-query — unavailable without an on-disk db file', () => {
  it('fails gracefully (not a crash) when the injected DatabaseLike has no usable name', async () => {
    const memoryDb = new Database(':memory:');
    memoryDb.exec('CREATE TABLE t (id INTEGER)');
    const memHandler = new McpQueryHandler(dbAdapter(memoryDb));

    const { socket, writes } = makeSocketDouble();
    await memHandler.handleMessage(
      { type: 'mcp-db-query', requestId: 'r10', runId: AGENT_RUN_ID, sql: 'SELECT * FROM t' },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('db_query_unavailable');
    memoryDb.close();
  });
});
