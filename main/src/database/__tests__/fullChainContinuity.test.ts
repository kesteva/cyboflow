/**
 * FULL-CHAIN migration continuity test (B8 cross-cutting).
 *
 * A fresh temp-file DB run through the real DatabaseService.initialize()
 * (schema.sql + every NNN_*.sql migration, in order) must:
 *   1. stamp PRAGMA user_version to the highest migration prefix on disk, and
 *   2. leave the latest migrations' columns actually present.
 *
 * This catches an ordering / FK-dependent migration that passes its own
 * per-migration test in isolation but breaks when the real predecessor chain
 * runs ahead of it. The expected user_version is computed FROM the migrations
 * directory (not hardcoded) so adding a migration doesn't silently rot this
 * test — but we also assert it is at LEAST 44 (the highest prefix that existed
 * when this test was written) as a floor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** Highest NNN_ prefix among the real migration files. */
function highestMigrationPrefix(): number {
  const re = /^(\d{3})_.*\.sql$/;
  let max = 0;
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const m = re.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-fullchain-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('Full-chain migration continuity', () => {
  it('stamps user_version to the highest migration prefix on a fresh initialize()', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();

    const raw = svc.getDb();
    const userVersion = raw.pragma('user_version', { simple: true }) as number;
    const appMax = highestMigrationPrefix();

    expect(userVersion).toBe(appMax);
    // Floor guard: this test was written against migration 044.
    expect(userVersion).toBeGreaterThanOrEqual(44);
    raw.close();
  });

  it('materializes the latest migrations’ columns after the whole chain runs', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    // 044_workflow_run_eval_enabled + 043_run_evals + 037/032/013 stamp columns
    // on workflow_runs — a representative sampling from the tail of the chain.
    const wrCols = columnNames(raw, 'workflow_runs');
    expect(wrCols).toContain('eval_enabled'); // 044
    expect(wrCols).toContain('execution_model'); // 032
    expect(wrCols).toContain('substrate'); // 013

    // 043 creates the run_evals table.
    const runEvals = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_evals'")
      .get();
    expect(runEvals).toBeDefined();

    // 029 + 038 build agent_overrides and its per-agent MCP column.
    expect(columnNames(raw, 'agent_overrides')).toContain('enabled_mcps_json'); // 038

    // 039 adds the per-session plugin/MCP toggle columns.
    const sessCols = columnNames(raw, 'sessions');
    expect(sessCols).toContain('disabled_mcp_servers_json'); // 039
    expect(sessCols).toContain('enabled_plugins_json'); // 039

    raw.close();
  });

  it('re-initializing the same DB is idempotent and keeps user_version stable', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const v1 = svc1.getDb().pragma('user_version', { simple: true }) as number;
    svc1.getDb().close();

    // Second open over the SAME file: every migration is ledger-skipped.
    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const v2 = svc2.getDb().pragma('user_version', { simple: true }) as number;
    expect(v2).toBe(v1);
    svc2.getDb().close();
  });
});
