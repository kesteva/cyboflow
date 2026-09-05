/**
 * Migration 129_tracker_provider_beads.sql — provider-CHECK widening to admit
 * 'beads', the `config_generation` counter, and the new
 * `tracker_reconciliation_ledger` table.
 *
 * Same technique as migration105.test.ts: runs the FULL real migration chain
 * via DatabaseService.initialize() (105's own recreate ran ahead of this one,
 * so the interesting properties here are what 129's SECOND recreate of the
 * same two tables preserves, plus the brand-new ledger table). Proves:
 *   1. 'beads' is now storable on both tracker_connections.provider and
 *      entity_external_links.provider, and an unknown provider is still
 *      rejected; 'linear'/'plane'/'dart' still work (105's widening survives
 *      a SECOND recreate).
 *   2. tracker_connections gains `config_generation`, NOT NULL DEFAULT 0 —
 *      every pre-existing row lands at 0, and every column from 093 through
 *      118 survives, in order.
 *   3. tracker_reconciliation_ledger exists with the exact shape the design
 *      calls for, its UNIQUE(connection_id, external_id) constraint holds,
 *      and its FK CASCADEs off tracker_connections like every other child
 *      table.
 *   4. Replay convergence: a ledger-wiped re-run of the whole directory does
 *      not throw, reproduces the same schema, and preserves every ROW —
 *      except `config_generation`'s pre-wipe VALUE, which does not survive
 *      (105's recreate runs first on replay, from a column list that
 *      predates this counter entirely, so it comes back only once 129 runs
 *      again — freshly at its DEFAULT). Same documented, accepted class of
 *      degradation migration110.test.ts pins for `push_target` and
 *      migration118.test.ts pins for `content_sync_mode`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration129-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function seedProject(raw: Database.Database, id: number, path: string): void {
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

function insertConnection(raw: Database.Database, id: string, provider: string): void {
  raw
    .prepare('INSERT INTO tracker_connections (id, project_id, provider) VALUES (?, 1, ?)')
    .run(id, provider);
}

describe('Migration 129: beads as a fourth tracker provider', () => {
  it("admits 'beads' on both provider columns, keeps the other three, and still rejects an unknown provider", () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');

    expect(() => insertConnection(raw, 'conn-beads', 'beads')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-linear', 'linear')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-plane', 'plane')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-dart', 'dart')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-bad', 'jira')).toThrow(/CHECK/i);

    const insertLink = raw.prepare(
      `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() => insertLink.run('conn-beads', 'idea', 'ide_1', 'beads', 'bd-a1b2')).not.toThrow();
    expect(() => insertLink.run('conn-beads', 'idea', 'ide_2', 'jira', 'X-1')).toThrow(/CHECK/i);
    raw.close();
  });

  it('tracker_connections gains config_generation (NOT NULL DEFAULT 0), and every prior column survives in order', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    insertConnection(raw, 'conn-1', 'beads');

    expect(
      raw.prepare("SELECT config_generation FROM tracker_connections WHERE id = 'conn-1'").get(),
    ).toEqual({ config_generation: 0 });

    expect(columnNames(raw, 'tracker_connections')).toEqual([
      'id', 'project_id', 'provider', 'status', 'workspace_id', 'workspace_name',
      'actor_label', 'base_url', 'secret_ciphertext', 'source_json', 'selection_mode',
      'selection_json', 'state_mapping_json', 'two_way', 'mirror_subissues',
      'conflict_mode', 'cursor_updated_at', 'cursor_external_id', 'last_sync_at',
      'last_sync_log_json', 'created_at', 'updated_at', 'status_sync_mode',
      'pull_mode', 'push_mode', 'push_target',
      'content_sync_mode', 'archive_sync_mode', 'priority_mapping_json', 'category_mapping_json',
      'config_generation',
      'status_sync_enabled',
    ]);

    // A pass can bump it explicitly (the reconciliation engine's own write).
    raw.prepare("UPDATE tracker_connections SET config_generation = 3 WHERE id = 'conn-1'").run();
    expect(
      raw.prepare("SELECT config_generation FROM tracker_connections WHERE id = 'conn-1'").get(),
    ).toEqual({ config_generation: 3 });

    const indexes = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('tracker_connections','entity_external_links')")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_tracker_connections_project');
    expect(indexes).toContain('idx_entity_external_links_conn');
    raw.close();
  });

  it('creates tracker_reconciliation_ledger with the designed shape, UNIQUE key, and CASCADE off tracker_connections', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    insertConnection(raw, 'conn-1', 'beads');

    expect(columnNames(raw, 'tracker_reconciliation_ledger')).toEqual([
      'id', 'connection_id', 'external_id', 'reason', 'last_seen_revision',
      'config_generation', 'seen_at',
    ]);

    const insertLedgerRow = raw.prepare(
      `INSERT INTO tracker_reconciliation_ledger
         (connection_id, external_id, reason, last_seen_revision, config_generation)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() => insertLedgerRow.run('conn-1', 'bd-a1b2', 'excluded-type', 'sha256:abc', 0)).not.toThrow();
    // UNIQUE(connection_id, external_id) — a second row for the same pair is
    // an upsert target, not a valid second INSERT.
    expect(() => insertLedgerRow.run('conn-1', 'bd-a1b2', 'still-excluded', 'sha256:def', 0)).toThrow(
      /UNIQUE/i,
    );
    // last_seen_revision may be NULL (a skip with no revision known yet).
    expect(() =>
      insertLedgerRow.run('conn-1', 'bd-c3d4', 'excluded-type', null, 0),
    ).not.toThrow();

    // FK CASCADE off tracker_connections, matching every other child table.
    raw.prepare("DELETE FROM tracker_connections WHERE id = 'conn-1'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracker_reconciliation_ledger').get()).toEqual({
      n: 0,
    });
    raw.close();
  });

  it('replay convergence: a ledger-wiped re-run preserves beads rows, config_generation, and the ledger table', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    insertConnection(raw1, 'conn-beads', 'beads');
    raw1.prepare("UPDATE tracker_connections SET config_generation = 2 WHERE id = 'conn-beads'").run();
    raw1
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-beads', 'idea', 'ide_1', 'beads', 'bd-a1b2')`,
      )
      .run();
    raw1
      .prepare(
        `INSERT INTO tracker_reconciliation_ledger (connection_id, external_id, reason, config_generation)
         VALUES ('conn-beads', 'bd-c3d4', 'excluded-type', 2)`,
      )
      .run();
    raw1.close();

    const rawWipe = new Database(dbPath);
    rawWipe.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
    rawWipe.close();

    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const raw2 = svc2.getDb();

    // config_generation's VALUE does not survive a full replay — the same
    // documented, accepted degradation migration110.test.ts pins for
    // push_target and migration118.test.ts pins for content_sync_mode: 105's
    // recreate runs FIRST on replay, from a hardcoded column list that
    // predates config_generation entirely, so the column comes back only
    // once 129 runs again later in the SAME replay pass — freshly added at
    // its DEFAULT, not carrying the pre-wipe value forward. The COLUMN and
    // its constraint survive; only a mid-chain value set before the wipe does
    // not.
    expect(
      raw2.prepare("SELECT id, provider, config_generation FROM tracker_connections WHERE id = 'conn-beads'").get(),
    ).toEqual({ id: 'conn-beads', provider: 'beads', config_generation: 0 });
    expect(
      raw2.prepare("SELECT entity_id, provider FROM entity_external_links WHERE external_id = 'bd-a1b2'").get(),
    ).toEqual({ entity_id: 'ide_1', provider: 'beads' });

    // The ledger table is `CREATE TABLE IF NOT EXISTS` (093's convention for a
    // brand-new table — see the migration's REPLAY SAFETY note), so a replay
    // is a true no-op on it: the row written before the wipe survives.
    expect(
      raw2.prepare("SELECT connection_id, external_id, config_generation FROM tracker_reconciliation_ledger WHERE external_id = 'bd-c3d4'").get(),
    ).toEqual({ connection_id: 'conn-beads', external_id: 'bd-c3d4', config_generation: 2 });
    expect(columnNames(raw2, 'tracker_reconciliation_ledger')).toEqual([
      'id', 'connection_id', 'external_id', 'reason', 'last_seen_revision',
      'config_generation', 'seen_at',
    ]);

    // Still widened after the replay.
    expect(() => insertConnection(raw2, 'conn-beads-2', 'beads')).not.toThrow();
    raw2.close();
  });
});
