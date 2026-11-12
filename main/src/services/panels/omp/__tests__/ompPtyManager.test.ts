import { describe, expect, it } from 'vitest';
import { OmpPtyManager, assertOmpRequiredSpawnFlags, ompApprovalModeForMode } from '../ompPtyManager';
import type { SessionManager } from '../../../sessionManager';

class TestableOmpPtyManager extends OmpPtyManager {
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

  // Test accessors for the private per-panel bookkeeping cleanupCliResources
  // touches, so its panel-scoping can be verified without a real PTY spawn.
  private maps(): { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> } {
    return this as unknown as { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> };
  }
  seedPanelRunId(panelId: string, runId: string): void {
    this.maps().panelRunIds.set(panelId, runId);
  }
  seedPtyBacklog(runId: string, data: string): void {
    this.maps().ptyBacklog.set(runId, data);
  }
  hasPanelRunId(panelId: string): boolean {
    return this.maps().panelRunIds.has(panelId);
  }
  hasPtyBacklog(runId: string): boolean {
    return this.maps().ptyBacklog.has(runId);
  }
  callCleanupCliResources(panelId: string, sessionId: string): Promise<void> {
    return (this as unknown as { cleanupCliResources(p: string, s: string): Promise<void> }).cleanupCliResources(
      panelId,
      sessionId,
    );
  }
}

function makeSessionManager(mode?: string): SessionManager {
  return {
    getDbSession: () => ({ agent_permission_mode: mode }),
  } as unknown as SessionManager;
}

describe('ompApprovalModeForMode', () => {
  it('maps every non-dontAsk mode to always-ask — never OMP\'s over-broad write tier', () => {
    expect(ompApprovalModeForMode('default')).toBe('always-ask');
    expect(ompApprovalModeForMode('acceptEdits')).toBe('always-ask');
    expect(ompApprovalModeForMode('auto')).toBe('always-ask');
  });

  it('maps dontAsk to yolo', () => {
    expect(ompApprovalModeForMode('dontAsk')).toBe('yolo');
  });
});

describe('OmpPtyManager.buildCommandArgs', () => {
  it.each(['default', 'acceptEdits', 'auto'])(
    'always emits --approval-mode always-ask, --no-extensions, --no-skills for %s mode (never write)',
    (mode) => {
      const manager = new TestableOmpPtyManager(makeSessionManager(mode));

      expect(manager.callBuildCommandArgs({})).toEqual([
        '--approval-mode',
        'always-ask',
        '--no-extensions',
        '--no-skills',
      ]);
    },
  );

  it('maps dontAsk to yolo', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('dontAsk'));

    expect(manager.callBuildCommandArgs({})).toEqual([
      '--approval-mode',
      'yolo',
      '--no-extensions',
      '--no-skills',
    ]);
  });

  it('maps legacy ignore to dontAsk for compatibility with old session rows', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager());

    expect(manager.callBuildCommandArgs({ permissionMode: 'ignore' })).toEqual([
      '--approval-mode',
      'yolo',
      '--no-extensions',
      '--no-skills',
    ]);
  });

  it('passes the model through VERBATIM — no per-provider alias resolution', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('default'));

    expect(manager.callBuildCommandArgs({ model: 'anthropic/claude-opus-5' })).toEqual([
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
      '--model',
      'anthropic/claude-opus-5',
    ]);
  });

  it('omits --model when none is selected', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('default'));

    expect(manager.callBuildCommandArgs({})).not.toContain('--model');
  });

  it('appends --continue only when isContinue is set', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('default'));

    expect(manager.callBuildCommandArgs({ isContinue: true })).toEqual([
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
      '--continue',
    ]);
    expect(manager.callBuildCommandArgs({})).not.toContain('--continue');
  });

  it('passes a non-empty prompt as the trailing MESSAGES argument after --', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('default'));

    expect(manager.callBuildCommandArgs({ prompt: 'implement this' })).toEqual([
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
      '--',
      'implement this',
    ]);
  });

  it('omits the trailing prompt args entirely for an empty/whitespace prompt', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('default'));

    expect(manager.callBuildCommandArgs({ prompt: '   ' })).toEqual([
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
    ]);
  });

  it('emits every flag together in the documented order for a full option set', () => {
    const manager = new TestableOmpPtyManager(makeSessionManager('acceptEdits'));

    expect(
      manager.callBuildCommandArgs({
        model: 'openrouter/deepseek-v4',
        isContinue: true,
        prompt: 'continue where we left off',
      }),
    ).toEqual([
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-skills',
      '--model',
      'openrouter/deepseek-v4',
      '--continue',
      '--',
      'continue where we left off',
    ]);
  });

  it('every real buildCommandArgs output across every mode satisfies the spawn-flag assertion', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk'] as const) {
      const args = new TestableOmpPtyManager(makeSessionManager(mode)).callBuildCommandArgs({});
      expect(() => assertOmpRequiredSpawnFlags(args)).not.toThrow();
    }
  });
});

describe('assertOmpRequiredSpawnFlags', () => {
  it('is a no-op when every required flag is present', () => {
    expect(() =>
      assertOmpRequiredSpawnFlags(['--approval-mode', 'always-ask', '--no-extensions', '--no-skills']),
    ).not.toThrow();
  });

  it('SECURITY INVARIANT: throws when a required lockdown flag is missing — the regression this exists to catch', () => {
    expect(() => assertOmpRequiredSpawnFlags(['--approval-mode', 'always-ask', '--no-extensions'])).toThrow(
      /dropped required flag/,
    );
    expect(() => assertOmpRequiredSpawnFlags(['--approval-mode', 'always-ask', '--no-extensions'])).toThrow(
      /--no-skills/,
    );
  });

  it('reports every missing flag, not just the first', () => {
    expect(() => assertOmpRequiredSpawnFlags([])).toThrow(/--approval-mode.*--no-extensions.*--no-skills/);
  });
});

describe('OmpPtyManager concurrent spawn context', () => {
  it('keeps interleaved PTY spawn provenance isolated', async () => {
    const manager = new TestableOmpPtyManager(makeSessionManager());
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

describe('OmpPtyManager.cleanupCliResources', () => {
  it('scopes cleanup to the exiting panel only — a sibling panel sharing the same session keeps its bookkeeping', async () => {
    // Regression: cleanupCliResources used to scan `this.processes` for every
    // panel matching the SESSION id and delete each one's panelRunIds/
    // ptyBacklog entry, so one panel's exit tore down a still-live sibling
    // panel's bookkeeping too (both panels in one session share the id).
    const manager = new TestableOmpPtyManager(makeSessionManager());
    const sharedSessionId = 'session-shared';
    manager.seedPanelRunId('panel-A', 'run-A');
    manager.seedPtyBacklog('run-A', 'A output');
    manager.seedPanelRunId('panel-B', 'run-B');
    manager.seedPtyBacklog('run-B', 'B output');

    await manager.callCleanupCliResources('panel-A', sharedSessionId);

    // Only panel-A's bookkeeping is gone.
    expect(manager.hasPanelRunId('panel-A')).toBe(false);
    expect(manager.hasPtyBacklog('run-A')).toBe(false);
    // panel-B (still live, same session) is untouched.
    expect(manager.hasPanelRunId('panel-B')).toBe(true);
    expect(manager.hasPtyBacklog('run-B')).toBe(true);
  });
});
