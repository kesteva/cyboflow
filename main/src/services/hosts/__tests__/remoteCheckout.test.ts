/**
 * RemoteCheckout on REAL git, without ssh: the "environment" is a temp directory driven through LocalHost (its
 * HostPaths re-keyed to 'local'), and local git reaches the bare repo by its filesystem path (no GIT_SSH_COMMAND).
 * Covers first-time init, a second session reusing the bare repo, re-entry after a crash between push and
 * worktree add (and after a half-made worktree directory), idempotent re-entry, compensation, and the refusals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { HostStore } from '../../../orchestrator/hosts/hostStore';
import { MergeBackStore } from '../../../orchestrator/hosts/mergeBackStore';
import type { ExecutionHost, HostPath } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import type { PreflightResult } from '../../../../../shared/types/hosts';
import { LocalHost } from '../localHost';
import {
  REMOTE_GIT_EXCLUDE_ENTRIES,
  RemoteCheckout,
  RemoteCheckoutError,
  parseWorktreeList,
  type LocalGitRunner,
} from '../remoteCheckout';
import { runGitCapture } from '../../../utils/runGit';

const MIG = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const logger: LoggerLike = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(repo: string, file: string, body: string): string {
  fs.writeFileSync(path.join(repo, file), body);
  git(repo, ['add', file]);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** LocalHost re-keyed: the checkout addresses paths with the remote host id; LocalHost only accepts 'local'. */
function asRemote(local: ExecutionHost, hooks: { beforeCapture?: (args: string[]) => void } = {}): ExecutionHost {
  const lp = (p: HostPath): HostPath => ({ hostId: 'local', path: p.path });
  return {
    info: local.info,
    exec: local.exec,
    fs: {
      exists: (p) => local.fs.exists(lp(p)),
      readFile: (p, n) => local.fs.readFile(lp(p), n),
      writeFile: (p, d, m) => local.fs.writeFile(lp(p), d, m),
      mkdirp: (p) => local.fs.mkdirp(lp(p)),
      readdir: (p) => local.fs.readdir(lp(p)),
      unlink: (p) => local.fs.unlink(lp(p)),
      rmrf: (p) => local.fs.rmrf(lp(p)),
      stat: (p) => local.fs.stat(lp(p)),
    },
    git: {
      run: (cwd, args, o) => local.git.run(lp(cwd), args, o),
      capture: (cwd, args, o) => {
        hooks.beforeCapture?.(args);
        return local.git.capture(lp(cwd), args, o);
      },
    },
    spawn: (spec) => local.spawn(spec),
    preflight: (mode) => local.preflight(mode),
  };
}

let tmp: string;
let project: string;
let remoteRoot: string;
let raw: Database.Database;
let hosts: HostStore;
let mergeBacks: MergeBackStore;
let hostId: string;
let gitCalls: string[][];
let failWorktreeAdd: boolean;
let pushes: number;
let checkout: RemoteCheckout;
let running: boolean;

