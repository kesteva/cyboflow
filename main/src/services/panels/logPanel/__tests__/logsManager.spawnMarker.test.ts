/**
 * LogsManager.runScript stamps the spawn marker onto the script's env:
 * CYBOFLOW_INSTANCE (this process's id) and CYBOFLOW_WORKTREE (the cwd).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const childSpawns = vi.hoisted(
  () => [] as Array<{ cwd?: string; env: Record<string, string | undefined> }>,
);

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: (_c: string, _a: string[], opts: { cwd?: string; env: Record<string, string | undefined> }) => {
      childSpawns.push(opts);
      return Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
    },
  };
});
vi.mock('../../../../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));
vi.mock('../../../../index', () => ({ mainWindow: null }));
vi.mock('../../../../utils/shellPath', () => ({ getShellPath: () => '/usr/bin:/bin' }));
vi.mock('../../../panelManager', () => {
  const panel = { id: 'p1', sessionId: 's1', type: 'logs', state: { customState: {} } };
  return {
    panelManager: {
      getPanelsForSession: vi.fn().mockResolvedValue([panel]),
      getPanel: vi.fn().mockResolvedValue(panel),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      setActivePanel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { LogsManager } from '../logsManager';
import { getInstanceId } from '../../../../utils/spawnMarker';

beforeEach(() => {
  childSpawns.length = 0;
});

describe('LogsManager spawn marker', () => {
  it('runScript stamps instance + worktree onto the spawned env', async () => {
    await LogsManager.getInstance().runScript('s1', 'echo hi', '/tmp/wt-logs');

    expect(childSpawns).toHaveLength(1);
    const env = childSpawns[0].env;
    expect(env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(env.CYBOFLOW_WORKTREE).toBe('/tmp/wt-logs');
    // The enhanced shell PATH still wins over the inherited one.
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});
