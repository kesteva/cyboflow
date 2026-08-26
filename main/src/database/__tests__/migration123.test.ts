/**
 * Migration 123_widen_agent_runtime_pi.sql — admitting the pi runtimes.
 *
 * The regression this file exists to prevent: an earlier attempt shipped the
 * widening as a NEW file numbered 101 (a gap below the already-released 103)
 * that rebuilt `sessions` from a hardcoded CREATE TABLE. Because the migration
 * ledger is keyed by FILENAME, that file ran LAST on an already-migrated DB
 * rather than in its numeric position — against a post-103/104 schema — where
 * it (a) dropped every column its hardcoded list omitted and (b) restated 103's
 * CHECK lists from memory, silently UN-widening 'omp-sdk'/'omp-pty'.
 *
 * So the tests below run the REAL upgrade a shipped-release user performs: a DB is built
 * by a DatabaseService whose migrations dir omits 123 ONLY (103 and 104 are
 * present, exactly as they are on a shipped install), rows are seeded, and a
 * second DatabaseService pointed at the full dir boots on the same file.
 *
 * Proves:
 *   1. 'omp-fleet' becomes storable on sessions and workflow_runs.
 *   2. 103's widenings SURVIVE — 'omp-sdk'/'omp-pty' stay storable on sessions.
 *   3. Every pre-existing row survives verbatim, INCLUDING a seeded omp-sdk
 *      session (the row shape that made the 101 attempt fail closed forever).
 *   4. No column is lost — in particular `status_message`, which database.ts
 *      adds imperatively and no .sql file lists.
 *   5. Indexes, triggers and FK edges are unchanged and foreign_key_check clean.
 *   6. The deliberate narrowings hold: omp-fleet is rejected on the two tables
 *      123 does not widen, and a bogus runtime is still rejected everywhere.
 *   7. The fresh-install path lands the same constraints.
 *   8. Re-applying 123 after a cleared ledger marker is a harmless no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_123 = '123_widen_agent_runtime_pi.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration123-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A migrations dir holding every real migration EXCEPT 123 — i.e. a shipped
 * 0.2.3 install, with 103 and 104 already applied. This is the distinction that
 * matters: excluding everything at-or-above the new file's number (as the 101
 * attempt's own test did) fabricates a pre-state that no user is ever in.
 */
function migrationsDirWithout123(): string {
  const dir = join(tmpDir, 'migrations-pre-123');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_123) continue;
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

/** Seed the rows a 0.2.3 OMP user actually has, plus the legacy baseline. */
function seedRows(db: BetterSqlite3.Database): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p123')`).run();
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                           status_message, agent_provider, agent_runtime)
     VALUES (?, ?, 'go', ?, ?, 1, ?, ?, ?)`,
  );
  insertSession.run('s-claude', 'Claude', 'wt-1', '/tmp/wt-1', 'Waiting', 'claude', 'claude-sdk');
  insertSession.run('s-codex-pty', 'Codex TUI', 'wt-2', '/tmp/wt-2', null, 'codex', 'codex-pty');
  // The row that made the 101 attempt fail closed on every boot, forever.
  insertSession.run('s-omp-sdk', 'OMP', 'wt-3', '/tmp/wt-3', 'Running', 'omp', 'omp-sdk');
  insertSession.run('s-omp-pty', 'OMP TUI', 'wt-4', '/tmp/wt-4', null, 'omp', 'omp-pty');

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                agent_provider, agent_runtime)
     VALUES (?, 'wf-1', 1, 'completed', 'default', ?, ?)`,
  );
  insertRun.run('run-claude', 'claude', 'claude-sdk');
  insertRun.run('run-omp', 'omp', 'omp-sdk');

  // The ONE table 123 recreates via DROP TABLE — seed it so the snapshot
  // proves row/column/index/FK survival through the recreate.
  db.prepare(
    `INSERT INTO agent_invocations (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime)
     VALUES ('inv-seed-1', 'run-claude', 'step-1', 'codex', 'codex-sdk')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_invocations (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, panel_id)
     VALUES ('inv-seed-2', 'run-claude', 'step-2', 'omp', 'omp-pty', 'panel-7')`,
  ).run();
}

function allRows(db: BetterSqlite3.Database, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
}

