/**
 * Unit tests for dockBadgeService.
 *
 * Verifies three behaviours required by TASK-407 acceptance criteria:
 *   1. Positive count → badge shows the string representation.
 *   2. Zero count    → badge is cleared (empty string, not '0').
 *   3. Negative count → clamped to 0, badge is cleared.
 *
 * The global test setup (main/src/test/setup.ts) mocks the `electron` module
 * but does not include `app.dock`. This file overrides the `electron` mock via
 * `vi.mock` (which is hoisted before imports) so `app.dock.setBadge` is
 * available when `dockBadgeService` is imported.
 *
 * `process.platform` is stubbed to 'darwin' via property descriptor so the
 * platform guard inside `setBadgeCount` does not short-circuit.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: variables defined here are available inside vi.mock factories
// because Vitest hoists both vi.hoisted() calls and vi.mock() calls to the
// top of the module before any other code runs.
// ---------------------------------------------------------------------------
const { mockSetBadge } = vi.hoisted(() => ({
  mockSetBadge: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Override the electron mock to include app.dock before dockBadgeService loads.
// vi.mock is hoisted — this runs before any import in this file.
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Crystal'),
    getVersion: vi.fn(() => '0.1.0'),
    dock: {
      setBadge: mockSetBadge,
    },
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

import { dockBadgeService } from '../dockBadgeService';

// ---------------------------------------------------------------------------
// Stub process.platform to 'darwin' for all tests so the platform guard in
// setBadgeCount is satisfied regardless of the CI host OS.
// ---------------------------------------------------------------------------
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dockBadgeService', () => {
  beforeEach(() => {
    mockSetBadge.mockClear();
  });

  it('setBadgeCount(3) calls app.dock.setBadge with "3"', () => {
    dockBadgeService.setBadgeCount(3);
    expect(mockSetBadge).toHaveBeenCalledOnce();
    expect(mockSetBadge).toHaveBeenCalledWith('3');
  });

  it('setBadgeCount(0) calls app.dock.setBadge with "" (clears badge)', () => {
    dockBadgeService.setBadgeCount(0);
    expect(mockSetBadge).toHaveBeenCalledOnce();
    expect(mockSetBadge).toHaveBeenCalledWith('');
  });

  it('setBadgeCount(-5) clamps to 0 and calls app.dock.setBadge with ""', () => {
    dockBadgeService.setBadgeCount(-5);
    expect(mockSetBadge).toHaveBeenCalledOnce();
    expect(mockSetBadge).toHaveBeenCalledWith('');
  });
});
