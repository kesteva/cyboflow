/**
 * Tests for the shared orchestratorTestDb fixture module.
 *
 * Covers:
 * 1. createTestDb returns a fresh in-memory DB with the expected tables.
 * 2. seedRun with defaults inserts a single workflow + workflow_run in 'running'.
 * 3. seedRun with overrides.status='awaiting_review' honors the override.
 * 4. Column-level parity: GATE_SCHEMA columns match 006_cyboflow_schema.sql
 *    for workflows, workflow_runs, approvals, raw_events.
 * 5. messages table is intentionally absent from GATE_SCHEMA.
 *
 * NOTE on parity test coverage: PRAGMA table_info() does NOT report CHECK
 * constraints. A CHECK-only drift (e.g. a new enum value added to a status
 * column) would NOT fail this test. Column additions, renames, and removals
 * ARE caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../orchestratorTestDb';

// ---------------------------------------------------------------------------
// Parity test helpers
// ---------------------------------------------------------------------------

/** Load the canonical 006_cyboflow_schema.sql into a fresh :memory: DB. */
function createCanonicalDb(): Database.Database {
  const schemaPath = join(
    process.cwd(),
    'src/database/migrations/006_cyboflow_schema.sql',
  );
  const sql = readFileSync(schemaPath, 'utf8');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(sql);
  return db;
}

/** Returns a Set of column names for the given table using PRAGMA table_info(). */
function columnSet(db: Database.Database, tableName: string): Set<string> {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// ---------------------------------------------------------------------------
// Unit tests: createTestDb
// ---------------------------------------------------------------------------

describe('createTestDb', () => {
  it('returns a fresh in-memory Database with FK enforcement ON', () => {
    const db = createTestDb();
    // FK pragma should return 1.
    const result = db.pragma('foreign_keys', { simple: true });
    expect(result).toBe(1);
  });

  it('creates workflows, workflow_runs, approvals, raw_events tables', () => {
    const db = createTestDb();
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('workflows');
    expect(tables).toContain('workflow_runs');
    expect(tables).toContain('approvals');
    expect(tables).toContain('raw_events');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: seedRun
// ---------------------------------------------------------------------------

describe('seedRun', () => {
  it('inserts one workflow + workflow_run row with default status=running', () => {
    const db = createTestDb();
    const { workflowId, runId } = seedRun(db);

    const wf = db
      .prepare('SELECT id FROM workflows WHERE id = ?')
      .get(workflowId) as { id: string } | undefined;
    expect(wf).toBeDefined();
    expect(wf!.id).toBe(workflowId);

    const run = db
      .prepare('SELECT id, status FROM workflow_runs WHERE id = ?')
      .get(runId) as { id: string; status: string } | undefined;
    expect(run).toBeDefined();
    expect(run!.status).toBe('running');
  });

  it("seedRun with overrides.status='awaiting_review' honors the override", () => {
    const db = createTestDb();
    const { runId } = seedRun(db, { id: 'run-override-test', status: 'awaiting_review' });

    const run = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string } | undefined;
    expect(run).toBeDefined();
    expect(run!.status).toBe('awaiting_review');
  });

  it('seedRun with explicit id sets the expected run id', () => {
    const db = createTestDb();
    const { runId } = seedRun(db, { id: 'my-explicit-run' });
    expect(runId).toBe('my-explicit-run');

    const run = db
      .prepare('SELECT id FROM workflow_runs WHERE id = ?')
      .get('my-explicit-run') as { id: string } | undefined;
    expect(run).toBeDefined();
  });

  it('seedRun with explicit workflowId wires the FK correctly', () => {
    const db = createTestDb();
    // Pre-insert the workflow so the shared ID can be reused.
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-shared', 1, 'shared', '{}')`,
    ).run();
    const { workflowId } = seedRun(db, { id: 'run-shared', workflowId: 'wf-shared' });
    expect(workflowId).toBe('wf-shared');
  });
});

// ---------------------------------------------------------------------------
// Parity test: GATE_SCHEMA vs 006_cyboflow_schema.sql column sets
// ---------------------------------------------------------------------------

describe('GATE_SCHEMA parity vs 006_cyboflow_schema.sql', () => {
  const TABLES_TO_CHECK = ['workflows', 'workflow_runs', 'approvals', 'raw_events'] as const;

  it.each(TABLES_TO_CHECK)(
    'column set for table "%s" matches between GATE_SCHEMA and 006_cyboflow_schema.sql',
    (tableName) => {
      const gateDb = createTestDb();
      const canonicalDb = createCanonicalDb();

      const gateCols = columnSet(gateDb, tableName);
      const canonicalCols = columnSet(canonicalDb, tableName);

      // Both sets must be identical.
      expect(gateCols).toEqual(canonicalCols);
    },
  );

  it('messages table is intentionally absent from GATE_SCHEMA', () => {
    const db = createTestDb();
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).not.toContain('messages');
  });
});
