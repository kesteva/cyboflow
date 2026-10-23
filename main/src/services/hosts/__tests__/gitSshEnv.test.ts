import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import {
  InvalidRemoteRepoPathError,
  assertRemoteRepoPath,
  buildGitSshCommand,
  buildGitSshEnv,
  remoteGitPackCommand,
  remoteGitUrl,
} from '../gitSshEnv';
import { SshTransport } from '../sshTransport';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';

const posix = process.platform !== 'win32';

function transportWithDir(dir: string): SshTransport {
  return new SshTransport({
    runner: async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    controlDir: () => dir,
    ensureDir: () => undefined,
    env: () => ({ PATH: '/usr/bin:/bin' }),
  });
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('gitSshEnv pure helpers', () => {
  it('quotes every word of the ssh command and sets the variant', () => {
    const t = transportWithDir('/Users/me/.cyboflow/ssh');
    const cmd = buildGitSshCommand(t, 'me@box');
    expect(cmd.startsWith(`'ssh' '-o' 'BatchMode=yes'`)).toBe(true);
    expect(cmd).toContain(`'ControlPath="/Users/me/.cyboflow/ssh/cm-%C"'`);
    expect(buildGitSshEnv(t, 'me@box')).toEqual({ GIT_SSH_COMMAND: cmd, GIT_SSH_VARIANT: 'ssh' });
  });

  it('builds ssh:// URLs only for absolute single-line paths and URL-safe targets', () => {
    expect(remoteGitUrl('me@box', '/home/me/cf-remote/h1/repos/3.git')).toBe('ssh://me@box/home/me/cf-remote/h1/repos/3.git');
    expect(remoteGitUrl('me@[::1]', '/r.git')).toBe('ssh://me@[::1]/r.git');
    expect(remoteGitUrl('box', '/a %41/r.git')).toBe('ssh://box/a %2541/r.git');
    expect(() => remoteGitUrl('me@box', '~/r.git')).toThrow(InvalidRemoteRepoPathError);
    expect(() => remoteGitUrl('me@box', 'r.git')).toThrow(InvalidRemoteRepoPathError);
    expect(() => remoteGitUrl('me@box', '/a\nb')).toThrow(InvalidRemoteRepoPathError);
    expect(() => remoteGitUrl('me@box', '/a\0b')).toThrow(InvalidRemoteRepoPathError);
    expect(() => remoteGitUrl('-oProxyCommand=x', '/r.git')).toThrow(/git URL/);
    expect(() => remoteGitUrl('box:2222', '/r.git')).toThrow(/git URL/);
    expect(() => remoteGitUrl('bo%78', '/r.git')).toThrow(/git URL/);
    expect(assertRemoteRepoPath('/x y/z')).toBe('/x y/z');
  });

  it('pins the pack program to the probed git, quoted for the remote shell', () => {
    expect(remoteGitPackCommand('/opt/homebrew/bin/git', 'receive-pack')).toBe(`'/opt/homebrew/bin/git' receive-pack`);
    expect(remoteGitPackCommand("/o'dd dir/git", 'upload-pack')).toBe(`'/o'\\''dd dir/git' upload-pack`);
    expect(remoteGitPackCommand(null, 'receive-pack')).toBe('git-receive-pack');
    expect(remoteGitPackCommand('git', 'upload-pack')).toBe('git-upload-pack');
  });
});

describe.skipIf(!posix)('gitSshEnv through the real /bin/sh', () => {
  it('GIT_SSH_COMMAND survives sh -c word for word with a space and % in the data dir', () => {
    const dir = '/tmp/my data%dir/ssh';
    const t = transportWithDir(dir);
    const cmd = buildGitSshCommand(t, 'me@box');
    // git runs `sh -c '<GIT_SSH_COMMAND> "$@"' … <host> <remote command>`; replace ssh with a printf.
    const out = execFileSync(
      '/bin/sh',
      ['-c', `ssh() { printf '%s\\n' "$@"; }; ${cmd} "$@"`, 'sh', 'me@box', `git-receive-pack '/r.git'`],
      { encoding: 'utf8' },
    );
    expect(out.split('\n').slice(0, -1)).toEqual([...t.controlArgs('me@box'), 'me@box', `git-receive-pack '/r.git'`]);
    expect(out).toContain('ControlPath="/tmp/my data%%dir/ssh/cm-%C"\n');
  });

  it('a real git push reaches a bare repo through GIT_SSH_COMMAND, the ssh:// URL and the pinned receive-pack', async () => {
    await withTempDir('git-ssh-env-', async (tmp) => {
      // A fake `ssh` on PATH records its argv and runs the remote command locally (no network, no sshd).
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      const log = path.join(tmp, 'ssh-args.log');
      fs.writeFileSync(
        path.join(bin, 'ssh'),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_SSH_LOG"\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n',
        { mode: 0o755 },
      );
      const project = path.join(tmp, 'proj');
      fs.mkdirSync(project);
      git(project, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
      git(project, ['add', 'a.txt']);
      git(project, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one']);
      const sha = git(project, ['rev-parse', 'HEAD']).trim();
      const bare = path.join(tmp, 'remote root %41%x', 'repos', '1.git');
      fs.mkdirSync(bare, { recursive: true });
      git(bare, ['init', '-q', '--bare']);
      const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

      const t = transportWithDir(path.join(tmp, 'data dir%', 'ssh'));
      const env = {
        ...process.env,
        ...buildGitSshEnv(t, 'me@box'),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_SSH_LOG: log,
      };
      git(project, [
        'push', '-q', `--receive-pack=${remoteGitPackCommand(gitPath, 'receive-pack')}`,
        remoteGitUrl('me@box', bare), `${sha}:refs/cyboflow/base/k1`,
      ], env);

      expect(git(bare, ['rev-parse', 'refs/cyboflow/base/k1']).trim()).toBe(sha);
      const argv = fs.readFileSync(log, 'utf8').split('\n').slice(0, -1);
      expect(argv.slice(0, t.controlArgs('me@box').length)).toEqual(t.controlArgs('me@box'));
      expect(argv).toContain('me@box');
      expect(argv[argv.length - 1]).toContain(`receive-pack '${bare}'`);
    });
  });
});
