/**
 * Migration 105_tracker_provider_dart.sql — provider-CHECK widening tests.
 *
 * 105 recreates BOTH tracker tables (093's `provider` CHECK is column-level and
 * SQLite cannot ALTER one), so the interesting properties are not just "does
 * 'dart' insert" but everything a recreate can silently break. Runs the FULL
 * real migration chain via DatabaseService.initialize(), the same technique as
 * migration093.test.ts. Proves:
 *   1. 'dart' is now storable on both tracker_connections.provider and
 *      entity_external_links.provider, and an unknown provider is still rejected.
 *   2. The recreate preserved every column, in order, on both tables — the
 *      recreate reproduces 093+094's shape by hand, so a dropped or reordered
 *      column is the live hazard.
 *   3. Rows written before the widening survive it, and the FK/CASCADE topology
 *      the recreate had to drop and re-establish still holds (a deleted project
 *      still takes its connections, links, outbox and conflicts with it, and
 *      tracker_conflicts.link_id is still ON DELETE SET NULL rather than CASCADE).
 *   4. entity_external_links' AUTOINCREMENT high-water mark survived, so a post-
 *      migration insert cannot be handed a retired rowid.
 *   5. Both UNIQUE constraints on entity_external_links survived the recreate,
 *      including the one that now has to admit a third provider for one entity.
 *   6. Replay convergence: a ledger-wiped re-run of the whole directory is
 *      convergent — 105 has no idempotent-ALTER first statement, so it genuinely
 *      re-executes, and the copy being verbatim is what makes that safe.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration105-'));
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

describe('Migration 105: dart as a third tracker provider', () => {
  it("admits 'dart' on both provider columns and still rejects an unknown provider", () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');

    // The widened value, plus both originals — 105 must ADD, never replace.
    expect(() => insertConnection(raw, 'conn-dart', 'dart')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-linear', 'linear')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-plane', 'plane')).not.toThrow();
    expect(() => insertConnection(raw, 'conn-bad', 'jira')).toThrow(/CHECK/i);

    const insertLink = raw.prepare(
      `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() => insertLink.run('conn-dart', 'idea', 'ide_1', 'dart', 'AbCdEfGhIjKl')).not.toThrow();
    expect(() => insertLink.run('conn-dart', 'idea', 'ide_2', 'jira', 'X-1')).toThrow(/CHECK/i);

    // The other CHECKs on the recreated tables came across intact.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO tracker_connections (id, project_id, provider, status) VALUES ('conn-x', 1, 'dart', 'bogus')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() => insertLink.run('conn-dart', 'bogus', 'x_1', 'dart', 'Zz1122334455')).toThrow(/CHECK/i);
    raw.close();
  });

  it('the recreate preserved every column of both tables, in order', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    // 093's columns followed by 094's three direction modes — the exact order a
    // hand-written CREATE TABLE can silently get wrong.
    expect(columnNames(raw, 'tracker_connections')).toEqual([
      'id', 'project_id', 'provider', 'status', 'workspace_id', 'workspace_name',
      'actor_label', 'base_url', 'secret_ciphertext', 'source_json', 'selection_mode',
      'selection_json', 'state_mapping_json', 'two_way', 'mirror_subissues',
      'conflict_mode', 'cursor_updated_at', 'cursor_external_id', 'last_sync_at',
      'last_sync_log_json', 'created_at', 'updated_at', 'status_sync_mode',
      'pull_mode', 'push_mode',
      // Appended by 110 after the recreate — the full chain runs here, so the
      // later file's column is visible; asserted for real in migration110.test.ts.
      'push_target',
      // Appended by 112 (content/archive write-back modes + mapping
      // overlays) — asserted for real in migration118.test.ts.
      'content_sync_mode', 'archive_sync_mode', 'priority_mapping_json', 'category_mapping_json',
      // Appended by 129 (beads as a fourth provider + the reconciliation
      // ledger's generation counter) — asserted for real in migration123.test.ts.
      'config_generation',
      'status_sync_enabled',
    ]);
    expect(columnNames(raw, 'entity_external_links')).toEqual([
      'id', 'connection_id', 'entity_type', 'entity_id', 'provider', 'external_id',
      'external_identifier', 'external_url', 'external_parent_id', 'baseline_json',
      'orphaned_at', 'created_at', 'updated_at',
    ]);

    // The indexes 105 re-creates after each rename.
    const indexes = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('tracker_connections','entity_external_links')")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_tracker_connections_project');
    expect(indexes).toContain('idx_entity_external_links_conn');
    raw.close();
  });

  it('preserves pre-existing rows and the FK topology the recreate had to re-establish', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    insertConnection(raw, 'conn-1', 'linear');
    raw
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-1', 'idea', 'ide_1', 'linear', 'LIN-1')`,
      )
      .run();
    const linkId = raw
      .prepare("SELECT id FROM entity_external_links WHERE external_id = 'LIN-1'")
      .get() as { id: number };
    raw
      .prepare(
        `INSERT INTO tracker_conflicts (connection_id, link_id, kind) VALUES ('conn-1', ?, 'field_conflict')`,
      )
      .run(linkId.id);
    raw
      .prepare(
        `INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', 'create_issue')`,
      )
      .run();

    // link_id is ON DELETE SET NULL, not CASCADE: the conflict outlives its link.
    raw.prepare('DELETE FROM entity_external_links WHERE id = ?').run(linkId.id);
    expect(
      raw.prepare("SELECT link_id FROM tracker_conflicts WHERE connection_id = 'conn-1'").get(),
    ).toEqual({ link_id: null });

    // project_id is ON DELETE CASCADE, and it reaches the children transitively.
    raw.prepare('DELETE FROM projects WHERE id = 1').run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracker_conflicts').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracker_outbox').get()).toEqual({ n: 0 });
    raw.close();
  });

  it("carries entity_external_links' AUTOINCREMENT high-water mark across the recreate", () => {
    // The regression 105 guards against: rows minted before the migration whose
    // ids are then CASCADE-deleted leave a sequence mark higher than max(id) of
    // the survivors, and copying explicit ids alone would let it regress.
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    insertConnection(raw1, 'conn-1', 'linear');
    const insertLink = raw1.prepare(
      `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
       VALUES ('conn-1', 'idea', ?, 'linear', ?)`,
    );
    insertLink.run('ide_1', 'LIN-1');
    insertLink.run('ide_2', 'LIN-2');
    insertLink.run('ide_3', 'LIN-3');
    // Delete the newest two, so max(id) among survivors is 1 but the mark is 3.
    raw1.prepare("DELETE FROM entity_external_links WHERE external_id IN ('LIN-2','LIN-3')").run();
    const seqBefore = raw1
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entity_external_links'")
      .get() as { seq: number };
    expect(seqBefore.seq).toBe(3);
    raw1.close();

    // Force 105 to re-run over that state.
    const rawWipe = new Database(dbPath);
    rawWipe.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
    rawWipe.close();

    const svc2 = new DatabaseService(dbPath);
    svc2.initialize();
    const raw2 = svc2.getDb();
    expect(
      raw2.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entity_external_links'").get(),
    ).toEqual({ seq: 3 });
    // A fresh insert therefore gets 4, never a retired rowid.
    raw2
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-1', 'idea', 'ide_4', 'dart', 'AbCdEfGhIjKl')`,
      )
      .run();
    expect(
      raw2.prepare("SELECT id FROM entity_external_links WHERE external_id = 'AbCdEfGhIjKl'").get(),
    ).toEqual({ id: 4 });
    raw2.close();
  });

  it('keeps both UNIQUE constraints on entity_external_links, now across three providers', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    insertConnection(raw, 'conn-linear', 'linear');
    insertConnection(raw, 'conn-dart', 'dart');
    const insertLink = raw.prepare(
      `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
       VALUES (?, 'idea', ?, ?, ?)`,
    );
    insertLink.run('conn-linear', 'ide_1', 'linear', 'LIN-1');

    // One entity may link once PER PROVIDER — so the same idea can carry a Dart
    // link alongside its Linear one...
    expect(() => insertLink.run('conn-dart', 'ide_1', 'dart', 'AbCdEfGhIjKl')).not.toThrow();
    // ...but not twice for the same provider.
    expect(() => insertLink.run('conn-linear', 'ide_1', 'linear', 'LIN-9')).toThrow(/UNIQUE/i);
    // And one external issue maps to at most one entity per connection.
    expect(() => insertLink.run('conn-dart', 'ide_2', 'dart', 'AbCdEfGhIjKl')).toThrow(/UNIQUE/i);
    raw.close();
  });

  it('replay convergence: a ledger-wiped re-run preserves dart rows and the schema', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    insertConnection(raw1, 'conn-dart', 'dart');
    raw1
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-dart', 'idea', 'ide_1', 'dart', 'AbCdEfGhIjKl')`,
      )
      .run();
    const colsBefore = {
      tracker_connections: columnNames(raw1, 'tracker_connections'),
      entity_external_links: columnNames(raw1, 'entity_external_links'),
    };
    raw1.close();

    const rawWipe = new Database(dbPath);
    rawWipe.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
    rawWipe.close();

    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const raw2 = svc2.getDb();

    expect(raw2.prepare("SELECT id, provider FROM tracker_connections WHERE id = 'conn-dart'").get()).toEqual({
      id: 'conn-dart',
      provider: 'dart',
    });
    expect(
      raw2.prepare("SELECT entity_id, provider FROM entity_external_links WHERE external_id = 'AbCdEfGhIjKl'").get(),
    ).toEqual({ entity_id: 'ide_1', provider: 'dart' });
    expect(columnNames(raw2, 'tracker_connections')).toEqual(colsBefore.tracker_connections);
    expect(columnNames(raw2, 'entity_external_links')).toEqual(colsBefore.entity_external_links);
    // Still widened after the replay (the CHECK is not silently narrowed back).
    expect(() => insertConnection(raw2, 'conn-dart-2', 'dart')).not.toThrow();
    raw2.close();
  });
});
