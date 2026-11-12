import { describe, it, expect } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import {
  ForwardFailedError,
  SshTransport,
  quoteRemoteArgv,
  type ProcessRunOptions,
  type ProcessRunner,
  type ProcessSpawner,
} from '../sshTransport';

/** A local ssh child stand-in: records its kills, exits when killed (like ssh on SIGTERM). */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdin: Writable = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  opts: SpawnOptions;
  child: FakeChild;
}

function fakeSpawner(make: () => FakeChild = () => new FakeChild()): { spawner: ProcessSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: ProcessSpawner = (file, args, opts) => {
    const child = make();
    calls.push({ file, args, opts, child });
    return child as unknown as ChildProcess;
  };
  return { spawner, calls };
}

type ExecAnswer = (args: readonly string[], opts: ProcessRunOptions) => Partial<ExecResult>;

function fakeRunner(answer: ExecAnswer = () => ({})): { runner: ProcessRunner; calls: Array<{ args: readonly string[] }> } {
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: ProcessRunner = async (_file, args, opts) => {
    calls.push({ args });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(args, opts) };
  };
  return { runner, calls };
}

function transport(spawner: ProcessSpawner, runner: ProcessRunner = fakeRunner().runner, over: { readyMs?: number } = {}) {
  return new SshTransport({
    runner,
    spawner,
    controlDir: () => '/Users/me/.cyboflow/ssh',
    ensureDir: () => undefined,
    env: () => ({ PATH: '/usr/bin:/bin' }),
    forwardReadyTimeoutMs: over.readyMs ?? 1_000,
    forwardPollMs: 5,
  });
}

const DEDICATED = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
];

/** The remote command string is the word right after the destination; everything after `--` is two words. */
function assertDestinationShape(args: readonly string[], target: string, trailing: number): void {
  const dd = args.indexOf('--');
  expect(dd).toBeGreaterThan(0);
  expect(args[dd + 1]).toBe(target);
  expect(args.length).toBe(dd + 2 + trailing);
  expect(args).not.toContain('-t');
  expect(args).not.toContain('-tt');
}

