import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PING_PROGRAM } from '../preflight/preflightEngine';
import { KILL_PROGRAM, PIDFILE_REAP_PROGRAM, SPAWN_WRAPPER, buildRemoteSpawnCommand } from '../remoteLaunch';
import { SSH_HOST_PROGRAMS, parseStatLine } from '../sshHost';
import { FORWARD_PREP_PROGRAM, quoteRemoteArgv, shQuote, spawnCapture } from '../sshTransport';
import {
  CHECK_PROGRAM,
  DISCARD_PROGRAM,
  GC_LIST_PROGRAM,
  GC_REMOVE_PROGRAM,
  INSTALL_PROGRAM,
  PUSH_PROGRAM,
} from '../toolchain/toolchainPusher';

const posix = process.platform !== 'win32';

/**
 * Every fixed program that travels as a `quoteRemoteArgv` word (the remote LOGIN shell parses it first). The
 * probe scripts are not here: they go on stdin to `/bin/sh -s` and never through the login shell's parser.
 */
const PROGRAMS: Record<string, string> = {
  SPAWN_WRAPPER,
  KILL_PROGRAM,
  PIDFILE_REAP_PROGRAM,
  FORWARD_PREP_PROGRAM,
  MCP_PING_PROGRAM,
  CHECK_PROGRAM,
  PUSH_PROGRAM,
  INSTALL_PROGRAM,
  DISCARD_PROGRAM,
  GC_LIST_PROGRAM,
  GC_REMOVE_PROGRAM,
  ...Object.fromEntries(Object.entries(SSH_HOST_PROGRAMS).map(([k, v]) => [`sshHost.${k}`, SSH_HOST_PROGRAMS.pathPrelude + v])),
};

/** Login shells a remote account may have. sh/bash/zsh are POSIX-ish; tcsh/csh history-expand `!` inside '…'. */
interface LoginShell {
  name: string;
  argv: (cmd: string) => string[];
}

const ALL_SHELLS: LoginShell[] = [
  { name: '/bin/sh', argv: (c) => ['/bin/sh', '-c', c] },
  { name: '/bin/bash', argv: (c) => ['/bin/bash', '-c', c] },
  { name: '/bin/zsh', argv: (c) => ['/bin/zsh', '-f', '-c', c] },
  { name: '/bin/tcsh', argv: (c) => ['/bin/tcsh', '-f', '-c', c] },
  { name: '/bin/csh', argv: (c) => ['/bin/csh', '-f', '-c', c] },
];
const SHELLS: LoginShell[] = ALL_SHELLS.filter((s) => existsSync(s.name));

/** What the remote login shell hands to printf: each word NUL-terminated, byte for byte. */
function parseWith(shell: LoginShell, quoted: string): string[] {
  const [file, ...args] = shell.argv(`/usr/bin/printf '%s\\0' ${quoted}`);
  const out = execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: tmpdir() },
  });
  const words = out.split('\0');
  words.pop();
  return words;
}

describe.skipIf(!posix)('quoteRemoteArgv round-trips every fixed remote program through each login shell', () => {
  it('has the shells this test relies on (tcsh ships with macOS)', () => {
    expect(SHELLS.map((s) => s.name)).toContain('/bin/sh');
    if (process.platform === 'darwin') expect(SHELLS.map((s) => s.name)).toContain('/bin/tcsh');
  });

  it('emits every ! outside the quotes as \\!', () => {
    expect(quoteRemoteArgv(['ab!cd'])).toBe("'ab'\\!'cd'");
    expect(quoteRemoteArgv(["!'!"])).toBe("''\\!''\\'''\\!''");
  });

  for (const shell of SHELLS) {
    it(`${shell.name}: every program (and hostile positional words) parse back byte-identical`, () => {
      for (const [name, program] of Object.entries(PROGRAMS)) {
        const argv = ['/bin/sh', '-c', program, 'sh', "/x/it's ! $HOME `y` sp ace", '!', '\\!', '!!', '!$'];
        expect(parseWith(shell, quoteRemoteArgv(argv)), name).toEqual(argv);
      }
    });
  }

  it('negative control: the plain single-quoting is broken under tcsh for a program with !', () => {
    const tcsh = SHELLS.find((s) => s.name === '/bin/tcsh');
    if (!tcsh) return;
    const argv = ['/bin/sh', '-c', SPAWN_WRAPPER];
    expect(() => parseWith(tcsh, argv.map(shQuote).join(' '))).toThrow();
  });

  it('property: hostile one-line words round-trip under every shell', () => {
    const pieces = ["'", '"', '$(', ')', '`', ';', ' ', '\t', '\\', '$HOME', '*', '?', '~', '&&', '|', '<', '>', '#',
      '!', '!!', '!$', '^', '{', '}', '[!a]', 'é', '%s', 'a', '0'];
    let seed = 0x5eed;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 40; i++) {
      const argv = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Array.from({ length: Math.floor(rand() * 6) }, () => pieces[Math.floor(rand() * pieces.length)]).join(''));
      for (const shell of SHELLS) expect(parseWith(shell, quoteRemoteArgv(argv)), `${shell.name} ${JSON.stringify(argv)}`).toEqual(argv);
    }
  });
});

