/**
 * Regression guard: ConfigManager must default permissionMode to 'approve'
 * (TASK-569).  Tests both the DEFAULT_CONFIG embedded in the constructor and
 * the getSessionCreationPreferences() inline fallback that fires when
 * this.config.sessionCreationPreferences is falsy.
 *
 * No initialize() call is made — no file I/O occurs.
 */
import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../configManager';

describe('ConfigManager permissionMode default', () => {
  it('getSessionCreationPreferences returns permissionMode "approve" on a fresh instance', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    const prefs = mgr.getSessionCreationPreferences();
    expect(prefs.claudeConfig?.permissionMode).toBe('approve');
  });

  it('DEFAULT_CONFIG embedded in constructor uses permissionMode "approve"', () => {
    // Reach the inline object via getConfig() — it mirrors the constructor literal.
    const mgr = new ConfigManager('/tmp/test-git-path');
    const config = mgr.getConfig();
    expect(config.sessionCreationPreferences?.claudeConfig?.permissionMode).toBe('approve');
  });

  it('inline fallback in getSessionCreationPreferences uses permissionMode "approve"', () => {
    // Force the || branch by nulling out the stored preference.
    const mgr = new ConfigManager('/tmp/test-git-path');
    // Cast to access internals for testing purposes.
    (mgr as unknown as { config: { sessionCreationPreferences: undefined } }).config.sessionCreationPreferences = undefined;
    const prefs = mgr.getSessionCreationPreferences();
    expect(prefs.claudeConfig?.permissionMode).toBe('approve');
  });

  it('top-level defaultPermissionMode in DEFAULT_CONFIG is "approve" (Settings.tsx reads this field)', () => {
    // Settings.tsx fetches config via API.config.get() and falls back with
    // data.defaultPermissionMode || 'approve'.  Regression guard: the
    // constructor DEFAULT_CONFIG must not ship 'ignore' as the stored default.
    const mgr = new ConfigManager('/tmp/test-git-path');
    const config = mgr.getConfig();
    expect(config.defaultPermissionMode).toBe('approve');
  });
});

describe('ConfigManager getDefaultAgentPermissionMode', () => {
  it('floors to "default" when defaultAgentPermissionMode is unset', () => {
    // Additive pattern: the constructor must NOT seed defaultAgentPermissionMode,
    // so a fresh instance has it undefined and the getter floors to 'default'.
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().defaultAgentPermissionMode).toBeUndefined();
    expect(mgr.getDefaultAgentPermissionMode()).toBe('default');
  });

  it('returns the configured value when defaultAgentPermissionMode is set', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    (
      mgr as unknown as { config: { defaultAgentPermissionMode: 'acceptEdits' } }
    ).config.defaultAgentPermissionMode = 'acceptEdits';
    expect(mgr.getDefaultAgentPermissionMode()).toBe('acceptEdits');
  });
});
