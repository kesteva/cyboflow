import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostGitCommandError } from '../../../orchestrator/trpc/contracts/executionHost';
import { runGitCapture } from '../../../utils/runGit';
import { LocalHost } from '../localHost';
import { HostPathMismatchError, UnsafeRemoveError } from '../sshHost';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('LocalHost M2 surface (real temp dir)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function setup(): { root: string; host: LocalHost } {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-local-')));
    const fakeHome = join(dir, 'home');
    mkdirSync(fakeHome);
    return { root: dir, host: new LocalHost({ appVersion: '1', homeDir: () => fakeHome }) };
  }
  const lp = (p: string) => ({ hostId: 'local', path: p });

  it('info.remoteRoot is null', () => {
    expect(new LocalHost({ appVersion: '1' }).info).toEqual({ id: 'local', kind: 'local', label: 'This Mac', remoteRoot: null });
  });

  it('exec honours cwd and merges env over the command env (both with and without stdin)', async () => {
    const { root, host } = setup();
    const r = await host.exec.exec(['/bin/sh', '-c', 'printf "%s|%s|%s" "$(pwd)" "$CF_X" "${PATH:+haspath}"'], {
      cwd: root, env: { CF_X: "v'1" },
    });
    expect(r).toMatchObject({ code: 0, stdout: `${root}|v'1|haspath`, timedOut: false });
    const s = await host.exec.exec(['/bin/sh', '-c', 'printf "%s|%s|" "$(pwd)" "$CF_X"; cat'], { cwd: root, env: { CF_X: 'y' }, stdin: 'in' });
    expect(s).toMatchObject({ code: 0, stdout: `${root}|y|in` });
  });

  it('readdir / unlink / stat', async () => {
    const { root, host } = setup();
    writeFileSync(join(root, 'f'), 'abc', { mode: 0o640 });
    mkdirSync(join(root, 'sub'));
    expect((await host.fs.readdir(lp(root))).sort()).toEqual(['f', 'home', 'sub']);
    expect(await host.fs.stat(lp(join(root, 'f')))).toEqual({ isFile: true, isDir: false, size: 3, mode: 0o640 });
    expect(await host.fs.stat(lp(join(root, 'sub')))).toMatchObject({ isFile: false, isDir: true });
    expect(await host.fs.stat(lp(join(root, 'nope')))).toBeNull();
    expect(await host.fs.stat(lp(join(root, 'f', 'under-a-file')))).toBeNull();
    await host.fs.unlink(lp(join(root, 'f')));
    expect(existsSync(join(root, 'f'))).toBe(false);
    await host.fs.unlink(lp(join(root, 'f')));
    await expect(host.fs.unlink(lp(join(root, 'sub')))).rejects.toBeInstanceOf(UnsafeRemoveError);
    await expect(host.fs.stat({ hostId: 'h1', path: root })).rejects.toBeInstanceOf(HostPathMismatchError);
  });

  it('rmrf removes a tree and refuses /, the home dir and relative paths', async () => {
    const { root, host } = setup();
    mkdirSync(join(root, 'tree', 'a'), { recursive: true });
    await host.fs.rmrf(lp(join(root, 'tree')));
    expect(existsSync(join(root, 'tree'))).toBe(false);
    await host.fs.rmrf(lp(join(root, 'tree')));
    for (const p of ['/', '//', join(root, 'home'), `${join(root, 'home')}/`, join(root, 'home', 'x', '..'), 'rel']) {
      await expect(host.fs.rmrf(lp(p))).rejects.toBeInstanceOf(UnsafeRemoveError);
    }
    expect(existsSync(join(root, 'home'))).toBe(true);
  });

  it('git.capture throws HostGitCommandError with the same code / stdout / stderr runGitCapture rejects with', async () => {
    const { root, host } = setup();
    execFileSync('git', ['init', '-q', root]);
    const args = ['rev-parse', '--verify', 'no-such-ref'];
    const expected = await runGitCapture(root, args).then(
      () => { throw new Error('expected git to fail'); },
      (e: unknown) => e as { code: number; stdout: string; stderr: string },
    );
    const err = await host.git.capture(lp(root), args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostGitCommandError);
    const e = err as HostGitCommandError;
    expect(e.code).toBe(expected.code);
    expect(e.stdout).toBe(expected.stdout);
    expect(e.stderr).toBe(expected.stderr);
    expect(e.message.startsWith('Command failed: git rev-parse --verify no-such-ref')).toBe(true);
    expect(await host.git.capture(lp(root), ['rev-parse', '--is-inside-work-tree'])).toEqual({ stdout: 'true\n', stderr: '' });
    const withEnv = await host.git.capture(lp(root), ['var', 'GIT_AUTHOR_IDENT'], { env: { GIT_AUTHOR_NAME: 'Env Name', GIT_AUTHOR_EMAIL: 'e@x' } });
    expect(withEnv.stdout).toMatch(/^Env Name <e@x>/);
  });

  it('spawn runs a local child with cwd and merged env', async () => {
    const { root, host } = setup();
    const p = host.spawn({ command: '/bin/sh', args: ['-c', 'printf "%s|%s" "$(pwd)" "$CF_Y"'], cwd: root, env: { CF_Y: 'z', CF_U: undefined }, spawnKey: 'ignored' });
    let out = '';
    p.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => p.once('close', (c: number | null) => resolve(c)));
    expect(code).toBe(0);
    expect(out).toBe(`${root}|z`);
    expect(typeof p.pid).toBe('number');
    expect(statSync(root).isDirectory()).toBe(true);
  });
});
