/**
 * Unit tests for findExecutableInPath (F8): the per-PATH-directory probe must
 * use fs.accessSync in-process rather than forking a `test -x` /bin/sh
 * subprocess per candidate directory per call.
 *
 * getShellPath()'s own PATH-detection machinery is exercised for real (it's
 * cheap/deterministic once SHELL points at a real, existing shell and
 * child_process.execSync is mocked), so the tests below drive the whole
 * findExecutableInPath() call rather than reaching into private state.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('child_process', () => ({ execSync: vi.fn() }));
// Partial-mock fs: only accessSync is controlled per-test (the probe under
// test); everything else (existsSync, readdirSync, ...) stays real so
// getShellPath()'s additional-paths detection behaves normally. fs's own
// exports are non-configurable, so vi.spyOn can't redefine them directly —
// wrap the real implementation in vi.fn() instead.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, accessSync: vi.fn(actual.accessSync) };
});

import { execSync } from 'child_process';
import { findExecutableInPath, clearShellPathCache } from './shellPath';

const mockExecSync = execSync as unknown as Mock;

const TEST_DIR = '/mock/bin/dir';

describe('findExecutableInPath', () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    clearShellPathCache();
    process.env.PATH = TEST_DIR;
    // A real, existing path on this (macOS) host — lets ShellDetector resolve
    // the shell from process.env.SHELL directly, without its own execSync/dscl call.
    process.env.SHELL = '/bin/zsh';
    process.env.NODE_ENV = 'test';
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('echo $PATH')) {
        return `${TEST_DIR}\n`;
      }
      // npm bin -g / yarn global bin / which node etc: simulate "not found".
      throw new Error('not found');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
    process.env.SHELL = originalShell;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('resolves an executable via fs.accessSync without spawning a subprocess per directory', () => {
    const target = path.join(TEST_DIR, 'mytool');
    vi.mocked(fs.accessSync).mockImplementation((p) => {
      if (p === target) return undefined;
      throw new Error('ENOENT');
    });

    const result = findExecutableInPath('mytool');

    expect(result).toBe(target);
    // The fix replaces execSync('test -x "<dir>/<name>"') — assert no such
    // subprocess was ever spawned during resolution.
    expect(
      mockExecSync.mock.calls.some(([cmd]) => typeof cmd === 'string' && cmd.includes('test -x')),
    ).toBe(false);
  });

  it('returns null when the executable is not found (or not executable) in any PATH directory', () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = findExecutableInPath('missingtool');

    expect(result).toBeNull();
    expect(fs.accessSync).toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => typeof cmd === 'string' && cmd.includes('test -x')),
    ).toBe(false);
  });
});
