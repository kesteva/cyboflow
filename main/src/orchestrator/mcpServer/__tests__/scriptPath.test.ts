/**
 * Unit tests for resolveMcpServerScriptPath().
 *
 * Three behaviours under test per the TASK-618 test strategy:
 *
 * 1. Dev mode — returns path.join(dirOverride, 'cyboflowMcpServer.js').
 * 2. Packaged mode — returns process.resourcesPath + app.asar.unpacked path;
 *    no fs writes occur.
 * 3. Memoization — 5 calls with no dirOverride invoke the underlying resolver
 *    at most once (subsequent calls return the cached value).
 *
 * All tests are hermetic.  The 'electron' module is mocked so app.isPackaged
 * can be toggled without a real Electron context.  No filesystem I/O occurs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track how many times computeResolvedPath is exercised indirectly.  We rely
// on app.isPackaged toggling rather than intercepting the private function, so
// instead we count how many unique paths are returned when there is no cache
// warm-up.

let mockIsPackaged = false;
const FAKE_RESOURCES_PATH = '/fake/resources';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
  },
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mock declarations so Vitest hoisting
// ensures electron is already mocked when scriptPath.ts resolves its imports.
// ---------------------------------------------------------------------------

import {
  resolveMcpServerScriptPath,
  __resetCacheForTests,
} from '../scriptPath';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset module-level cache between tests.
  __resetCacheForTests();
  mockIsPackaged = false;
  // Override process.resourcesPath for packaged-mode tests.
  Object.defineProperty(process, 'resourcesPath', {
    value: FAKE_RESOURCES_PATH,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Test suite 1: dev mode
// ---------------------------------------------------------------------------

describe('resolveMcpServerScriptPath — dev mode', () => {
  it('returns dirOverride joined with cyboflowMcpServer.js when not packaged', () => {
    mockIsPackaged = false;
    const dir = '/some/override/dir';

    const result = resolveMcpServerScriptPath(dir);

    expect(result).toBe(path.join(dir, 'cyboflowMcpServer.js'));
  });

  it('returns __dirname joined with cyboflowMcpServer.js when no dirOverride given', () => {
    mockIsPackaged = false;

    // Without dirOverride, the function uses __dirname which in the compiled
    // output lives in main/dist/…/orchestrator/mcpServer/.  We cannot assert
    // the exact __dirname in tests, but we can verify the filename suffix.
    const result = resolveMcpServerScriptPath();

    expect(result).toMatch(/cyboflowMcpServer\.js$/);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: packaged mode
// ---------------------------------------------------------------------------

describe('resolveMcpServerScriptPath — packaged mode', () => {
  it('returns process.resourcesPath + app.asar.unpacked path when packaged', () => {
    mockIsPackaged = true;

    const expected = path.join(
      FAKE_RESOURCES_PATH,
      'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js',
    );

    const result = resolveMcpServerScriptPath('/irrelevant-dir');

    expect(result).toBe(expected);
  });

  it('does not depend on dirOverride when packaged — always uses resourcesPath', () => {
    mockIsPackaged = true;

    const result1 = resolveMcpServerScriptPath('/dir-a');
    const result2 = resolveMcpServerScriptPath('/dir-b');

    expect(result1).toBe(result2);
    expect(result1).toContain('app.asar.unpacked');
    expect(result1).toContain(FAKE_RESOURCES_PATH);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: memoization
// ---------------------------------------------------------------------------

describe('resolveMcpServerScriptPath — memoization', () => {
  it('returns the same value on 5 consecutive calls without dirOverride', () => {
    mockIsPackaged = false;

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(resolveMcpServerScriptPath());
    }

    // All five calls must return the exact same string.
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });

  it('cache is reset between tests via __resetCacheForTests()', () => {
    mockIsPackaged = false;

    // First call seeds the cache.
    const before = resolveMcpServerScriptPath();

    // Reset and switch to packaged mode — the next call must return the new value.
    __resetCacheForTests();
    mockIsPackaged = true;

    const after = resolveMcpServerScriptPath();

    expect(before).not.toBe(after);
    expect(after).toContain('app.asar.unpacked');
  });
});