describe('spawnStreaming argv', () => {
  it('dedicated: own connection, -T, LogLevel=ERROR, `--` then the destination, then ONE command word', () => {
    const { spawner, calls } = fakeSpawner();
    const cmd = quoteRemoteArgv(['/bin/sh', '-c', 'x', 'sh', `/w/-it's $(x) \`y\``]);
    transport(spawner).spawnStreaming('cybo-mbp', cmd, { stdin: 'pipe', dedicated: true });
    const { file, args, opts } = calls[0];
    expect(file).toBe('ssh');
    expect(args).toEqual([...DEDICATED, '-T', '-o', 'LogLevel=ERROR', '--', 'cybo-mbp', cmd]);
    assertDestinationShape(args, 'cybo-mbp', 1);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.env).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('shared: rides the ControlMaster; refuses a bad destination, an empty or NUL command', () => {
    const { spawner, calls } = fakeSpawner();
    const t = transport(spawner);
    t.spawnStreaming('box', "'true'", { stdin: 'pipe', dedicated: false });
    expect(calls[0].args).toContain('ControlMaster=auto');
    expect(calls[0].args).not.toContain('ControlPath=none');
    expect(() => t.spawnStreaming('-oProxyCommand=x', "'true'", { stdin: 'pipe', dedicated: true })).toThrow();
    expect(() => t.spawnStreaming('box', '', { stdin: 'pipe', dedicated: true })).toThrow(/empty/);
    expect(() => t.spawnStreaming('box', 'a\0b', { stdin: 'pipe', dedicated: true })).toThrow(/NUL/);
    expect(calls).toHaveLength(1);
  });
});

describe('openForward', () => {
  const spec = { remoteSock: '/Users/me/cf-remote/h1/s/o.sock', localSock: '/Users/me/Library/cyboflow dir/sockets/orch.sock' };

  it('prepares the 0700 parent, spawns a dedicated -N -R forward, and is ready once `test -S` passes', async () => {
    const { spawner, calls } = fakeSpawner();
    let probes = 0;
    const r = fakeRunner((args) => {
      if (args.at(-1)?.includes("'test'")) return { code: ++probes >= 3 ? 0 : 1 };
      return {};
    });
    const handle = transport(spawner, r.runner).openForward('box', spec);
    await handle.ready;
    expect(probes).toBe(3);
    // 1st exec: the prep program, dir + socket as positional words.
    const prep = r.calls[0].args.at(-1) ?? '';
    expect(prep).toContain('mkdir -p');
    expect(prep).toContain("'sh' '/Users/me/cf-remote/h1/s' '/Users/me/cf-remote/h1/s/o.sock'");
    expect(r.calls[1].args.at(-1)).toBe("'test' '-S' '/Users/me/cf-remote/h1/s/o.sock'");
    const { args, opts } = calls[0];
    expect(args).toEqual([
      ...DEDICATED, '-T', '-o', 'LogLevel=ERROR', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
      '-R', `${spec.remoteSock}:${spec.localSock}`, '--', 'box',
    ]);
    assertDestinationShape(args, 'box', 0);
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(handle.exited).toBe(false);
    const exits: Array<number | null> = [];
    handle.on('exit', (code) => exits.push(code));
    handle.close();
    await new Promise((res) => setTimeout(res, 20));
    expect(calls[0].child.signals).toEqual(['SIGTERM']);
    expect(exits).toEqual([null]);
    expect(handle.exited).toBe(true);
  });

  it('readiness times out: rejects, kills the forward, and still fires exit once', async () => {
    const { spawner, calls } = fakeSpawner();
    const r = fakeRunner((args) => (args.at(-1)?.includes("'test'") ? { code: 1 } : {}));
    const handle = transport(spawner, r.runner, { readyMs: 60 }).openForward('box', spec);
    const exits: string[] = [];
    handle.on('exit', (_c, tail) => exits.push(tail));
    await expect(handle.ready).rejects.toBeInstanceOf(ForwardFailedError);
    await expect(handle.ready).rejects.toThrow(/did not come up/);
    await new Promise((res) => setTimeout(res, 20));
    expect(calls[0].child.signals).toEqual(['SIGTERM']);
    expect(exits).toHaveLength(1);
  });

  it('an ssh that exits first (forward refused) rejects with the redacted stderr line', async () => {
    const { spawner, calls } = fakeSpawner();
    const r = fakeRunner((args) => (args.at(-1)?.includes("'test'") ? { code: 1 } : {}));
    const handle = transport(spawner, r.runner).openForward('box', spec);
    const exits: Array<[number | null, string]> = [];
    handle.on('exit', (c, tail) => exits.push([c, tail]));
    await new Promise((res) => setTimeout(res, 10));
    const child = calls[0].child;
    child.stderr.write('Error: remote port forwarding failed for listen path sk-ant-abc\n');
    await new Promise((res) => setTimeout(res, 5));
    child.exit(255);
    await expect(handle.ready).rejects.toThrow(/remote port forwarding failed/);
    await expect(handle.ready).rejects.not.toThrow(/sk-ant-abc/);
    await new Promise((res) => setTimeout(res, 5));
    expect(exits).toHaveLength(1);
    expect(exits[0][0]).toBe(255);
    expect(exits[0][1]).toContain('sk-ant-[REDACTED]');
  });

  it('a failed prep never spawns; close() before ready rejects; bad socket paths throw before any ssh', async () => {
    const { spawner, calls } = fakeSpawner();
    const failing = fakeRunner(() => ({ code: 1, stderr: 'mkdir: Permission denied' }));
    const h1 = transport(spawner, failing.runner).openForward('box', spec);
    const exits: number[] = [];
    h1.on('exit', () => exits.push(1));
    await expect(h1.ready).rejects.toThrow(/prepare the remote socket directory/);
    expect(calls).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 5));
    expect(exits).toEqual([1]);

    const h2 = transport(spawner).openForward('box', spec);
    h2.close();
    await expect(h2.ready).rejects.toThrow(/closed/);

    const t = transport(spawner);
    expect(() => t.openForward('box', { ...spec, remoteSock: 'relative/o.sock' })).toThrow(ForwardFailedError);
    expect(() => t.openForward('box', { ...spec, remoteSock: '/a:b/o.sock' })).toThrow(ForwardFailedError);
    expect(() => t.openForward('box', { ...spec, localSock: '/x\n/o.sock' })).toThrow(ForwardFailedError);
    expect(() => t.openForward('-bad', spec)).toThrow();
  });
});

