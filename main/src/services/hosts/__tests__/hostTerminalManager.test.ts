import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HostTerminalManager } from '../hostTerminalManager';
import type { ManagedPty, ShellSpawner } from '../../runShellManager';
import { getInstanceId } from '../../../utils/spawnMarker';

vi.mock('../../../utils/shellPath', () => ({ getShellPath: () => '/usr/bin:/bin' }));

interface FakePty extends ManagedPty {
  emitData(d: string): void;
  emitExit(code?: number): void;
  written: string[];
  resizes: Array<[number, number]>;
  killed: number;
}

let nextPid = 5000;
function makeFakePty(): FakePty {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  const pty: FakePty = {
    pid: nextPid++,
    written: [],
    resizes: [],
    killed: 0,
    onData(cb) { dataCb = cb; },
    onExit(cb) { exitCb = cb; },
    write(d) { pty.written.push(d); },
    resize(c, r) { pty.resizes.push([c, r]); },
    kill() { pty.killed++; },
    emitData(d) { dataCb?.(d); },
    emitExit(code = 0) { exitCb?.({ exitCode: code }); },
  };
  return pty;
}

function harness(maxOpen?: number, onExit?: (id: string, code: number | null) => void) {
  const spawns: Array<{ file: string; args: string[] | string; options: { cwd?: string; env?: Record<string, string | undefined> }; pty: FakePty }> = [];
  const emits: Array<{ id: string; chunk: string }> = [];
  const spawner: ShellSpawner = (file, args, options) => {
    const pty = makeFakePty();
    spawns.push({ file, args, options: options as (typeof spawns)[number]['options'], pty });
    return pty;
  };
  const mgr = new HostTerminalManager((id, chunk) => emits.push({ id, chunk }), spawner, {
    homedir: () => '/home/test',
    maxOpen,
    onExit,
  });
  return { mgr, spawns, emits };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HostTerminalManager.open', () => {
  it('spawns ssh with the fixed argv and returns monotonic ids', () => {
    const { mgr, spawns } = harness();
    const a = mgr.open('h1', 'me@box');
    const b = mgr.open('h1', 'me@box');
    expect(a).toBe('host::h1::t1');
    expect(b).toBe('host::h1::t2');
    expect(spawns[0].file).toBe('ssh');
    expect(spawns[0].args).toEqual(['-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', 'me@box']);
    expect(spawns[0].options.cwd).toBe('/home/test');
  });

  it('rejects an invalid target without spawning', () => {
    const { mgr, spawns } = harness();
    for (const bad of ['-oProxyCommand=x', 'a b', '', 'x;y']) {
      expect(() => mgr.open('h1', bad)).toThrow(expect.objectContaining({ name: 'InvalidSshTargetError' }));
    }
    expect(spawns).toHaveLength(0);
  });

  it('scrubs run-scoped env, stamps the marker, keeps secrets off argv', () => {
    const saved = { ...process.env };
    process.env.CYBOFLOW_RUN_ID = 'r';
    process.env.CYBOFLOW_ORCH_SOCKET = 's';
    process.env.CYBOFLOW_ORCH_TOKEN = 'cbt_secret';
    process.env.CYBOFLOW_RUN_ARTIFACTS_DIR = '/a';
    try {
      const { mgr, spawns } = harness();
      mgr.open('h1', 'box');
      const env = spawns[0].options.env ?? {};
      expect(env.CYBOFLOW_RUN_ID).toBeUndefined();
      expect(env.CYBOFLOW_ORCH_SOCKET).toBeUndefined();
      expect(env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBeUndefined();
      expect(env.CYBOFLOW_INSTANCE).toBe(getInstanceId());
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.TERM).toBe('xterm-256color');
      expect(JSON.stringify(spawns[0].args)).not.toContain('secret');
    } finally {
      process.env = saved;
    }
  });

  it('throws HostTerminalUnavailableError past the cap and frees a slot on close', () => {
    const { mgr } = harness(2);
    const a = mgr.open('h', 'box');
    mgr.open('h', 'box');
    expect(() => mgr.open('h', 'box')).toThrow(expect.objectContaining({ name: 'HostTerminalUnavailableError' }));
    mgr.closeOne(a);
    expect(() => mgr.open('h', 'box')).not.toThrow();
  });

  it('exited terminals do not hold a slot: the oldest exited entry is evicted, live ones never are', () => {
    const { mgr, spawns } = harness(3);
    const a = mgr.open('h', 'box');
    const b = mgr.open('h', 'box');
    const c = mgr.open('h', 'box');
    spawns[1].pty.emitExit(0); // b exits first
    spawns[0].pty.emitExit(1); // then a (older entry)
    const d = mgr.open('h', 'box');
    // a is the oldest EXITED entry by open order, so it is evicted; b stays readable.
    expect(mgr.getBacklog(a)).toEqual({ backlog: '', exited: true, exitCode: null });
    expect(mgr.getBacklog(b)).toMatchObject({ exited: true, exitCode: 0 });
    const e = mgr.open('h', 'box');
    expect(mgr.getBacklog(b)).toEqual({ backlog: '', exited: true, exitCode: null });
    expect([c, d, e].every((id) => mgr.getBacklog(id).exited === false)).toBe(true);
    // All three slots live: only now is the cap a refusal.
    expect(() => mgr.open('h', 'box')).toThrow(expect.objectContaining({ name: 'HostTerminalUnavailableError' }));
    expect(spawns.every((sp) => sp.pty.killed === 0)).toBe(true);
  });

  it('defaults the cap to 8', () => {
    const { mgr } = harness();
    for (let i = 0; i < 8; i++) mgr.open('h', 'box');
    expect(() => mgr.open('h', 'box')).toThrow(expect.objectContaining({ name: 'HostTerminalUnavailableError' }));
  });
});

