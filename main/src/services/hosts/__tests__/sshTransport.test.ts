import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  SshTransport,
  classifySshFailure,
  quoteRemoteArgv,
  shQuote,
  spawnCapture,
  type ProcessRunOptions,
  type ProcessRunner,
} from '../sshTransport';
import { InvalidSshTargetError } from '../../../orchestrator/hosts/errors';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';

const posix = process.platform !== 'win32';

interface Call {
  file: string;
  args: readonly string[];
  opts: ProcessRunOptions;
}

function fakeRunner(result: Partial<ExecResult> = {}): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return { runner, calls };
}

function logger(): LoggerLike & { warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function transport(runner: ProcessRunner, over: { dir?: string; ensureDir?: (d: string) => void; log?: LoggerLike } = {}) {
  return new SshTransport({
    runner,
    controlDir: () => over.dir ?? '/Users/me/.cyboflow/ssh',
    ensureDir: over.ensureDir ?? (() => undefined),
    env: () => ({ PATH: '/usr/bin:/bin' }),
    logger: over.log,
  });
}

/** Deterministic PRNG (mulberry32) so a failing case is reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_PIECES = [
  "'", '"', '$(', ')', '`', '\n', ';', '-', '--', ' ', '\t', '\\', '$HOME', '${IFS}', '*', '?', '~', '&&', '|',
  '<', '>', '#', '!', '{', '}', "'\\''", 'rm -rf /', 'é', '日本', '%s', '\r', 'a', 'Z', '0',
];

function hostileWord(rand: () => number): string {
  const n = Math.floor(rand() * 7);
  let s = '';
  for (let i = 0; i < n; i++) s += HOSTILE_PIECES[Math.floor(rand() * HOSTILE_PIECES.length)];
  return s;
}

describe('remote quoting', () => {
  it('single-quotes every word and escapes embedded quotes', () => {
    expect(shQuote('a b')).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote('')).toBe("''");
    expect(quoteRemoteArgv(['git', '-C', '/x y', 'status'])).toBe("'git' '-C' '/x y' 'status'");
  });

  it('rejects an empty argv and NUL bytes', () => {
    expect(() => quoteRemoteArgv([])).toThrow(/empty/);
    expect(() => quoteRemoteArgv(['a\0b'])).toThrow(/NUL/);
  });

  it.skipIf(!posix)('property: a POSIX shell parses the quoted command back into the exact argv', () => {
    const rand = prng(0xc0ffee);
    for (let i = 0; i < 150; i++) {
      const argv = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => hostileWord(rand));
      // printf repeats its format per argument: each word comes back NUL-terminated, byte for byte.
      const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${quoteRemoteArgv(argv)}`], { encoding: 'utf8' });
      const words = out.split('\0');
      words.pop();
      expect(words, JSON.stringify(argv)).toEqual(argv);
    }
  });

  it.skipIf(!posix)('property: hostile words never execute (no command substitution side effects)', () => {
    const marker = `/tmp/cyboflow-quote-canary-${process.pid}`;
    const argv = [`$(touch ${marker})`, `\`touch ${marker}\``, `; touch ${marker}`, `\ntouch ${marker}`];
    execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${quoteRemoteArgv(argv)}`]);
    expect(() => execFileSync('/bin/test', ['-e', marker])).toThrow();
  });
});

describe('SshTransport argv', () => {
  it('exec: control options, `--` before the destination, the remote command as ONE quoted argv element', async () => {
    const { runner, calls } = fakeRunner();
    const ensureDir = vi.fn();
    const t = transport(runner, { ensureDir });
    await t.exec('cybo-mbp', ['echo', "it's $(x)"], { timeoutMs: 1234 });
    expect(calls).toHaveLength(1);
    const { file, args, opts } = calls[0];
    expect(file).toBe('ssh');
    expect(args).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', 'ControlPath="/Users/me/.cyboflow/ssh/cm-%C"',
      '--', 'cybo-mbp', "'echo' 'it'\\''s $(x)'",
    ]);
    expect(opts.timeoutMs).toBe(1234);
    expect(opts.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(ensureDir).toHaveBeenCalledWith('/Users/me/.cyboflow/ssh');
    await t.exec('cybo-mbp', ['true']);
    expect(ensureDir).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid or option-like destination before spawning', async () => {
    const { runner, calls } = fakeRunner();
    const t = transport(runner);
    await expect(t.exec('-oProxyCommand=evil', ['true'])).rejects.toBeInstanceOf(InvalidSshTargetError);
    await expect(t.exec('a b', ['true'])).rejects.toBeInstanceOf(InvalidSshTargetError);
    await expect(t.runScript('', 'true')).rejects.toBeInstanceOf(InvalidSshTargetError);
    expect(calls).toHaveLength(0);
  });

  it('falls back to ControlMaster=no when the socket path would be too long', async () => {
    const { runner, calls } = fakeRunner();
    const log = logger();
    const t = transport(runner, { dir: `/Users/${'x'.repeat(60)}/.cyboflow/ssh`, log });
    await t.exec('box', ['true']);
    expect(calls[0].args).toContain('ControlMaster=no');
    expect(calls[0].args.some((a) => a.startsWith('ControlPath='))).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to ControlMaster=no when the control directory cannot be created', async () => {
    const { runner, calls } = fakeRunner();
    const t = transport(runner, { ensureDir: () => { throw new Error('EACCES'); } });
    await t.exec('box', ['true']);
    expect(calls[0].args).toContain('ControlMaster=no');
  });

  it('escapes % in the data dir (ssh token syntax)', async () => {
    const { runner, calls } = fakeRunner();
    await transport(runner, { dir: '/d/50%/ssh' }).exec('box', ['true']);
    expect(calls[0].args).toContain('ControlPath="/d/50%%/ssh/cm-%C"');
  });

  it('runScript sends the script on stdin to /bin/sh -s and redacts both streams', async () => {
    const { runner, calls } = fakeRunner({ stdout: 'tok=sk-ant-abc123\n', stderr: 'sk-ant-zzz' });
    const r = await transport(runner).runScript('box', 'echo hi');
    expect(calls[0].args.slice(-4)).toEqual(['--', 'box', '/bin/sh', '-s']);
    expect(calls[0].opts.stdin).toBe('echo hi');
    expect(r.stdout).toBe('tok=sk-ant-[REDACTED]\n');
    expect(r.stderr).toBe('sk-ant-[REDACTED]');
  });

  it('exec redacts stderr but returns stdout (data) untouched', async () => {
    const { runner } = fakeRunner({ stdout: 'sk-ant-data', stderr: 'oops sk-ant-secret' });
    const r = await transport(runner).exec('box', ['cat', 'f']);
    expect(r.stdout).toBe('sk-ant-data');
    expect(r.stderr).toBe('oops sk-ant-[REDACTED]');
  });

  it('closeMaster fires `ssh -O exit` and is a no-op for invalid targets or without multiplexing', async () => {
    const { runner, calls } = fakeRunner();
    transport(runner).closeMaster('box');
    expect(calls[0].args.slice(0, 2)).toEqual(['-O', 'exit']);
    expect(calls[0].args.slice(-2)).toEqual(['--', 'box']);
    transport(runner).closeMaster('-bad');
    transport(runner, { dir: `/${'y'.repeat(90)}` }).closeMaster('box');
    expect(calls).toHaveLength(1);
  });
});

describe.skipIf(!posix)('spawnCapture (local processes only)', () => {
  const env = { PATH: '/usr/bin:/bin' };

  it('captures stdout/stderr/exit code and feeds stdin', async () => {
    const r = await spawnCapture('/bin/sh', ['-c', 'cat; echo err >&2; exit 3'], { stdin: 'hello', timeoutMs: 5000, env });
    expect(r).toEqual({ code: 3, stdout: 'hello', stderr: 'err\n', timedOut: false });
  });

  it('kills on timeout and reports timedOut without throwing', async () => {
    const r = await spawnCapture('/bin/sleep', ['5'], { timeoutMs: 100, env });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('resolves (never rejects) for a missing binary', async () => {
    const r = await spawnCapture('/nonexistent/ssh-binary', [], { timeoutMs: 1000, env });
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('honours an abort signal', async () => {
    const ac = new AbortController();
    const p = spawnCapture('/bin/sleep', ['5'], { timeoutMs: 10_000, env, signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    const pre = await spawnCapture('/bin/sleep', ['5'], { timeoutMs: 10_000, env, signal: ac.signal });
    expect(pre.stderr).toBe('aborted');
  });
});

describe('classifySshFailure', () => {
  const cases: Array<[string, string, boolean, string, RegExp]> = [
    ['auth', 'user@box: Permission denied (publickey).', false, 'auth', /ssh-copy-id box/],
    ['auth (multi-method)', 'Permission denied (publickey,password,keyboard-interactive).', false, 'auth', /ssh-agent/],
    ['host key failed', 'Host key verification failed.', false, 'host-key', /Run `ssh box` once in Terminal/],
    ['host key changed', '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', false, 'host-key', /confirm the host key/],
    ['dns', 'ssh: Could not resolve hostname box: nodename nor servname provided, or not known', false, 'dns', /Tailscale/],
    ['timeout (ours)', '', true, 'timeout', /asleep or offline/],
    ['timeout (ssh)', 'ssh: connect to host box port 22: Operation timed out', false, 'timeout', /asleep or offline/],
    ['refused', 'ssh: connect to host box port 22: Connection refused', false, 'refused', /Remote Login/],
    ['other', 'kex_exchange_identification: read: Connection reset by peer', false, 'other', /ssh box/],
  ];
  it.each(cases)('%s', (_name, stderr, timedOut, kind, fix) => {
    const f = classifySshFailure(stderr, timedOut, 'box');
    expect(f.kind).toBe(kind);
    expect(f.fix).toMatch(fix);
    expect(f.detail.length).toBeGreaterThan(0);
  });

  it('redacts secrets and bounds the detail line', () => {
    const f = classifySshFailure(`debug sk-ant-SECRETVALUE\n${'x'.repeat(1000)} sk-${'a'.repeat(30)}`, false, 'box');
    expect(f.detail).not.toMatch(/SECRETVALUE|a{30}/);
    expect(f.detail.length).toBeLessThanOrEqual(301);
  });
});
