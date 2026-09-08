/**
 * Migration 093_tracker_sync.sql — schema + constraint + replay tests.
 *
 * Runs the FULL real migration chain via DatabaseService.initialize() (a
 * fresh temp-file DB, same technique as fullChainContinuity.test.ts and
 * migration089.test.ts test (f)) rather than hand-picking a file subset,
 * since 093 has no interesting predecessor-chain interaction beyond "015
 * created task_external_links, 093 drops it" — the full chain exercises that
 * for free. Proves:
 *   1. The four new tables (tracker_connections, entity_external_links,
 *      tracker_outbox, tracker_conflicts) exist with the spec'd columns.
 *   2. task_external_links (mig 014/015) is gone.
 *   3. CHECK / UNIQUE / FK constraints from docs/proposals/
 *      tracker-sync-integration.md "Data model" hold.
 *   4. tracker_conflicts.link_id is ON DELETE SET NULL (survives its link
 *      being removed); tracker_connections.project_id is ON DELETE CASCADE
 *      (a deleted project takes its connections, and transitively their
 *      outbox/links/conflicts rows, with it).
 *   5. Replay convergence: a ledger-wiped re-run of the whole migrations
 *      directory (the same technique cyboflowSchema.test.ts's
 *      "existing-install" describe block uses) is a true no-op — no thrown
 *      error, no data loss, task_external_links does not reappear. This is
 *      the load-bearing property behind 093's IF-NOT-EXISTS / IF-EXISTS
 *      choice (see the migration file's header): a bare first-statement
 *      CREATE TABLE would hit "table already exists" on replay, which the
 *      runner's duplicate-column tolerance does NOT cover.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration093-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function tableExists(raw: Database.Database, table: string): boolean {
  return (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  );
}

function seedProject(raw: Database.Database, id: number, path: string): void {
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

describe('Migration 093: tracker-sync data model', () => {
  it('creates the four tracker tables with the spec columns and drops task_external_links', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    for (const t of ['tracker_connections', 'entity_external_links', 'tracker_outbox', 'tracker_conflicts']) {
      expect(tableExists(raw, t), `${t} should exist`).toBe(true);
    }
    expect(tableExists(raw, 'task_external_links'), 'task_external_links should be dropped').toBe(false);

    expect(columnNames(raw, 'tracker_connections')).toEqual([
      'id',
      'project_id',
      'provider',
      'status',
      'workspace_id',
      'workspace_name',
      'actor_label',
      'base_url',
      'secret_ciphertext',
      'source_json',
      'selection_mode',
      'selection_json',
      'state_mapping_json',
      'two_way',
      'mirror_subissues',
      'conflict_mode',
      'cursor_updated_at',
      'cursor_external_id',
      'last_sync_at',
      'last_sync_log_json',
      'created_at',
      'updated_at',
      // Appended by 094 (the per-direction modes). This suite runs the FULL
      // migration chain, so it necessarily sees the later file's columns; they
      // are asserted for real in migration094.test.ts.
      'status_sync_mode',
      'pull_mode',
      'push_mode',
      // Appended by 110 (multi-project mapping's per-connection push flag),
      // asserted for real in migration110.test.ts.
      'push_target',
      // Appended by 112 (content/archive write-back modes + mapping
      // overlays), asserted for real in migration118.test.ts.
      'content_sync_mode',
      'archive_sync_mode',
      'priority_mapping_json',
      'category_mapping_json',
      // Appended by 129 (beads as a fourth provider + the reconciliation
      // ledger's generation counter), asserted for real in migration123.test.ts.
      'config_generation',
      'status_sync_enabled',
    ]);

    expect(columnNames(raw, 'entity_external_links')).toEqual([
      'id',
      'connection_id',
      'entity_type',
      'entity_id',
      'provider',
      'external_id',
      'external_identifier',
      'external_url',
      'external_parent_id',
      'baseline_json',
      'orphaned_at',
      'created_at',
      'updated_at',
    ]);

    expect(columnNames(raw, 'tracker_outbox')).toEqual([
      'id',
      'connection_id',
      'kind',
      'entity_type',
      'entity_id',
      'external_id',
      'client_key',
      'payload_json',
      'state',
      'attempts',
      'last_error',
      'next_attempt_at',
      'created_at',
      'updated_at',
    ]);

    expect(columnNames(raw, 'tracker_conflicts')).toEqual([
      'id',
      'connection_id',
      'link_id',
      'kind',
      'field',
      'local_value',
      'remote_value',
      'payload_json',
      'state',
      'resolution',
      'created_at',
      'resolved_at',
    ]);

    raw.close();
  });

  it('enforces the provider/status/selection_mode/conflict_mode CHECK constraints on tracker_connections', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');

    expect(() =>
      raw
        .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-1', 1, 'linear')`)
        .run(),
    ).not.toThrow();
    expect(() =>
      raw
        .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-2', 1, 'plane')`)
        .run(),
    ).not.toThrow();
    expect(() =>
      raw
        .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-bad', 1, 'jira')`)
        .run(),
    ).toThrow(/CHECK/i);

    const row = raw.prepare('SELECT status, selection_mode, conflict_mode, two_way, mirror_subissues FROM tracker_connections WHERE id = ?').get('conn-1') as
      | { status: string; selection_mode: string; conflict_mode: string; two_way: number; mirror_subissues: number }
      | undefined;
    expect(row).toEqual({ status: 'active', selection_mode: 'all', conflict_mode: 'auto', two_way: 1, mirror_subissues: 1 });

    raw.close();
  });

  it('enforces entity_external_links UNIQUE (entity_type, entity_id, provider) and (connection_id, external_id)', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    raw.prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-1', 1, 'linear')`).run();
    raw.prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-2', 1, 'plane')`).run();

    const insertLink = raw.prepare(
      `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() => insertLink.run('conn-1', 'idea', 'ide_1', 'linear', 'LIN-1')).not.toThrow();

    // Same entity + same provider (via a different connection) collides on
    // (entity_type, entity_id, provider) even though connection_id differs.
    expect(() => insertLink.run('conn-1', 'idea', 'ide_1', 'linear', 'LIN-2')).toThrow(/UNIQUE/i);

    // Same connection + same external_id collides on (connection_id, external_id)
    // even though the entity differs.
    expect(() => insertLink.run('conn-1', 'task', 'tsk_1', 'linear', 'LIN-1')).toThrow(/UNIQUE/i);

    // Different provider (different connection) for the same entity is fine —
    // an idea can be linked to both a Linear issue and a Plane issue.
    expect(() => insertLink.run('conn-2', 'idea', 'ide_1', 'plane', 'PLN-1')).not.toThrow();

    // A bogus entity_type is rejected by the CHECK.
    expect(() => insertLink.run('conn-1', 'bogus', 'x_1', 'linear', 'LIN-3')).toThrow(/CHECK/i);

    raw.close();
  });

  it('enforces tracker_outbox.kind/state CHECKs and defaults', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    raw.prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-1', 1, 'linear')`).run();

    expect(() =>
      raw.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', 'create_sub_issue')`).run(),
    ).not.toThrow();
    expect(() =>
      raw.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', 'delete_issue')`).run(),
    ).toThrow(/CHECK/i);

    const row = raw
      .prepare("SELECT state, attempts, payload_json FROM tracker_outbox WHERE connection_id = 'conn-1'")
      .get() as { state: string; attempts: number; payload_json: string };
    expect(row).toEqual({ state: 'pending', attempts: 0, payload_json: '{}' });

    raw.close();
  });

  it('tracker_conflicts.link_id is ON DELETE SET NULL; tracker_connections.project_id is ON DELETE CASCADE', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    raw.pragma('foreign_keys = ON');
    seedProject(raw, 1, '/tmp/p1');
    raw.prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-1', 1, 'linear')`).run();
    const linkId = raw
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-1', 'idea', 'ide_1', 'linear', 'LIN-1')`,
      )
      .run().lastInsertRowid;
    raw
      .prepare(
        `INSERT INTO tracker_conflicts (connection_id, link_id, kind) VALUES ('conn-1', ?, 'field_conflict')`,
      )
      .run(linkId);

    // Deleting the link nulls out the conflict's link_id instead of cascading.
    raw.prepare('DELETE FROM entity_external_links WHERE id = ?').run(linkId);
    const conflictAfterUnlink = raw
      .prepare("SELECT link_id FROM tracker_conflicts WHERE connection_id = 'conn-1'")
      .get() as { link_id: number | null };
    expect(conflictAfterUnlink.link_id).toBeNull();

    // Deleting the project cascades through connections into outbox/conflicts.
    raw.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', 'update_state')`).run();
    raw.prepare('DELETE FROM projects WHERE id = 1').run();
    expect((raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number }).n).toBe(0);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM tracker_outbox').get() as { n: number }).n).toBe(0);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM tracker_conflicts').get() as { n: number }).n).toBe(0);

    raw.close();
  });

  it('replay convergence: a ledger-wiped re-run of the whole chain is a no-op and preserves data', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    raw1.prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('conn-1', 1, 'linear')`).run();
    raw1
      .prepare(
        `INSERT INTO entity_external_links (connection_id, entity_type, entity_id, provider, external_id)
         VALUES ('conn-1', 'idea', 'ide_1', 'linear', 'LIN-1')`,
      )
      .run();
    const colsBefore = {
      tracker_connections: columnNames(raw1, 'tracker_connections'),
      entity_external_links: columnNames(raw1, 'entity_external_links'),
      tracker_outbox: columnNames(raw1, 'tracker_outbox'),
      tracker_conflicts: columnNames(raw1, 'tracker_conflicts'),
    };
    raw1.close();

    // Wipe every file_migration_applied:* ledger marker (same technique as
    // cyboflowSchema.test.ts's "existing-install" replay test) so the next
    // initialize() re-applies EVERY migration file, including 093, against a
    // DB that already has 093's tables and data.
    const rawWipe = new Database(dbPath);
    rawWipe.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
    rawWipe.close();

    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const raw2 = svc2.getDb();

    // Data survived the replay untouched.
    const conn = raw2.prepare('SELECT id, provider FROM tracker_connections WHERE id = ?').get('conn-1');
    expect(conn).toEqual({ id: 'conn-1', provider: 'linear' });
    const link = raw2
      .prepare("SELECT entity_id, external_id FROM entity_external_links WHERE connection_id = 'conn-1'")
      .get();
    expect(link).toEqual({ entity_id: 'ide_1', external_id: 'LIN-1' });

    // Schema is unchanged.
    expect(columnNames(raw2, 'tracker_connections')).toEqual(colsBefore.tracker_connections);
    expect(columnNames(raw2, 'entity_external_links')).toEqual(colsBefore.entity_external_links);
    expect(columnNames(raw2, 'tracker_outbox')).toEqual(colsBefore.tracker_outbox);
    expect(columnNames(raw2, 'tracker_conflicts')).toEqual(colsBefore.tracker_conflicts);

    // task_external_links does not reappear (015 recreates it, 093 re-drops it).
    expect(tableExists(raw2, 'task_external_links')).toBe(false);

    // The ledger marker for 093 itself is recorded again after the replay.
    const marker = raw2
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:093_tracker_sync.sql'")
      .get() as { value: string } | undefined;
    expect(marker?.value).toBe('true');

    raw2.close();
  });
});
