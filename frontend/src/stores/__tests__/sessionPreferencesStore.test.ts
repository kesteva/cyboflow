/**
 * Unit test asserting that the sessionPreferencesStore default permissionMode
 * is 'approve', not 'ignore' (TASK-569 regression guard).
 *
 * The API module is mocked so the store can be imported in a jsdom environment
 * without a live Electron IPC bridge.  The test only inspects the initial
 * Zustand state — no async loadPreferences() call is made.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the API module before importing the store, so the store module evaluates
// without an Electron IPC bridge.
vi.mock('../../utils/api', () => ({
  API: {
    config: {
      getSessionPreferences: vi.fn().mockResolvedValue({ success: false }),
      updateSessionPreferences: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

import { useSessionPreferencesStore } from '../sessionPreferencesStore';

describe('sessionPreferencesStore default permissionMode', () => {
  it('defaults permissionMode to "approve" on fresh mount', () => {
    const mode = useSessionPreferencesStore.getState().preferences.claudeConfig.permissionMode;
    expect(mode).toBe('approve');
  });
});
