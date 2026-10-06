/**
 * Regression guard: ConfigManager must default permissionMode to 'approve'
 * (TASK-569) in the DEFAULT_CONFIG embedded in the constructor.
 *
 * No initialize() call is made — no file I/O occurs.
 */
import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../configManager';

describe('ConfigManager permissionMode default', () => {
  it('top-level defaultPermissionMode in DEFAULT_CONFIG is "approve" (Settings.tsx reads this field)', () => {
    // Settings.tsx fetches config via API.config.get() and falls back with
    // data.defaultPermissionMode || 'approve'.  Regression guard: the
    // constructor DEFAULT_CONFIG must not ship 'ignore' as the stored default.
    const mgr = new ConfigManager();
    const config = mgr.getConfig();
    expect(config.defaultPermissionMode).toBe('approve');
  });
});

describe('ConfigManager getDefaultAgentPermissionMode', () => {
  it('floors to "default" when defaultAgentPermissionMode is unset', () => {
    // Additive pattern: the constructor must NOT seed defaultAgentPermissionMode,
    // so a fresh instance has it undefined and the getter floors to 'default'.
    const mgr = new ConfigManager();
    expect(mgr.getConfig().defaultAgentPermissionMode).toBeUndefined();
    expect(mgr.getDefaultAgentPermissionMode()).toBe('default');
  });

  it('returns the configured value when defaultAgentPermissionMode is set', () => {
    const mgr = new ConfigManager();
    (
      mgr as unknown as { config: { defaultAgentPermissionMode: 'acceptEdits' } }
    ).config.defaultAgentPermissionMode = 'acceptEdits';
    expect(mgr.getDefaultAgentPermissionMode()).toBe('acceptEdits');
  });
});
