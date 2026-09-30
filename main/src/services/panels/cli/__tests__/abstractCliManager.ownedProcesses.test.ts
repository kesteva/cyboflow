/**
 * AbstractCliManager.listOwnedProcesses — the read-only live-PID map the process
 * snapshot service unions with its one shared `ps` scan. Uses fake ptys (no real
 * processes); exit is driven through the real setupProcessHandlers exit handler.
 */
import { describe, it, expect } from 'vitest';
import { AbstractCliManager } from '../AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConversationMessage } from '../../../../database/models';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

type ExitCb = (e: { exitCode: number; signal?: number }) => void | Promise<void>;

interface FakePty {
  pty: IPty;
  emitExit(): Promise<void>;
}

function makeFakePty(pid: number): FakePty {
  const exitCbs: ExitCb[] = [];
  const pty = {
    pid,
    onData: () => ({ dispose() {} }),
    onExit: (cb: ExitCb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
  } as unknown as IPty;
  return {
    pty,
    emitExit: async () => {
      await Promise.all(exitCbs.map((cb) => cb({ exitCode: 0 })));
    },
  };
}

class TestCliManager extends AbstractCliManager {
  constructor() {
    super({} as unknown as SessionManager, undefined, undefined);
  }
  protected getCliToolName(): string {
    return 'testcli';
  }
  protected getAgentProvider(): 'claude' | 'codex' {
    return 'claude';
  }
  protected async testCliAvailability(): Promise<{ available: boolean }> {
    return { available: true };
  }
  protected buildCommandArgs(): string[] {
    return [];
  }
  protected async getCliExecutablePath(): Promise<string> {
    return 'sh';
  }
  protected parseCliOutput(): [] {
    return [];
  }
  protected async initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  protected async cleanupCliResources(): Promise<void> {
    return;
  }
  protected async getCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  async startPanel(): Promise<void> {
    return;
  }
  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    return;
  }
  async stopPanel(): Promise<void> {
    return;
  }
  async restartPanelWithHistory(): Promise<void> {
    return;
  }

  /** Register a fake pty exactly as startPanel does (record + exit handlers). */
  register(fake: FakePty, panelId: string, sessionId: string, worktreePath: string): void {
    this.processes.set(panelId, { process: fake.pty, panelId, sessionId, worktreePath });
    this.setupProcessHandlers(fake.pty, panelId, sessionId);
  }
}

describe('AbstractCliManager.listOwnedProcesses', () => {
  it('is empty for a manager with no processes', () => {
    expect(new TestCliManager().listOwnedProcesses()).toEqual([]);
  });

  it('returns one entry per live process with pid/panel/session/worktree', () => {
    const mgr = new TestCliManager();
    mgr.register(makeFakePty(4321), 'panel-1', 'sess-1', '/wt/one');

    expect(mgr.listOwnedProcesses()).toEqual([
      { pid: 4321, provider: 'claude', panelId: 'panel-1', sessionId: 'sess-1', worktreePath: '/wt/one' },
    ]);
  });

  it('excludes a process whose pty has already exited', async () => {
    const mgr = new TestCliManager();
    const live = makeFakePty(4321);
    const dying = makeFakePty(4322);
    mgr.register(live, 'panel-1', 'sess-1', '/wt/one');
    mgr.register(dying, 'panel-2', 'sess-2', '/wt/two');

    // The exit handler flags the record synchronously, BEFORE its async cleanup
    // removes it — so start the exit and read while the record still lingers.
    const exiting = dying.emitExit();
    expect(mgr.listOwnedProcesses().map((p) => p.panelId)).toEqual(['panel-1']);
    await exiting;
    expect(mgr.listOwnedProcesses().map((p) => p.panelId)).toEqual(['panel-1']);
  });

  it('skips a record with no real pid (pid 0)', () => {
    const mgr = new TestCliManager();
    mgr.register(makeFakePty(0), 'panel-1', 'sess-1', '/wt/one');
    expect(mgr.listOwnedProcesses()).toEqual([]);
  });
});
