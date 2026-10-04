/**
 * RunCommandManager stamps the spawn marker (CYBOFLOW_INSTANCE / CYBOFLOW_WORKTREE)
 * on the ad hoc script PTY it spawns. node-pty is replaced by a recorder whose
 * fake PTY exits immediately, so startRunCommands drives its real spawn path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ptySpawns = vi.hoisted(
  () => [] as Array<{ cwd?: string; env: Record<string, string | undefined> }>,
);

vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: (_f: string, _a: string[], opts: { cwd?: string; env: Record<string, string | undefined> }) => {
    ptySpawns.push(opts);
    return {
      pid: 1,
      onData: vi.fn(),
      onExit: (cb: (e: { exitCode: number }) => void) => queueMicrotask(() => cb({ exitCode: 0 })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  },
}));
vi.mock('../../utils/shellDetector', () => ({
  ShellDetector: {
    getDefaultShell: () => ({ path: '/bin/zsh', name: 'zsh', args: [] }),
    getShellCommandArgs: (cmd: string) => ({ shell: '/bin/zsh', args: ['-c', cmd] }),
    buildCommandString: (_vars: Record<string, string>, lines: string[]) => lines.join(' && '),
  },
}));
vi.mock('../../utils/shellPath', () => ({ getShellPath: () => '/usr/bin:/bin' }));

import { RunCommandManager } from '../runCommandManager';
import { getInstanceId } from '../../utils/spawnMarker';
import type { DatabaseService } from '../../database/database';

beforeEach(() => {
  ptySpawns.length = 0;
});

describe('RunCommandManager spawn marker', () => {
  it('stamps instance id + the worktree path on the spawned PTY env', async () => {
    const db = {
      getProjectRunCommands: () => [{ id: 1, command: 'echo hi', display_name: 'hi' }],
    } as unknown as DatabaseService;
    const wt = '/tmp/wt-run-command';
    const stale = process.env.CYBOFLOW_INSTANCE;
    process.env.CYBOFLOW_INSTANCE = 'stale-inherited-instance';
    try {
      await new RunCommandManager(db).startRunCommands('s1', 7, wt);
    } finally {
      if (stale === undefined) delete process.env.CYBOFLOW_INSTANCE;
      else process.env.CYBOFLOW_INSTANCE = stale;
    }
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].cwd).toBe(wt);
    expect(ptySpawns[0].env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(ptySpawns[0].env.CYBOFLOW_WORKTREE).toBe(wt);
    // Env built inline survives the stamp.
    expect(ptySpawns[0].env.WORKTREE_PATH).toBe(wt);
  });

  it('negative control: the pre-change env shape (no stamp) fails the marker assertions', () => {
    const preChange: Record<string, string | undefined> = { WORKTREE_PATH: '/tmp/wt', PATH: '/usr/bin' };
    expect(() => expect(preChange.CYBOFLOW_WORKTREE).toBe('/tmp/wt')).toThrow();
    expect(() => expect(preChange.CYBOFLOW_INSTANCE).toBe(getInstanceId())).toThrow();
  });
});
