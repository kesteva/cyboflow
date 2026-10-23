/**
 * sessions:open-ide — the M2 remote guard: the IDE command runs on this Mac, so a session whose worktree lives on a
 * remote environment is refused with a readable reason and nothing is executed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
const execMock = vi.fn();
vi.mock('child_process', () => ({ exec: (...args: unknown[]) => execMock(...args) }));
vi.mock('../../services/panels/logPanel/logsManager', () => ({ logsManager: { stopScript: vi.fn() } }));
vi.mock('../../utils/shellPath', () => ({ getShellPath: () => '/usr/bin', findExecutableInPath: () => null }));

import { registerScriptHandlers } from '../script';
import type { AppServices } from '../types';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function register(session: Record<string, unknown>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, h: Handler) => handlers.set(channel, h) } as unknown as IpcMain;
  const services = {
    sessionManager: {
      getSession: vi.fn(() => session),
      getProjectForSession: vi.fn(() => ({ open_ide_command: 'code .' })),
    },
  } as unknown as AppServices;
  registerScriptHandlers(ipcMain, services);
  return handlers;
}

beforeEach(() => execMock.mockReset());

describe('sessions:open-ide', () => {
  it('refuses a remote-environment session and runs nothing', async () => {
    const handlers = register({ id: 's1', worktreePath: '/home/me/cf-remote/h/wt', hostId: 'host-a' });
    const res = await handlers.get('sessions:open-ide')!({}, 's1');
    expect(res).toEqual({ success: false, error: 'Open in IDE is not available on remote environments.' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('still runs the IDE command for a local session', async () => {
    execMock.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a): a is (e: null, o: string, s: string) => void => typeof a === 'function');
      cb?.(null, '', '');
    });
    const handlers = register({ id: 's1', worktreePath: '/tmp/wt', hostId: null });
    const res = await handlers.get('sessions:open-ide')!({}, 's1');
    expect(res).toEqual({ success: true });
    expect(execMock).toHaveBeenCalledWith('code .', expect.objectContaining({ cwd: '/tmp/wt' }), expect.any(Function));
  });
});
