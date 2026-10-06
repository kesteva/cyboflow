/**
 * Migration 148_drop_crystal_dead_schema.sql — drops dead Crystal-era tables
 * and columns.
 *
 * (a) a fresh initialize() never ends up with them; (b) an UPGRADED DB that
 * still carries them (rebuilt here by hand, since the inline adders are gone)
 * loses them when 148 applies, keeping its rows and the live columns; (c) a
 * ledger-wiped replay over a DB that no longer has them does not block boot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const LEDGER_KEY = 'file_migration_applied:148_drop_crystal_dead_schema.sql';
const DEAD_SESSION_COLS = ['auto_commit', 'commit_mode', 'commit_mode_settings', 'last_output', 'pid'];
const DEAD_PROJECT_COLS = [
  'main_branch',
  'lastUsedModel',
  'commit_mode',
  'commit_structured_prompt_template',
  'commit_checkpoint_prefix',
];
const DEAD_TABLES = ['project_run_commands', 'app_opens', 'messages'];

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-mig148-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function freshDb(): void {
  const svc = new DatabaseService(dbPath);
  svc.initialize();
  svc.getDb().close();
}

function expectDeadSchemaGone(db: Database.Database): void {
  const sessionCols = columns(db, 'sessions');
  const projectCols = columns(db, 'projects');
  for (const c of DEAD_SESSION_COLS) expect(sessionCols).not.toContain(c);
  for (const c of DEAD_PROJECT_COLS) expect(projectCols).not.toContain(c);
  for (const t of DEAD_TABLES) expect(tables(db)).not.toContain(t);
  // The live neighbours survive.
  expect(sessionCols).toEqual(expect.arrayContaining(['exit_code', 'status_message', 'run_started_at']));
  expect(projectCols).toEqual(expect.arrayContaining(['run_script', 'build_script', 'open_ide_command', 'worktree_folder']));
}

describe('migration 148 — drop dead Crystal schema', () => {
  it('(a) a fresh initialize() ends without any of the dead columns or tables', () => {
    freshDb();
    const db = new Database(dbPath);
    expectDeadSchemaGone(db);
    db.close();
  });

  it('(b) drops them from an upgraded DB that still carries them, keeping its rows', () => {
    freshDb();

    // Recreate the pre-148 shape and clear the ledger marker so 148 re-applies.
    const raw = new Database(dbPath);
    for (const c of DEAD_SESSION_COLS) raw.exec(`ALTER TABLE sessions ADD COLUMN ${c} TEXT`);
    for (const c of DEAD_PROJECT_COLS) raw.exec(`ALTER TABLE projects ADD COLUMN ${c} TEXT`);
    raw.exec(`CREATE TABLE project_run_commands (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
      command TEXT NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE)`);
    raw.exec('CREATE TABLE app_opens (id INTEGER PRIMARY KEY, opened_at DATETIME)');
    raw.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content_json TEXT)');
    raw.exec(`INSERT INTO projects (name, path, main_branch, lastUsedModel, open_ide_command)
      VALUES ('P', '/p', 'main', 'sonnet', 'code .')`);
    raw.exec(`INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id, pid, exit_code)
      VALUES ('s1', 'S', 'p', 'w', '/w', 1, 42, 0)`);
    raw.prepare('DELETE FROM user_preferences WHERE key = ?').run(LEDGER_KEY);
    raw.close();

    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const db = svc.getDb();
    expectDeadSchemaGone(db);
    expect(db.prepare("SELECT name, path FROM projects WHERE path = '/p'").get()).toEqual({ name: 'P', path: '/p' });
    // open_ide_command is live (the Diff tab's Open in IDE button) — its value survives 148.
    expect(db.prepare("SELECT open_ide_command FROM projects WHERE path = '/p'").get()).toEqual({
      open_ide_command: 'code .',
    });
    expect(db.prepare("SELECT exit_code FROM sessions WHERE id = 's1'").get()).toEqual({ exit_code: 0 });
    expect(db.prepare('SELECT value FROM user_preferences WHERE key = ?').get(LEDGER_KEY)).toEqual({ value: 'true' });
    db.close();
  });

  it('(c) a ledger-wiped replay over a DB without them does not block boot', () => {
    freshDb();
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM user_preferences WHERE key = ?').run(LEDGER_KEY);
    raw.close();

    const svc = new DatabaseService(dbPath);
    expect(() => svc.initialize()).not.toThrow();
    expectDeadSchemaGone(svc.getDb());
    svc.getDb().close();
  });
});
