/**
 * Unit tests for generateQuickWorktreeBranchName — the pure UTC-timestamp
 * helper exported from session.ts for the sessions:create-quick IPC handler.
 *
 * Three tests covering:
 *  1. Format invariance — fixed Date produces the expected quick-YYYYMMDD-HHmmss string.
 *  2. UTC correctness — the result matches the /^quick-\d{8}-\d{6}$/ pattern for
 *     an arbitrary default call, confirming UTC getters are used.
 *  3. Zero-padding — month/day/hour/minute/second components are two-digit padded.
 *
 * Follows the same pattern as sessionJsonMessages.test.ts: stub the Electron
 * surface so session.ts can load in a plain Node.js/Vitest environment, then
 * import only the pure helper under test.
 */

import { describe, it, expect, vi } from 'vitest';

// Electron is imported transitively via session.ts → panelManager etc.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// panelManager uses IPC at module load time — stub it.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
  },
}));

import { generateQuickWorktreeBranchName } from '../session';

describe('generateQuickWorktreeBranchName', () => {
  it('returns quick-YYYYMMDD-HHmmss for a fixed UTC date', () => {
    // Date.UTC(2026, 4, 23, 15, 27, 58) → 2026-05-23T15:27:58Z (month is 0-indexed)
    const result = generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 4, 23, 15, 27, 58)));
    expect(result).toBe('quick-20260523-152758');
  });

  it('matches the /^quick-\\d{8}-\\d{6}$/ pattern for a default (now) call', () => {
    const result = generateQuickWorktreeBranchName();
    expect(result).toMatch(/^quick-\d{8}-\d{6}$/);
  });

  it('zero-pads month, day, hour, minute, and second to two digits', () => {
    // Date.UTC(2026, 0, 5, 3, 4, 5) → 2026-01-05T03:04:05Z
    // month 0 → '01', day 5 → '05', hour 3 → '03', minute 4 → '04', second 5 → '05'
    const result = generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)));
    expect(result).toBe('quick-20260105-030405');
  });
});
