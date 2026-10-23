import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostGitCommandError, type ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import { InvalidRemoteEnvError, KILL_PROGRAM, SPAWN_WRAPPER, type RemoteHostFacts } from '../remoteLaunch';
import { InvalidRemotePathError, RemoteHostNotReadyError, SshHost, UnsafeRemoveError, parseStatLine } from '../sshHost';
import { quoteRemoteArgv, spawnCapture, type SshExecOptions, type SshTransportLike } from '../sshTransport';

const posix = process.platform !== 'win32';

interface ExecCall {
  argv: readonly string[];
  opts?: SshExecOptions;
}

interface Recording {
  transport: SshTransportLike;
  calls: ExecCall[];
  streams: Array<{ target: string; command: string; dedicated: boolean }>;
}

function recording(answer: (argv: readonly string[]) => Partial<ExecResult> = () => ({})): Recording {
  const calls: ExecCall[] = [];
  const streams: Recording['streams'] = [];
  const transport: SshTransportLike = {
    exec: async (_target, argv, opts) => {
      calls.push({ argv, opts });
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(argv) };
    },
    runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    closeMaster: () => undefined,
    controlArgs: () => [],
    spawnStreaming: (target, command, opts) => {
      streams.push({ target, command, dedicated: opts.dedicated });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
      });
      return child as unknown as ChildProcess;
    },
    openForward: () => { throw new Error('not used'); },
    pushStream: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  };
  return { transport, calls, streams };
}

function host(transport: SshTransportLike, over: { remoteRoot?: string; facts?: RemoteHostFacts | null } = {}): SshHost {
  return new SshHost({
    id: 'h1', label: 'Box', sshTarget: 'box', remoteRoot: over.remoteRoot ?? '~/cf-remote/h1', appVersion: '1.0.0', transport,
    localExists: () => false, remoteFacts: () => over.facts ?? null,
  });
}

const FACTS: RemoteHostFacts = { remoteRoot: '/Users/me/cf-remote/h1', home: '/Users/me', user: 'me' };

describe('SshHost exec with cwd / env (wrapper prelude, never argv)', () => {
  it('routes through the wrapper: cwd positional, env + caller stdin on stdin', async () => {
    const { transport, calls } = recording();
    const h = host(transport);
    await h.exec.exec(['git', 'status'], { cwd: "~/wt/it's", env: { GIT_TERMINAL_PROMPT: '0' }, stdin: 'data', timeoutMs: 7 });
    expect(calls[0].argv).toEqual(['/bin/sh', '-c', SPAWN_WRAPPER, 'sh', "~/wt/it's", '', '', 'git', 'status']);
    expect(calls[0].opts).toMatchObject({ stdin: 'GIT_TERMINAL_PROMPT=0\n\ndata', timeoutMs: 7 });
    expect(calls[0].argv.join(' ')).not.toContain('GIT_TERMINAL_PROMPT');
  });

  it('without cwd/env the argv is sent as-is; invalid env / cwd are refused before any ssh', async () => {
    const { transport, calls } = recording();
    const h = host(transport);
    await h.exec.exec(['uname']);
    expect(calls[0].argv).toEqual(['uname']);
    await expect(h.exec.exec(['x'], { env: { 'A B': '1' } })).rejects.toBeInstanceOf(InvalidRemoteEnvError);
    await expect(h.exec.exec(['x'], { env: { A: 'a\nb' } })).rejects.toBeInstanceOf(InvalidRemoteEnvError);
    await expect(h.exec.exec(['x'], { cwd: 'relative' })).rejects.toBeInstanceOf(InvalidRemotePathError);
    await expect(h.exec.exec([])).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(1);
  });

  it('git.run with env goes through the wrapper with the repo as cwd', async () => {
    const { transport, calls } = recording();
    await host(transport).git.run({ hostId: 'h1', path: '~/r' }, ['commit', '-m', 'x'], { env: { GIT_AUTHOR_NAME: 'A' } });
    expect(calls[0].argv.slice(3)).toEqual(['sh', '~/r', '', '', 'git', 'commit', '-m', 'x']);
    expect(calls[0].opts?.stdin).toBe('GIT_AUTHOR_NAME=A\n\n');
  });
});

describe('SshHost git.capture (runGitCapture parity)', () => {
  it('returns both streams on exit 0 and throws HostGitCommandError with code + redacted stderr tail otherwise', async () => {
    const ok = recording(() => ({ stdout: 'abc\n', stderr: 'warn\n' }));
    expect(await host(ok.transport).git.capture({ hostId: 'h1', path: '~/r' }, ['rev-parse', 'HEAD'])).toEqual({ stdout: 'abc\n', stderr: 'warn\n' });
    const bad = recording(() => ({ code: 128, stdout: 'partial', stderr: 'fatal: bad token sk-ant-SECRET\n' }));
    const err = await host(bad.transport).git.capture({ hostId: 'h1', path: '~/r' }, ['fetch', 'origin']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostGitCommandError);
    const e = err as HostGitCommandError;
    expect(e.code).toBe(128);
    expect(e.stdout).toBe('partial');
    expect(e.message).toBe('Command failed: git fetch origin\nfatal: bad token sk-ant-[REDACTED]');
    expect(e.stderr).not.toContain('SECRET');
  });
});

