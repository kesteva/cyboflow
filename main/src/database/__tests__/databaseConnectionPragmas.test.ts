/**
 * Regression guard for the single better-sqlite3 connection's boot-time
 * PRAGMAs (main/src/database/database.ts constructor): journal_mode=WAL,
 * synchronous=NORMAL, busy_timeout=5000 must all be set immediately after the
 * connection opens, alongside the pre-existing foreign_keys=ON.
 *
 * Uses a FILE-backed DB (a temp dir, not `:memory:`) because journal_mode=WAL
 * only takes effect on a real file — an in-memory DB reports 'memory'
 * regardless of what's requested, which is expected and not under test here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let db: DatabaseService;

afterEach(() => {
  db?.getDb().close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('DatabaseService connection PRAGMAs', () => {
  it('sets journal_mode=WAL on a file-backed database', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-pragmas-'));
    db = new DatabaseService(join(tmpDir, 'test.db'));

    expect(db.getDb().pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('sets synchronous=NORMAL and busy_timeout=5000', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-pragmas-'));
    db = new DatabaseService(join(tmpDir, 'test.db'));

    // synchronous: OFF=0, NORMAL=1, FULL=2
    expect(db.getDb().pragma('synchronous', { simple: true })).toBe(1);
    expect(db.getDb().pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('still sets foreign_keys=ON', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-pragmas-'));
    db = new DatabaseService(join(tmpDir, 'test.db'));

    expect(db.getDb().pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