describe('bytes, backlog, exit', () => {
  it('emits bytes and trims the backlog to 256 KB', () => {
    const { mgr, spawns, emits } = harness();
    const id = mgr.open('h', 'box');
    spawns[0].pty.emitData('hello');
    expect(emits).toEqual([{ id, chunk: 'hello' }]);
    spawns[0].pty.emitData('x'.repeat(300_000));
    const { backlog } = mgr.getBacklog(id);
    expect(backlog.length).toBe(256_000);
    expect(backlog.endsWith('xxx')).toBe(true);
  });

  it('keeps an exited entry readable until closeOne', () => {
    const { mgr, spawns } = harness();
    const id = mgr.open('h', 'box');
    spawns[0].pty.emitData('bye');
    spawns[0].pty.emitExit(255);
    expect(mgr.getBacklog(id)).toEqual({ backlog: 'bye', exited: true, exitCode: 255 });
    expect(mgr.listOwnedShells()).toEqual([]);
    mgr.write(id, 'x');
    expect(spawns[0].pty.written).toEqual([]);
    mgr.closeOne(id);
    expect(mgr.getBacklog(id)).toEqual({ backlog: '', exited: true, exitCode: null });
  });

  it('pushes the exit through onExit, and a throwing listener is contained', () => {
    const exits: Array<[string, number | null]> = [];
    const { mgr, spawns } = harness(undefined, (id, code) => {
      exits.push([id, code]);
      throw new Error('listener');
    });
    const id = mgr.open('h', 'box');
    expect(() => spawns[0].pty.emitExit(255)).not.toThrow();
    expect(exits).toEqual([[id, 255]]);
    expect(mgr.getBacklog(id)).toMatchObject({ exited: true, exitCode: 255 });
  });

  it('unknown ids are inert', () => {
    const { mgr } = harness();
    expect(mgr.getBacklog('nope')).toEqual({ backlog: '', exited: true, exitCode: null });
    expect(() => {
      mgr.write('nope', 'x');
      mgr.resize('nope', 80, 24);
      mgr.closeOne('nope');
    }).not.toThrow();
  });
});

describe('write / resize', () => {
  it('relays input and geometry, ignoring non-positive sizes', () => {
    const { mgr, spawns } = harness();
    const id = mgr.open('h', 'box');
    mgr.write(id, 'ls\n');
    mgr.resize(id, 100, 40);
    mgr.resize(id, 0, 40);
    expect(spawns[0].pty.written).toEqual(['ls\n']);
    expect(spawns[0].pty.resizes).toEqual([[100, 40]]);
  });
});

describe('close / list', () => {
  it('closeForHost kills only that host; destroyAll kills the rest', () => {
    const { mgr, spawns } = harness();
    mgr.open('a', 'box');
    mgr.open('b', 'box');
    mgr.open('a', 'box');
    mgr.closeForHost('a');
    expect(spawns.map((s) => s.pty.killed)).toEqual([1, 0, 1]);
    expect(mgr.listOwnedShells()).toEqual([{ pid: spawns[1].pty.pid, terminalId: 'host::b::t2', hostId: 'b' }]);
    mgr.destroyAll();
    expect(spawns[1].pty.killed).toBe(1);
    expect(mgr.listOwnedShells()).toEqual([]);
  });

  it('survives a throwing kill', () => {
    const { mgr, spawns } = harness();
    const id = mgr.open('h', 'box');
    spawns[0].pty.kill = () => { throw new Error('boom'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => mgr.closeOne(id)).not.toThrow();
    err.mockRestore();
  });
});
