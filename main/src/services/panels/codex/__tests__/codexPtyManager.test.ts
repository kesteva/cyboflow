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

  captureConcurrentContext(
    context: { panelId: string; sessionId: string; runId: string },
    delayMs: number,
  ): Promise<{ panelId: string; sessionId: string; runId: string } | undefined> {
    return this.runWithPtySpawnContext(context, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return this.getActivePtySpawnContext();
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

  it('omits --model when a stale Claude model value reaches Codex PTY', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'opus', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
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

describe('CodexPtyManager concurrent spawn context', () => {
  it('keeps interleaved PTY spawn provenance isolated', async () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const first = { panelId: 'panel-1', sessionId: 'session-1', runId: 'run-1' };
    const second = { panelId: 'panel-2', sessionId: 'session-2', runId: 'run-2' };

    const [capturedFirst, capturedSecond] = await Promise.all([
      manager.captureConcurrentContext(first, 10),
      manager.captureConcurrentContext(second, 0),
    ]);

    expect(capturedFirst).toEqual(first);
    expect(capturedSecond).toEqual(second);
  });
});