describe.skipIf(!posix || !existsSync('/bin/tcsh'))('fixed programs EXECUTED behind a tcsh login shell', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('the spawn wrapper runs its program with the prelude env; the kill / reap programs exit 0 on nothing', async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-tcsh-')));
    const root = join(home, 'cf-remote', 'h1');
    mkdirSync(root, { recursive: true });
    const command = buildRemoteSpawnCommand({
      facts: { remoteRoot: root, home, path: '/usr/bin:/bin' },
      spawnKey: 'k',
      spawnNonce: '0123456789abcdef',
      argv: ['/bin/sh', '-c', 'printf "%s|%s" "$A" "$1"', 'sh', 'a!b'],
    });
    const r = await spawnCapture('/bin/tcsh', ['-f', '-c', command], { env: { PATH: '/usr/bin:/bin', HOME: home }, stdin: 'A=x!y\n\n', timeoutMs: 10_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('x!y|a!b');
    expect(existsSync(join(root, 'run', 'k.0123456789abcdef.pid'))).toBe(true);
    for (const program of [KILL_PROGRAM, PIDFILE_REAP_PROGRAM]) {
      const k = await spawnCapture('/bin/tcsh', ['-f', '-c', quoteRemoteArgv(['/bin/sh', '-c', program, 'sh', join(root, 'none.pid'), 'TERM'])], {
        env: { PATH: '/usr/bin:/bin', HOME: home }, timeoutMs: 10_000,
      });
      expect(k.code).toBe(0);
    }
  });
});

describe.skipIf(!posix)('sshHost STAT program dialect', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const run = (path: string, env: NodeJS.ProcessEnv) => spawnCapture(
    '/bin/sh', ['-c', SSH_HOST_PROGRAMS.pathPrelude + SSH_HOST_PROGRAMS.stat, 'sh', path], { env, timeoutMs: 10_000 },
  );

  it('uses the local (BSD on macOS) stat and parses', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-stat-')));
    const f = join(dir, 'f');
    writeFileSync(f, 'abc');
    chmodSync(f, 0o640);
    const r = await run(f, { PATH: '/usr/bin:/bin' });
    expect(r.code).toBe(0);
    expect(parseStatLine(r.stdout)).toEqual({ isFile: true, isDir: false, size: 3, mode: 0o640 });
    expect((await run(join(dir, 'missing'), { PATH: '/usr/bin:/bin' })).code).toBe(1);
  });

  it('on a non-BSD uname it calls GNU `stat -L -c` (never `stat -f`, GNU filesystem mode)', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-stat-')));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
    // A GNU-like stat: answers -c, and "succeeds" with filesystem junk on -f (the old fallback's trap).
    writeFileSync(join(bin, 'stat'), '#!/bin/sh\ncase "$2" in -c) echo "regular file|3|640" ;; -f) echo "fs-junk" ;; *) exit 9 ;; esac\n');
    chmodSync(join(bin, 'uname'), 0o755);
    chmodSync(join(bin, 'stat'), 0o755);
    const f = join(dir, 'f');
    writeFileSync(f, 'abc');
    const r = await run(f, { PATH: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(parseStatLine(r.stdout)).toEqual({ isFile: true, isDir: false, size: 3, mode: 0o640 });
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho FreeBSD\n');
    expect((await run(f, { PATH: `${bin}:/usr/bin:/bin` })).stdout.trim()).toBe('fs-junk');
  });
});
