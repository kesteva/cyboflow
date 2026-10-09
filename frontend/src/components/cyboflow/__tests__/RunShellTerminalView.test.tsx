/**
 * RunShellTerminalView: the optional exit PUSH (`api.onExit`) used by the Environments host terminal. An ssh
 * process that exits AFTER the view mounted must show "Disconnected (exit N)" (the backlog only reports an exit
 * that already happened), exactly once, and the push is unsubscribed on unmount. Run shells (no `api`) are
 * unchanged: they never subscribe to anything but bytes.
 */
import '@testing-library/jest-dom';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const termMock = {
  open: vi.fn(),
  write: vi.fn(),
  loadAddon: vi.fn(),
  dispose: vi.fn(),
  scrollToBottom: vi.fn(),
  refresh: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  cols: 80,
  rows: 24,
  buffer: { active: { viewportY: 0, baseY: 0 } },
  options: {} as Record<string, unknown>,
};

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => termMock) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn(), dispose: vi.fn() })) }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }) }));
vi.mock('../../../utils/terminalLinks', () => ({ attachTerminalLinks: vi.fn() }));
vi.mock('../../../utils/cyboflowApi', () => ({ subscribeToShellBytes: vi.fn(() => () => undefined) }));

const runs = vi.hoisted(() => ({
  shellOpen: vi.fn(async () => ({ ok: true })),
  shellInput: vi.fn(async () => ({ ok: true })),
  shellResize: vi.fn(async () => ({ ok: true })),
  shellBacklog: vi.fn(async () => ({ backlog: '', exited: false, exitCode: null })),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        shellOpen: { mutate: runs.shellOpen },
        shellInput: { mutate: runs.shellInput },
        shellResize: { mutate: runs.shellResize },
        shellBacklog: { query: runs.shellBacklog },
      },
    },
  },
}));

import { RunShellTerminalView, type ShellTerminalApi } from '../RunShellTerminalView';

function hostApi(backlog: { backlog: string; exited: boolean; exitCode: number | null }) {
  let listener: ((code: number | null) => void) | null = null;
  const unsubscribe = vi.fn();
  const api: ShellTerminalApi = {
    open: async () => ({ ok: true }),
    input: async () => ({ ok: true }),
    resize: async () => ({ ok: true }),
    backlog: async () => backlog,
    onExit: vi.fn((l: (code: number | null) => void) => {
      listener = l;
      return unsubscribe;
    }),
  };
  return { api, unsubscribe, push: (code: number | null) => listener?.(code) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RunShellTerminalView exit push', () => {
  it('shows "Disconnected (exit N)" when the process exits after mount, once, and unsubscribes on unmount', async () => {
    const { api, unsubscribe, push } = hostApi({ backlog: 'hi', exited: false, exitCode: null });
    const onExited = vi.fn();
    const view = render(<RunShellTerminalView runId="host::h1::t1" terminalId="host::h1::t1" api={api} onExited={onExited} />);
    expect(api.onExit).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('run-shell-terminal-disconnected')).toBeNull();
    act(() => push(255));
    expect(screen.getByTestId('run-shell-terminal-disconnected')).toHaveTextContent('Disconnected (exit 255)');
    act(() => push(0));
    expect(screen.getByTestId('run-shell-terminal-disconnected')).toHaveTextContent('Disconnected (exit 255)');
    expect(onExited).toHaveBeenCalledTimes(1);
    expect(onExited).toHaveBeenCalledWith(255);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('an exit already in the backlog plus a late push is reported once', async () => {
    const { api, push } = hostApi({ backlog: '', exited: true, exitCode: 1 });
    const onExited = vi.fn();
    render(<RunShellTerminalView runId="t" terminalId="t" api={api} onExited={onExited} />);
    await waitFor(() => expect(screen.getByTestId('run-shell-terminal-disconnected')).toHaveTextContent('Disconnected (exit 1)'));
    act(() => push(1));
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it('a run shell (no api) still uses runs.shell* and reports exit only from the backlog', async () => {
    runs.shellBacklog.mockResolvedValueOnce({ backlog: '', exited: true, exitCode: null });
    render(<RunShellTerminalView runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('run-shell-terminal-disconnected')).toHaveTextContent('Disconnected'));
    expect(runs.shellOpen).toHaveBeenCalledWith({ runId: 'run-1', terminalId: 'run-1' });
    expect(runs.shellBacklog).toHaveBeenCalledWith({ terminalId: 'run-1' });
  });
});
