/**
 * Behavioral tests for git:restore in main/src/ipc/fileOps.ts (createFileOps —
 * backs the `workspaceFiles` tRPC router).
 *
 * Uses a REAL temporary git repo, because the assertion is about a real git
 * effect: git:restore discards uncommitted tracked changes AND removes
 * untracked files (the irreversible reset --hard/clean -fd path); a missing
 * session returns success:false with no mutation (there is nothing to mutate).
 *
 * Project-scoped containment is covered in fileProjectContainment.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

import { createFileOps } from '../fileOps';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';

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
    const ops = createFileOps(servicesFor(session));

    const result = await ops.gitRestore({ sessionId: 's1' });

    expect(result.success).toBe(true);
    // reset --hard restored the committed content...
    expect(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf-8')).toBe('committed\n');
    // ...and clean -fd removed the untracked file.
    expect(fs.existsSync(path.join(wt, 'scratch.tmp'))).toBe(false);
    // Working tree is clean afterward.
    expect(git(wt, 'status', '--porcelain').trim()).toBe('');
  });

  it('returns success:false with no git effect when the session is missing', async () => {
    const ops = createFileOps(servicesFor(undefined));

    const result = await ops.gitRestore({ sessionId: 'ghost' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain('Session not found');
  });
});
