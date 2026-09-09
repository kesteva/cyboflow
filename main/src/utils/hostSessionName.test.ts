import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveHostSessionName } from './hostSessionName';

/**
 * The lookup exists for the dogfooding case where the RUNNING instance's own
 * database is not the one holding the session — so every test seeds a data dir
 * other than the caller's and asserts we still find (or correctly miss) it.
 */
function seedDataDir(
  home: string,
  dirName: string,
  rows: Array<{ name: string; worktreePath: string; archived?: number }>
): void {
  const dir = path.join(home, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'sessions.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    archived BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const insert = db.prepare(
    'INSERT INTO sessions (id, name, worktree_path, archived) VALUES (?, ?, ?, ?)'
  );
  rows.forEach((row, index) => {
    insert.run(`s${index}`, row.name, row.worktreePath, row.archived ?? 0);
  });
  db.close();
}

describe('resolveHostSessionName', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-session-name-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds the session name in a SIBLING data dir, not just the running one', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'hidden-comet-20260901');
    fs.mkdirSync(worktree, { recursive: true });
    // The dev server's own dir is empty; the stable app's dir holds the session.
    seedDataDir(home, '.cyboflow_dev', []);
    seedDataDir(home, '.cyboflow', [{ name: 'support codex assistant', worktreePath: worktree }]);

    expect(resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })).toBe(
      'support codex assistant'
    );
  });

  it('returns undefined when no data dir knows the worktree', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'unknown-otter');
    fs.mkdirSync(worktree, { recursive: true });
    seedDataDir(home, '.cyboflow', [
      { name: 'some other session', worktreePath: path.join(home, 'repo', 'worktrees', 'elsewhere') },
    ]);

    expect(
      resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })
    ).toBeUndefined();
  });

  it('prefers a live session over an archived row for the same worktree', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'reused-slug');
    fs.mkdirSync(worktree, { recursive: true });
    seedDataDir(home, '.cyboflow_archived_first', [
      { name: 'stale archived name', worktreePath: worktree, archived: 1 },
    ]);
    seedDataDir(home, '.cyboflow', [{ name: 'live name', worktreePath: worktree }]);

    expect(resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })).toBe(
      'live name'
    );
  });

  it('falls back to an archived row when that is all there is', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'only-archived');
    fs.mkdirSync(worktree, { recursive: true });
    seedDataDir(home, '.cyboflow', [
      { name: 'archived name', worktreePath: worktree, archived: 1 },
    ]);

    expect(resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })).toBe(
      'archived name'
    );
  });

  it('honours an explicit CYBOFLOW_DIR outside the home scan', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'pinned');
    fs.mkdirSync(worktree, { recursive: true });
    const pinned = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-datadir-'));
    try {
      const db = new Database(path.join(pinned, 'sessions.db'));
      db.exec(
        'CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, worktree_path TEXT NOT NULL, archived BOOLEAN DEFAULT 0, updated_at DATETIME)'
      );
      db.prepare('INSERT INTO sessions (id, name, worktree_path, archived) VALUES (?, ?, ?, 0)').run(
        's0',
        'pinned session',
        worktree
      );
      db.close();

      expect(resolveHostSessionName(worktree, { homeDir: home, explicitDir: pinned })).toBe(
        'pinned session'
      );
    } finally {
      fs.rmSync(pinned, { recursive: true, force: true });
    }
  });

  it('skips a data dir whose database is unreadable or foreign-schema', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'resilient');
    fs.mkdirSync(worktree, { recursive: true });
    const brokenDir = path.join(home, '.cyboflow_broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'sessions.db'), 'not a database at all');
    seedDataDir(home, '.cyboflow', [{ name: 'good name', worktreePath: worktree }]);

    expect(resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })).toBe(
      'good name'
    );
  });

  it('ignores unrelated dotdirs in home', () => {
    const worktree = path.join(home, 'repo', 'worktrees', 'ignored');
    fs.mkdirSync(worktree, { recursive: true });
    seedDataDir(home, '.crystal', [{ name: 'legacy crystal name', worktreePath: worktree }]);

    expect(
      resolveHostSessionName(worktree, { homeDir: home, explicitDir: undefined })
    ).toBeUndefined();
  });
});
