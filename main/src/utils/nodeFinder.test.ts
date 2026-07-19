/**
 * Unit tests for findNodeExecutable's memoization (F8): the resolved Node.js
 * path is cached at module scope so a per-spawn/per-turn caller doesn't
 * re-run the whole PATH/common-locations/`which` search every time. A genuine
 * resolution failure (the bare 'node' fallback) must NOT be cached, so a
 * later call can retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'fs';

vi.mock('./shellPath', () => ({ findExecutableInPath: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('child_process', () => ({ execSync: vi.fn() }));
// fs's own exports are non-configurable, so vi.spyOn can't redefine them
// directly — wrap the real implementations in vi.fn() instead (see shellPath.test.ts).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), accessSync: vi.fn(actual.accessSync) };
});

import { execSync } from 'child_process';
import { findExecutableInPath } from './shellPath';
import { findNodeExecutable, clearNodeExecutableCache } from './nodeFinder';

const mockFindExecutableInPath = findExecutableInPath as unknown as Mock;
const mockExecSync = execSync as unknown as Mock;

describe('findNodeExecutable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNodeExecutableCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('memoizes the resolved path: a second call does not re-probe fs.accessSync or PATH', async () => {
    // Not found in PATH, so resolution falls through to the common-locations
    // list, which probes fs.accessSync on candidates that fs.existsSync reports.
    mockFindExecutableInPath.mockReturnValue(null);
    vi.mocked(fs.existsSync).mockImplementation((p) => p === '/usr/local/bin/node');
    vi.mocked(fs.accessSync).mockImplementation((p) => {
      if (p === '/usr/local/bin/node') return undefined;
      throw new Error('EACCES');
    });

    const first = await findNodeExecutable();
    expect(first).toBe('/usr/local/bin/node');
    expect(fs.accessSync).toHaveBeenCalledTimes(1);
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(1);

    const second = await findNodeExecutable();
    expect(second).toBe('/usr/local/bin/node');
    // Cached — neither probe ran again.
    expect(fs.accessSync).toHaveBeenCalledTimes(1);
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(1);
  });

  it('does not cache a resolution failure — a later call retries', async () => {
    mockFindExecutableInPath.mockReturnValue(null);
    vi.mocked(fs.existsSync).mockReturnValue(false); // no common install location exists
    mockExecSync.mockImplementation(() => {
      throw new Error('which: node not found'); // `which node` fails too
    });

    const first = await findNodeExecutable();
    expect(first).toBe('node'); // bare fallback — resolution genuinely failed
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(1);

    const second = await findNodeExecutable();
    expect(second).toBe('node');
    // Not cached — the search ran again on the second call.
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(2);
  });

  it('clearNodeExecutableCache forces re-resolution', async () => {
    mockFindExecutableInPath.mockReturnValueOnce('/opt/homebrew/bin/node');
    const first = await findNodeExecutable();
    expect(first).toBe('/opt/homebrew/bin/node');
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(1);

    mockFindExecutableInPath.mockReturnValueOnce('/usr/local/bin/node');
    clearNodeExecutableCache();
    const second = await findNodeExecutable();
    expect(second).toBe('/usr/local/bin/node');
    expect(mockFindExecutableInPath).toHaveBeenCalledTimes(2);
  });
});
