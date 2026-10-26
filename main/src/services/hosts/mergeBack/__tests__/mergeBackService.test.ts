/**
 * MergeBackService on REAL git, without ssh: a local project repo, a "remote" environment that is a temp directory
 * driven through LocalHost (HostPaths re-keyed to 'local'), its bare repo + session worktree created by the real
 * RemoteCheckout, and local git reaching the bare repo by filesystem path (no GIT_SSH_COMMAND). The merge itself is
 * the unchanged WorktreeManager squash (or rebase-merge). After a merge the session is RESYNCED, not removed: its
 * environment branch equals main again and the next round merges on top.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { HostStore } from '../../../../orchestrator/hosts/hostStore';
import { MergeBackStore } from '../../../../orchestrator/hosts/mergeBackStore';
import type { ExecutionHost, HostPath } from '../../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../../orchestrator/types';
import type { PreflightResult } from '../../../../../../shared/types/hosts';
import { runGitCapture } from '../../../../utils/runGit';
import { WorktreeManager } from '../../../worktreeManager';
import { LocalHost } from '../../localHost';
import { RemoteCheckout, type LocalGitRunner } from '../../remoteCheckout';
import {
  MergeBackError,
  MergeBackService,
  fallbackMirrorBranch,
  mirrorWorktreePath,
  type MergeBackServiceDeps,
  type MergeBackStep,
  type MergeSessionInput,
} from '../mergeBackService';

const MIG = path.join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
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

const refExists = (repo: string, ref: string): boolean => {
  try {
    git(repo, ['rev-parse', '--verify', '-q', ref]);
    return true;
  } catch {
    return false;
  }
};

function asRemote(local: ExecutionHost, onGit: (args: string[]) => void): ExecutionHost {
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
      run: (cwd, args, o) => {
        onGit(args);
        return local.git.run(lp(cwd), args, o);
      },
      capture: (cwd, args, o) => {
        onGit(args);
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
let checkout: RemoteCheckout;
let svc: MergeBackService;
let deps: MergeBackServiceDeps;
let order: string[];
let fetches: number;
let beforeFetch: (() => void) | null;
let afterFetch: (() => void) | null;
let crashAt: MergeBackStep | null;
/** Runs right before each git command on the "environment" (the agent acting between our check and our write). */
let beforeRemoteGit: ((args: string[]) => void) | null;
const wm = new WorktreeManager();
/** Several full rounds of real git (fetch, worktrees, squash, push) in one test. */
const LONG_MS = 20_000;