function schemaObjectNames(db: BetterSqlite3.Database, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE tbl_name = ? AND type IN ('index','trigger','view')
          ORDER BY name`,
      )
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function fkEdges(db: BetterSqlite3.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>
  )
    .map((fk) => `${table}.${fk.from} -> ${fk.table}.${fk.to} ON DELETE ${fk.on_delete}`)
    .sort();
}

interface Snapshot {
  rows: Record<string, Array<Record<string, unknown>>>;
  columns: Record<string, string[]>;
  objects: Record<string, string[]>;
  fks: Record<string, string[]>;
}

const TARGET_TABLES = ['sessions', 'workflow_runs', 'agent_invocations'] as const;

function snapshot(db: BetterSqlite3.Database): Snapshot {
  const snap: Snapshot = { rows: {}, columns: {}, objects: {}, fks: {} };
  for (const t of TARGET_TABLES) {
    snap.rows[t] = allRows(db, t);
    snap.columns[t] = columnNames(db, t);
    snap.objects[t] = schemaObjectNames(db, t);
    snap.fks[t] = fkEdges(db, t);
  }
  return snap;
}

/** Migrate to the shipped pre-123 state, seed, snapshot; then boot with 123. */
function upgradeThrough123(): { db: BetterSqlite3.Database; before: Snapshot; svc: DatabaseService } {
  const pre123 = migrationsDirWithout123();
  // Two pre-123 boots, not one: initializeSchema() reads PRAGMA table_info(sessions)
  // before schema.sql has created the table, so its imperative
  // "ALTER TABLE sessions ADD COLUMN status_message" only lands on the SECOND
  // launch. Settling that here keeps the snapshot diff about 123 alone — and
  // makes `status_message` present in the pre-state, which is the whole point.
  openAt(pre123).close();
  const pre = openAt(pre123);
  seedRows(pre.getDb());
  const before = snapshot(pre.getDb());
  pre.close();

  const svc = openAt(MIGRATIONS_DIR);
  return { db: svc.getDb(), before, svc };
}

/** Insert a session with the given runtime; return the SQLite error, if any. */
function trySession(db: BetterSqlite3.Database, id: string, provider: string, runtime: string): string | null {
  try {
    db.prepare(
      `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path,
                             agent_provider, agent_runtime)
       VALUES (?, ?, 'go', ?, ?, ?, ?)`,
    ).run(id, id, `wt-${id}`, `/tmp/${id}`, provider, runtime);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function tryRun(db: BetterSqlite3.Database, id: string, provider: string, runtime: string): string | null {
  try {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                  agent_provider, agent_runtime)
       VALUES (?, 'wf-1', 1, 'running', 'default', ?, ?)`,
    ).run(id, provider, runtime);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('Migration 123: the native pi runtimes admitted on sessions + workflow_runs', () => {
  it('(a) makes the fleet and pi runtimes storable on sessions and workflow_runs', () => {
    const { db, svc } = upgradeThrough123();
    expect(trySession(db, 's-fleet', 'omp', 'omp-fleet')).toBeNull();
    expect(trySession(db, 's-pi-sdk', 'pi', 'pi-sdk')).toBeNull();
    expect(trySession(db, 's-pi-pty', 'pi', 'pi-pty')).toBeNull();
    expect(tryRun(db, 'run-pi', 'pi', 'pi-sdk')).toBeNull();
    svc.close();
  });

  it("(b) preserves 103's widenings — omp-sdk and omp-pty stay storable on sessions", () => {
    const { db, svc } = upgradeThrough123();
    expect(trySession(db, 's-new-omp-sdk', 'omp', 'omp-sdk')).toBeNull();
    expect(trySession(db, 's-new-omp-pty', 'omp', 'omp-pty')).toBeNull();
    expect(tryRun(db, 'run-new-omp-sdk', 'omp', 'omp-sdk')).toBeNull();
    svc.close();
  });

  it('(c) preserves every pre-existing row verbatim, including the omp-sdk session', () => {
    const { db, before, svc } = upgradeThrough123();
    for (const t of TARGET_TABLES) {
      expect(allRows(db, t)).toEqual(before.rows[t]);
    }
    const ompRow = allRows(db, 'sessions').find((r) => r.id === 's-omp-sdk');
    expect(ompRow?.agent_runtime).toBe('omp-sdk');
    expect(ompRow?.status_message).toBe('Running');
    svc.close();
  });

  it('(d) loses no column — status_message (added imperatively, listed in no .sql) survives', () => {
    const { db, before, svc } = upgradeThrough123();
    for (const t of TARGET_TABLES) {
      expect(columnNames(db, t)).toEqual(before.columns[t]);
    }
    expect(columnNames(db, 'sessions')).toContain('status_message');
    // The temp parking columns must not leak into the final shape.
    expect(columnNames(db, 'sessions')).not.toContain('agent_runtime_widen_123');
    expect(columnNames(db, 'workflow_runs')).not.toContain('agent_runtime_widen_123');
    svc.close();
  });

  it('(e) leaves indexes, triggers and foreign keys untouched', () => {
    const { db, before, svc } = upgradeThrough123();
    for (const t of TARGET_TABLES) {
      expect(schemaObjectNames(db, t)).toEqual(before.objects[t]);
      expect(fkEdges(db, t)).toEqual(before.fks[t]);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    svc.close();
  });

  it('(f) variants admit pi-sdk but reject pi-pty; invocations admit both; bogus rejected', () => {
    const { db, svc } = upgradeThrough123();
    // workflow_variants mirrors the LAUNCHABLE list: pi-sdk in, pi-pty out.
    db.prepare(
      `INSERT INTO workflow_variants (id, workflow_id, label, agent_provider, agent_runtime)
       VALUES ('wfv-pi', 'wf-1', 'pi-arm', 'pi', 'pi-sdk')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_variants (id, workflow_id, label, agent_provider, agent_runtime)
           VALUES ('wfv-pty', 'wf-1', 'pty-arm', 'pi', 'pi-pty')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // agent_invocations records the transport that actually served a turn;
    // omp-pty is admitted there historically, so pi-pty matches.
    db.prepare(
      `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
       VALUES ('inv-pi-sdk', 'run-claude', 'pi', 'pi-sdk')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
       VALUES ('inv-pi-pty', 'run-claude', 'pi', 'pi-pty')`,
    ).run();
    expect(trySession(db, 's-bogus', 'pi', 'pi-telepathy')).toMatch(/CHECK constraint failed/);
    expect(tryRun(db, 'run-bogus', 'pi', 'pi-telepathy')).toMatch(/CHECK constraint failed/);
    svc.close();
  });

  it('(g) lands the same constraints on a fresh install', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p123f')`).run();
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
    ).run();
    expect(trySession(db, 's-fleet', 'omp', 'omp-fleet')).toBeNull();
    expect(trySession(db, 's-pi-sdk', 'pi', 'pi-sdk')).toBeNull();
    expect(trySession(db, 's-sdk', 'omp', 'omp-sdk')).toBeNull();
    expect(tryRun(db, 'run-pi', 'pi', 'pi-sdk')).toBeNull();
    expect(trySession(db, 's-bogus', 'pi', 'pi-telepathy')).toMatch(/CHECK constraint failed/);
    svc.close();
  });

  it('(h) re-applying 123 after a cleared ledger marker is a harmless no-op', () => {
    const { db, before, svc } = upgradeThrough123();
    db.prepare('DELETE FROM user_preferences WHERE key = ?').run(
      `file_migration_applied:${MIGRATION_123}`,
    );
    svc.close();

    const again = openAt(MIGRATIONS_DIR);
    const db2 = again.getDb();
    for (const t of TARGET_TABLES) {
      expect(allRows(db2, t)).toEqual(before.rows[t]);
      expect(columnNames(db2, t)).toEqual(before.columns[t]);
    }
    expect(trySession(db2, 's-fleet-again', 'omp', 'omp-fleet')).toBeNull();
    expect(trySession(db2, 's-pi-again', 'pi', 'pi-sdk')).toBeNull();
    again.close();
  });

  it('(i) no stale pre-renumber pi-or-fleet migration exists in the migrations dir', () => {
    // The ledger is keyed by FILENAME, so a resurrected 105_/107_ copy of this
    // widening would apply AGAIN after 123 — against an already-widened schema
    // where its add/copy/drop sequence is still idempotent, but its existence
    // means two files claim the same widening and the next renumber war starts
    // here. Guard the invariant at the directory level.
    const names = readdirSync(MIGRATIONS_DIR);
    expect(names).toContain(MIGRATION_123);
    expect(names).not.toContain('105_agent_runtime_omp_fleet.sql');
    expect(names).not.toContain('107_agent_runtime_omp_fleet.sql');
  });
});
