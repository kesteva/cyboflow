/**
 * Behavioral tests for the destructive/file IPC handlers in
 * main/src/ipc/file.ts.
 *
 * Uses REAL temporary git repos where the assertion is about a real git or fs
 * effect (git:restore's `reset --hard` + `clean -fd`, nested-dir creation on
 * write, readAtRevision against a real object DB). Path-guard rejections are
 * exercised through the handler with a stubbed sessionManager.
 *
 * Covered:
 *  - git:restore discards uncommitted tracked changes AND removes untracked
 *    files (the irreversible reset --hard/clean -fd path); a missing session
 *    returns success:false with no mutation (there is nothing to mutate).
 *  - file:read / file:write reject `../` traversal and absolute paths.
 *  - file:write creates missing nested parent directories.
 *  - file:readAtRevision returns empty content when the file is absent at the
 *    revision, vs surfacing a real git error (bad revision) as success:false.
 *  - realpath containment guard (file:read/file:write): a symlink inside the
 *    worktree pointing OUTSIDE it is rejected; a sibling worktree whose name is
 *    a string prefix of the real worktree is rejected; a legit symlink pointing
 *    WITHIN the worktree still works.
 *
 * The realpath containment guard in file:read/file:write was previously dead
 * (its `&&` paired an always-true inner condition, and it used a separator-less
 * startsWith), so a symlink inside the worktree could escape it. That guard is
 * now fixed and the escape cases are asserted below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

import { registerFileHandlers } from '../file';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** Init a real git repo with one committed file "tracked.txt" = content. */
function initRepo(dir: string, content = 'v1\n'): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@cyboflow.dev');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
}

/** Build a services object whose sessionManager returns the given session. */
function servicesFor(session: Session | undefined): AppServices {
  return {
    sessionManager: { getSession: vi.fn(() => session) },
    databaseService: { getProject: vi.fn() },
    gitStatusManager: { refreshSessionGitStatus: vi.fn(async () => {}) },
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-file-'));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('git:restore', () => {
  it('discards uncommitted tracked changes and removes untracked files', async () => {
    const wt = path.join(tmpRoot, 'wt');
    fs.mkdirSync(wt);
    initRepo(wt, 'committed\n');

    // Dirty the working tree: modify the tracked file + add an untracked file.
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'LOCAL EDIT\n');
    fs.writeFileSync(path.join(wt, 'scratch.tmp'), 'junk\n');

    const session = { id: 's1', worktreePath: wt } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(ipcMain as unknown as Parameters<typeof registerFileHandlers>[0], servicesFor(session));

    const result = (await invoke(handlers, 'git:restore', { sessionId: 's1' })) as { success: boolean };

    expect(result.success).toBe(true);
    // reset --hard restored the committed content...
    expect(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf-8')).toBe('committed\n');
    // ...and clean -fd removed the untracked file.
    expect(fs.existsSync(path.join(wt, 'scratch.tmp'))).toBe(false);
    // Working tree is clean afterward.
    expect(git(wt, 'status', '--porcelain').trim()).toBe('');
  });

  it('returns success:false with no git effect when the session is missing', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(undefined),
    );

    const result = (await invoke(handlers, 'git:restore', { sessionId: 'ghost' })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Session not found');
  });
});

describe('file path guards (file:read / file:write)', () => {
  const wt = 'PLACEHOLDER';

  function handlersForWorktree(worktree: string) {
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );
    return handlers;
  }

  it('file:read rejects a `../` traversal path', async () => {
    void wt;
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: '../outside.txt',
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid file path');
  });

  it('file:read rejects an absolute path', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: '/etc/passwd',
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid file path');
  });

  it('file:write rejects a `../` traversal path and writes nothing', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const handlers = handlersForWorktree(worktree);
    const escapeTarget = path.join(tmpRoot, 'outside.txt');
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: '../outside.txt',
      content: 'pwned',
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid file path');
    expect(fs.existsSync(escapeTarget)).toBe(false);
  });

  it('file:write rejects an absolute path', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: path.join(tmpRoot, 'abs.txt'),
      content: 'x',
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid file path');
  });
});

