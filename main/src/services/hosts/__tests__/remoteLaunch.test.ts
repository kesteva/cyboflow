import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidRemoteEnvError,
  InvalidSpawnKeyError,
  InvalidSpawnNonceError,
  KILL_PROGRAM,
  PIDFILE_REAP_PROGRAM,
  SPAWN_WRAPPER,
  TOKEN_ENV_FILE_PATTERN,
  WRAPPER_EXIT,
  buildRemoteSpawnCommand,
  composeRemoteEnv,
  composeRemotePath,
  describeWrapperExit,
  encodeEnvPrelude,
  envIBase,
  isPidFileOfSpawnKey,
  killArgv,
  reapPidFileArgv,
  remotePidFile,
  remotePidFileGlob,
  wrapperArgv,
  type RemoteHostFacts,
} from '../remoteLaunch';
import { quoteRemoteArgv, spawnCapture } from '../sshTransport';

const posix = process.platform !== 'win32';

/** The exact wrapper text. Any change to SPAWN_WRAPPER must be a deliberate, reviewed edit of this golden. */
const GOLDEN_WRAPPER =
  'umask 077; c=$1; e=$2; f=$3; shift 3; ' +
  'case "$c" in "~/"*) c="$HOME/${c#??}" ;; esac; ' +
  'case "$e" in "~/"*) e="$HOME/${e#??}" ;; esac; ' +
  'case "$f" in "~/"*) f="$HOME/${f#??}" ;; esac; ' +
  'if [ -n "$c" ]; then cd -- "$c" || exit 97; fi; ' +
  'if [ -n "$f" ]; then g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " "); ' +
  'mkdir -p -- "${f%/*}" && printf "%s %s\\n" "$$" "$g" > "$f" || exit 95; fi; ' +
  'if [ -n "$e" ] && [ -f "$e" ]; then ' +
  't=$(grep -m1 -E -e "^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-[A-Za-z0-9_-]+\\$" -- "$e" 2>/dev/null) && [ -n "$t" ] && export "$t"; t=; fi; ' +
  'while :; do IFS= read -r l || exit 98; [ -z "$l" ] && break; ' +
  'case "$l" in *=*) ;; *) exit 98 ;; esac; k=${l%%=*}; ' +
  'case "$k" in ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) exit 98 ;; esac; ' +
  'export "$l"; done; ' +
  '[ $# -gt 0 ] || exit 96; exec "$@"';

const NONCE = '0123456789abcdef';

const HOSTILE_DIR = `-d it's "q" $HOME \`x\` sp ace`;

function facts(over: Partial<RemoteHostFacts> = {}): RemoteHostFacts {
  return { remoteRoot: '/Users/me/cf-remote/h1', home: '/Users/me', user: 'me', shell: '/bin/zsh', ...over };
}

describe('SPAWN_WRAPPER', () => {
  it('matches the golden text, is one line, and splices no caller data', () => {
    expect(SPAWN_WRAPPER).toBe(GOLDEN_WRAPPER);
    expect(SPAWN_WRAPPER).not.toContain('\n');
    expect(SPAWN_WRAPPER).not.toMatch(/\beval\b|\bsource\b|(^|[;\s])\.\s/);
  });

  it('the token pattern documented for the env file is the one the wrapper greps', () => {
    expect(SPAWN_WRAPPER).toContain(TOKEN_ENV_FILE_PATTERN.replace('$', '\\$'));
    const re = new RegExp(TOKEN_ENV_FILE_PATTERN);
    expect(re.test('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbC_9-x')).toBe(true);
    expect(re.test('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-x; rm -rf ~')).toBe(false);
    expect(re.test('export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-x')).toBe(false);
    expect(re.test('CLAUDE_CODE_OAUTH_TOKEN=$(id)')).toBe(false);
  });
});

