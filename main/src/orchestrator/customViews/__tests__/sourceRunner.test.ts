/**
 * Unit tests for runWidgetSources (docs/proposals/CUSTOM-VIEWS.md §4.2).
 *
 * A FILE-BACKED sqlite database is used because `sql` sources execute on the
 * readonly sibling connection, which needs an on-disk path. The `query`
 * adapters read the same file through the writer handle, exactly as they do in
 * production (they are pure SELECT helpers).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceResult, WidgetSpec } from '../../../../../shared/types/customViews';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { closeReadonlySiblings, openReadonlySibling } from '../../readOnlyQuery';
import { runWidgetSources, type SourceOutcome } from '../sourceRunner';
import type { DatabaseLike } from '../../types';

const CONTEXT = { projectId: 7, nowIso: '2026-09-10T12:00:00.000Z', todayIso: '2026-09-10' };

let tmpDir: string;
let rawDb: Database.Database;
let db: DatabaseLike;
let handle: Database.Database;

function rowsOf(outcome: SourceOutcome | undefined): SourceResult['rows'] {
  expect(outcome).toBeDefined();
  expect(outcome && 'error' in outcome ? outcome.error : null).toBeNull();
  return (outcome as SourceResult).rows;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-source-runner-'));
  rawDb = new Database(join(tmpDir, 'test.db'));
  rawDb.pragma('foreign_keys = OFF');
  rawDb.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER, label TEXT, amount INTEGER);
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', outcome TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, ended_at DATETIME
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE run_usage (
      run_id TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL, num_turns INTEGER, assistant_message_count INTEGER NOT NULL DEFAULT 0,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const insert = rawDb.prepare('INSERT INTO items (id, project_id, label, amount) VALUES (?, ?, ?, ?)');
  insert.run(1, 7, 'alpha', 10);
  insert.run(2, 7, 'beta', 30);
  insert.run(3, 9, 'gamma', 50);

  db = dbAdapter(rawDb);
  handle = openReadonlySibling(db);
});

afterEach(() => {
  closeReadonlySiblings();
  rawDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sql sources
// ---------------------------------------------------------------------------

describe('runWidgetSources — sql sources', () => {
  it('binds a context param and returns rows + columns', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: {
          type: 'sql',
          sql: 'SELECT id, label, amount FROM items WHERE project_id = :pid ORDER BY id',
          params: { pid: { context: 'projectId' } },
        },
      },
      render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'label' }] },
    };
    const result = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle });
    const slot = result.sources.rows as SourceResult;
    expect(slot.columns).toEqual(['id', 'label', 'amount']);
    expect(slot.rows).toEqual([
      { id: 1, label: 'alpha', amount: 10 },
      { id: 2, label: 'beta', amount: 30 },
    ]);
    expect(slot.truncated).toBe(false);
  });

  it('coerces a boolean literal param to 1', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'SELECT :flag AS flag', params: { flag: { literal: true } } },
      },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'flag' },
    };
    expect(rowsOf(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows)).toEqual([
      { flag: 1 },
    ]);
  });

  it('applies the source transforms after the query', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT id, label, amount FROM items ORDER BY id' } },
      transforms: {
        rows: [
          { op: 'filter', field: 'amount', cmp: 'gte', value: 30 },
          { op: 'sort', field: 'amount', dir: 'desc' },
          { op: 'limit', n: 1 },
        ],
      },
      render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'label' }] },
    };
    expect(rowsOf(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows)).toEqual([
      { id: 3, label: 'gamma', amount: 50 },
    ]);
  });

  it('reports columns produced by a transform, not the statement columns', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT id, amount FROM items ORDER BY id' } },
      transforms: { rows: [{ op: 'derive', as: 'doubled', expr: { mul: [{ field: 'amount' }, { literal: 2 }] } }] },
      render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'doubled' }] },
    };
    const slot = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows as SourceResult;
    expect(slot.columns).toEqual(['id', 'amount', 'doubled']);
  });

  it('applies the widget SQL profile — EXPLAIN fails this source only', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        bad: { type: 'sql', sql: 'EXPLAIN SELECT id FROM items' },
        good: { type: 'sql', sql: 'SELECT id FROM items ORDER BY id LIMIT 1' },
      },
      render: { type: 'shape', shape: 'table', source: 'good', columns: [{ field: 'id' }] },
    };
    const result = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle });
    expect(result.sources.bad).toEqual({ error: 'explain_not_allowed' });
    expect(rowsOf(result.sources.good)).toEqual([{ id: 1 }]);
  });

  it('refuses a recursive CTE with recursive_not_allowed', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'WITH RECURSIVE c(n) AS (SELECT 1) SELECT n FROM c' },
      },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'n' },
    };
    expect(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows).toEqual({
      error: 'recursive_not_allowed',
    });
  });

  it('reports a missing bind as missing_param:<name> in that source slot', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT id FROM items WHERE project_id = :pid' } },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'id' },
    };
    expect(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows).toEqual({
      error: 'missing_param:pid',
    });
  });

  it('fails a sql source with db_query_unavailable when no readonly handle exists', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'SELECT id FROM items' },
        stats: { type: 'query', name: 'insights.workflowStats', input: { projectId: { literal: null } } },
      },
      render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'id' }] },
    };
    const result = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle: null });
    expect((result.sources.rows as { error: string }).error).toContain('db_query_unavailable');
    expect(rowsOf(result.sources.stats)).toEqual([]);
  });

  it('reports a surviving setting reference rather than binding null', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'SELECT :pid AS pid', params: { pid: { setting: 'projectSetting' } } },
      },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'pid' },
    };
    expect(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows).toEqual({
      error: 'unresolved_setting:projectSetting',
    });
  });
});

// ---------------------------------------------------------------------------
// query sources
// ---------------------------------------------------------------------------

describe('runWidgetSources — query adapters', () => {
  beforeEach(() => {
    rawDb.prepare('INSERT INTO workflows (id, project_id, name) VALUES (?, ?, ?)').run('wf-1', 7, 'sprint');
    rawDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, outcome, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run('run-1', 'wf-1', 7, 'completed', 'merged');
    rawDb
      .prepare("INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, 'assistant', ?, datetime('now'))")
      .run(
        'run-1',
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_x',
            model: 'claude-opus-4-5',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      );
  });

  it('runs insights.workflowStats scoped by a context projectId', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        stats: { type: 'query', name: 'insights.workflowStats', input: { projectId: { context: 'projectId' } } },
      },
      render: { type: 'shape', shape: 'table', source: 'stats', columns: [{ field: 'workflowName' }] },
    };
    const rows = rowsOf(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.stats);
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowName).toBe('sprint');
    expect(rows[0].totalRuns).toBe(1);
  });

  it('runs insights.dailyUsage and applies its transforms', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        usage: {
          type: 'query',
          name: 'insights.dailyUsage',
          input: { projectId: { literal: null }, days: { literal: 30 } },
        },
      },
      transforms: { usage: [{ op: 'filter', field: 'model', cmp: 'eq', value: 'claude-opus-4-5' }] },
      render: { type: 'shape', shape: 'columns', source: 'usage', x: 'day', series: 'model', y: 'totalTokens' },
    };
    const rows = rowsOf(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.usage);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('claude-opus-4-5');
    expect(rows[0].totalTokens).toBe(150);
  });

  it('runs insights.usageTrend with a nullable workflowId', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        trend: {
          type: 'query',
          name: 'insights.usageTrend',
          input: { workflowId: { literal: null }, projectId: { context: 'projectId' }, days: { literal: 7 } },
        },
      },
      render: { type: 'shape', shape: 'columns', source: 'trend', x: 'date', series: 'date', y: 'totalTokens' },
    };
    const rows = rowsOf(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.trend);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(1);
  });

  it('rejects a query input the router schema would reject', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        usage: {
          type: 'query',
          name: 'insights.dailyUsage',
          input: { projectId: { literal: null }, days: { literal: 4000 } },
        },
      },
      render: { type: 'shape', shape: 'stat', source: 'usage', value: 'totalTokens' },
    };
    const slot = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.usage;
    expect(slot).toHaveProperty('error');
    expect((slot as { error: string }).error).toMatch(/^invalid_input:/);
  });

  it('rejects a usageTrend input missing its required workflowId', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        trend: { type: 'query', name: 'insights.usageTrend', input: { projectId: { literal: null } } },
      },
      render: { type: 'shape', shape: 'stat', source: 'trend', value: 'runs' },
    };
    const slot = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.trend;
    expect((slot as { error: string }).error).toMatch(/^invalid_input:/);
  });
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

describe('runWidgetSources — caps', () => {
  it('marks a truncated source and warns', () => {
    const insert = rawDb.prepare('INSERT INTO items (id, project_id, label, amount) VALUES (?, 7, ?, 1)');
    rawDb.transaction(() => {
      for (let i = 100; i < 700; i++) insert.run(i, `row-${i}`);
    })();
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT id FROM items' } },
      render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'id' }] },
    };
    const result = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle });
    const slot = result.sources.rows as SourceResult;
    expect(slot.rows).toHaveLength(500);
    expect(slot.truncated).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("source 'rows' truncated");
  });

  it('fails a source with row_too_large when one row exceeds the widget row cap', () => {
    rawDb.prepare('INSERT INTO items (id, project_id, label, amount) VALUES (?, 7, ?, 1)').run(50, 'x'.repeat(3000));
    // Each string is truncated to 2000 chars first, so the cap bites on a WIDE
    // row (10 x ~2 KB = ~20 KB) rather than on one long string.
    const columns = Array.from({ length: 10 }, (_, i) => `label AS c${i}`).join(', ');
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: `SELECT ${columns} FROM items WHERE id = 50` } },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'c0' },
    };
    expect(runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows).toEqual({
      error: 'row_too_large',
    });
  });

  it('truncates a single long string at the widget string cap instead of failing', () => {
    rawDb.prepare('INSERT INTO items (id, project_id, label, amount) VALUES (?, 7, ?, 1)').run(51, 'y'.repeat(5000));
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT label FROM items WHERE id = 51' } },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'label' },
    };
    const slot = runWidgetSources({ resolvedSpec: spec, context: CONTEXT, db, handle }).sources.rows as SourceResult;
    expect(String(slot.rows[0].label)).toMatch(/…\[truncated\]$/);
  });
});