function preflight(): PreflightResult {
  const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  return {
    hostId, mode: 'full', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '2026-10-22T10:00:01.000Z',
    results: [], reachable: true, probeComplete: true, detectedTier: 'full',
    runtimes: { claudeSdk: true, codexSdk: false, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: '15.0', toolchainHash: null, appVersion: '1.0.0',
    remote: {
      home: tmp, remoteRoot, user: 'me', logname: 'me', shell: '/bin/zsh', tmpdir: null, lang: null,
      nodePath: null, gitPath, codexPath: null, arch: 'arm64', socketPathOk: true,
    },
  };
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-checkout-')));
  project = path.join(tmp, 'project');
  remoteRoot = path.join(tmp, 'cf remote %41');
  fs.mkdirSync(project);
  git(project, ['init', '-q', '-b', 'main']);
  commit(project, 'a.txt', 'a\n');

  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);
            INSERT INTO projects (id, name) VALUES (7, 'p');
            INSERT INTO sessions (id) VALUES ('s1'), ('s2'), ('s3');`);
  raw.exec(fs.readFileSync(path.join(MIG, '152_hosts.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(MIG, '153_session_merge_backs.sql'), 'utf8'));
  hosts = new HostStore(dbAdapter(raw));
  mergeBacks = new MergeBackStore(dbAdapter(raw));
  hostId = await hosts.addSsh({ label: 'Studio', sshTarget: 'me@studio' });
  await hosts.recordPreflight(hostId, preflight());

  gitCalls = [];
  failWorktreeAdd = false;
  pushes = 0;
  running = true;
  const host = asRemote(new LocalHost({ appVersion: '1.0.0' }), {
    beforeCapture: (args) => {
      gitCalls.push(args);
      if (failWorktreeAdd && args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('simulated crash before worktree add');
      }
    },
  });
  const localGit: LocalGitRunner = (cwd, args, opts) => {
    if (args[0] === 'push') pushes++;
    return runGitCapture(cwd, args, opts);
  };
  checkout = new RemoteCheckout({
    status: () => ({ running, killed: false }),
    store: hosts,
    getHost: () => host,
    transport: { controlArgs: () => [] },
    mergeBacks,
    logger,
    localGit,
    gitRemote: (_h, bare) => ({ url: bare, env: {} }),
  });
});

afterEach(() => {
  raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const input = (sessionId: string, key: string) => ({
  sessionId, hostId, projectId: 7, projectPath: project, sessionKey: key, branch: key,
});
const bare = (): string => path.join(remoteRoot, 'repos', '7.git');

describe('RemoteCheckout.ensureSessionWorktree (real git)', { timeout: 30_000 }, () => {
  it('first session: inits the bare repo, pushes the base, adds the worktree, walks the row to remote_ready', async () => {
    const head = git(project, ['rev-parse', 'HEAD']).trim();
    expect(await checkout.worktreeExists(hostId, 'k1')).toBe(false);
    const res = await checkout.ensureSessionWorktree(input('s1', 'k1'));
    const wt = path.join(remoteRoot, 'wt', 'k1');
    expect(res).toEqual({ remoteWorktreePath: wt, baseSha: head, baseBranch: 'HEAD' });
    expect(checkout.plannedWorktreePath(hostId, 'k1')).toBe(wt);
    expect(await checkout.worktreeExists(hostId, 'k1')).toBe(true);

    expect(git(bare(), ['rev-parse', '--is-bare-repository']).trim()).toBe('true');
    expect(git(bare(), ['config', 'uploadpack.allowReachableSHA1InWant']).trim()).toBe('true');
    expect(git(bare(), ['rev-parse', 'refs/cyboflow/base/k1']).trim()).toBe(head);
    const exclude = fs.readFileSync(path.join(bare(), 'info', 'exclude'), 'utf8');
    for (const e of REMOTE_GIT_EXCLUDE_ENTRIES) expect(exclude.split('\n')).toContain(e);
    expect(hosts.getCheckout(hostId, 7)).toMatchObject({ remoteRepoPath: bare() });

    expect(git(wt, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/k1');
    expect(git(wt, ['rev-parse', 'HEAD']).trim()).toBe(head);
    // The bare repo's exclude covers its worktrees: generated files never show as changes.
    fs.mkdirSync(path.join(wt, '.cyboflow'));
    fs.writeFileSync(path.join(wt, '.cyboflow', 'x'), 'x');
    expect(git(wt, ['status', '--porcelain'])).toBe('');

    expect(mergeBacks.get('s1')).toMatchObject({
      state: 'remote_ready', hostId, projectId: 7, mergeKey: 'k1', branch: 'k1', baseSha: head,
      remoteWorktreePath: wt, lastError: null,
    });
  });

  it('a second session reuses the bare repo and branches from the moved base', async () => {
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    const firstCheckout = hosts.getCheckout(hostId, 7);
    const moved = commit(project, 'b.txt', 'b\n');
    gitCalls = [];
    const res = await checkout.ensureSessionWorktree(input('s2', 'k2'));
    expect(res.baseSha).toBe(moved);
    expect(gitCalls.some((a) => a[0] === 'init')).toBe(false);
    expect(hosts.getCheckout(hostId, 7)).toEqual(firstCheckout);
    const listed = parseWorktreeList(git(bare(), ['worktree', 'list', '--porcelain']));
    expect([...listed.values()].filter((b) => b !== null).sort()).toEqual(['refs/heads/k1', 'refs/heads/k2']);
    expect(git(path.join(remoteRoot, 'wt', 'k2'), ['rev-parse', 'HEAD']).trim()).toBe(moved);
  });

  it('pins an exact baseCommittish and validates a named base branch', async () => {
    const first = git(project, ['rev-parse', 'HEAD']).trim();
    commit(project, 'c.txt', 'c\n');
    const res = await checkout.ensureSessionWorktree({ ...input('s1', 'k1'), baseCommittish: first, baseBranch: 'main' });
    expect(res).toMatchObject({ baseSha: first, baseBranch: 'main' });
    const err = await checkout.ensureSessionWorktree({ ...input('s2', 'k2'), baseBranch: 'nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCheckoutError);
    expect((err as RemoteCheckoutError).code).toBe('base');
    expect((err as Error).message).toMatch(/Base branch 'nope' does not exist/);
    expect(mergeBacks.get('s2')).toBeNull();
  });

  it('re-entry after a crash between push and worktree add completes without pushing again', async () => {
    failWorktreeAdd = true;
    const err = await checkout.ensureSessionWorktree(input('s1', 'k1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCheckoutError);
    expect((err as RemoteCheckoutError).code).toBe('worktree');
    const parked = mergeBacks.get('s1');
    expect(parked?.state).toBe('base_pushed');
    expect(parked?.lastError).toMatch(/simulated crash/);
    expect(pushes).toBe(1);

    // A half-made worktree directory (crash mid-add) is cleared, not tripped over.
    const wt = path.join(remoteRoot, 'wt', 'k1');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'junk'), 'j');
    // The local base moving in between does not move the recorded base.
    commit(project, 'd.txt', 'd\n');

    failWorktreeAdd = false;
    const res = await checkout.ensureSessionWorktree(input('s1', 'k1'));
    expect(pushes).toBe(1);
    expect(res.baseSha).toBe(parked?.baseSha);
    expect(fs.existsSync(path.join(wt, 'junk'))).toBe(false);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'remote_ready', lastError: null, remoteWorktreePath: wt });
  });

  it('a completed session re-enters as a no-op', async () => {
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    gitCalls = [];
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    expect(pushes).toBe(1);
    expect(gitCalls.filter((a) => a[0] === 'worktree' && a[1] === 'add')).toEqual([]);
    expect(mergeBacks.get('s1')?.state).toBe('remote_ready');
  });

  it('refuses a conflicting row, a bad key, and a turned-off feature', async () => {
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    await expect(checkout.ensureSessionWorktree({ ...input('s1', 'k1'), branch: 'other' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(checkout.ensureSessionWorktree(input('s2', '../x'))).rejects.toMatchObject({ code: 'invalid-name' });
    await expect(checkout.ensureSessionWorktree({ ...input('s2', 'k2'), branch: '-x' })).rejects.toMatchObject({ code: 'invalid-name' });
    running = false;
    await expect(checkout.ensureSessionWorktree(input('s2', 'k2'))).rejects.toThrow(/turned off/);
    expect(mergeBacks.get('s2')).toBeNull();
  });
});

describe('RemoteCheckout.removeSessionWorktree (real git)', { timeout: 30_000 }, () => {
  it('removes the worktree, branch and base ref, then marks the row cleaned; repeat calls are no-ops', async () => {
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    await checkout.ensureSessionWorktree(input('s2', 'k2'));
    fs.writeFileSync(path.join(remoteRoot, 'wt', 'k1', 'dirty.txt'), 'uncommitted');
    expect(await checkout.removeSessionWorktree('s1')).toBe(true);
    expect(fs.existsSync(path.join(remoteRoot, 'wt', 'k1'))).toBe(false);
    expect(() => git(bare(), ['rev-parse', '--verify', '-q', 'refs/heads/k1'])).toThrow();
    expect(() => git(bare(), ['rev-parse', '--verify', '-q', 'refs/cyboflow/base/k1'])).toThrow();
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'cleaned', lastError: null });
    // The sibling session is untouched.
    expect(git(path.join(remoteRoot, 'wt', 'k2'), ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/k2');
    expect(await checkout.removeSessionWorktree('s1')).toBe(true);
    expect(await checkout.removeSessionWorktree('s3')).toBe(true);
  });

  it('cleans up a session that failed half way (base pushed, no worktree)', async () => {
    failWorktreeAdd = true;
    await checkout.ensureSessionWorktree(input('s1', 'k1')).catch(() => undefined);
    failWorktreeAdd = false;
    expect(await checkout.removeSessionWorktree('s1')).toBe(true);
    expect(() => git(bare(), ['rev-parse', '--verify', '-q', 'refs/cyboflow/base/k1'])).toThrow();
    expect(mergeBacks.get('s1')?.state).toBe('cleaned');
  });

  it('a cleanup that cannot reach the environment leaves the row abandoned with last_error', async () => {
    await checkout.ensureSessionWorktree(input('s1', 'k1'));
    running = false;
    gitCalls = [];
    expect(await checkout.removeSessionWorktree('s1')).toBe(false);
    expect(gitCalls).toEqual([]);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'abandoned' });
    expect(mergeBacks.get('s1')?.lastError).toMatch(/Could not remove/);
    running = true;
    expect(await checkout.removeSessionWorktree('s1')).toBe(true);
    expect(mergeBacks.get('s1')?.state).toBe('cleaned');
  });
});

describe('parseWorktreeList', () => {
  it('maps each listed path to its branch (null for bare / detached)', () => {
    const out = 'worktree /r/b.git\nbare\n\nworktree /r/wt/k\nHEAD abc\nbranch refs/heads/k\n\nworktree /r/wt/d\nHEAD abc\ndetached\n';
    expect([...parseWorktreeList(out)]).toEqual([['/r/b.git', null], ['/r/wt/k', 'refs/heads/k'], ['/r/wt/d', null]]);
  });
});