describe('encodeEnvPrelude', () => {
  it('encodes KEY=value lines plus the empty terminator, skipping undefined', () => {
    expect(encodeEnvPrelude({ A: '1', B: 'x y=z', C: undefined, _D9: '' })).toBe('A=1\nB=x y=z\n_D9=\n\n');
    expect(encodeEnvPrelude({})).toBe('\n');
  });

  it.each([['A B'], ['1A'], [''], ['A-B'], ['A=B'], ['é']])('rejects the key %j locally', (key) => {
    expect(() => encodeEnvPrelude({ [key]: 'x' })).toThrow(InvalidRemoteEnvError);
  });

  it('rejects newline / NUL values and the keys that must never travel in a prelude', () => {
    expect(() => encodeEnvPrelude({ A: 'x\ny' })).toThrow(InvalidRemoteEnvError);
    expect(() => encodeEnvPrelude({ A: 'x\0y' })).toThrow(InvalidRemoteEnvError);
    for (const key of ['CYBOFLOW_ORCH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
      expect(() => encodeEnvPrelude({ [key]: 'v' })).toThrow(/never/);
    }
  });
});

describe('remote command builders', () => {
  it('envIBase uses only probe facts, with a default PATH, and requires home', () => {
    expect(envIBase(facts({ lang: 'en_US.UTF-8', tmpdir: '/var/tmp' }))).toEqual([
      '/usr/bin/env', '-i', 'HOME=/Users/me', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'USER=me', 'LOGNAME=me',
      'SHELL=/bin/zsh', 'TMPDIR=/var/tmp', 'LANG=en_US.UTF-8',
    ]);
    expect(() => envIBase(facts({ home: '' }))).toThrow(InvalidRemoteEnvError);
    expect(() => envIBase(facts({ user: 'a\nb' }))).toThrow(InvalidRemoteEnvError);
  });

  it('wrapperArgv / buildRemoteSpawnCommand put every path and arg in a positional word', () => {
    expect(wrapperArgv({ cwd: '/w', envFile: '', pidFile: '/p', argv: ['claude', '-p'] })).toEqual([
      '/bin/sh', '-c', SPAWN_WRAPPER, 'sh', '/w', '', '/p', 'claude', '-p',
    ]);
    expect(() => wrapperArgv({ cwd: '', envFile: '', pidFile: '', argv: [] })).toThrow(/empty/);
    const cmd = buildRemoteSpawnCommand({
      facts: facts(), cwd: HOSTILE_DIR, withTokenEnvFile: true, spawnKey: 'run-1', spawnNonce: NONCE, argv: ['/t/claude', '--x', "a'b"],
    });
    expect(cmd).toBe(quoteRemoteArgv([
      ...envIBase(facts()),
      '/bin/sh', '-c', SPAWN_WRAPPER, 'sh', HOSTILE_DIR, '/Users/me/cf-remote/h1/env', '/Users/me/cf-remote/h1/run/run-1.0123456789abcdef.pid',
      '/t/claude', '--x', "a'b",
    ]));
    const noToken = buildRemoteSpawnCommand({ facts: facts(), spawnKey: 'k', spawnNonce: NONCE, argv: ['x'] });
    expect(noToken).toContain(`'sh' '' '' '/Users/me/cf-remote/h1/run/k.0123456789abcdef.pid' 'x'`);
  });

  it('spawn keys are filename-safe; the pidfile is per spawn (<key>.<nonce>.pid)', () => {
    expect(remotePidFile('/r', 'run_1.a-b', NONCE)).toBe(`/r/run/run_1.a-b.${NONCE}.pid`);
    for (const bad of ['', '..', '.', 'a/b', 'a b', '$x', 'x'.repeat(129)]) {
      expect(() => remotePidFile('/r', bad, NONCE)).toThrow(InvalidSpawnKeyError);
    }
    for (const bad of ['', 'abc', 'ABCDEF0123', '0123456789abcdeg', '../../x1234567', 'a'.repeat(65)]) {
      expect(() => remotePidFile('/r', 'k', bad)).toThrow(InvalidSpawnNonceError);
    }
  });

  it('isPidFileOfSpawnKey matches one key exactly (key `a` never claims key `a.b`)', () => {
    expect(isPidFileOfSpawnKey(`a.${NONCE}.pid`, 'a')).toBe(true);
    expect(isPidFileOfSpawnKey(`a.b.${NONCE}.pid`, 'a')).toBe(false);
    expect(isPidFileOfSpawnKey(`a.b.${NONCE}.pid`, 'a.b')).toBe(true);
    expect(isPidFileOfSpawnKey('a.pid', 'a')).toBe(false);
    expect(isPidFileOfSpawnKey(`ab.${NONCE}.pid`, 'a')).toBe(false);
  });

  it('reapPidFileArgv passes the pidfile positionally', () => {
    expect(reapPidFileArgv('/r/run/k.x.pid')).toEqual(['/bin/sh', '-c', PIDFILE_REAP_PROGRAM, 'sh', '/r/run/k.x.pid']);
  });

  it('killArgv passes the pidfile and signal positionally', () => {
    expect(killArgv('/r/run/k.pid', 'TERM')).toEqual(['/bin/sh', '-c', KILL_PROGRAM, 'sh', '/r/run/k.pid', 'TERM']);
  });

  it('describeWrapperExit names the wrapper codes only', () => {
    expect(describeWrapperExit({ code: WRAPPER_EXIT.cwd })).toMatch(/working directory/);
    expect(describeWrapperExit({ code: WRAPPER_EXIT.prelude })).toMatch(/prelude/);
    expect(describeWrapperExit({ code: 0 })).toBeNull();
  });
});

describe('composeRemoteEnv (allowlist)', () => {
  const local = {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/local',
    USER: 'local',
    SSH_AUTH_SOCK: '/tmp/agent',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    ELECTRON_RUN_AS_NODE: '1',
    CYBOFLOW_ORCH_TOKEN: 'tok',
    CYBOFLOW_ORCH_SOCKET: '/Users/local/.cyboflow/sockets/orch.sock',
    CYBOFLOW_RUN_ARTIFACTS_DIR: '/Users/local/.cyboflow/artifacts/runs/r1',
    CYBOFLOW_RUN_ID: 'r1',
    CYBOFLOW_WORKTREE: '/Users/local/proj/.cyboflow/worktrees/s1/sub',
    CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1',
    CLAUDE_AGENT_SDK_VERSION: '0.3.0',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CODEX_HOME: '/Users/local/.codex',
    LANE_SLOT: '/Users/local/proj/.cyboflow/worktrees/s1/.lane/2',
    LC_ALL: 'en_US.UTF-8',
  };

  it('keeps only the allowlist, takes identity from the remote facts and remaps paths', () => {
    const env = composeRemoteEnv(local, {
      facts: facts({ tmpdir: '/var/tmp', lang: 'C' }),
      path: composeRemotePath({ codexPathDir: '/r/tc/codex-path', nodeDir: '/opt/node/bin', gitDir: null }),
      orchSocket: '/Users/me/cf-remote/h1/s/o.sock',
      artifactsDir: '/Users/me/cf-remote/h1/artifacts/runs/r1',
      orchTokenFile: '/Users/me/cf-remote/h1/run/r1.token',
      extraKeys: ['LANE_SLOT', 'ELECTRON_RUN_AS_NODE', 'CYBOFLOW_ORCH_TOKEN'],
      pathMap: [{ from: '/Users/local/proj/.cyboflow/worktrees/s1', to: '/Users/me/cf-remote/h1/wt/s1' }],
    });
    expect(env).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/tmp',
      LANG: 'C',
      TERM: 'dumb',
      PATH: '/r/tc/codex-path:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      LC_ALL: 'en_US.UTF-8',
      CLAUDE_AGENT_SDK_VERSION: '0.3.0',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CYBOFLOW_RUN_ID: 'r1',
      CYBOFLOW_WORKTREE: '/Users/me/cf-remote/h1/wt/s1/sub',
      CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1',
      LANE_SLOT: '/Users/me/cf-remote/h1/wt/s1/.lane/2',
      CYBOFLOW_ORCH_SOCKET: '/Users/me/cf-remote/h1/s/o.sock',
      CYBOFLOW_RUN_ARTIFACTS_DIR: '/Users/me/cf-remote/h1/artifacts/runs/r1',
      CYBOFLOW_ORCH_TOKEN_FILE: '/Users/me/cf-remote/h1/run/r1.token',
    });
  });

  it('drops the remappable cyboflow paths without a remote value; CODEX_HOME only when set remotely', () => {
    const env = composeRemoteEnv(local, { facts: facts(), path: '/usr/bin:/bin', codexHome: '/Users/me/.codex' });
    expect(env.CYBOFLOW_ORCH_SOCKET).toBeUndefined();
    expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBeUndefined();
    expect(env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
    expect(env.CYBOFLOW_ORCH_TOKEN_FILE).toBeUndefined();
    expect(env.CODEX_HOME).toBe('/Users/me/.codex');
    expect(composeRemoteEnv(local, { facts: facts(), path: '/usr/bin' }).CODEX_HOME).toBeUndefined();
    // The composed env is always prelude-carriable.
    expect(() => encodeEnvPrelude(env)).not.toThrow();
  });
});

