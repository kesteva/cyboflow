/**
 * The three session/terminal spawn sites that build their own env inline —
 * SessionManager (run script + build exec), TerminalSessionManager and
 * TerminalPanelManager — must each hand the child the spawn marker
 * (CYBOFLOW_INSTANCE + CYBOFLOW_WORKTREE = the real worktree path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dataDir = '';
vi.mock('../../utils/cyboflowDirectory', () => ({
  getCyboflowSubdirectory: (...sub: string[]) => path.join(dataDir, ...sub),
}));

type SpawnOpts = { env: Record<string, string | undefined>; cwd?: string };
const ptySpawn = vi.hoisted(() => vi.fn());
const childSpawn = vi.hoisted(() => vi.fn());

vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: ptySpawn,
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: childSpawn };
});
vi.mock('../../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));
vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn(),
    getPanelsForSession: vi.fn().mockReturnValue([]),
    updatePanel: vi.fn().mockResolvedValue(undefined),
    emitPanelEvent: vi.fn(),
  },
}));
vi.mock('../scriptExecutionTracker', () => ({
  scriptExecutionTracker: {
    start: vi.fn(),
    stop: vi.fn(),
    markClosing: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    getRunningScriptId: vi.fn().mockReturnValue(null),
  },
}));
vi.mock('../../index', () => ({ mainWindow: null }));

import { SessionManager } from '../sessionManager';
import { TerminalSessionManager } from '../terminalSessionManager';
import { TerminalPanelManager } from '../terminalPanelManager';
import { getInstanceId, _resetInstanceIdForTesting } from '../../utils/spawnMarker';
import type { DatabaseService } from '../../database/database';
import type { ToolPanel } from '../../../../shared/types/panels';

function fakePty() {
  return { onData: vi.fn(), onExit: vi.fn(), pid: 4242, write: vi.fn(), kill: vi.fn() };
}

const WORKTREE = '/tmp/cyboflow-marker-worktree';

describe('session/terminal PTY spawns carry the spawn marker', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-marker-'));
    _resetInstanceIdForTesting();
    ptySpawn.mockReset();
    childSpawn.mockReset();
    // The parent env may itself carry a marker (hosting instance) — the stamp must win over it.
    process.env.CYBOFLOW_WORKTREE = '/stale/from/host';
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CYBOFLOW_WORKTREE;
    delete process.env.CYBOFLOW_INSTANCE;
  });

  it('TerminalSessionManager.createTerminalSession stamps the session worktree', async () => {
    ptySpawn.mockReturnValue(fakePty());
    await new TerminalSessionManager().createTerminalSession('sess-1', WORKTREE);

    const opts = ptySpawn.mock.calls[0][2] as SpawnOpts;
    expect(opts.env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(opts.env.CYBOFLOW_WORKTREE).toBe(WORKTREE);
    expect(opts.cwd).toBe(WORKTREE);
    // Pre-existing vars survive the stamp.
    expect(opts.env.CYBOFLOW_SESSION_ID).toBe('sess-1');
  });

  it('TerminalPanelManager.initializeTerminal stamps the panel cwd', async () => {
    ptySpawn.mockReturnValue(fakePty());
    const panel = {
      id: 'panel-1',
      sessionId: 'sess-2',
      state: { customState: {} },
    } as unknown as ToolPanel;
    await new TerminalPanelManager().initializeTerminal(panel, WORKTREE);

    const opts = ptySpawn.mock.calls[0][2] as SpawnOpts;
    expect(opts.env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(opts.env.CYBOFLOW_WORKTREE).toBe(WORKTREE);
    expect(opts.env.CYBOFLOW_PANEL_ID).toBe('panel-1');
  });

  it('SessionManager.runScript stamps the script working directory', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4343,
    });
    childSpawn.mockReturnValue(proc);
    const sm = new SessionManager({
      getSession: vi.fn(),
      updateSession: vi.fn(),
    } as unknown as DatabaseService);
    // setSessionRunning is DB/emit bookkeeping irrelevant to the env under test.
    (sm as unknown as { setSessionRunning: () => void }).setSessionRunning = vi.fn();

    await sm.runScript('sess-3', ['echo hi'], WORKTREE);

    const opts = childSpawn.mock.calls[0][2] as SpawnOpts;
    expect(opts.env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(opts.env.CYBOFLOW_WORKTREE).toBe(WORKTREE);
    expect(opts.cwd).toBe(WORKTREE);
  });

  it.skipIf(process.platform === 'win32')(
    'SessionManager.runBuildScript exec stamps the build working directory',
    async () => {
      // execWithShellPath resolves child_process via require(), so run a REAL
      // shell and read the marker back out of the child's own environment.
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-cwd-')));
      try {
        const sm = new SessionManager({} as unknown as DatabaseService);
        const result = await sm.runBuildScript('sess-4', ['printf "%s|%s" "$CYBOFLOW_INSTANCE" "$CYBOFLOW_WORKTREE"'], cwd);
        expect(result.success).toBe(true);
        expect(result.output).toBe(`${getInstanceId()}|${cwd}`);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
