/**
 * platformProcess — killTree's POSIX option surface + killTreeImmediate.
 *
 * Fully hermetic: every seam (execCommand / sendSignal / isPidAlive /
 * descendantPids / listDescendants) is injected, so no real `ps`/`kill`/`exec`
 * ever runs. Pins the three POSIX group-resolution shapes and the win32
 * taskkill ladder by their exact
 * command strings and signal order — the contract each call site's ladder was
 * moved under byte-identically:
 *  - 'lookup' (default): terminalSessionManager's shape — SIGTERM, then the
 *    `ps -o pgid=` lookup, group kills by the resolved pgid, dual-probe poll.
 *  - 'root': AbstractCliManager / sessionManager — NO lookup, the root pid IS
 *    the group id, fixed (non-probed) grace.
 *  - 'enumerate': runCommandManager — pgid resolved BEFORE any signal, group
 *    members the tree walk missed swept into the per-descendant kills.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectDescendantPidsAsync,
  describeProcesses,
  forceKillPids,
  killTree,
  killTreeImmediate,
  signalTree,
} from './platformProcess';

type ExecSpy = ReturnType<typeof vi.fn<(command: string) => Promise<{ stdout: string }>>>;

/** Hermetic option defaults: no real enumeration, no real signals. */
function baseOpts() {
  return {
    platform: 'linux' as const,
    descendantPids: [] as number[],
    listDescendants: () => Promise.resolve([] as number[]),
    sendSignal: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
    isPidAlive: vi.fn<(pid: number) => boolean>(() => false),
  };
}

