import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import {
  HostPathMismatchError,
  InvalidRemotePathError,
  RemoteOperationError,
  RemotePathIsLocalError,
  SshHost,
} from '../sshHost';
import { quoteRemoteArgv, spawnCapture, type SshExecOptions, type SshTransportLike } from '../sshTransport';

const posix = process.platform !== 'win32';

interface ExecCall {
  target: string;
  argv: readonly string[];
  opts?: SshExecOptions;
}

function recordingTransport(result: Partial<ExecResult> = {}) {
  const calls: ExecCall[] = [];
  const transport: SshTransportLike = {
    exec: async (target, argv, opts) => {
      calls.push({ target, argv, opts });
      return { code: 0, stdout: 'out', stderr: '', timedOut: false, ...result };
    },
    runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    closeMaster: () => undefined,
  };
  return { transport, calls };
}

function host(transport: SshTransportLike, localExists: (p: string) => boolean = () => false): SshHost {
  return new SshHost({
    id: 'h1', label: 'Box', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', appVersion: '1.0.0', transport, localExists,
  });
}

describe('SshHost guards', () => {
  it('refuses a HostPath that belongs to another host before any ssh', async () => {
    const { transport, calls } = recordingTransport();
    const h = host(transport);
    await expect(h.fs.exists({ hostId: 'local', path: '/tmp/x' })).rejects.toBeInstanceOf(HostPathMismatchError);
    await expect(h.fs.mkdirp({ hostId: 'h2', path: '~/x' })).rejects.toBeInstanceOf(HostPathMismatchError);
    await expect(h.git.run({ hostId: 'local', path: '~/r' }, ['status'])).rejects.toBeInstanceOf(HostPathMismatchError);
    expect(calls).toHaveLength(0);
  });

  it('remote-root guard: an absolute path that exists on this Mac is refused', async () => {
    const { transport, calls } = recordingTransport();
    const localExists = vi.fn((p: string) => p === '/Users/me/project');
    const h = host(transport, localExists);
    await expect(h.fs.writeFile({ hostId: 'h1', path: '/Users/me/project' }, 'x', 0o600)).rejects.toBeInstanceOf(RemotePathIsLocalError);
    await expect(h.git.run({ hostId: 'h1', path: '/Users/me/project' }, ['status'])).rejects.toBeInstanceOf(RemotePathIsLocalError);
    expect(calls).toHaveLength(0);
    await h.fs.mkdirp({ hostId: 'h1', path: '/srv/cf' });
    expect(calls).toHaveLength(1);
    // `~/` paths are the remote home: never checked against the local disk.
    localExists.mockClear();
    await h.fs.mkdirp({ hostId: 'h1', path: '~/cf-remote/h1' });
    expect(localExists).not.toHaveBeenCalled();
  });

  it('relative paths (and NUL bytes) are refused', async () => {
    const { transport } = recordingTransport();
    const h = host(transport);
    await expect(h.fs.exists({ hostId: 'h1', path: 'relative/x' })).rejects.toBeInstanceOf(InvalidRemotePathError);
    await expect(h.fs.exists({ hostId: 'h1', path: '~user/x' })).rejects.toBeInstanceOf(InvalidRemotePathError);
    await expect(h.fs.exists({ hostId: 'h1', path: '/a\0b' })).rejects.toBeInstanceOf(InvalidRemotePathError);
  });
});

describe('SshHost operations (argv shape)', () => {
  it('passes the path as a positional argument, never spliced into the program', async () => {
    const { transport, calls } = recordingTransport();
    const h = host(transport);
    const evil = "/srv/x'; rm -rf ~; '$(boom)";
    await h.fs.mkdirp({ hostId: 'h1', path: evil });
    const argv = calls[0].argv;
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(argv[2]).not.toContain('boom');
    expect(argv.slice(3)).toEqual(['sh', evil]);
    expect(calls[0].target).toBe('box');
  });

  it('writeFile sends data on stdin with an octal mode; git.run forwards args after the path', async () => {
    const { transport, calls } = recordingTransport();
    const h = host(transport);
    await h.fs.writeFile({ hostId: 'h1', path: '~/f' }, 'payload', 0o600);
    expect(calls[0].argv.slice(-2)).toEqual(['~/f', '600']);
    expect(calls[0].opts?.stdin).toBe('payload');
    await expect(h.fs.writeFile({ hostId: 'h1', path: '~/f' }, 'x', 0o7777)).rejects.toThrow(/mode/);
    await h.git.run({ hostId: 'h1', path: '~/r' }, ['log', '-1', '--format=%H'], { timeoutMs: 5 });
    expect(calls[1].argv.slice(-4)).toEqual(['~/r', 'log', '-1', '--format=%H']);
    expect(calls[1].opts?.timeoutMs).toBe(5);
  });

  it('exists maps 0 / 1 and throws a redacted error for an ssh failure', async () => {
    expect(await host(recordingTransport({ code: 0 }).transport).fs.exists({ hostId: 'h1', path: '~/a' })).toBe(true);
    expect(await host(recordingTransport({ code: 1 }).transport).fs.exists({ hostId: 'h1', path: '~/a' })).toBe(false);
    const failing = host(recordingTransport({ code: 255, stderr: 'auth sk-ant-XYZ failed' }).transport);
    const err = await failing.fs.exists({ hostId: 'h1', path: '~/a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteOperationError);
    expect((err as Error).message).not.toContain('XYZ');
  });

  it('exec runs the argv on the machine through the transport', async () => {
    const { transport, calls } = recordingTransport();
    const r = await host(transport).exec.exec(['uname', '-a']);
    expect(calls[0]).toMatchObject({ target: 'box', argv: ['uname', '-a'] });
    expect(r.stdout).toBe('out');
  });
});

describe.skipIf(!posix)('SshHost programs run by a local /bin/sh loopback (no ssh)', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('mkdirp / writeFile / exists / readFile behave on a ~/ path', async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-sshhost-')));
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const loopback: SshTransportLike = {
      // What sshd does with the command string: hand it to a shell.
      exec: (_t, argv, opts) =>
        spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(argv)], { env, timeoutMs: 10_000, stdin: opts?.stdin }),
      runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      closeMaster: () => undefined,
    };
    const h = host(loopback);
    const dir = { hostId: 'h1', path: "~/cf remote/it's" };
    const file = { hostId: 'h1', path: "~/cf remote/it's/env" };
    await h.fs.mkdirp(dir);
    expect(await h.fs.exists(file)).toBe(false);
    await h.fs.writeFile(file, 'hello world', 0o600);
    expect(await h.fs.exists(file)).toBe(true);
    expect(await h.fs.readFile(file, 5)).toBe('hello');
    const local = join(home, 'cf remote', "it's", 'env');
    expect(readFileSync(local, 'utf8')).toBe('hello world');
    expect(statSync(local).mode & 0o777).toBe(0o600);
    await expect(h.fs.readFile({ hostId: 'h1', path: '~/missing' })).rejects.toBeInstanceOf(RemoteOperationError);
  });
});
