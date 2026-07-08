import { describe, expect, it } from 'vitest';
import { CodexPtyManager, codexPermissionFlagsForMode } from '../codexPtyManager';
import type { SessionManager } from '../../../sessionManager';

class TestableCodexPtyManager extends CodexPtyManager {
  callBuildCommandArgs(options: Record<string, unknown>): string[] {
    return this.buildCommandArgs({
      panelId: 'panel-1',
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      prompt: '',
      ...options,
    });
  }
}

function makeSessionManager(mode?: string): SessionManager {
  return {
    getDbSession: () => ({ agent_permission_mode: mode }),
  } as unknown as SessionManager;
}

describe('codexPermissionFlagsForMode', () => {
  it('maps Cyboflow permission modes to Codex sandbox and approval flags', () => {
    expect(codexPermissionFlagsForMode('default')).toEqual({
      sandbox: 'read-only',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('acceptEdits')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('auto')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('dontAsk')).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });
});

describe('CodexPtyManager.buildCommandArgs', () => {
  it('uses the session agent permission mode and passes model plus prompt after --', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'gpt-5.5', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-5.5',
      '--',
      'implement this',
    ]);
  });

  it('maps legacy ignore to dontAsk for compatibility with old session rows', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());

    expect(manager.callBuildCommandArgs({ permissionMode: 'ignore' })).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
    ]);
  });
});