describe('killTree POSIX — group resolution shapes', () => {
  it("default 'lookup': SIGTERM, pgid lookup, group kills by pgid, dual-probe poll", async () => {
    const opts = { ...baseOpts(), descendantPids: [5001] };
    const events: string[] = [];
    const execCommand: ExecSpy = vi.fn((command: string) => {
      events.push(`exec:${command}`);
      return Promise.resolve({ stdout: '' });
    });
    // Poll cadence: the pid is alive through the first probe pair, then gone.
    let probes = 0;
    opts.isPidAlive = vi.fn(() => {
      probes += 1;
      return probes <= 2;
    });
    opts.sendSignal = vi.fn((_pid, signal) => {
      events.push(`signal:${signal}`);
    });

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMs: 1000,
      pollIntervalMs: 5,
    });

    // Lookup ran (terminalSessionManager's echo-suffix shape) and, returning
    // nothing, the root pid stood in for the group id in both group kills.
    expect(execCommand).toHaveBeenCalledWith('ps -o pgid= -p 4242 2>/dev/null || echo ""');
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4242');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4242');
    // The enumerated descendant was killed individually, then the pkill sweep.
    expect(execCommand).toHaveBeenCalledWith('kill -9 5001');
    expect(execCommand).toHaveBeenCalledWith('pkill -9 -P 4242');
    // Both root and group were probed (dual probe), SIGTERM then SIGKILL.
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(probes).toBeLessThanOrEqual(4);
    // Relative order pinned end to end.
    expect(events).toEqual([
      'signal:SIGTERM',
      'exec:ps -o pgid= -p 4242 2>/dev/null || echo ""',
      'exec:kill -TERM -4242',
      'signal:SIGKILL',
      'exec:kill -9 -4242',
      'exec:kill -9 5001',
      'exec:pkill -9 -P 4242',
    ]);
  });

  it("'root': no pgid lookup — the root pid IS the group id, and the fixed grace never probes", async () => {
    const opts = { ...baseOpts() };
    const events: string[] = [];
    const execCommand: ExecSpy = vi.fn((command: string) => {
      events.push(`exec:${command}`);
      return Promise.resolve({ stdout: '' });
    });
    opts.sendSignal = vi.fn((_pid, signal) => {
      events.push(`signal:${signal}`);
    });
    const start = Date.now();

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMode: 'fixed',
      graceMs: 40,
      posixGroupMode: 'root',
    });

    // No lookup in either position (post-SIGTERM or pre-signal).
    const lookupCalls = execCommand.mock.calls.filter(([cmd]) => cmd.startsWith('ps -o pgid='));
    expect(lookupCalls).toEqual([]);
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4242');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4242');
    // Fixed grace: the window was genuinely slept out, unprobed.
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(opts.isPidAlive).not.toHaveBeenCalled();
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    // Relative order pinned: no lookup between the signal phases.
    expect(events).toEqual([
      'signal:SIGTERM',
      'exec:kill -TERM -4242',
      'signal:SIGKILL',
      'exec:kill -9 -4242',
      'exec:pkill -9 -P 4242',
    ]);
  });

  it("'enumerate': resolves the pgid BEFORE any signal and sweeps group members into the kill list", async () => {
    const events: string[] = [];
    const opts = { ...baseOpts(), descendantPids: [5001] };
    opts.sendSignal = vi.fn((_pid, signal) => {
      events.push(`signal:${signal}`);
    });
    const execCommand: ExecSpy = vi.fn((command: string) => {
      events.push(`exec:${command}`);
      // The real pgid differs from the root pid, and its members include the
      // root (filtered), an already-enumerated descendant (filtered), and one
      // newcomer (5002) that must join the per-descendant kill list.
      if (command === 'ps -o pgid= -p 4242') return Promise.resolve({ stdout: ' 4100\n' });
      if (command.startsWith('ps -o pid= -g 4100')) {
        return Promise.resolve({ stdout: '5001\n4242\n5002\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMode: 'fixed',
      graceMs: 10,
      posixGroupMode: 'enumerate',
    });

    // pgid resolution happened before the first signal flew.
    const lookupIndex = events.findIndex(e => e === 'exec:ps -o pgid= -p 4242');
    const firstSignalIndex = events.findIndex(e => e.startsWith('signal:'));
    expect(lookupIndex).toBeGreaterThanOrEqual(0);
    expect(firstSignalIndex).toBeGreaterThan(lookupIndex);

    // Group kills target the RESOLVED pgid; the newcomer joined the
    // per-descendant kills; the bare lookup shape (no echo suffix) ran.
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4100');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4100');
    expect(execCommand).toHaveBeenCalledWith('kill -9 5002');
    const bareLookups = execCommand.mock.calls.filter(([cmd]) => cmd === 'ps -o pgid= -p 4242');
    expect(bareLookups).toHaveLength(1);
  });

  it('never mutates a caller-provided descendant array (enumerate mode appends to a copy)', async () => {
    const descendantPids = [5001];
    const execCommand: ExecSpy = vi.fn((command: string) => {
      if (command === 'ps -o pgid= -p 4242') return Promise.resolve({ stdout: ' 4100\n' });
      if (command.startsWith('ps -o pid= -g 4100')) return Promise.resolve({ stdout: '5002\n' });
      return Promise.resolve({ stdout: '' });
    });

    await killTree(4242, {
      platform: 'linux',
      descendantPids,
      execCommand,
      graceMode: 'fixed',
      graceMs: 10,
      listDescendants: () => Promise.resolve([]),
    });

    expect(descendantPids).toEqual([5001]);
  });

  it("'enumerate': a failed pgid lookup warns and falls back to the root pid", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every shell call fails — including the pre-signal pgid lookup.
    const execCommand: ExecSpy = vi.fn(() => Promise.reject(new Error('process gone')));
    const opts = { ...baseOpts() };

    const stopped = await killTree(4242, {
      ...opts,
      execCommand,
      graceMode: 'fixed',
      graceMs: 10,
      posixGroupMode: 'enumerate',
    });

    // The lookup failure warned (fail-soft) and the ladder proceeded with the
    // root pid standing in for the group id — no group-member sweep ran.
    expect(warnSpy).toHaveBeenCalledWith('Could not resolve the process group', expect.any(Error));
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4242');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4242');
    const sweepCalls = execCommand.mock.calls.filter(([cmd]) => cmd.startsWith('ps -o pid= -g'));
    expect(sweepCalls).toEqual([]);
    expect(stopped).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('killTree win32 — the taskkill ladder', () => {
  it('graceful /T, then /T /F, then a per-descendant /F for each alive enumerated child', async () => {
    const events: string[] = [];
    const execCommand: ExecSpy = vi.fn((command: string) => {
      events.push(`exec:${command}`);
      return Promise.resolve({ stdout: '' });
    });
    // The root is already gone when the grace poll probes it; the enumerated
    // child is still alive when its per-descendant pass runs.
    const isPidAlive = vi.fn((pid: number) => pid === 5001);

    const stopped = await killTree(4242, {
      platform: 'win32',
      descendantPids: [5001],
      execCommand,
      isPidAlive,
      graceMs: 50,
      pollIntervalMs: 5,
      listDescendants: () => Promise.resolve([]),
    });

    expect(execCommand).toHaveBeenCalledWith('taskkill /PID 4242 /T');
    expect(execCommand).toHaveBeenCalledWith('taskkill /PID 4242 /T /F');
    expect(execCommand).toHaveBeenCalledWith('taskkill /PID 5001 /F');
    expect(stopped).toBe(true);
    // Sequence pinned: graceful attempt first, then the forced tree kill,
    // then the alive child.
    expect(events).toEqual([
      'exec:taskkill /PID 4242 /T',
      'exec:taskkill /PID 4242 /T /F',
      'exec:taskkill /PID 5001 /F',
    ]);
  });

  it('survivors found by the verification pass get one direct /F each, then a re-check', async () => {
    const execCommand: ExecSpy = vi.fn(() => Promise.resolve({ stdout: '' }));
    let verificationCalls = 0;
    const listDescendants = vi.fn(() => {
      verificationCalls += 1;
      // The verification pass finds one survivor; the re-check after its
      // forced kill finds none.
      return Promise.resolve(verificationCalls === 1 ? [6001] : []);
    });
    const onSurvivors = vi.fn();

    const stopped = await killTree(4242, {
      platform: 'win32',
      descendantPids: [],
      execCommand,
      isPidAlive: () => false,
      graceMode: 'fixed',
      graceMs: 10,
      listDescendants,
      onSurvivors,
    });

    expect(execCommand).toHaveBeenCalledWith('taskkill /PID 6001 /F');
    expect(onSurvivors).not.toHaveBeenCalled();
    expect(stopped).toBe(true);
    expect(verificationCalls).toBe(2);
  });
});

describe('killTree — the injected logger', () => {
  it('reports each ladder step to the site, so a session log can show it', async () => {
    const info: string[] = [];
    const warn: string[] = [];

    await killTree(4242, {
      ...baseOpts(),
      graceMode: 'fixed',
      graceMs: 1,
      posixGroupMode: 'root',
      logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) },
      execCommand: () => Promise.resolve({ stdout: '' }),
    });

    expect(info).toEqual([
      'Waiting 1ms for graceful shutdown',
      'Grace period expired, using forceful termination',
      'Sent SIGKILL to process 4242',
      'Sent SIGKILL to process group 4242',
    ]);
    expect(warn).toEqual([]);
  });

  it('sends a failed group signal to the site rather than the console', async () => {
    const warn = vi.fn<(message: string, error?: unknown) => void>();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await killTree(4242, {
        ...baseOpts(),
        graceMode: 'fixed',
        graceMs: 1,
        posixGroupMode: 'root',
        logger: { warn },
        execCommand: (command) =>
          command.startsWith('kill -9 -')
            ? Promise.reject(new Error('no such process group'))
            : Promise.resolve({ stdout: '' }),
      });

      expect(warn).toHaveBeenCalledWith(
        'Could not send SIGKILL to process group 4242',
        expect.any(Error),
      );
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('falls back to the console when no logger is injected', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await killTree(4242, {
        ...baseOpts(),
        graceMode: 'fixed',
        graceMs: 1,
        posixGroupMode: 'root',
        execCommand: (command) =>
          command.startsWith('kill -9 -')
            ? Promise.reject(new Error('no such process group'))
            : Promise.resolve({ stdout: '' }),
      });

      expect(consoleWarn).toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

describe('forceKillPids', () => {
  it('issues one kill per pid, in the command form that platform uses', async () => {
    const posix: string[] = [];
    await forceKillPids([11, 22], {
      platform: 'linux',
      execCommand: (command) => {
        posix.push(command);
        return Promise.resolve({ stdout: '' });
      },
    });
    expect(posix).toEqual(['kill -9 11', 'kill -9 22']);

    const win: string[] = [];
    await forceKillPids([11, 22], {
      platform: 'win32',
      execCommand: (command) => {
        win.push(command);
        return Promise.resolve({ stdout: '' });
      },
    });
    expect(win).toEqual(['taskkill /PID 11 /F', 'taskkill /PID 22 /F']);
  });

  it('reports only the kills that did not throw, and never stops early', async () => {
    const onKilled = vi.fn<(pid: number) => void>();
    await forceKillPids([11, 22, 33], {
      platform: 'linux',
      execCommand: (command) =>
        command.endsWith('22') ? Promise.reject(new Error('no such process')) : Promise.resolve({ stdout: '' }),
      onKilled,
    });

    expect(onKilled.mock.calls.map(([pid]) => pid)).toEqual([11, 33]);
  });
});

describe('describeProcesses', () => {
  it('POSIX: asks ps for each comm name, and calls an unresolvable pid unknown', async () => {
    const described = await describeProcesses([11, 22], {
      platform: 'linux',
      execCommand: (command) =>
        command.includes('-p 11')
          ? Promise.resolve({ stdout: 'node\n' })
          : Promise.reject(new Error('gone')),
    });

    expect(described).toEqual([
      { pid: 11, name: 'node' },
      { pid: 22, name: 'unknown' },
    ]);
  });

  it('POSIX: empty ps output reads as unknown rather than an empty name', async () => {
    const described = await describeProcesses([11], {
      platform: 'linux',
      execCommand: () => Promise.resolve({ stdout: '   \n' }),
    });

    expect(described).toEqual([{ pid: 11, name: 'unknown' }]);
  });
});

describe('signalTree', () => {
  it('POSIX: signals the process group by negative pid', () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();

    expect(signalTree(4242, 'SIGTERM', { platform: 'linux', sendSignal })).toBe('signaled');
    expect(sendSignal).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('POSIX: reports ESRCH as "gone", so a caller skips its fallback', () => {
    const sendSignal = vi.fn(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(signalTree(4242, 'SIGKILL', { platform: 'linux', sendSignal })).toBe('gone');
  });

  it('POSIX: reports any other rejection as "failed", so the caller falls back', () => {
    const sendSignal = vi.fn(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    expect(signalTree(4242, 'SIGKILL', { platform: 'linux', sendSignal })).toBe('failed');
  });

  it('win32: kills the tree by positive pid and never signals', () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    // Injected: a real taskkill at an arbitrary pid would kill a real process.
    const killWindows = vi.fn<(pid: number) => void>();

    expect(
      signalTree(4242, 'SIGTERM', { platform: 'win32', sendSignal, killWindows }),
    ).toBe('signaled');
    expect(killWindows).toHaveBeenCalledWith(4242);
    // A negative pid fails EINVAL on Windows, so the POSIX sender is not used.
    expect(sendSignal).not.toHaveBeenCalled();
  });
});

describe('collectDescendantPidsAsync', () => {
  // The POSIX arm is exercised through the injected one-level lister; the win32
  // arm reads the shared (pid, ppid) table, which has its own suite.
  it('walks the tree depth-first without blocking, and never includes the root', async () => {
    const children = new Map<number, number[]>([
      [100, [200, 300]],
      [200, [400]],
      [400, []],
      [300, []],
    ]);
    const listed: number[] = [];

    const found = await collectDescendantPidsAsync(100, {
      platform: 'linux',
      posixChildPids: async (ppid) => {
        listed.push(ppid);
        return children.get(ppid) ?? [];
      },
    });

    expect(found).toEqual([200, 400, 300]);
    expect(found).not.toContain(100);
    expect(listed).toEqual([100, 200, 400, 300]);
  });

  it('terminates on a cycle and never traverses pid <= 1', async () => {
    const found = await collectDescendantPidsAsync(100, {
      platform: 'linux',
      posixChildPids: async (ppid) => (ppid === 100 ? [200, 1] : [100, 200]),
    });

    expect(found).toEqual([200]);
  });

  it('reports a failed level and degrades to a partial list rather than throwing', async () => {
    const onWalkError = vi.fn();

    const found = await collectDescendantPidsAsync(100, {
      platform: 'linux',
      onWalkError,
      posixChildPids: async (ppid) => {
        if (ppid === 200) throw new Error('ps raced away');
        return ppid === 100 ? [200, 300] : [];
      },
    });

    expect(found).toEqual([200, 300]);
    expect(onWalkError).toHaveBeenCalledTimes(1);
  });

  it('returns [] for a non-positive or non-integer root', async () => {
    await expect(collectDescendantPidsAsync(0, { platform: 'linux' })).resolves.toEqual([]);
    await expect(collectDescendantPidsAsync(-5, { platform: 'linux' })).resolves.toEqual([]);
    await expect(collectDescendantPidsAsync(1.5, { platform: 'linux' })).resolves.toEqual([]);
  });
});

describe('killTreeImmediate', () => {
  it('SIGKILLs the root and every enumerated descendant, then runs the shell sweep', async () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const execCommand: ExecSpy = vi.fn(() => Promise.resolve({ stdout: '' }));

    await killTreeImmediate(4242, {
      platform: 'linux',
      descendantPids: [5001, 5002],
      sendSignal,
      execCommand,
    });

    expect(sendSignal).toHaveBeenCalledTimes(3);
    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(sendSignal).toHaveBeenCalledWith(5001, 'SIGKILL');
    expect(sendSignal).toHaveBeenCalledWith(5002, 'SIGKILL');
    expect(execCommand).toHaveBeenCalledWith(
      'kill -9 4242 5001 5002 2>/dev/null; pkill -9 -P 4242 2>/dev/null',
    );
  });

  it('is fail-soft: dead pids and a failing sweep never throw', async () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid) => {
      if (pid === 5001) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const execCommand: ExecSpy = vi.fn(() => Promise.reject(new Error('pkill matched nothing')));
    const onError = vi.fn();

    await expect(
      killTreeImmediate(4242, {
        platform: 'linux',
        descendantPids: [5001],
        sendSignal,
        execCommand,
        onError,
      }),
    ).resolves.toBeUndefined();

    // The sweep failure is ignored by contract — not surfaced through onError.
    expect(onError).not.toHaveBeenCalled();
  });
});