describe('SshHost rmrf / info.remoteRoot guards', () => {
  it.each([
    ['/'], ['~/'], ['/Users/me'], ['~/cf-remote/h1'], ['~/cf-remote/h1/'], ['~/cf-remote/h1/../x'],
    ['~/cf-remote/h1/./x'], ['~/cf-remote/h2/x'], ['~/cf-remote/h10/x'], ['/etc/cf-remote/h1/x'],
  ])('refuses %j before any ssh', async (p) => {
    const { transport, calls } = recording();
    await expect(host(transport).fs.rmrf({ hostId: 'h1', path: p })).rejects.toBeInstanceOf(UnsafeRemoveError);
    expect(calls).toHaveLength(0);
  });

  it('sends the path and the matching root form positionally; a remote refusal (exit 3) throws', async () => {
    const { transport, calls } = recording();
    // A bare `~` is not even a valid remote path.
    await expect(host(transport).fs.rmrf({ hostId: 'h1', path: '~' })).rejects.toBeInstanceOf(InvalidRemotePathError);
    await host(transport).fs.rmrf({ hostId: 'h1', path: '~/cf-remote/h1/wt/s1/' });
    expect(calls[0].argv.slice(3)).toEqual(['sh', '~/cf-remote/h1/wt/s1', '~/cf-remote/h1']);
    // With probe facts, the expanded absolute form is accepted too.
    const withFacts = recording();
    await host(withFacts.transport, { facts: FACTS }).fs.rmrf({ hostId: 'h1', path: '/Users/me/cf-remote/h1/wt/x' });
    expect(withFacts.calls[0].argv.slice(-1)).toEqual(['/Users/me/cf-remote/h1']);
    const refused = recording(() => ({ code: 3 }));
    await expect(host(refused.transport).fs.rmrf({ hostId: 'h1', path: '~/cf-remote/h1/x' })).rejects.toBeInstanceOf(UnsafeRemoveError);
  });

  it('info.remoteRoot: facts first, an absolute configured root as-is, else null', () => {
    const { transport } = recording();
    expect(host(transport).info.remoteRoot).toBeNull();
    expect(host(transport, { facts: FACTS }).info.remoteRoot).toBe('/Users/me/cf-remote/h1');
    expect(host(transport, { remoteRoot: '/srv/cf/' }).info.remoteRoot).toBe('/srv/cf');
  });

  it('parseStatLine reads BSD and GNU shapes', () => {
    expect(parseStatLine('Regular File|213|0644\n')).toEqual({ isFile: true, isDir: false, size: 213, mode: 0o644 });
    expect(parseStatLine('directory|4096|1777')).toEqual({ isFile: false, isDir: true, size: 4096, mode: 0o1777 });
    expect(parseStatLine('regular empty file|0|600').isFile).toBe(true);
    expect(() => parseStatLine('garbage')).toThrow();
  });
});

describe('SshHost spawn', () => {
  it('refuses before a complete probe; never puts the env on the command line', () => {
    const { transport, streams } = recording();
    expect(() => host(transport).spawn({ command: 'x', args: [], spawnKey: 'k' })).toThrow(RemoteHostNotReadyError);
    const p = host(transport, { facts: FACTS }).spawn({
      command: '/r/tc/claude', args: ['--output-format', 'stream-json'], cwd: '/Users/me/cf-remote/h1/wt/s1',
      env: { CYBOFLOW_RUN_ID: 'r1', SECRETISH: 'value-only-on-stdin' }, spawnKey: 'r1', withTokenEnvFile: true,
    });
    expect(p.pid).toBeUndefined();
    expect(streams).toHaveLength(1);
    expect(streams[0].dedicated).toBe(true);
    expect(streams[0].command).not.toContain('value-only-on-stdin');
    expect(streams[0].command).toContain(quoteRemoteArgv([
      'sh', '/Users/me/cf-remote/h1/wt/s1', '/Users/me/cf-remote/h1/env', '/Users/me/cf-remote/h1/run/r1.pid',
      '/r/tc/claude', '--output-format', 'stream-json',
    ]));
    expect(() => host(transport, { facts: FACTS }).spawn({ command: 'x', args: [], spawnKey: '../k' })).toThrow();
    expect(() => host(transport, { facts: FACTS }).spawn({ command: 'x', args: [], spawnKey: 'k', env: { A: 'x\ny' } })).toThrow(InvalidRemoteEnvError);
  });
});

