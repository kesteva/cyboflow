/**
 * Unit tests for ClaudeCodeManager permission-mode enforcement.
 *
 * Security invariant: every Cyboflow run must go through the permission socket.
 * --dangerously-skip-permissions is banned; ignore mode is a hard error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeManager } from '../panels/claude/claudeCodeManager';
import type { SessionManager } from '../sessionManager';
import type { ConfigManager } from '../configManager';

// ---------------------------------------------------------------------------
// Helpers / minimal mocks
// ---------------------------------------------------------------------------

/** Thin subclass that exposes the protected buildCommandArgs for testing. */
class TestableClaudeCodeManager extends ClaudeCodeManager {
  public callBuildCommandArgs(
    options: Parameters<ClaudeCodeManager['buildCommandArgs']>[0]
  ): string[] {
    return this.buildCommandArgs(options);
  }
}

function makeMinimalSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn().mockReturnValue(undefined),
    getPanelClaudeSessionId: vi.fn().mockReturnValue(undefined),
    getProjectById: vi.fn().mockReturnValue(undefined),
  } as unknown as SessionManager;
}

function makeConfigManager(defaultPermissionMode: 'approve' | 'ignore' = 'approve'): ConfigManager {
  return {
    getConfig: vi.fn().mockReturnValue({ defaultPermissionMode }),
    getSystemPromptAppend: vi.fn().mockReturnValue(undefined),
  } as unknown as ConfigManager;
}

const BASE_OPTIONS = {
  panelId: 'panel-1',
  sessionId: 'session-1',
  worktreePath: '/tmp/worktree',
  prompt: 'hello',
  isResume: false,
  mcpConfigPath: '/tmp/mcp-config.json',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager permission-mode enforcement', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = makeMinimalSessionManager();
  });

  // AC-1: approve + permissionIpcPath set → argv has --permission-prompt-tool, no --dangerously-skip-permissions
  it('approve mode with permissionIpcPath set: argv contains --permission-prompt-tool and NOT --dangerously-skip-permissions', () => {
    const configManager = makeConfigManager('approve');
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      configManager,
      '/tmp/cyboflow.sock'
    );

    const argv = manager.callBuildCommandArgs({
      ...BASE_OPTIONS,
      permissionMode: 'approve',
    });

    expect(argv).toContain('--permission-prompt-tool');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  // AC-2: approve + permissionIpcPath null → throws with message containing "permissionIpcPath"
  it('approve mode with permissionIpcPath null: throws an error naming permissionIpcPath', () => {
    const configManager = makeConfigManager('approve');
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      configManager,
      null
    );

    expect(() =>
      manager.callBuildCommandArgs({
        ...BASE_OPTIONS,
        permissionMode: 'approve',
      })
    ).toThrow(/permissionIpcPath/i);
  });

  // AC-3: ignore mode → throws with message matching /Cyboflow runs require approve mode/
  it('ignore mode: throws with "Cyboflow runs require approve mode"', () => {
    const configManager = makeConfigManager('approve');
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      configManager,
      '/tmp/cyboflow.sock'
    );

    expect(() =>
      manager.callBuildCommandArgs({
        ...BASE_OPTIONS,
        permissionMode: 'ignore',
      })
    ).toThrow(/Cyboflow runs require approve mode/i);
  });

  // AC-4: no explicit permissionMode (relies on config default) → behaves as approve mode
  it('no explicit permissionMode with permissionIpcPath set: behaves as approve (contains --permission-prompt-tool)', () => {
    // Config default is 'approve', no permissionMode arg passed
    const configManager = makeConfigManager('approve');
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      configManager,
      '/tmp/cyboflow.sock'
    );

    const argv = manager.callBuildCommandArgs({
      ...BASE_OPTIONS,
      // permissionMode intentionally omitted — falling through to config default
    });

    expect(argv).toContain('--permission-prompt-tool');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });
});
