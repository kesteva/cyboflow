/**
 * Spawn-marker stamping at the PTY / script spawn sites that build their env
 * inline: sessionManager (runScript + execWithShellPath), terminalSessionManager
 * and terminalPanelManager. Each spawn is driven through its real entry point
 * with node-pty / child_process replaced by recorders; the observed env must
 * carry CYBOFLOW_INSTANCE (this process's id) and CYBOFLOW_WORKTREE (the cwd).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ptySpawns = vi.hoisted(() => [] as Array<{ cwd?: string; env: Record<string, string | undefined> }>);
const childSpawns = vi.hoisted(() => [] as Array<{ cwd?: string; env: Record<string, string | undefined> }>);

vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: (_f: string, _a: string[], opts: { cwd?: string; env: Record<string, string | undefined> }) => {
    ptySpawns.push(opts);
    return { pid: 1, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
  },
}));
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: (_c: string, _a: string[], opts: { cwd?: string; env: Record<string, string | undefined> }) => {
      childSpawns.push(opts);
      return Object.assign(new EventEmitter(), { pid: 2, stdout: new EventEmitter(), stderr: new EventEmitter() });
    },
  };
});
vi.mock('../../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));
vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn(),
    getPanelsForSession: vi.fn().mockReturnValue([]),
    updatePanel: vi.fn(),
    emitPanelEvent: vi.fn(),
  },
}));
vi.mock('../../index', () => ({ mainWindow: null }));
vi.mock('../scriptExecutionTracker', () => ({
  scriptExecutionTracker: { start: vi.fn(), stop: vi.fn(), markClosing: vi.fn(), isRunning: vi.fn().mockReturnValue(false) },
}));

import { SessionManager } from '../sessionManager';
import { TerminalSessionManager } from '../terminalSessionManager';
import { TerminalPanelManager } from '../terminalPanelManager';
import { getInstanceId } from '../../utils/spawnMarker';
import type { DatabaseService } from '../../database/database';
import type { ToolPanel } from '../../../../shared/types/panels';

beforeEach(() => {
  ptySpawns.length = 0;
  childSpawns.length = 0;
});

describe('spawn marker at inline-env spawn sites', () => {
  it('TerminalSessionManager.createTerminalSession stamps instance + worktree', async () => {
    const wt = '/tmp/wt-terminal-session';
    await new TerminalSessionManager().createTerminalSession('s1', wt);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(ptySpawns[0].env.CYBOFLOW_WORKTREE).toBe(wt);
    // Sibling vars built inline are preserved.
    expect(ptySpawns[0].env.WORKTREE_PATH).toBe(wt);
  });

  it('TerminalPanelManager.initializeTerminal stamps instance + worktree', async () => {
    const wt = '/tmp/wt-terminal-panel';
    const panel = { id: 'p1', sessionId: 's1', type: 'terminal', state: {} } as unknown as ToolPanel;
    try {
      await new TerminalPanelManager().initializeTerminal(panel, wt);
    } catch {
      // post-spawn panel bookkeeping may need more mocks; the spawn already happened
    }
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(ptySpawns[0].env.CYBOFLOW_WORKTREE).toBe(wt);
    expect(ptySpawns[0].env.CYBOFLOW_SESSION_ID).toBe('s1');
  });

  it('SessionManager.runScript stamps the script child with the working directory', async () => {
    const sm = new SessionManager({} as unknown as DatabaseService);
    vi.spyOn(sm as unknown as { setSessionRunning: () => void }, 'setSessionRunning').mockImplementation(() => {});
    const wt = '/tmp/wt-run-script';
    await sm.runScript('s1', ['echo hi'], wt);
    expect(childSpawns).toHaveLength(1);
    expect(childSpawns[0].env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(childSpawns[0].env.CYBOFLOW_WORKTREE).toBe(wt);
  });

  // POSIX shell syntax ($VAR, printf); cmd.exe would echo the names unexpanded.
  it.skipIf(process.platform === 'win32')('SessionManager.execWithShellPath stamps a real exec child with its cwd', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marker-exec-')));
    try {
      const sm = new SessionManager({} as unknown as DatabaseService);
      const exec = (sm as unknown as {
        execWithShellPath(c: string, o: { cwd: string }): Promise<{ stdout: string }>;
      }).execWithShellPath.bind(sm);
      const { stdout } = await exec('printf "%s|%s" "$CYBOFLOW_INSTANCE" "$CYBOFLOW_WORKTREE"', { cwd: dir });
      expect(stdout).toBe(`${getInstanceId()}|${dir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('negative control: the pre-change env shape (no stamp) fails the marker assertions', () => {
    const preChange = { ...process.env, PATH: '/usr/bin', WORKTREE_PATH: '/tmp/wt' } as Record<string, string | undefined>;
    expect(() => expect(preChange.CYBOFLOW_WORKTREE).toBe('/tmp/wt')).toThrow();
    expect(() => expect(preChange.CYBOFLOW_INSTANCE).toBe(getInstanceId())).toThrow();
  });
});
