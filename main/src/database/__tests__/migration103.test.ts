/**
 * Migration 103_widen_provider_checks.sql — provider/runtime CHECK widening.
 *
 * Exercises the REAL upgrade path rather than an isolated `db.exec(file)`: a DB
 * is migrated to 102 by a DatabaseService whose migrations dir omits 103, rows
 * are seeded into all four affected tables, and then a second DatabaseService
 * pointed at the full migrations dir boots on the same file — which is exactly
 * what happens when a user updates the app. That routes 103 through the real
 * runner, including its PRAGMA foreign_keys=OFF handling and its wrapping
 * transaction.
 *
 * Proves:
 *   1. Every pre-existing row survives the widening verbatim.
 *   2. PRAGMA foreign_key_check is clean and each table's FK edges are unchanged
 *      — including the 21 children that reference workflow_runs.
 *   3. Each table's index/trigger set is unchanged (name lists from sqlite_master).
 *   4. 'omp' / 'omp-sdk' (and 'omp-pty' where the design allows it) are now
 *      storable on every table, while a bogus value is still rejected.
 *   5. The deliberate narrowings survive: omp-pty is rejected on workflow_runs
 *      and workflow_variants exactly as codex-pty already is.
 *   6. agent_invocations' NOT-NULL-without-default semantics survive its rebuild
 *      (an omitted provider must still fail, not silently become 'claude'), as
 *      does its AUTOINCREMENT high-water mark.
 *   7. The fresh-install path lands the same widened constraints.
 *   8. Re-applying 103 after its ledger marker is cleared is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_103 = '103_widen_provider_checks.sql';
const TARGET_TABLES = ['sessions', 'workflow_runs', 'workflow_variants', 'agent_invocations'] as const;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration103-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 103 — i.e. the pre-103 app. */
function migrationsDirWithout103(): string {
  const dir = join(tmpDir, 'migrations-pre-103');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_103) continue;
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