describe.skipIf(!posix)('SshHost against a local /bin/sh loopback (no ssh)', () => {
  let home: string | null = null;
  const live: ChildProcess[] = [];
  afterEach(() => {
    for (const c of live.splice(0)) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  /** exec = `sh -c <quoted argv>` with HOME=<temp>; spawnStreaming = the same in a fresh session (sshd setsid). */
  function loopback(h: string, outside: string): SshTransportLike {
    const env = { PATH: '/usr/bin:/bin', HOME: h };
    return {
      exec: async (_t, argv, opts) => {
        if (argv[2] === KILL_PROGRAM) {
          // Safety net for the test runner's own group: only ever signal the loopback session we started.
          const [pid, pgid] = readFileSync(argv[4], 'utf8').trim().split(' ');
          if (!live.some((c) => String(c.pid) === pgid || String(c.pid) === pid)) throw new Error('refusing to signal a foreign group');
        }
        return spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(argv)], { env, timeoutMs: 10_000, stdin: opts?.stdin });
      },
      runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      closeMaster: () => undefined,
      controlArgs: () => [],
      spawnStreaming: (_t, command) => {
        const c = spawn('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', OUTSIDE: outside }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        live.push(c);
        return c;
      },
      openForward: () => { throw new Error('not used'); },
      pushStream: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    };
  }

  function setup() {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-sshx-')));
    const root = join(home, 'cf-remote', 'h1');
    mkdirSync(root, { recursive: true });
    const facts: RemoteHostFacts = { remoteRoot: root, home };
    const h = new SshHost({
      id: 'h1', label: 'Box', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', appVersion: '1', localExists: () => false,
      transport: loopback(home, 'leak'), remoteFacts: () => facts,
    });
    return { home, root, h };
  }

  it('readdir lists hostile names (NUL-separated); stat / unlink behave', async () => {
    const { root, h } = setup();
    const dir = join(root, 'd');
    mkdirSync(dir);
    const names = ['-leading', "it's", 'sp ace', 'new\nline', '.hidden', '..dots', '$HOME', '`x`'];
    for (const n of names) writeFileSync(join(dir, n), 'x');
    mkdirSync(join(dir, 'sub'));
    const hp = (p: string) => ({ hostId: 'h1', path: p });
    expect((await h.fs.readdir(hp('~/cf-remote/h1/d'))).sort()).toEqual([...names, 'sub'].sort());
    await expect(h.fs.readdir(hp('~/cf-remote/h1/missing'))).rejects.toThrow();
    expect(await h.fs.stat(hp(`${dir}/it's`))).toMatchObject({ isFile: true, isDir: false, size: 1 });
    expect(await h.fs.stat(hp('~/cf-remote/h1/d/sub'))).toMatchObject({ isFile: false, isDir: true });
    expect(await h.fs.stat(hp('~/cf-remote/h1/nope'))).toBeNull();
    await h.fs.unlink(hp('~/cf-remote/h1/d/-leading'));
    expect(existsSync(join(dir, '-leading'))).toBe(false);
    await h.fs.unlink(hp('~/cf-remote/h1/d/-leading'));
    await expect(h.fs.unlink(hp('~/cf-remote/h1/d/sub'))).rejects.toBeInstanceOf(UnsafeRemoveError);
  });

  it('rmrf removes inside the root and refuses a symlinked parent that points outside it', async () => {
    const { home: hm, root, h } = setup();
    mkdirSync(join(root, 'wt', 'a', 'b'), { recursive: true });
    await h.fs.rmrf({ hostId: 'h1', path: '~/cf-remote/h1/wt/a' });
    expect(existsSync(join(root, 'wt', 'a'))).toBe(false);
    await h.fs.rmrf({ hostId: 'h1', path: '~/cf-remote/h1/wt/gone' });
    const outside = join(hm, 'precious');
    mkdirSync(join(outside, 'keep'), { recursive: true });
    symlinkSync(outside, join(root, 'link'));
    await expect(h.fs.rmrf({ hostId: 'h1', path: '~/cf-remote/h1/link/keep' })).rejects.toBeInstanceOf(UnsafeRemoveError);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
  });

  it('spawn: the program gets cwd + prelude env (not the local env), reads the remaining stdin, and kill() reaps it', async () => {
    const { root, h } = setup();
    const wt = join(root, 'wt', "s 1'");
    mkdirSync(wt, { recursive: true });
    const p = h.spawn({
      command: '/bin/sh',
      args: ['-c', 'printf "%s|%s|%s\\n" "$(pwd)" "$RUN" "${OUTSIDE-unset}"; read line; printf "got:%s\\n" "$line"; exec sleep 30'],
      cwd: wt,
      env: { RUN: 'r 1', PATH: '/usr/bin:/bin' },
      spawnKey: 'r1',
    });
    let out = '';
    p.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    p.stdin.write('hello\n');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no output: ${out}`)), 5_000);
      p.stdout.on('data', () => {
        if (out.includes('got:')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    expect(out).toBe(`${wt}|r 1|unset\ngot:hello\n`);
    expect(readFileSync(join(root, 'run', 'r1.pid'), 'utf8')).toMatch(/^\d+ \d+\n$/);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => p.once('exit', (_c: number | null, s: NodeJS.Signals | null) => resolve(s)));
    expect(p.kill('SIGTERM')).toBe(true);
    // stdin EOF does not stop `sleep`: the remote group kill after the 2 s grace does.
    expect(await exited).toBe('SIGTERM');
    expect(p.killed).toBe(true);
  }, 15_000);
});
