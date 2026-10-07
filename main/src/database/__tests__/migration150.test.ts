/**
 * Migration 150_cloud_account.sql — the cyboflow cloud device registration (one row).
 *
 * (a)-(c) run the file over an empty in-memory DB; (d) proves it lands through the real
 * DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '150_cloud_account.sql'), 'utf-8');

interface ColumnInfo { name: string; notnull: number; pk: number; dflt_value: string | null }

function insertRow(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cloud_account
       (id, origin, account_id, device_id, device_name, device_code, token_ciphertext, created_at, updated_at)
     VALUES (1, 'https://cloud-staging.cyboflow.com', 'acc', 'dev', 'My computer', 'ABC', ?, ?, ?)`,
  ).run(Buffer.from([1, 2, 3]), now, now);
}

describe('migration 150 — cloud_account', () => {
  it('(a) creates cloud_account with the exact columns', () => {
    const db = new Database(':memory:');
    db.exec(SQL);
    const cols = db.prepare('PRAGMA table_info(cloud_account)').all() as ColumnInfo[];
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'origin', 'account_id', 'device_id', 'device_name', 'device_code', 'display_login',
      'entitlements_json', 'scopes', 'token_ciphertext', 'state', 'created_at', 'updated_at', 'last_ok_at',
    ]);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')?.pk).toBe(1);
    const notNull = cols.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(notNull).toEqual([
      'origin', 'account_id', 'device_id', 'device_name', 'device_code', 'entitlements_json', 'scopes',
      'token_ciphertext', 'state', 'created_at', 'updated_at',
    ]);
    expect(byName.get('display_login')?.notnull).toBe(0);
    expect(byName.get('last_ok_at')?.notnull).toBe(0);
    expect(byName.get('state')?.dflt_value).toBe("'ok'");
    expect(byName.get('entitlements_json')?.dflt_value).toBe("'[]'");
    db.close();
  });

  it('(b) is idempotent — the ledger tracks by filename, so a renumber re-applies it', () => {
    const db = new Database(':memory:');
    db.exec(SQL);
    insertRow(db);
    expect(() => db.exec(SQL)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_account').get()).toEqual({ n: 1 });
    db.close();
  });

  it('(c) has no CHECK constraint and no datetime default', () => {
    const db = new Database(':memory:');
    db.exec(SQL);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cloud_account'`)
      .get() as { sql: string };
    expect(row.sql).not.toMatch(/CHECK/i);
    const cols = db.prepare('PRAGMA table_info(cloud_account)').all() as ColumnInfo[];
    for (const c of cols) expect(c.dflt_value ?? '').not.toMatch(/now|CURRENT/i);
    db.close();
  });

  it('(d) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration150-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const cols = (svc.getDb().prepare('PRAGMA table_info(cloud_account)').all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['origin', 'token_ciphertext', 'state', 'last_ok_at']));
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