function preflight(): PreflightResult {
  return {
    hostId, mode: 'full', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '2026-10-22T10:00:01.000Z',
    results: [], reachable: true, probeComplete: true, detectedTier: 'full',
    runtimes: { claudeSdk: true, codexSdk: false, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: '15.0', toolchainHash: null, appVersion: '1.0.0',
    remote: {
      home: tmp, remoteRoot, user: 'me', logname: 'me', shell: '/bin/zsh', tmpdir: null, lang: null,
      // null: the pack programs resolve as `git-upload-pack` from git's own exec-path (a local path URL).
      nodePath: null, gitPath: null, codexPath: null, arch: 'arm64', socketPathOk: true,
    },
  };
}

const remoteWt = (key = 'k1'): string => path.join(remoteRoot, 'wt', key);
const bare = (): string => path.join(remoteRoot, 'repos', '7.git');
const mainSha = (): string => git(project, ['rev-parse', 'main']).trim();

async function setupSession(sessionId: string, key: string): Promise<void> {
  await checkout.ensureSessionWorktree({ sessionId, hostId, projectId: 7, projectPath: project, sessionKey: key, branch: key });
  git(remoteWt(key), ['config', 'user.name', 'agent']);
  git(remoteWt(key), ['config', 'user.email', 'agent@t']);
}

function squashInput(sessionId = 's1', msg = 'squashed'): MergeSessionInput {
  return {
    sessionId,
    projectPath: project,
    mainBranch: 'main',
    stopProcesses: async () => { order.push('stop'); },
    needsRebase: (m) => wm.hasChangesToRebase(m, 'main'),
    merge: (m) => wm.squashAndMergeWorktreeToMain(project, m, 'main', msg),
  };
}

function rebaseInput(sessionId = 's1'): MergeSessionInput {
  return { ...squashInput(sessionId), merge: (m) => wm.mergeWorktreeToMain(project, m, 'main') };
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-back-')));
  project = path.join(tmp, 'project');
  remoteRoot = path.join(tmp, 'cf remote %41');
  fs.mkdirSync(project);
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.name', 'me']);
  git(project, ['config', 'user.email', 'me@t']);
  commit(project, 'a.txt', 'a\n');

  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);
            INSERT INTO projects (id, name) VALUES (7, 'p');
            INSERT INTO sessions (id) VALUES ('s1'), ('s2'), ('s3'), ('s4');`);
  raw.exec(fs.readFileSync(path.join(MIG, '152_hosts.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(MIG, '153_session_merge_backs.sql'), 'utf8'));
  hosts = new HostStore(dbAdapter(raw));
  mergeBacks = new MergeBackStore(dbAdapter(raw));
  hostId = await hosts.addSsh({ label: 'Studio', sshTarget: 'me@studio' });
  await hosts.recordPreflight(hostId, preflight());

  order = [];
  fetches = 0;
  beforeFetch = null;
  afterFetch = null;
  crashAt = null;
  beforeRemoteGit = null;
  const host = asRemote(new LocalHost({ appVersion: '1.0.0' }), (args) => {
    if (args[0] === 'status') order.push('status');
    beforeRemoteGit?.(args);
  });
  const localGit: LocalGitRunner = (cwd, args, opts) => {
    if (args[0] === 'fetch') {
      fetches++;
      beforeFetch?.();
      return runGitCapture(cwd, args, opts).finally(() => afterFetch?.());
    }
    return runGitCapture(cwd, args, opts);
  };
  const gitRemote = (_h: { sshTarget: string }, b: string) => ({ url: b, env: {} });
  checkout = new RemoteCheckout({
    status: () => ({ running: true, killed: false }),
    store: hosts, getHost: () => host, transport: { controlArgs: () => [] }, mergeBacks, logger, localGit, gitRemote,
  });
  deps = {
    status: () => ({ running: true, killed: false }),
    store: hosts,
    getHost: () => host,
    transport: { controlArgs: () => [] },
    mergeBacks,
    projectPathFor: (id) => (id === 7 ? project : null),
    logger,
    localGit,
    gitRemote,
    afterStep: (_s, step) => {
      if (step === crashAt) {
        crashAt = null;
        throw new Error(`simulated crash after ${step}`);
      }
    },
  };
  svc = new MergeBackService(deps);
  await setupSession('s1', 'k1');
});

afterEach(async () => {
  await svc.whenIdle();
  raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Post-merge: the environment keeps the session (branch = base ref = main, clean tree); This Mac's half is gone. */
function expectResynced(key = 'k1', sessionId = 's1'): void {
  const main = mainSha();
  expect(mergeBacks.get(sessionId)).toMatchObject({
    state: 'remote_ready', lastError: null, baseSha: main, importSha: null, checkpointSha: null, localWorktreePath: null,
  });
  expect(fs.existsSync(remoteWt(key))).toBe(true);
  expect(git(bare(), ['rev-parse', `refs/heads/${key}`]).trim()).toBe(main);
  expect(git(bare(), ['rev-parse', `refs/cyboflow/base/${key}`]).trim()).toBe(main);
  expect(git(remoteWt(key), ['rev-parse', 'HEAD']).trim()).toBe(main);
  expect(git(remoteWt(key), ['status', '--porcelain'])).toBe('');
  expect(refExists(project, `refs/cyboflow/import/${key}`)).toBe(false);
  expect(refExists(project, `refs/cyboflow/checkpoint/${key}`)).toBe(false);
  expect(refExists(project, `refs/heads/${key}`)).toBe(false);
  expect(fs.existsSync(mirrorWorktreePath(project, key))).toBe(false);
}

function expectCleaned(key = 'k1', sessionId = 's1'): void {
  expect(mergeBacks.get(sessionId)).toMatchObject({ state: 'cleaned', lastError: null });
  expect(fs.existsSync(remoteWt(key))).toBe(false);
  expect(refExists(bare(), `refs/heads/${key}`)).toBe(false);
  expect(refExists(bare(), `refs/cyboflow/base/${key}`)).toBe(false);
  expect(refExists(project, `refs/cyboflow/import/${key}`)).toBe(false);
  expect(refExists(project, `refs/cyboflow/checkpoint/${key}`)).toBe(false);
  expect(refExists(project, `refs/heads/${key}`)).toBe(false);
  expect(fs.existsSync(mirrorWorktreePath(project, key))).toBe(false);
}

describe('MergeBackService.mergeSession (real git)', { timeout: 30_000 }, () => {
  it('happy path: stop first, import, mirror, squash on main, then resynced (the environment keeps the session)', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    const tip = commit(remoteWt(), 'c.txt', 'c\n');
    const base = mainSha();
    let projectStatusAtLocalReady: string | null = null;
    const service = new MergeBackService({
      ...deps,
      afterStep: (_s, step) => {
        if (step === 'local-ready') projectStatusAtLocalReady = git(project, ['status', '--porcelain']);
      },
    });

    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(order.slice(0, 2)).toEqual(['stop', 'status']);
    expect(projectStatusAtLocalReady).toBe('');
    expect(git(project, ['rev-list', '--count', `${base}..main`]).trim()).toBe('1');
    expect(git(project, ['log', '-1', '--format=%s', 'main']).trim()).toBe('squashed');
    expect(git(project, ['show', 'main:c.txt'])).toBe('c\n');
    expect(mergeBacks.get('s1')?.importSha).toBe(tip);
    // Recorded with the merge itself: merged_sha = the main it landed on, the close-out still open.
    expect(mergeBacks.get('s1')).toMatchObject({ mergedSha: mainSha(), closedOutAt: null });
    await expect(service.whenResynced('s1')).resolves.toBe(true);
    expectResynced();
    expect(mergeBacks.get('s1')?.mergedSha).toBe(mainSha());
  });

  it('refuses uncommitted changes on the environment and keeps the state', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    fs.writeFileSync(path.join(remoteWt(), 'wip.txt'), 'wip');
    const err = await svc.mergeSession(squashInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeBackError);
    expect((err as MergeBackError).code).toBe('dirty');
    expect((err as Error).message).toBe('Uncommitted changes on Studio — ask the agent to commit them first.');
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'remote_ready', lastError: (err as Error).message });
    expect(fetches).toBe(0);
  });

  it('a squash conflict keeps local_ready; the retry re-syncs the mirror and lands', async () => {
    commit(remoteWt(), 'a.txt', 'agent\n');
    commit(project, 'a.txt', 'main\n');
    const input = { ...squashInput(), needsRebase: undefined };
    await expect(svc.mergeSession(input)).rejects.toThrow(/Failed to squash and merge/);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'local_ready' });
    expect(mergeBacks.get('s1')?.lastError).toMatch(/merge on This Mac failed/);

    // Main drops the conflicting commit; the mirror is dirtied by hand — the retry must not care.
    git(project, ['reset', '--hard', '-q', 'HEAD~1']);
    const mirror = mergeBacks.get('s1')?.localWorktreePath as string;
    fs.writeFileSync(path.join(mirror, 'junk.txt'), 'junk');
    fs.writeFileSync(path.join(mirror, 'a.txt'), 'scribbled\n');
    await expect(svc.mergeSession(input)).resolves.toEqual({ kind: 'merged' });
    expect(git(project, ['show', 'main:a.txt'])).toBe('agent\n');
    expect(git(project, ['ls-tree', '--name-only', 'main'])).not.toContain('junk.txt');
    await svc.whenResynced('s1');
    expectResynced();
  });

  it('SHA race: the branch moves during the fetch, the retry re-reads it and imports the new tip', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    let moved = '';
    beforeFetch = () => {
      beforeFetch = null;
      moved = commit(remoteWt(), 'late.txt', 'late\n');
    };
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    // The fetch brought the moved tip; the second pass re-reads it, finds the ref already there and fetches nothing.
    expect(fetches).toBe(1);
    expect(mergeBacks.get('s1')?.importSha).toBe(moved);
    expect(git(project, ['show', 'main:late.txt'])).toBe('late\n');
  });

  it('SHA race that never settles fails after three attempts at import_intent', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    let n = 0;
    // The branch moves during every fetch AND again before the next read: the ref never matches the read tip.
    beforeFetch = () => { commit(remoteWt(), `race${n++}.txt`, 'x\n'); };
    afterFetch = () => { commit(remoteWt(), `race${n++}.txt`, 'x\n'); };
    const err = await svc.mergeSession(squashInput()).catch((e: unknown) => e);
    expect((err as MergeBackError).code).toBe('import');
    expect((err as Error).message).toMatch(/kept changing/);
    expect(fetches).toBe(3);
    expect(mergeBacks.get('s1')?.state).toBe('import_intent');
    beforeFetch = null;
    afterFetch = null;
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
  });

  it.each<MergeBackStep>(['import-intent', 'imported', 'local-ready', 'merged'])(
    'a crash after %s converges on re-run with exactly one squash on main',
    async (step) => {
      commit(remoteWt(), 'b.txt', 'b\n');
      const base = mainSha();
      crashAt = step;
      await expect(svc.mergeSession(squashInput())).rejects.toThrow(/simulated crash/);
      const second = await svc.mergeSession(squashInput());
      expect(second.kind).toBe(step === 'merged' ? 'already-landed' : 'merged');
      expect(git(project, ['rev-list', '--count', `${base}..main`]).trim()).toBe('1');
      await svc.whenResynced('s1');
      expectResynced();
    },
  );

  it.each<MergeBackStep>(['resync-base', 'resync-remote', 'cleanup-local'])(
    'a crash during the resync (%s) leaves merged + last_error; the next merge finishes it, then lands nothing new',
    async (step) => {
      commit(remoteWt(), 'b.txt', 'b\n');
      const base = mainSha();
      crashAt = step;
      await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
      await expect(svc.whenResynced('s1')).resolves.toBe(false);
      expect(mergeBacks.get('s1')).toMatchObject({ state: 'merged' });
      expect(mergeBacks.get('s1')?.lastError).toMatch(/simulated crash/);
      await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'already-landed' });
      await svc.whenResynced('s1');
      expect(git(project, ['rev-list', '--count', `${base}..main`]).trim()).toBe('1');
      expectResynced();
    },
  );

  it('a tree dirtied before the resync keeps merged + last_error; once committed, the next merge asks for a rebase', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    const imported = git(remoteWt(), ['rev-parse', 'HEAD']).trim();
    const service = new MergeBackService({
      ...deps,
      afterStep: (_s, step) => {
        if (step === 'merged') fs.writeFileSync(path.join(remoteWt(), 'wip.txt'), 'wip\n');
      },
    });
    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    await expect(service.whenResynced('s1')).resolves.toBe(false);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'merged' });
    expect(mergeBacks.get('s1')?.lastError).toMatch(/^Uncommitted changes on Studio after the merge/);
    // Nothing was reset or removed on either side.
    expect(git(remoteWt(), ['rev-parse', 'HEAD']).trim()).toBe(imported);
    expect(fs.readFileSync(path.join(remoteWt(), 'wip.txt'), 'utf8')).toBe('wip\n');
    expect(refExists(project, 'refs/cyboflow/import/k1')).toBe(true);
    // Still dirty: the next merge refuses with the same message.
    await expect(service.mergeSession(squashInput())).rejects.toMatchObject({ code: 'dirty' });

    // The agent commits it: the branch moved past the imported tip, so it is NOT reset; main moved, so: rebase.
    git(remoteWt(), ['add', 'wip.txt']);
    git(remoteWt(), ['commit', '-q', '-m', 'wip']);
    const out = await service.mergeSession(squashInput());
    expect(out.kind).toBe('needs-rebase');
    expect(git(remoteWt(), ['log', '-1', '--format=%s']).trim()).toBe('wip');
    git(remoteWt(), ['rebase', '-q', 'refs/cyboflow/base/k1']);
    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(git(project, ['show', 'main:wip.txt'])).toBe('wip\n');
    await service.whenResynced('s1');
    expectResynced();
  }, LONG_MS);

  it('ALREADY_UP_TO_DATE on re-entry (fast-forwarded by hand) counts as merged', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    expect(mergeBacks.get('s1')?.state).toBe('local_ready');
    git(project, ['merge', '--ff-only', '-q', 'refs/cyboflow/import/k1']);
    const merges: string[] = [];
    const input = { ...squashInput(), merge: async (m: string) => { merges.push(m); await squashInput().merge(m); } };
    await expect(svc.mergeSession(input)).resolves.toEqual({ kind: 'already-landed' });
    expect(merges).toHaveLength(1);
    await svc.whenResynced('s1');
    expectResynced();
    // A second press with nothing new on the branch lands nothing.
    const before = mainSha();
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'already-landed' });
    expect(mainSha()).toBe(before);
  });

  it('a squash landed by hand (main moved) is merged, not sent back for a rebase', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    git(project, ['merge', '--squash', '-q', 'refs/cyboflow/import/k1']);
    git(project, ['commit', '-q', '-m', 'landed by hand']);
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'already-landed' });
    expect(refExists(bare(), 'refs/cyboflow/base/k1')).toBe(true);
    await svc.whenResynced('s1');
    expectResynced();
  });

  it('needs-rebase: refreshes refs/cyboflow/base/<key>; after the agent rebases, the merge lands', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    commit(project, 'm.txt', 'm\n');
    const out = await svc.mergeSession(squashInput());
    expect(out.kind).toBe('needs-rebase');
    expect(out.kind === 'needs-rebase' && out.message).toContain('git rebase refs/cyboflow/base/k1');
    expect(git(bare(), ['rev-parse', 'refs/cyboflow/base/k1']).trim()).toBe(mainSha());

    git(remoteWt(), ['rebase', '-q', 'refs/cyboflow/base/k1']);
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(git(project, ['show', 'main:b.txt'])).toBe('b\n');
    expect(git(project, ['show', 'main:m.txt'])).toBe('m\n');
  });

  it('refreshBase on its own pushes local main to the base ref', async () => {
    const moved = commit(project, 'm.txt', 'm\n');
    await expect(svc.refreshBase('s1', project, 'main')).resolves.toMatch(/git rebase refs\/cyboflow\/base\/k1/);
    expect(git(bare(), ['rev-parse', 'refs/cyboflow/base/k1']).trim()).toBe(moved);
  });

  it('never moves a local branch it does not own: the mirror falls back to cyboflow-import/<key>', async () => {
    const theirs = commit(project, 'x.txt', 'x\n');
    git(project, ['branch', 'k1', theirs]);
    git(project, ['reset', '--hard', '-q', 'HEAD~1']);
    commit(remoteWt(), 'b.txt', 'b\n');
    const branch = await svc.withMirror({ sessionId: 's1', projectPath: project }, async (m) => m.branch);
    expect(branch).toBe(fallbackMirrorBranch('k1'));
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    await svc.whenResynced('s1');
    expect(git(project, ['rev-parse', 'k1']).trim()).toBe(theirs);
    expect(refExists(project, `refs/heads/${fallbackMirrorBranch('k1')}`)).toBe(false);
  });

  it.each([
    ['squash', squashInput],
    ['rebase', rebaseInput],
  ] as const)('two consecutive rounds on one session (%s): merge, resync, new commits, merge again', async (kind, input) => {
    const base = mainSha();
    commit(remoteWt(), 'b.txt', 'b1\n');
    commit(remoteWt(), 'c.txt', 'c\n');
    await expect(svc.mergeSession(input())).resolves.toEqual({ kind: 'merged' });
    await expect(svc.whenResynced('s1')).resolves.toBe(true);
    expectResynced();
    const round1 = mainSha();
    expect(git(project, ['rev-list', '--count', `${base}..main`]).trim()).toBe(kind === 'squash' ? '1' : '2');

    // The agent keeps working on the reset branch (on top of main), a checkpoint is taken, main does not move.
    commit(remoteWt(), 'b.txt', 'b2\n');
    const tip = commit(remoteWt(), 'd.txt', 'd\n');
    await svc.requestCheckpoint('s1');
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'checkpointed', checkpointSha: tip });
    order = [];
    await expect(svc.mergeSession(input())).resolves.toEqual({ kind: 'merged' });
    expect(order.slice(0, 2)).toEqual(['stop', 'status']);
    expect(git(project, ['rev-list', '--count', `${round1}..main`]).trim()).toBe(kind === 'squash' ? '1' : '2');
    expect(git(project, ['show', 'main:b.txt'])).toBe('b2\n');
    expect(git(project, ['show', 'main:c.txt'])).toBe('c\n');
    expect(git(project, ['show', 'main:d.txt'])).toBe('d\n');
    await expect(svc.whenResynced('s1')).resolves.toBe(true);
    expectResynced();
  }, LONG_MS);

  it('a branch that moved after an earlier import is re-imported: import_sha follows the new tip', async () => {
    const first = commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'local_ready', importSha: first });
    const second = commit(remoteWt(), 'c.txt', 'c\n');
    const states: string[] = [];
    const service = new MergeBackService({
      ...deps,
      afterStep: (sid) => {
        const row = mergeBacks.get(sid);
        states.push(`${row?.state}@${row?.importSha === second ? 'second' : row?.importSha === first ? 'first' : 'other'}`);
      },
    });
    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(states.slice(0, 4)).toEqual(['import_intent@second', 'imported@second', 'local_ready@second', 'merged@second']);
    expect(git(project, ['show', 'main:c.txt'])).toBe('c\n');
    await service.whenResynced('s1');
    expectResynced();
  });
});

describe('MergeBackService delivery probe, checkpoints, archive and boot resume (real git)', { timeout: 30_000 }, () => {
  it('probeLanding fetches the tip (no stop, no refusal), records a checkpoint, and sees a hand landing', async () => {
    const tip = commit(remoteWt(), 'b.txt', 'b\n');
    fs.writeFileSync(path.join(remoteWt(), 'wip.txt'), 'wip');
    await expect(svc.probeLanding('s1', project, 'main')).resolves.toEqual({ landed: false, ownCommits: 1, proven: true });
    expect(order).toEqual([]);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'checkpointed', checkpointSha: tip });
    git(project, ['merge', '--squash', '-q', 'refs/cyboflow/checkpoint/k1']);
    git(project, ['commit', '-q', '-m', 'landed by hand']);
    await expect(svc.probeLanding('s1', project, 'main')).resolves.toMatchObject({ landed: true, proven: true });
  });

  it('checkpoint requests coalesce, and never regress a later state', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    const tip = commit(remoteWt(), 'c.txt', 'c\n');
    await Promise.all([svc.requestCheckpoint('s1'), svc.requestCheckpoint('s1'), svc.requestCheckpoint('s1')]);
    expect(fetches).toBe(2);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'checkpointed', checkpointSha: tip });

    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    commit(remoteWt(), 'd.txt', 'd\n');
    await svc.requestCheckpoint('s1');
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'local_ready', checkpointSha: tip });
  });

  it('archive: RemoteCheckout removes the remote half, cleanupLocal the local half', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    await svc.requestCheckpoint('s1');
    await expect(checkout.removeSessionWorktree('s1')).resolves.toBe(true);
    await expect(svc.cleanupLocal('s1')).resolves.toBe(true);
    expectCleaned();
  });

  it('boot resume: merged is resynced (not removed), abandoned cleaned, a landed import closed out, the rest left', async () => {
    // s1: merged, the resync never ran (crash right after the merged stamp).
    commit(remoteWt(), 'b.txt', 'b\n');
    crashAt = 'merged';
    await expect(svc.mergeSession(squashInput())).rejects.toThrow(/simulated crash/);
    expect(mergeBacks.get('s1')?.state).toBe('merged');
    // s2: abandoned (archive whose remote cleanup did not run).
    await setupSession('s2', 'k2');
    await mergeBacks.transition('s2', { from: ['remote_ready'], to: 'abandoned' });
    // s3: local_ready whose work was landed by hand before the crash.
    await setupSession('s3', 'k3');
    commit(remoteWt('k3'), 'k3.txt', 'k3\n');
    await svc.withMirror({ sessionId: 's3', projectPath: project }, async () => undefined);
    git(project, ['merge', '--squash', '-q', 'refs/cyboflow/import/k3']);
    git(project, ['commit', '-q', '-m', 'k3 by hand']);
    // s4: local_ready, not landed: left for the user.
    await setupSession('s4', 'k4');
    commit(remoteWt('k4'), 'k4.txt', 'k4\n');
    await svc.withMirror({ sessionId: 's4', projectPath: project }, async () => undefined);

    const closed: string[] = [];
    const summary = await svc.resumeAll({ closeOut: async (sessionId) => { closed.push(sessionId); } });
    expect(summary).toEqual({ resynced: 2, cleaned: 1, closedOut: 2, left: 1, errored: 0 });
    expect(closed.sort()).toEqual(['s1', 's3']);
    expectResynced('k1', 's1');
    expectCleaned('k2', 's2');
    expectResynced('k3', 's3');
    expect(mergeBacks.get('s4')?.state).toBe('local_ready');

    // The resumed session works on: a second round lands on top of everything.
    commit(remoteWt('k1'), 'more.txt', 'more\n');
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(git(project, ['show', 'main:more.txt'])).toBe('more\n');
    await svc.whenResynced('s1');
    expectResynced('k1', 's1');
  }, LONG_MS);

  it('archive after a merge removes the kept environment worktree, branch and base ref', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.mergeSession(squashInput());
    await svc.whenResynced('s1');
    expectResynced();
    await expect(checkout.removeSessionWorktree('s1')).resolves.toBe(true);
    await expect(svc.cleanupLocal('s1')).resolves.toBe(true);
    expectCleaned();
  });

  it('cleanup (both halves) refuses anything but an archived row', async () => {
    await expect(svc.cleanup('s1')).resolves.toBe(false);
    expect(mergeBacks.get('s1')?.state).toBe('remote_ready');
    expect(fs.existsSync(remoteWt())).toBe(true);
  });

  it('refuses a session whose environment worktree is gone or not ready', async () => {
    await mergeBacks.transition('s1', { from: ['remote_ready'], to: 'abandoned' });
    await expect(svc.mergeSession(squashInput())).rejects.toMatchObject({ code: 'state' });
    await expect(svc.mergeSession(squashInput('s2'))).rejects.toMatchObject({ code: 'no-row' });
  });
});

/** The first command that moves the environment's session branch (the CAS update-ref, or a hard reset). */
const movesRemoteBranch = (args: string[], key = 'k1'): boolean =>
  (args[0] === 'update-ref' && args.includes(`refs/heads/${key}`)) || (args[0] === 'reset' && args.includes('--hard'));

describe('MergeBackService data safety (real git)', { timeout: 30_000 }, () => {
  it('MB-1: a squash whose commit a hook rejects is never taken as landed by boot resume', async () => {
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    commit(remoteWt(), 'b.txt', 'b\n');
    const tip = commit(remoteWt(), 'c.txt', 'c\n');
    const main = mainSha();
    await expect(svc.mergeSession(squashInput())).rejects.toThrow();
    expect(mergeBacks.get('s1')?.state).toBe('local_ready');
    // The failed squash left the mirror reset onto main — exactly the shape that once read as "landed".
    expect(git(mirrorWorktreePath(project, 'k1'), ['rev-parse', 'HEAD']).trim()).toBe(main);

    const closed: string[] = [];
    const summary = await svc.resumeAll({ closeOut: async (id) => { closed.push(id); } });
    await svc.whenIdle();
    expect(summary).toMatchObject({ closedOut: 0, resynced: 0, left: 1 });
    expect(closed).toEqual([]);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'local_ready', mergedSha: null });
    expect(mainSha()).toBe(main);
    expect(git(bare(), ['rev-parse', 'refs/heads/k1']).trim()).toBe(tip);
    expect(git(remoteWt(), ['rev-parse', 'HEAD']).trim()).toBe(tip);
    expect(git(remoteWt(), ['show', 'HEAD:c.txt'])).toBe('c\n');

    // Hook gone: the retry lands the untouched work.
    fs.rmSync(hook);
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    expect(git(project, ['show', 'main:c.txt'])).toBe('c\n');
  });

  it('MB-4: an agent commit between the resync checks and the branch move wins; nothing is reset', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    let agent = '';
    beforeRemoteGit = (args) => {
      if (!movesRemoteBranch(args)) return;
      beforeRemoteGit = null;
      agent = commit(remoteWt(), 'late.txt', 'late\n');
    };
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    await expect(svc.whenResynced('s1')).resolves.toBe(true);
    expect(agent).not.toBe('');
    expect(git(bare(), ['rev-parse', 'refs/heads/k1']).trim()).toBe(agent);
    expect(git(remoteWt(), ['rev-parse', 'HEAD']).trim()).toBe(agent);
    expect(fs.readFileSync(path.join(remoteWt(), 'late.txt'), 'utf8')).toBe('late\n');
    expect(git(remoteWt(), ['status', '--porcelain'])).toBe('');
    expect(mergeBacks.get('s1')?.state).toBe('remote_ready');
  });

  it('MB-4: a local change made between the checks and the move is never overwritten; the branch is put back', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    const imported = git(remoteWt(), ['rev-parse', 'HEAD']).trim();
    const service = new MergeBackService({
      ...deps,
      // Main moves on This Mac after the merge, so the resync must bring x.txt to the environment.
      afterStep: (_s, step) => { if (step === 'merged') commit(project, 'x.txt', 'main x\n'); },
    });
    beforeRemoteGit = (args) => {
      if (!movesRemoteBranch(args)) return;
      beforeRemoteGit = null;
      fs.writeFileSync(path.join(remoteWt(), 'x.txt'), 'agent x\n');
    };
    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    await expect(service.whenResynced('s1')).resolves.toBe(false);
    expect(fs.readFileSync(path.join(remoteWt(), 'x.txt'), 'utf8')).toBe('agent x\n');
    expect(git(bare(), ['rev-parse', 'refs/heads/k1']).trim()).toBe(imported);
    expect(git(remoteWt(), ['rev-parse', 'HEAD']).trim()).toBe(imported);
    expect(git(remoteWt(), ['status', '--porcelain']).trim()).toBe('?? x.txt');
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'merged' });
    expect(mergeBacks.get('s1')?.lastError).toMatch(/^Uncommitted changes on Studio after the merge/);
  });

  it('LC-5: a merged row whose close-out completed is only resynced at boot, never closed out again', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    const service = new MergeBackService({
      ...deps,
      afterStep: (_s, step) => { if (step === 'merged') fs.writeFileSync(path.join(remoteWt(), 'wip.txt'), 'wip\n'); },
    });
    await expect(service.mergeSession(squashInput())).resolves.toEqual({ kind: 'merged' });
    await expect(service.whenResynced('s1')).resolves.toBe(false);
    await service.recordClosedOut('s1'); // gitOps, after its close-out
    expect(mergeBacks.get('s1')?.closedOutAt).not.toBeNull();

    const closed: string[] = [];
    const resume = { closeOut: async (id: string) => { closed.push(id); }, runsCreatedSince: () => 0 };
    await expect(service.resumeAll(resume)).resolves.toMatchObject({ closedOut: 0, errored: 1 });
    expect(closed).toEqual([]);
    // The stray file goes: the next boot finishes the resync — still no close-out.
    fs.rmSync(path.join(remoteWt(), 'wip.txt'));
    await expect(service.resumeAll(resume)).resolves.toMatchObject({ closedOut: 0, resynced: 1 });
    expect(closed).toEqual([]);
    expectResynced();
  });

  it('LC-5: an unrecorded close-out is not repeated once the session has runs created after the merge', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    crashAt = 'merged';
    await expect(svc.mergeSession(squashInput())).rejects.toThrow(/simulated crash/);
    const row = mergeBacks.get('s1');
    expect(row).toMatchObject({ state: 'merged', closedOutAt: null });
    const asked: string[] = [];
    const closed: string[] = [];
    await svc.resumeAll({
      closeOut: async (id) => { closed.push(id); },
      runsCreatedSince: (id, iso) => { asked.push(`${id}@${iso}`); return 1; },
    });
    expect(asked).toEqual([`s1@${row?.mergedAt}`]);
    expect(closed).toEqual([]);
    expect(mergeBacks.get('s1')?.closedOutAt).not.toBeNull();
  });

  it('LC-5: a crash before the close-out completes is closed out once (with the recorded merge sha), then never again', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    crashAt = 'merged';
    await expect(svc.mergeSession(squashInput())).rejects.toThrow(/simulated crash/);
    const merged = mergeBacks.get('s1')?.mergedSha;
    expect(merged).toBe(mainSha());
    commit(project, 'later.txt', 'later\n'); // main moves before the boot: the close-out still names the merge
    fs.writeFileSync(path.join(remoteWt(), 'wip.txt'), 'wip\n'); // keeps the resync failing across boots
    const closed: Array<[string, string | undefined]> = [];
    const resume = { closeOut: async (id: string, sha: string | undefined) => { closed.push([id, sha]); }, runsCreatedSince: () => 0 };
    await svc.resumeAll(resume);
    await svc.resumeAll(resume);
    expect(closed).toEqual([['s1', merged]]);
    expect(mergeBacks.get('s1')?.state).toBe('merged');
  });

  it('MB-5: cleanup with the environment away still removes This Mac\'s half; the remote half is retried later', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    await svc.requestCheckpoint('s1');
    await mergeBacks.transition('s1', { from: ['local_ready'], to: 'abandoned' });
    const away = new MergeBackService({ ...deps, status: () => ({ running: false, killed: false }) });
    await expect(away.cleanup('s1')).resolves.toBe(false);
    expect(mergeBacks.get('s1')?.state).toBe('abandoned');
    expect(mergeBacks.get('s1')?.lastError).toMatch(/on its environment/);
    expect(refExists(project, 'refs/cyboflow/import/k1')).toBe(false);
    expect(refExists(project, 'refs/cyboflow/checkpoint/k1')).toBe(false);
    expect(refExists(project, 'refs/heads/k1')).toBe(false);
    expect(fs.existsSync(mirrorWorktreePath(project, 'k1'))).toBe(false);
    expect(fs.existsSync(remoteWt())).toBe(true);
    // Back: the boot resume finishes the remote half.
    await expect(svc.resumeAll({ closeOut: async () => undefined })).resolves.toMatchObject({ cleaned: 1, errored: 0 });
    expectCleaned();
  });

  it('MB-5 / LC-4: boot resume abandons and cleans the live row of an archived session (incl. a half-provisioned one)', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    // s2: provisioning stopped at bare_ready (crash); the boot sweep archived the session.
    await mergeBacks.create({ sessionId: 's2', hostId, projectId: 7, mergeKey: 'k2', branch: 'k2', baseSha: mainSha(), state: 'bare_ready' });
    // s3: fully provisioned and NOT archived — untouched.
    await setupSession('s3', 'k3');
    const archived = new Set(['s1', 's2']);
    const summary = await svc.resumeAll({ closeOut: async () => undefined, isArchived: (id) => archived.has(id) });
    expect(summary).toMatchObject({ cleaned: 2, errored: 0, closedOut: 0 });
    expectCleaned('k1', 's1');
    expect(mergeBacks.get('s2')?.state).toBe('cleaned');
    expect(mergeBacks.get('s3')?.state).toBe('remote_ready');
    expect(fs.existsSync(remoteWt('k3'))).toBe(true);
  });
});
