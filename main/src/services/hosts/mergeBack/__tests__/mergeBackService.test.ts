/**
 * MergeBackService on REAL git, without ssh: a local project repo, a "remote" environment that is a temp directory
 * driven through LocalHost (HostPaths re-keyed to 'local'), its bare repo + session worktree created by the real
 * RemoteCheckout, and local git reaching the bare repo by filesystem path (no GIT_SSH_COMMAND). The merge itself is
 * the unchanged WorktreeManager squash.
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
const wm = new WorktreeManager();

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
  const host = asRemote(new LocalHost({ appVersion: '1.0.0' }), (args) => {
    if (args[0] === 'status') order.push('status');
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

describe('MergeBackService.mergeSession (real git)', () => {
  it('happy path: stop first, import, mirror, squash on main, then cleaned', async () => {
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
    await expect(service.whenCleanedUp('s1')).resolves.toBe(true);
    expectCleaned();
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
    await svc.whenCleanedUp('s1');
    expectCleaned();
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
      await svc.whenCleanedUp('s1');
      expectCleaned();
    },
  );

  it.each<MergeBackStep>(['cleanup-remote', 'cleanup-local'])('a crash during cleanup (%s) leaves merged + last_error; cleanup re-runs', async (step) => {
    commit(remoteWt(), 'b.txt', 'b\n');
    crashAt = step;
    await svc.mergeSession(squashInput());
    await expect(svc.whenCleanedUp('s1')).resolves.toBe(false);
    expect(mergeBacks.get('s1')).toMatchObject({ state: 'merged' });
    expect(mergeBacks.get('s1')?.lastError).toMatch(/simulated crash/);
    await expect(svc.cleanup('s1')).resolves.toBe(true);
    expectCleaned();
  });

  it('ALREADY_UP_TO_DATE on re-entry (fast-forwarded by hand) counts as merged', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    expect(mergeBacks.get('s1')?.state).toBe('local_ready');
    git(project, ['merge', '--ff-only', '-q', 'refs/cyboflow/import/k1']);
    const merges: string[] = [];
    const input = { ...squashInput(), merge: async (m: string) => { merges.push(m); await squashInput().merge(m); } };
    await expect(svc.mergeSession(input)).resolves.toEqual({ kind: 'already-landed' });
    expect(merges).toHaveLength(1);
    await svc.whenCleanedUp('s1');
    expectCleaned();
    // merged / cleaned re-entry never imports again.
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'already-landed' });
  });

  it('a squash landed by hand (main moved) is merged, not sent back for a rebase', async () => {
    commit(remoteWt(), 'b.txt', 'b\n');
    await svc.withMirror({ sessionId: 's1', projectPath: project }, async () => undefined);
    git(project, ['merge', '--squash', '-q', 'refs/cyboflow/import/k1']);
    git(project, ['commit', '-q', '-m', 'landed by hand']);
    await expect(svc.mergeSession(squashInput())).resolves.toEqual({ kind: 'already-landed' });
    expect(refExists(bare(), 'refs/cyboflow/base/k1')).toBe(true);
    await svc.whenCleanedUp('s1');
    expectCleaned();
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
    await svc.whenCleanedUp('s1');
    expect(git(project, ['rev-parse', 'k1']).trim()).toBe(theirs);
    expect(refExists(project, `refs/heads/${fallbackMirrorBranch('k1')}`)).toBe(false);
  });
});

describe('MergeBackService delivery probe, checkpoints, archive and boot resume (real git)', () => {
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

  it('boot resume: merged and abandoned are cleaned, a landed import is closed out, the rest is left', async () => {
    // s1: merged, cleanup never ran (crash right after the merged stamp).
    commit(remoteWt(), 'b.txt', 'b\n');
    crashAt = 'merged';
    await expect(svc.mergeSession(squashInput())).rejects.toThrow(/simulated crash/);
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
    expect(summary).toEqual({ cleaned: 3, closedOut: 2, left: 1, errored: 0 });
    expect(closed.sort()).toEqual(['s1', 's3']);
    expectCleaned('k1', 's1');
    expectCleaned('k2', 's2');
    expectCleaned('k3', 's3');
    expect(mergeBacks.get('s4')?.state).toBe('local_ready');
  });

  it('refuses a session whose environment worktree is gone or not ready', async () => {
    await mergeBacks.transition('s1', { from: ['remote_ready'], to: 'abandoned' });
    await expect(svc.mergeSession(squashInput())).rejects.toMatchObject({ code: 'state' });
    await expect(svc.mergeSession(squashInput('s2'))).rejects.toMatchObject({ code: 'no-row' });
  });
});