describe.skipIf(!posix)('wrapper run by a local /bin/sh (what sshd does with the command; no ssh)', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  function setup(): { home: string; root: string; work: string } {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-wrap-')));
    const root = join(home, 'cf-remote', 'h1');
    const work = join(home, HOSTILE_DIR);
    mkdirSync(root, { recursive: true });
    mkdirSync(work, { recursive: true });
    return { home, root, work };
  }

  /** Runs the remote command string like sshd: `sh -c <command>`, in a fresh session (setsid) like sshd does. */
  function runRemote(command: string, stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  const PROBE = 'printf "pwd=%s\\n" "$(pwd)"; printf "A=%s\\n" "$A"; printf "LEAK=%s\\n" "${LEAK-unset}"; ' +
    'printf "TOKLEN=%s\\n" "${#CLAUDE_CODE_OAUTH_TOKEN}"; printf "PID=%s\\n" "$$"; printf "REST=%s\\n" "$(cat)"';

  it('cds into a hostile path, exports the prelude under env -i, extracts only the token line, passes the rest of stdin', async () => {
    const { home: h, root, work } = setup();
    writeFileSync(join(root, 'env'), '# comment\nexport FOO=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-Ab_9\n$(touch /tmp/never)\n', { mode: 0o600 });
    const command = buildRemoteSpawnCommand({
      facts: { remoteRoot: root, home: h, path: '/usr/bin:/bin' },
      cwd: work, withTokenEnvFile: true, spawnKey: 'k1', spawnNonce: NONCE, argv: ['/bin/sh', '-c', PROBE],
    });
    const r = await runRemote(command, `${encodeEnvPrelude({ A: "va'l $x `y`" })}payload-bytes`, { PATH: '/usr/bin:/bin', LEAK: 'yes' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pwd=${work}\n`);
    expect(r.stdout).toContain("A=va'l $x `y`\n");
    expect(r.stdout).toContain('LEAK=unset\n');
    expect(r.stdout).toContain(`TOKLEN=${'sk-ant-oat01-Ab_9'.length}\n`);
    expect(r.stdout).toContain('REST=payload-bytes');
    const pid = /PID=(\d+)/.exec(r.stdout)?.[1];
    const pidfile = readFileSync(join(root, 'run', `k1.${NONCE}.pid`), 'utf8');
    // The program kept the wrapper's pid (exec), and a pgid was recorded (the session's group: whether the
    // outer `sh -c` execs or forks its one command is the shell's business).
    expect(pidfile).toMatch(/^\d+ \d+\n$/);
    expect(pidfile.split(' ')[0]).toBe(pid);
    expect(Number(pidfile.trim().split(' ')[1])).toBeGreaterThan(1);
  });

  it('a malformed env file exports nothing; a missing one is fine', async () => {
    const { home: h, root } = setup();
    writeFileSync(join(root, 'env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-ok; echo pwned\n', { mode: 0o600 });
    const run = (withTokenEnvFile: boolean) => runRemote(
      buildRemoteSpawnCommand({ facts: { remoteRoot: root, home: h }, withTokenEnvFile, spawnKey: 'k', spawnNonce: NONCE, argv: ['/bin/sh', '-c', PROBE] }),
      '\n',
      {},
    );
    const r = await run(true);
    expect(r.stdout).toContain('TOKLEN=0\n');
    expect(r.stdout).not.toContain('pwned');
    rmSync(join(root, 'env'));
    expect((await run(true)).code).toBe(0);
  });

  it('exits 98 on a bad prelude line or EOF before the terminator, 97 on a missing cwd', async () => {
    const { home: h, root } = setup();
    const cmd = (cwd?: string) => buildRemoteSpawnCommand({ facts: { remoteRoot: root, home: h }, cwd, spawnKey: 'k', spawnNonce: NONCE, argv: ['/usr/bin/true'] });
    expect((await runRemote(cmd(), 'A B=1\n\n', {})).code).toBe(WRAPPER_EXIT.prelude);
    expect((await runRemote(cmd(), '1A=x\n\n', {})).code).toBe(WRAPPER_EXIT.prelude);
    expect((await runRemote(cmd(), 'novalue\n\n', {})).code).toBe(WRAPPER_EXIT.prelude);
    expect((await runRemote(cmd(), 'A=1\n', {})).code).toBe(WRAPPER_EXIT.prelude);
    expect((await runRemote(cmd(join(h, 'nope')), '\n', {})).code).toBe(WRAPPER_EXIT.cwd);
    expect((await runRemote(cmd('~/cf-remote'), '\n', {})).code).toBe(0);
  });

  it('KILL_PROGRAM signals the recorded group, never a pgid <= 1, and treats a missing pidfile as done', async () => {
    const { root } = setup();
    const victim = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => victim.on('exit', (_c, sig) => resolve(sig)));
    const pidfile = join(root, 'run', 'v.pid');
    mkdirSync(join(root, 'run'), { recursive: true });
    const env = { PATH: '/usr/bin:/bin' };
    writeFileSync(pidfile, 'abc 1\n');
    expect((await spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(killArgv(pidfile, 'TERM'))], { env, timeoutMs: 5000 })).code).toBe(0);
    expect(victim.exitCode).toBeNull();
    expect((await spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(killArgv(join(root, 'none.pid'), 'TERM'))], { env, timeoutMs: 5000 })).code).toBe(0);
    // A detached child leads its own group (pgid = pid), like the sshd session the wrapper records.
    writeFileSync(pidfile, `${victim.pid} ${victim.pid}\n`);
    expect((await spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(killArgv(pidfile, 'TERM'))], { env, timeoutMs: 5000 })).code).toBe(0);
    expect(await exited).toBe('SIGTERM');
  });

  it('PIDFILE_REAP_PROGRAM keeps the pidfile of a live pid and removes a dead / malformed one', async () => {
    const { root } = setup();
    const env = { PATH: '/usr/bin:/bin' };
    const run = (f: string) => spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(reapPidFileArgv(f))], { env, timeoutMs: 5000 });
    mkdirSync(join(root, 'run'), { recursive: true });
    const victim = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const live = join(root, 'run', `live.${NONCE}.pid`);
      writeFileSync(live, `${victim.pid} ${victim.pid}\n`);
      expect((await run(live)).code).toBe(0);
      expect(existsSync(live)).toBe(true);
      const dead = join(root, 'run', `dead.${NONCE}.pid`);
      writeFileSync(dead, '999999 999999\n');
      expect((await run(dead)).code).toBe(0);
      expect(existsSync(dead)).toBe(false);
      const junk = join(root, 'run', `junk.${NONCE}.pid`);
      writeFileSync(junk, '-1 x\n');
      expect((await run(junk)).code).toBe(0);
      expect(existsSync(junk)).toBe(false);
      expect((await run(join(root, 'run', 'absent.pid'))).code).toBe(0);
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it('remotePidFileGlob, expanded by a real /bin/sh, lists exactly one spawn key\'s pidfiles', async () => {
    const { root } = setup();
    const run = join(root, 'run');
    mkdirSync(run, { recursive: true });
    const names = [`a.${NONCE}.pid`, 'a.fedcba9876543210.pid', `a.b.${NONCE}.pid`, `ab.${NONCE}.pid`, 'a.pid', 'a.0123.pid'];
    for (const n of names) writeFileSync(join(run, n), '1 1\n');
    const r = await spawnCapture('/bin/sh', ['-c', `for f in ${remotePidFileGlob(root, 'a')}; do [ -e "$f" ] && printf '%s\\n' "\${f##*/}"; done`], {
      env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000,
    });
    expect(r.stdout.trim().split('\n').sort()).toEqual([`a.${NONCE}.pid`, 'a.fedcba9876543210.pid']);
    expect(readdirSync(run).filter((n) => isPidFileOfSpawnKey(n, 'a')).sort()).toEqual([`a.${NONCE}.pid`, 'a.fedcba9876543210.pid']);
  });
});
