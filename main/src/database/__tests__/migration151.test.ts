/**
 * Migration 151_persistent_agents.sql — the vendor-neutral persistent-agents core tables.
 *
 * (a)-(h) run the file over an empty in-memory DB with foreign keys on; (i) proves it lands through the
 * real DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '151_persistent_agents.sql'), 'utf-8');

const TABLES = [
  'vendor_credentials',
  'persistent_agents',
  'persistent_agent_connections',
  'persistent_agent_messages',
  'persistent_agent_events',
  'persistent_agent_usage',
];
const INDEXES = [
  'idx_pac_current', 'idx_pac_one_swap', 'idx_pac_remote', 'idx_pac_agent', 'idx_pac_revoke',
  'idx_pam_remote', 'idx_pam_seq', 'idx_pam_intent', 'idx_pam_thread', 'idx_pam_outbox', 'idx_pam_conn_state',
  'idx_pam_unread', 'idx_pae_agent', 'idx_pae_created', 'idx_pau_agent',
];
const NOW = '2026-10-07T12:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SQL);
  return db;
}

function insertAgent(db: Database.Database, id: string, handle = id): void {
  db.prepare(
    `INSERT INTO persistent_agents (id, handle, display_name, vendor, created_at, updated_at)
     VALUES (?, ?, 'Agent', 'openai-dots', ?, ?)`,
  ).run(id, handle, NOW, NOW);
}

function insertConnection(
  db: Database.Database,
  id: string,
  agentId: string,
  opts: { isCurrent?: 0 | 1; swapState?: string | null; credentialId?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO persistent_agent_connections
       (id, agent_id, kind, connector_id, connector_version, state, credential_id, capabilities_json,
        is_current, swap_state, created_at, updated_at)
     VALUES (?, ?, 'bridge', 'bridge', 1, 'pending', ?, '{}', ?, ?, ?, ?)`,
  ).run(id, agentId, opts.credentialId ?? null, opts.isCurrent ?? 0, opts.swapState ?? null, NOW, NOW);
}

function insertMessage(
  db: Database.Database,
  id: string,
  connectionId: string,
  direction: 'in' | 'out',
  opts: { remoteEventId?: string | null; relaySeq?: number | null; relayEpoch?: number | null } = {},
): void {
  db.prepare(
    `INSERT INTO persistent_agent_messages
       (id, agent_id, connection_id, direction, author, kind, body, remote_event_id, relay_seq, relay_epoch,
        created_at, updated_at)
     VALUES (?, 'a1', ?, ?, 'agent', 'text', 'hi', ?, ?, ?, ?, ?)`,
  ).run(id, connectionId, direction, opts.remoteEventId ?? null, opts.relaySeq ?? null, opts.relayEpoch ?? null,
    NOW, NOW);
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('migration 151 — persistent agents', () => {
  it('(a) creates the six tables and every named index', () => {
    const db = freshDb();
    const names = (db.prepare(`SELECT name FROM sqlite_master`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([...TABLES, ...INDEXES]));
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table'`).all() as Array<{ sql: string }>)
      .map((r) => r.sql).join('\n');
    expect(ddl).not.toMatch(/CHECK/i);
    db.close();
  });

  it('(b) is idempotent with data present — the ledger tracks by filename', () => {
    const db = freshDb();
    insertAgent(db, 'a1');
    insertConnection(db, 'c1', 'a1', { isCurrent: 1 });
    expect(() => db.exec(SQL)).not.toThrow();
    expect(count(db, 'persistent_agents')).toBe(1);
    expect(count(db, 'persistent_agent_connections')).toBe(1);
    db.close();
  });

  it('(c) idx_pac_current rejects a second current connection for one agent', () => {
    const db = freshDb();
    insertAgent(db, 'a1');
    insertConnection(db, 'c1', 'a1', { isCurrent: 1 });
    expect(() => insertConnection(db, 'c2', 'a1', { isCurrent: 1 })).toThrow(/UNIQUE/);
    expect(() => insertConnection(db, 'c3', 'a1', { isCurrent: 0 })).not.toThrow();
    db.close();
  });

  it('(d) swap flip: old→0 then new→1 in one transaction succeeds; new→1 first fails UNIQUE', () => {
    const db = freshDb();
    insertAgent(db, 'a1');
    insertConnection(db, 'old', 'a1', { isCurrent: 1 });
    insertConnection(db, 'new', 'a1', { isCurrent: 0 });
    const setCurrent = db.prepare(`UPDATE persistent_agent_connections SET is_current = ? WHERE id = ?`);
    const wrongOrder = db.transaction(() => {
      setCurrent.run(1, 'new');
      setCurrent.run(0, 'old');
    });
    expect(() => wrongOrder()).toThrow(/UNIQUE/);
    const rightOrder = db.transaction(() => {
      setCurrent.run(0, 'old');
      setCurrent.run(1, 'new');
    });
    expect(() => rightOrder()).not.toThrow();
    const current = db.prepare(`SELECT id FROM persistent_agent_connections WHERE is_current = 1`).all();
    expect(current).toEqual([{ id: 'new' }]);
    db.close();
  });

  it('(e) idx_pac_one_swap rejects two swap rows for one agent', () => {
    const db = freshDb();
    insertAgent(db, 'a1');
    insertConnection(db, 'c1', 'a1', { isCurrent: 1 });
    insertConnection(db, 'c2', 'a1', { swapState: 'connecting' });
    expect(() => insertConnection(db, 'c3', 'a1', { swapState: 'awaiting_verify' })).toThrow(/UNIQUE/);
    db.close();
  });

  it('(f) idx_pam_remote dedupes per direction; idx_pam_seq allows equal seq across directions', () => {
    const db = freshDb();
    insertAgent(db, 'a1');
    insertConnection(db, 'c1', 'a1', { isCurrent: 1 });
    insertMessage(db, 'm1', 'c1', 'in', { remoteEventId: 'ev-1' });
    expect(() => insertMessage(db, 'm2', 'c1', 'in', { remoteEventId: 'ev-1' })).toThrow(/UNIQUE/);
    expect(() => insertMessage(db, 'm3', 'c1', 'out', { remoteEventId: 'ev-1' })).not.toThrow();

    insertMessage(db, 's1', 'c1', 'in', { relaySeq: 7, relayEpoch: 1 });
    expect(() => insertMessage(db, 's2', 'c1', 'in', { relaySeq: 7, relayEpoch: 1 })).toThrow(/UNIQUE/);
    expect(() => insertMessage(db, 's3', 'c1', 'out', { relaySeq: 7, relayEpoch: 1 })).not.toThrow();
    expect(() => insertMessage(db, 's4', 'c1', 'in', { relaySeq: 7, relayEpoch: 2 })).not.toThrow();
    db.close();
  });

  it('(g) cascades from the agent, nulls a forgotten credential, refuses deleting a connection with messages', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO vendor_credentials (id, vendor, label, secret_ciphertext, fingerprint, created_at, updated_at)
       VALUES ('k1', 'anthropic', 'Key', ?, '…abcd · 01234567', ?, ?)`,
    ).run(Buffer.from([9]), NOW, NOW);
    insertAgent(db, 'a1');
    insertConnection(db, 'c1', 'a1', { isCurrent: 1, credentialId: 'k1' });
    insertMessage(db, 'm1', 'c1', 'in', { remoteEventId: 'ev-1' });
    db.prepare(
      `INSERT INTO persistent_agent_events (id, agent_id, connection_id, remote_event_id, type, occurred_at, created_at)
       VALUES ('e1', 'a1', 'c1', 'r1', 'status', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO persistent_agent_usage (connection_id, remote_scope, agent_id, coverage, computed_at)
       VALUES ('c1', 'session', 'a1', 'complete', ?)`,
    ).run(NOW);

    db.prepare(`DELETE FROM vendor_credentials WHERE id = 'k1'`).run();
    expect(db.prepare(`SELECT credential_id FROM persistent_agent_connections WHERE id = 'c1'`).get())
      .toEqual({ credential_id: null });

    expect(() => db.prepare(`DELETE FROM persistent_agent_connections WHERE id = 'c1'`).run()).toThrow(/FOREIGN KEY/);

    db.prepare(`DELETE FROM persistent_agents WHERE id = 'a1'`).run();
    expect(count(db, 'persistent_agent_connections')).toBe(0);
    expect(count(db, 'persistent_agent_messages')).toBe(0);
    expect(count(db, 'persistent_agent_events')).toBe(0);
    expect(count(db, 'persistent_agent_usage')).toBe(0);
    db.close();
  });

  it('(h) no column default writes datetime(now)', () => {
    const db = freshDb();
    for (const table of TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ dflt_value: string | null }>;
      for (const c of cols) expect(c.dflt_value ?? '').not.toMatch(/now|CURRENT/i);
    }
    db.close();
  });

  it('(i) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration151-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const names = (svc.getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(TABLES));
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