/** Rows to seed, one per legal pre-103 provider/runtime combination we care about. */
function seedLegacyRows(db: BetterSqlite3.Database): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p103')`).run();
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                           agent_provider, agent_runtime)
     VALUES (?, ?, 'go', ?, ?, 1, ?, ?)`,
  );
  insertSession.run('s-claude', 'Claude session', 'wt-1', '/tmp/wt-1', 'claude', 'claude-sdk');
  insertSession.run('s-codex-pty', 'Codex TUI session', 'wt-2', '/tmp/wt-2', 'codex', 'codex-pty');

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                agent_provider, agent_runtime)
     VALUES (?, 'wf-1', 1, 'completed', 'default', ?, ?)`,
  );
  insertRun.run('run-claude', 'claude', 'claude-sdk');
  insertRun.run('run-codex', 'codex', 'codex-sdk');

  const insertVariant = db.prepare(
    `INSERT INTO workflow_variants (id, workflow_id, label, agent_provider, agent_runtime)
     VALUES (?, 'wf-1', ?, ?, ?)`,
  );
  insertVariant.run('wfv-pinned', 'codex-arm', 'codex', 'codex-sdk');
  // NULL = inherit the launch default; the IS NULL arm of the CHECK must survive.
  insertVariant.run('wfv-inherit', 'baseline-arm', null, null);

  const insertInvocation = db.prepare(
    `INSERT INTO agent_invocations (agent_invocation_id, run_id, step_id, agent_provider,
                                    agent_runtime, model, external_session_id, panel_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertInvocation.run('inv-claude', 'run-claude', 'implement', 'claude', 'claude-sdk', 'opus', 'sess-abc', null);
  insertInvocation.run('inv-codex', 'run-codex', null, 'codex', 'codex-sdk', 'gpt-5', 'thread-1', 'panel-1');
}

function allRows(db: BetterSqlite3.Database, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

/** Index + trigger names sqlite_master carries for a table, sorted. */
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

/** Every FK edge in the DB that points AT one of the rebuilt/altered tables. */
function inboundFkEdges(db: BetterSqlite3.Database): string[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  const edges: string[] = [];
  for (const t of tables) {
    for (const edge of fkEdges(db, t)) {
      if (TARGET_TABLES.some((target) => edge.includes(`-> ${target}.`))) edges.push(edge);
    }
  }
  return edges.sort();
}

interface Snapshot {
  rows: Record<string, Array<Record<string, unknown>>>;
  objects: Record<string, string[]>;
  fks: Record<string, string[]>;
  inbound: string[];
}

function snapshot(db: BetterSqlite3.Database): Snapshot {
  const rows: Snapshot['rows'] = {};
  const objects: Snapshot['objects'] = {};
  const fks: Snapshot['fks'] = {};
  for (const t of TARGET_TABLES) {
    rows[t] = allRows(db, t);
    objects[t] = schemaObjectNames(db, t);
    fks[t] = fkEdges(db, t);
  }
  return { rows, objects, fks, inbound: inboundFkEdges(db) };
}

/** Migrate to 102, seed, snapshot; then boot with 103 and hand back both. */
function upgradeThrough103(): { db: BetterSqlite3.Database; before: Snapshot; svc: DatabaseService } {
  const pre103 = migrationsDirWithout103();
  // Two pre-103 boots, not one: initializeSchema() reads PRAGMA table_info(sessions)
  // before schema.sql has created the table, so its imperative
  // "ALTER TABLE sessions ADD COLUMN status_message" only lands on the SECOND
  // launch. Settling that here keeps the snapshot diff about 103 alone.
  openAt(pre103).close();
  const pre = openAt(pre103);
  seedLegacyRows(pre.getDb());
  const before = snapshot(pre.getDb());
  pre.close();

  const svc = openAt(MIGRATIONS_DIR);
  return { db: svc.getDb(), before, svc };
}

describe('Migration 103: widened provider/runtime CHECK constraints', () => {
  it('(a) preserves every pre-existing row across the widening', () => {
    const { db, before, svc } = upgradeThrough103();
    for (const t of TARGET_TABLES) {
      expect(allRows(db, t)).toEqual(before.rows[t]);
    }
    svc.close();
  });

  it('(b) leaves foreign keys intact — clean check, unchanged edges in both directions', () => {
    const { db, before, svc } = upgradeThrough103();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    for (const t of TARGET_TABLES) {
      expect(fkEdges(db, t)).toEqual(before.fks[t]);
    }
    // The 21 tables that reference workflow_runs (plus sessions' five children)
    // must still point at the real tables after the agent_invocations rename.
    expect(inboundFkEdges(db)).toEqual(before.inbound);
    expect(before.inbound.length).toBeGreaterThan(20);
    svc.close();
  });

  it('(c) leaves each table index/trigger set unchanged', () => {
    const { db, before, svc } = upgradeThrough103();
    for (const t of TARGET_TABLES) {
      expect(schemaObjectNames(db, t)).toEqual(before.objects[t]);
    }
    svc.close();
  });

  it('(d) accepts omp values on every table and still rejects a bogus one', () => {
    const { db, svc } = upgradeThrough103();

    // sessions: all three OMP runtimes — the two OMP transports PLUS the fleet
    // supervisor carried forward from 101 (a dropped 'omp-fleet' in 103's
    // re-add would brick every upgraded fleet session).
    for (const runtime of ['omp-sdk', 'omp-pty', 'omp-fleet']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                                   agent_provider, agent_runtime)
             VALUES (?, 'OMP', 'go', ?, ?, 1, 'omp', ?)`,
          )
          .run(`s-${runtime}`, `wt-${runtime}`, `/tmp/wt-${runtime}`, runtime),
      ).not.toThrow();
    }
    expect(() =>
      db
        .prepare(
          `UPDATE sessions SET agent_provider = 'nonsense' WHERE id = 's-claude'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    // workflow_runs: omp-sdk only — PLUS 'omp-fleet', never a launch target but
    // the storable identity of a fleet quick session's sentinel row.
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                      agent_provider, agent_runtime)
           VALUES ('run-omp', 'wf-1', 1, 'running', 'default', 'omp', 'omp-sdk')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                     agent_provider, agent_runtime)
           VALUES ('run-fleet', 'wf-1', 1, 'running', 'default', 'omp', 'omp-fleet')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(`UPDATE workflow_runs SET agent_runtime = 'nonsense' WHERE id = 'run-omp'`).run(),
    ).toThrow(/CHECK constraint failed/i);

    // workflow_variants: the columns workflowRegistry.updateVariant writes.
    expect(() =>
      db
        .prepare(
          `UPDATE workflow_variants SET agent_provider = 'omp', agent_runtime = 'omp-sdk'
            WHERE id = 'wfv-inherit'`,
        )
        .run(),
    ).not.toThrow();
    expect(
      db.prepare(`SELECT agent_provider, agent_runtime FROM workflow_variants WHERE id = 'wfv-inherit'`).get(),
    ).toEqual({ agent_provider: 'omp', agent_runtime: 'omp-sdk' });
    expect(() =>
      db.prepare(`UPDATE workflow_variants SET agent_provider = 'nonsense' WHERE id = 'wfv-inherit'`).run(),
    ).toThrow(/CHECK constraint failed/i);
    // The IS NULL arm survives: clearing a pin is still legal.
    expect(() =>
      db
        .prepare(
          `UPDATE workflow_variants SET agent_provider = NULL, agent_runtime = NULL WHERE id = 'wfv-inherit'`,
        )
        .run(),
    ).not.toThrow();

    // agent_invocations: both OMP runtimes (§9 wants a PTY turn representable).
    for (const runtime of ['omp-sdk', 'omp-pty']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
             VALUES (?, 'run-claude', 'omp', ?)`,
          )
          .run(`inv-${runtime}`, runtime),
      ).not.toThrow();
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
           VALUES ('inv-bad', 'run-claude', 'nonsense', 'omp-sdk')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(e) keeps omp-pty off workflow runs and variants, mirroring codex-pty', () => {
    const { db, svc } = upgradeThrough103();
    expect(() =>
      db.prepare(`UPDATE workflow_runs SET agent_runtime = 'omp-pty' WHERE id = 'run-claude'`).run(),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db.prepare(`UPDATE workflow_variants SET agent_runtime = 'omp-pty' WHERE id = 'wfv-pinned'`).run(),
    ).toThrow(/CHECK constraint failed/i);
    svc.close();
  });

  it('(f) preserves column defaults and NOT NULL semantics across the rewrite', () => {
    const { db, svc } = upgradeThrough103();

    // sessions/workflow_runs keep their claude defaults for callers that omit the columns.
    db.prepare(
      `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id)
       VALUES ('s-default', 'Defaults', 'go', 'wt-d', '/tmp/wt-d', 1)`,
    ).run();
    expect(db.prepare(`SELECT agent_provider, agent_runtime FROM sessions WHERE id = 's-default'`).get()).toEqual({
      agent_provider: 'claude',
      agent_runtime: 'claude-sdk',
    });

    // agent_invocations was rebuilt, NOT re-ALTERed: its columns must still be
    // NOT NULL with NO default, so an omitted provider fails loudly rather than
    // silently becoming 'claude'.
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_runtime)
           VALUES ('inv-nodefault', 'run-claude', 'omp-sdk')`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/i);

    svc.close();
  });

  it("(g) carries agent_invocations' AUTOINCREMENT high-water mark across the rebuild", () => {
    const pre103 = migrationsDirWithout103();
    openAt(pre103).close();
    const pre = openAt(pre103);
    seedLegacyRows(pre.getDb());
    // Retire the newest invocation so the surviving max(id) is BELOW the mark —
    // the shape a CASCADE-deleted run leaves behind.
    pre.getDb().prepare(`DELETE FROM agent_invocations WHERE agent_invocation_id = 'inv-codex'`).run();
    const markBefore = pre
      .getDb()
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'agent_invocations'`)
      .get() as { seq: number };
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    expect(db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'agent_invocations'`).get()).toEqual(
      markBefore,
    );
    // The retired rowid is not reused.
    db.prepare(
      `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
       VALUES ('inv-next', 'run-claude', 'omp', 'omp-sdk')`,
    ).run();
    const next = db
      .prepare(`SELECT id FROM agent_invocations WHERE agent_invocation_id = 'inv-next'`)
      .get() as { id: number };
    expect(next.id).toBeGreaterThan(markBefore.seq);
    svc.close();
  });

  it('(h) the fresh-install path lands the same widened constraints', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p103-fresh')`).run();
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id,
                                 agent_provider, agent_runtime)
           VALUES ('s-fresh', 'OMP', 'go', 'wt-f', '/tmp/wt-f', 1, 'omp', 'omp-pty')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot,
                                      agent_provider, agent_runtime)
           VALUES ('run-fresh', 'wf-1', 1, 'running', 'default', 'omp', 'omp-sdk')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_variants (id, workflow_id, label, agent_provider, agent_runtime)
           VALUES ('wfv-fresh', 'wf-1', 'omp-arm', 'omp', 'omp-sdk')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
           VALUES ('inv-fresh', 'run-fresh', 'omp', 'omp-pty')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
           VALUES ('inv-fresh-bad', 'run-fresh', 'omp', 'nonsense')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(i) re-applying 103 after a cleared ledger marker is a harmless no-op', () => {
    const { db, before, svc } = upgradeThrough103();
    db.prepare(`DELETE FROM user_preferences WHERE key = ?`).run(`file_migration_applied:${MIGRATION_103}`);
    svc.close();

    const again = openAt(MIGRATIONS_DIR);
    const raw = again.getDb();
    for (const t of TARGET_TABLES) {
      expect(allRows(raw, t)).toEqual(before.rows[t]);
      expect(schemaObjectNames(raw, t)).toEqual(before.objects[t]);
    }
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_provider, agent_runtime)
           VALUES ('inv-replay', 'run-claude', 'omp', 'omp-sdk')`,
        )
        .run(),
    ).not.toThrow();
    again.close();
  });
});
