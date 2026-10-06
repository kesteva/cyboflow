/**
 * Realpath containment for the PROJECT-scoped `search` op in
 * main/src/ipc/fileOps.ts: the renderer-supplied pattern's leading segments
 * pick the glob root, so `@../../etc/pass` must not walk that root out of the
 * project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

import { createFileOps } from '../fileOps';
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
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices);
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
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
    // Relative paths come back in the platform's native separators
    // (path.relative), so build the expectation the same way.
    expect(res.success && res.files.some((f) => f.path === path.join('src', 'findme.ts'))).toBe(true);
  });
});
