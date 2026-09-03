/**
 * Realpath containment for the PROJECT-scoped file ops in
 * main/src/ipc/fileOps.ts, plus the "validate the path you actually use" property
 * for the write paths.
 *
 * The project-scoped ops (`readProject`, `writeProject`) used to guard only
 * LEXICALLY — reject `..` and absolute paths, then `path.join`. That stops
 * `../../etc/passwd` and nothing else: a symlink committed inside the project
 * (`docs/out -> /Users/me/.ssh`) is a perfectly ordinary relative path
 * lexically, and the handler would read or write straight through it. The
 * session-scoped ops already resolved symlinks before checking; these tests
 * pin that the project ones now do too.
 *
 * Every escape case is built as a REAL symlink in a real tmpdir — a mocked fs
 * would only prove the guard's own arithmetic, not that it survives contact with
 * realpath.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

import { createFileOps } from '../fileOps';
import { createDirSymlink, fileSymlinksNeedPrivilege } from '../../__test_fixtures__/symlink';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';

let tmpRoot: string;
let projectPath: string;
let outsidePath: string;
let ops: ReturnType<typeof createFileOps>;

beforeEach(async () => {
  // realpath the tmp root: macOS /var → /private/var, and the ops judge
  // containment on resolved paths.
  tmpRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cyboflow-contain-')));
  projectPath = path.join(tmpRoot, 'project');
  outsidePath = path.join(tmpRoot, 'outside');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(outsidePath, { recursive: true });
  fs.writeFileSync(path.join(outsidePath, 'secret.txt'), 'SECRET\n');

  const session: Session = {
    id: 's1',
    worktreePath: projectPath,
    archived: false,
  } as unknown as Session;

  ops = createFileOps({
    sessionManager: { getSession: vi.fn(() => session) },
    databaseService: { getProject: vi.fn(() => ({ id: 1, path: projectPath })) },
    gitStatusManager: { refreshSessionGitStatus: vi.fn(async () => {}) },
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices);
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('file:read-project — realpath containment', () => {
  it('reads an ordinary file inside the project', async () => {
    fs.writeFileSync(path.join(projectPath, 'ok.txt'), 'hello\n');
    const res = await ops.readProject({ projectId: 1, filePath: 'ok.txt' });
    expect(res).toMatchObject({ success: true, data: 'hello\n' });
  });

  // POSIX-only fixture: a symlinked FILE needs privileges on win32; the dir-
  // symlink escape cases below carry the same realpath-guard coverage there.
  it.skipIf(fileSymlinksNeedPrivilege)(
    'REJECTS a symlinked FILE inside the project that points outside it',
    async () => {
    fs.symlinkSync(path.join(outsidePath, 'secret.txt'), path.join(projectPath, 'leak.txt'));
    const res = await ops.readProject({ projectId: 1, filePath: 'leak.txt' });
    expect(res.success).toBe(false);
    expect((res as { data?: unknown }).data).toBeUndefined();
    expect(!res.success && res.error).toMatch(/outside/i);
    },
  );

  it('REJECTS a path through a symlinked DIRECTORY inside the project', async () => {
    createDirSymlink(outsidePath, path.join(projectPath, 'escape'));
    const res = await ops.readProject({ projectId: 1, filePath: 'escape/secret.txt' });
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toMatch(/outside/i);
  });

  it('REJECTS a link escape to a SIBLING dir that shares a name prefix (prefix-safety)', async () => {
    // 'project-evil' shares 'project' as a string prefix; the containment check
    // must compare path components (or resolved realpaths), not raw prefixes.
    const evilSibling = path.join(tmpRoot, 'project-evil');
    fs.mkdirSync(evilSibling, { recursive: true });
    fs.writeFileSync(path.join(evilSibling, 'secret.txt'), 'SECRET\n');
    createDirSymlink(evilSibling, path.join(projectPath, 'escape'));
    const res = await ops.readProject({ projectId: 1, filePath: 'escape/secret.txt' });
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toMatch(/outside/i);
  });

  it('still allows a symlink that stays WITHIN the project', async () => {
    fs.mkdirSync(path.join(projectPath, 'real'));
    fs.writeFileSync(path.join(projectPath, 'real', 'inner.txt'), 'inner\n');
    createDirSymlink(path.join(projectPath, 'real'), path.join(projectPath, 'link'));
    const res = await ops.readProject({ projectId: 1, filePath: 'link/inner.txt' });
    expect(res).toMatchObject({ success: true, data: 'inner\n' });
  });

  it('still rejects plain lexical traversal', async () => {
    const res = await ops.readProject({ projectId: 1, filePath: '../outside/secret.txt' });
    expect(res.success).toBe(false);
  });
});

describe('file:write-project — realpath containment', () => {
  it('writes an ordinary file inside the project, creating parent dirs', async () => {
    const res = await ops.writeProject({ projectId: 1, filePath: 'nested/deep/new.txt', content: 'written\n' });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(projectPath, 'nested/deep/new.txt'), 'utf-8')).toBe('written\n');
  });

  // POSIX-only fixture: a symlinked FILE needs privileges on win32; the dir-
  // symlink write case below carries the same realpath-guard coverage there.
  it.skipIf(fileSymlinksNeedPrivilege)(
    'REJECTS writing through a symlink pointing outside, leaving the target untouched',
    async () => {
    fs.symlinkSync(path.join(outsidePath, 'secret.txt'), path.join(projectPath, 'leak.txt'));
    const res = await ops.writeProject({ projectId: 1, filePath: 'leak.txt', content: 'PWNED\n' });
    expect(res.success).toBe(false);
    expect(fs.readFileSync(path.join(outsidePath, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
    },
  );

  // POSIX-only fixture: a DANGLING FILE symlink has no unprivileged win32
  // stand-in (a dangling junction can only name a directory).
  it.skipIf(fileSymlinksNeedPrivilege)(
    'REJECTS a DANGLING symlink pointing outside — writeFile would CREATE the target',
    async () => {
    const wouldBeCreated = path.join(outsidePath, 'planted.txt');
    fs.symlinkSync(wouldBeCreated, path.join(projectPath, 'dangling.txt'));
    const res = await ops.writeProject({ projectId: 1, filePath: 'dangling.txt', content: 'PWNED\n' });
    expect(res.success).toBe(false);
    expect(fs.existsSync(wouldBeCreated)).toBe(false);
    },
  );

  it('REJECTS a write through a symlinked DIRECTORY inside the project', async () => {
    createDirSymlink(outsidePath, path.join(projectPath, 'escape'));
    const res = await ops.writeProject({ projectId: 1, filePath: 'escape/planted.txt', content: 'PWNED\n' });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(outsidePath, 'planted.txt'))).toBe(false);
  });
});

describe('file:write (session-scoped) — writes the path it validated', () => {
  // POSIX-only fixture: the leaf FILE link has no unprivileged win32 stand-in.
  it.skipIf(fileSymlinksNeedPrivilege)(
    'does not re-follow the leaf symlink at write time',
    async () => {
    // The guard resolved the leaf and accepted it; writing to the LEXICAL path
    // instead would re-traverse the link. Point a link at a sibling INSIDE the
    // worktree: the write must land on the resolved target, once.
    fs.writeFileSync(path.join(projectPath, 'target.txt'), 'old\n');
    fs.symlinkSync(path.join(projectPath, 'target.txt'), path.join(projectPath, 'alias.txt'));
    const res = await ops.write({ sessionId: 's1', filePath: 'alias.txt', content: 'new\n' });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(projectPath, 'target.txt'), 'utf-8')).toBe('new\n');
    // The alias is still a symlink — the write went THROUGH the resolved path,
    // it did not replace the link with a regular file.
    expect(fs.lstatSync(path.join(projectPath, 'alias.txt')).isSymbolicLink()).toBe(true);
    },
  );

  // POSIX-only fixture: a DANGLING FILE symlink has no unprivileged win32
  // stand-in (a dangling junction can only name a directory).
  it.skipIf(fileSymlinksNeedPrivilege)(
    'REJECTS a dangling symlink escaping the worktree',
    async () => {
    const wouldBeCreated = path.join(outsidePath, 'wt-planted.txt');
    fs.symlinkSync(wouldBeCreated, path.join(projectPath, 'wt-dangling.txt'));
    const res = await ops.write({ sessionId: 's1', filePath: 'wt-dangling.txt', content: 'PWNED\n' });
    expect(res.success).toBe(false);
    expect(fs.existsSync(wouldBeCreated)).toBe(false);
    },
  );
});

describe('file:list — realpath containment', () => {
  it('lists an ordinary directory with paths relative to the worktree', async () => {
    fs.mkdirSync(path.join(projectPath, 'src'));
    fs.writeFileSync(path.join(projectPath, 'src', 'a.ts'), '');
    const res = await ops.list({ sessionId: 's1', path: 'src' });
    expect(res.success).toBe(true);
    // Relative paths come back in the platform's native separators
    // (path.relative), so build the expectation the same way.
    expect(res.success && res.files.map((f) => f.path)).toEqual([path.join('src', 'a.ts')]);
  });

  it('REJECTS listing through a symlinked directory that escapes the worktree', async () => {
    createDirSymlink(outsidePath, path.join(projectPath, 'escape'));
    const res = await ops.list({ sessionId: 's1', path: 'escape' });
    expect(res.success).toBe(false);
    expect((res as { files?: unknown }).files).toBeUndefined();
  });
});

describe('file:search — the pattern cannot walk the glob root out of the project', () => {
  it('returns no matches instead of searching an escaped directory', async () => {
    const res = await ops.search({ projectId: 1, pattern: '../outside/secret' });
    // Empty, and specifically NOT a listing of `outside/`.
    expect(res).toEqual({ success: true, files: [] });
  });

  it('still searches normally inside the project', async () => {
    fs.mkdirSync(path.join(projectPath, 'src'));
    fs.writeFileSync(path.join(projectPath, 'src', 'findme.ts'), '');
    const res = await ops.search({ projectId: 1, pattern: 'findme' });
    expect(res.success).toBe(true);
    // Match against native separators (see the file:list note above).
    expect(res.success && res.files.some((f) => f.path === path.join('src', 'findme.ts'))).toBe(true);
  });
});