describe('realpath containment guard (symlink escape)', () => {
  function handlersForWorktree(worktree: string) {
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );
    return handlers;
  }

  it('file:read rejects a symlink inside the worktree that points outside it', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const outside = path.join(tmpRoot, 'outside.txt');
    fs.writeFileSync(outside, 'TOPSECRET\n');
    fs.symlinkSync(outside, path.join(worktree, 'escape.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: 'escape.txt',
    })) as { success: boolean; error?: string; content?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('File path is outside worktree');
    expect(result.content).toBeUndefined();
  });

  it('file:read rejects a symlink escaping to a sibling worktree that shares a name prefix', async () => {
    // worktree `.../xyz-wt`, sibling `.../xyz-wt-other`: the sibling's realpath
    // is a string prefix of nothing valid, but a separator-less startsWith
    // (the old bug) would treat `.../xyz-wt-other/...` as inside `.../xyz-wt`.
    const worktree = path.join(tmpRoot, 'xyz-wt');
    fs.mkdirSync(worktree);
    const sibling = path.join(tmpRoot, 'xyz-wt-other');
    fs.mkdirSync(sibling);
    const secret = path.join(sibling, 'secret.txt');
    fs.writeFileSync(secret, 'SIBLING SECRET\n');
    fs.symlinkSync(secret, path.join(worktree, 'leak.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: 'leak.txt',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('File path is outside worktree');
  });

  it('file:write rejects a symlink escaping the worktree and does not write through it', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const outside = path.join(tmpRoot, 'target.txt');
    fs.writeFileSync(outside, 'ORIGINAL\n');
    fs.symlinkSync(outside, path.join(worktree, 'escape-w.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: 'escape-w.txt',
      content: 'PWNED',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('File path is outside worktree');
    // The out-of-worktree target must be untouched (no write-through).
    expect(fs.readFileSync(outside, 'utf-8')).toBe('ORIGINAL\n');
  });

  it('file:write rejects a DANGLING symlink pointing outside the worktree and does not create the target', async () => {
    // realpath refuses dangling links, but fs.writeFile through one CREATES
    // the (outside) target — the guard must chase the link chain manually.
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const outsideTarget = path.join(tmpRoot, 'not-yet-created.txt');
    fs.symlinkSync(outsideTarget, path.join(worktree, 'dangling.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: 'dangling.txt',
      content: 'PWNED',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('File path is outside worktree');
    // The write must not have materialized the outside file.
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it('file:write through a dangling symlink to a not-yet-existing path INSIDE the worktree works', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const insideTarget = path.join(worktree, 'future.txt');
    fs.symlinkSync(insideTarget, path.join(worktree, 'dangling-in.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: 'dangling-in.txt',
      content: 'created via link',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    // The write landed at the (in-worktree) link target.
    expect(fs.readFileSync(insideTarget, 'utf-8')).toBe('created via link');
  });

  it('file:read follows a legitimate symlink that stays within the worktree', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const real = path.join(worktree, 'real.txt');
    fs.writeFileSync(real, 'INSIDE\n');
    fs.symlinkSync(real, path.join(worktree, 'link.txt'));

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: 'link.txt',
    })) as { success: boolean; content?: string };

    expect(result.success).toBe(true);
    expect(result.content).toBe('INSIDE\n');
  });

  it('file:read reads a normal in-worktree file unaffected by the guard', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, 'note.txt'), 'hello\n');

    const handlers = handlersForWorktree(worktree);
    const result = (await invoke(handlers, 'file:read', {
      sessionId: 's1',
      filePath: 'note.txt',
    })) as { success: boolean; content?: string };

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello\n');
  });
});

describe('file:write nested directory creation', () => {
  it('creates missing parent directories under the worktree', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );

    const rel = path.join('deep', 'nested', 'dir', 'file.txt');
    const result = (await invoke(handlers, 'file:write', {
      sessionId: 's1',
      filePath: rel,
      content: 'hello nested',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(worktree, rel), 'utf-8')).toBe('hello nested');
  });
});

describe('file:readAtRevision', () => {
  it('returns empty content when the file does not exist at the revision', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    initRepo(worktree);
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );

    // never-committed.txt was never in HEAD -> git show fails with "does not exist".
    const result = (await invoke(handlers, 'file:readAtRevision', {
      sessionId: 's1',
      filePath: 'never-committed.txt',
      revision: 'HEAD',
    })) as { success: boolean; content?: string };

    expect(result.success).toBe(true);
    expect(result.content).toBe('');
  });

  it('returns the committed content for a file that exists at HEAD', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    initRepo(worktree, 'HEAD CONTENT\n');
    // Dirty the working copy — readAtRevision must reflect HEAD, not the edit.
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'WORKING EDIT\n');
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );

    const result = (await invoke(handlers, 'file:readAtRevision', {
      sessionId: 's1',
      filePath: 'tracked.txt',
      revision: 'HEAD',
    })) as { success: boolean; content?: string };

    expect(result.success).toBe(true);
    expect(result.content).toBe('HEAD CONTENT\n');
  });

  it('surfaces a bad-revision git error as success:false (not an empty-content masquerade)', async () => {
    const worktree = path.join(tmpRoot, 'wt');
    fs.mkdirSync(worktree);
    initRepo(worktree);
    const session = { id: 's1', worktreePath: worktree } as unknown as Session;
    const { ipcMain, handlers } = makeHandlerCapture();
    registerFileHandlers(
      ipcMain as unknown as Parameters<typeof registerFileHandlers>[0],
      servicesFor(session),
    );

    const result = (await invoke(handlers, 'file:readAtRevision', {
      sessionId: 's1',
      filePath: 'tracked.txt',
      // Neutral bad ref: its own text must NOT contain the handler's
      // "does not exist"/"bad file" empty-content sentinels.
      revision: 'zzznope',
    })) as { success: boolean; content?: string; error?: string };

    // A genuine git failure (unknown revision) is NOT the "absent at revision"
    // empty-content case — it returns success:false with an error.
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
