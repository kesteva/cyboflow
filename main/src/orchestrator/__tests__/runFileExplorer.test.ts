/**
 * Unit tests for the run File Explorer handler (listRunFiles / readRunFile).
 *
 * Seeds an in-memory workflow_runs row whose worktree_path points at a real
 * temp directory (created per-test under os.tmpdir()), then exercises:
 *   - directory listing (dirs-first ordering, .git exclusion, sizes)
 *   - lazy subdirectory listing via a relative path
 *   - file reads (utf-8), empty files, binary detection, size cap
 *   - path-safety rejections (absolute, traversal, symlink escape)
 *   - run-resolution failures (unknown run, no worktree, missing worktree)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  listRunFiles,
  readRunFile,
  RunFileError,
  MAX_VIEWABLE_BYTES,
} from '../runFileExplorer';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';

const RUN_ID = 'run-fe-001';

describe('runFileExplorer', () => {
  let db: Database.Database;
  let worktree: string;

  beforeEach(() => {
    db = createTestDb();
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-fe-'));
    seedRun(db, { id: RUN_ID, projectId: 1, worktreePath: worktree });
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listRunFiles — root listing
  // -------------------------------------------------------------------------
  it('lists the worktree root with directories first, then files, and excludes .git', async () => {
    fs.writeFileSync(path.join(worktree, 'README.md'), '# hello');
    fs.writeFileSync(path.join(worktree, 'app.ts'), 'export const a = 1;');
    fs.mkdirSync(path.join(worktree, 'src'));
    fs.mkdirSync(path.join(worktree, '.git'));
    fs.writeFileSync(path.join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main');

    const entries = await listRunFiles(dbAdapter(db), RUN_ID);

    // .git is excluded; dirs sort before files; files sort case-insensitively
    // (so 'app.ts' precedes 'README.md').
    expect(entries.map((e) => e.name)).toEqual(['src', 'app.ts', 'README.md']);
    expect(entries[0]).toMatchObject({ name: 'src', path: 'src', isDirectory: true });
    expect(entries[0].size).toBeUndefined();

    const readme = entries.find((e) => e.name === 'README.md');
    expect(readme).toMatchObject({ isDirectory: false, path: 'README.md' });
    expect(readme?.size).toBe(Buffer.byteLength('# hello'));
  });

  it('returns [] for an empty worktree root', async () => {
    const entries = await listRunFiles(dbAdapter(db), RUN_ID);
    expect(entries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // listRunFiles — subdirectory listing via relative path
  // -------------------------------------------------------------------------
  it('lists a subdirectory addressed by a relative path', async () => {
    fs.mkdirSync(path.join(worktree, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'index.ts'), 'x');
    fs.writeFileSync(path.join(worktree, 'src', 'nested', 'deep.ts'), 'y');

    const entries = await listRunFiles(dbAdapter(db), RUN_ID, 'src');
    expect(entries.map((e) => e.name)).toEqual(['nested', 'index.ts']);
    // Child paths are relative to the worktree root, POSIX-style.
    expect(entries.find((e) => e.name === 'index.ts')?.path).toBe('src/index.ts');
    expect(entries.find((e) => e.name === 'nested')?.path).toBe('src/nested');
  });

  it('throws not-a-directory when the relative path is a file', async () => {
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'data');
    await expect(listRunFiles(dbAdapter(db), RUN_ID, 'file.txt')).rejects.toMatchObject({
      reason: 'not-a-directory',
    });
  });

  // -------------------------------------------------------------------------
  // readRunFile
  // -------------------------------------------------------------------------
  it('reads a utf-8 file', async () => {
    fs.writeFileSync(path.join(worktree, 'note.md'), 'line1\nline2');
    const result = await readRunFile(dbAdapter(db), RUN_ID, 'note.md');
    expect(result).toEqual({
      path: 'note.md',
      content: 'line1\nline2',
      size: Buffer.byteLength('line1\nline2'),
      unviewableReason: null,
    });
  });

  it('reads a nested file addressed by a relative path', async () => {
    fs.mkdirSync(path.join(worktree, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'a', 'b', 'c.txt'), 'deep');
    const result = await readRunFile(dbAdapter(db), RUN_ID, 'a/b/c.txt');
    expect(result.content).toBe('deep');
    expect(result.path).toBe('a/b/c.txt');
  });

  it('returns empty content for an empty file', async () => {
    fs.writeFileSync(path.join(worktree, 'empty.txt'), '');
    const result = await readRunFile(dbAdapter(db), RUN_ID, 'empty.txt');
    expect(result.content).toBe('');
    expect(result.unviewableReason).toBeNull();
    expect(result.size).toBe(0);
  });

  it('flags a binary file (NUL byte) as unviewable without returning content', async () => {
    fs.writeFileSync(path.join(worktree, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]));
    const result = await readRunFile(dbAdapter(db), RUN_ID, 'blob.bin');
    expect(result.content).toBeNull();
    expect(result.unviewableReason).toBe('binary');
    expect(result.size).toBe(3);
  });

  it('flags an oversized file as too-large without returning content', async () => {
    const big = Buffer.alloc(MAX_VIEWABLE_BYTES + 1, 0x61); // all 'a', no NUL
    fs.writeFileSync(path.join(worktree, 'big.txt'), big);
    const result = await readRunFile(dbAdapter(db), RUN_ID, 'big.txt');
    expect(result.content).toBeNull();
    expect(result.unviewableReason).toBe('too-large');
    expect(result.size).toBe(MAX_VIEWABLE_BYTES + 1);
  });

  it('throws not-a-file when reading a directory', async () => {
    fs.mkdirSync(path.join(worktree, 'adir'));
    await expect(readRunFile(dbAdapter(db), RUN_ID, 'adir')).rejects.toMatchObject({
      reason: 'not-a-file',
    });
  });

  it('throws not-found when reading a missing file', async () => {
    await expect(readRunFile(dbAdapter(db), RUN_ID, 'nope.txt')).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  // -------------------------------------------------------------------------
  // Path safety
  // -------------------------------------------------------------------------
  it('rejects an absolute path', async () => {
    await expect(readRunFile(dbAdapter(db), RUN_ID, '/etc/passwd')).rejects.toMatchObject({
      reason: 'invalid-path',
    });
  });

  it('rejects a traversal path that escapes the worktree', async () => {
    await expect(listRunFiles(dbAdapter(db), RUN_ID, '../..')).rejects.toMatchObject({
      reason: 'invalid-path',
    });
    await expect(readRunFile(dbAdapter(db), RUN_ID, '../secret.txt')).rejects.toMatchObject({
      reason: 'invalid-path',
    });
  });

  it('rejects a symlink that points outside the worktree', async () => {
    // A secret file OUTSIDE the worktree, with a symlink to it INSIDE.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-outside-'));
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    try {
      fs.symlinkSync(secret, path.join(worktree, 'link.txt'));
      await expect(readRunFile(dbAdapter(db), RUN_ID, 'link.txt')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // fs hardening — special files + symlink metadata containment
  // -------------------------------------------------------------------------
  it('rejects a non-regular file (FIFO) instead of reading it (no threadpool hang)', () => {
    const fifo = path.join(worktree, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform — skip
    }
    // Must reject promptly via the stat/isFile guard, never block on readFile.
    return expect(readRunFile(dbAdapter(db), RUN_ID, 'pipe')).rejects.toMatchObject({
      reason: 'not-a-file',
    });
  });

  it('does not leak the size/type of a symlink whose target is OUTSIDE the worktree', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-outside-'));
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'top secret payload'); // 18 bytes — must NOT surface
    try {
      fs.symlinkSync(secret, path.join(worktree, 'leak'));
      const entries = await listRunFiles(dbAdapter(db), RUN_ID);
      const leak = entries.find((e) => e.name === 'leak');
      expect(leak).toBeDefined();
      // Reported as a non-traversable leaf with no size — target metadata hidden.
      expect(leak).toMatchObject({ name: 'leak', isDirectory: false });
      expect(leak?.size).toBeUndefined();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('follows an IN-worktree symlink for type and size', async () => {
    fs.mkdirSync(path.join(worktree, 'realdir'));
    fs.writeFileSync(path.join(worktree, 'realfile.txt'), 'hello in-tree'); // 13 bytes
    fs.symlinkSync(path.join(worktree, 'realfile.txt'), path.join(worktree, 'linkfile'));
    fs.symlinkSync(path.join(worktree, 'realdir'), path.join(worktree, 'linkdir'));

    const entries = await listRunFiles(dbAdapter(db), RUN_ID);
    const linkfile = entries.find((e) => e.name === 'linkfile');
    const linkdir = entries.find((e) => e.name === 'linkdir');
    // In-worktree symlinks are safely followed: file size + dir classification.
    expect(linkfile).toMatchObject({ isDirectory: false });
    expect(linkfile?.size).toBe(Buffer.byteLength('hello in-tree'));
    expect(linkdir).toMatchObject({ isDirectory: true });
  });

  it('lists a broken (dangling) symlink as a leaf rather than dropping or throwing', async () => {
    fs.symlinkSync(path.join(worktree, 'does-not-exist'), path.join(worktree, 'dangling'));
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'x');
    const entries = await listRunFiles(dbAdapter(db), RUN_ID);
    const dangling = entries.find((e) => e.name === 'dangling');
    expect(dangling).toMatchObject({ name: 'dangling', isDirectory: false });
    expect(dangling?.size).toBeUndefined();
    // The valid sibling is unaffected — one broken link doesn't break the listing.
    expect(entries.find((e) => e.name === 'keep.txt')).toBeDefined();
  });

  it('excludes only the exact ".git" name (keeps .gitignore / .github) at any level', async () => {
    fs.mkdirSync(path.join(worktree, '.git'));
    fs.writeFileSync(path.join(worktree, '.gitignore'), 'node_modules');
    fs.mkdirSync(path.join(worktree, '.github'));
    fs.mkdirSync(path.join(worktree, 'sub'));
    fs.mkdirSync(path.join(worktree, 'sub', '.git')); // nested .git too

    const root = await listRunFiles(dbAdapter(db), RUN_ID);
    const rootNames = root.map((e) => e.name);
    expect(rootNames).not.toContain('.git');
    expect(rootNames).toContain('.gitignore'); // exact-match filter, not startsWith
    expect(rootNames).toContain('.github');

    // The exact-name filter applies at every level — a nested .git is also hidden.
    const sub = await listRunFiles(dbAdapter(db), RUN_ID, 'sub');
    expect(sub.map((e) => e.name)).not.toContain('.git');
  });

  it('rejects a symlink to a SIBLING dir that shares the worktree path prefix (prefix-safety)', async () => {
    // base/wt is the worktree; base/wt-evil is a sibling whose path starts with
    // base/wt. Without the `realRoot + path.sep` guard, startsWith('base/wt')
    // would wrongly ALLOW base/wt-evil/secret.txt.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-prefix-'));
    const wt = path.join(base, 'wt');
    const sibling = path.join(base, 'wt-evil');
    fs.mkdirSync(wt);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling secret');
    seedRun(db, { id: 'run-prefix', projectId: 1, worktreePath: wt });
    try {
      fs.symlinkSync(path.join(sibling, 'secret.txt'), path.join(wt, 'link'));
      await expect(readRunFile(dbAdapter(db), 'run-prefix', 'link')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Run resolution failures
  // -------------------------------------------------------------------------
  it('throws run-not-found for an unknown run id', async () => {
    await expect(listRunFiles(dbAdapter(db), 'no-such-run')).rejects.toBeInstanceOf(RunFileError);
    await expect(listRunFiles(dbAdapter(db), 'no-such-run')).rejects.toMatchObject({
      reason: 'run-not-found',
    });
  });

  it('throws no-worktree when the run has no worktree_path', async () => {
    seedRun(db, { id: 'run-nowt', projectId: 1, worktreePath: undefined });
    // seedRun defaults worktree_path to '/tmp/test'; overwrite to NULL directly.
    db.prepare('UPDATE workflow_runs SET worktree_path = NULL WHERE id = ?').run('run-nowt');
    await expect(listRunFiles(dbAdapter(db), 'run-nowt')).rejects.toMatchObject({
      reason: 'no-worktree',
    });
  });

  it('throws worktree-missing when worktree_path no longer exists on disk', async () => {
    seedRun(db, { id: 'run-gone', projectId: 1, worktreePath: '/nonexistent/cyboflow/worktree' });
    await expect(listRunFiles(dbAdapter(db), 'run-gone')).rejects.toMatchObject({
      reason: 'worktree-missing',
    });
  });
});