/** stdin that accepts 16 bytes before asking for a drain, completing each write asynchronously. */
class SlowStdin extends Writable {
  readonly received: Buffer[] = [];
  writesWhileFull = 0;
  fullCount = 0;
  constructor() {
    super({ highWaterMark: 16 });
  }
  override write(chunk: Buffer, ...rest: never[]): boolean {
    if (this.writableNeedDrain) this.writesWhileFull++;
    const accepted = super.write(chunk, ...rest);
    if (!accepted) this.fullCount++;
    return accepted;
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.received.push(chunk);
    setImmediate(() => cb());
  }
}

describe('pushStream', () => {
  it('pipes the source with backpressure, reports progress, runs /bin/sh -c <script> on a dedicated connection', async () => {
    const stdin = new SlowStdin();
    const { spawner, calls } = fakeSpawner(() => {
      const c = new FakeChild();
      c.stdin = stdin;
      stdin.on('finish', () => {
        c.stdout.write('ok\n');
        c.stderr.write('note sk-ant-zzz\n');
        setImmediate(() => c.exit(0));
      });
      return c;
    });
    const chunks = Array.from({ length: 40 }, (_v, i) => Buffer.alloc(10, i));
    const progress: number[] = [];
    const r = await transport(spawner).pushStream('box', 'umask 077; tar xzf - -C "$HOME/x"', Readable.from(chunks), {
      timeoutMs: 10_000,
      onProgress: (n) => progress.push(n),
    });
    expect(r).toEqual({ code: 0, stdout: 'ok\n', stderr: 'note sk-ant-[REDACTED]\n', timedOut: false });
    expect(Buffer.concat(stdin.received)).toEqual(Buffer.concat(chunks));
    // The buffer DID fill (backpressure was exercised) and the pump never wrote past it.
    expect(stdin.fullCount).toBeGreaterThan(5);
    expect(stdin.writesWhileFull).toBe(0);
    expect(progress).toHaveLength(40);
    expect(progress.at(-1)).toBe(400);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const { args } = calls[0];
    expect(args.slice(0, DEDICATED.length)).toEqual(DEDICATED);
    expect(args.at(-1)).toBe(quoteRemoteArgv(['/bin/sh', '-c', 'umask 077; tar xzf - -C "$HOME/x"']));
    assertDestinationShape(args, 'box', 1);
  });

  it('a failing source kills ssh and reports the local error; a timeout reports timedOut (never throws)', async () => {
    const { spawner, calls } = fakeSpawner();
    const broken = new Readable({ read() { this.destroy(new Error('disk read failed')); } });
    const r = await transport(spawner).pushStream('box', 'cat >/dev/null', broken, { timeoutMs: 10_000 });
    expect(r.code).toBeNull();
    expect(r.stderr).toContain('The local source failed: disk read failed');
    expect(calls[0].child.signals).toContain('SIGTERM');

    const never = new Readable({ read() { /* never produces */ } });
    const t = await transport(fakeSpawner().spawner).pushStream('box', 'cat >/dev/null', never, { timeoutMs: 30 });
    expect(t.timedOut).toBe(true);
    never.destroy();
  });
});
