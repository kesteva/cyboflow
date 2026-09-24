/**
 * Behavioral tests for `getComparisonBases` in main/src/ipc/gitOps.ts — the ops
 * implementation behind the `cyboflow.sessionGit.getComparisonBases` tRPC
 * procedure (TASK-216), the data source for the diff panel's future
 * BaseSelector menu.
 *
 * These use REAL temp git repos (clone/push/fetch driven via execSync in test
 * SETUP only — the code under test never runs `git fetch`) and a REAL
 * GitDiffManager/WorktreeManager, matching the style of
 * main/src/ipc/__tests__/gitCombinedDiff.test.ts. Unlike that sibling file,
 * `worktreeManager` here is the REAL WorktreeManager class (not a stub that
 * hardcodes `getProjectMainBranch` to `'main'`), because the detached-HEAD and
 * no-origin-symref acceptance criteria are only testable against the real
 * `getProjectMainBranch`/`getOriginBranch` behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { GitDiffManager } from '../../services/gitDiffManager';
import { WorktreeManager } from '../../services/worktreeManager';

// Instrument the git invocation boundary WITHOUT changing behavior: every
// runner in utils/runGit is wrapped in a pass-through vi.fn so tests can
// inspect the exact argv the code under test handed to git (the no-fetch and
// resolved-sha proofs below), while git itself still really runs.
vi.mock('../../utils/runGit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/runGit')>();
  return {
    ...actual,
    runGit: vi.fn(actual.runGit),
    runGitAsync: vi.fn(actual.runGitAsync),
    runGitCapture: vi.fn(actual.runGitCapture),
  };
});
import { runGit, runGitAsync, runGitCapture } from '../../utils/runGit';

/** Every git argv issued through utils/runGit since the last mockClear. */
function recordedGitArgv(): string[][] {
  return [
    ...vi.mocked(runGit).mock.calls,
    ...vi.mocked(runGitAsync).mock.calls,
    ...vi.mocked(runGitCapture).mock.calls,
  ].map(([, args]) => args);
}

beforeEach(() => {
  vi.mocked(runGit).mockClear();
  vi.mocked(runGitAsync).mockClear();
  vi.mocked(runGitCapture).mockClear();
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(async () => ({ id: 'panel-git-1', state: { customState: {} } })),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../claudePanel', () => ({
  claudePanelManager: { registerPanel: vi.fn(), startPanel: vi.fn(async () => {}) },
}));

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';
import type { ComparisonBases } from '../../../../shared/types/runFiles';

// Real-git suite: several cases clone + clone + push + fetch per test. Under
// the 5s vitest default that reports machine LOAD (a full-suite run with a
// fork on every core) as a failure — time out on a genuine hang instead.
vi.setConfig({ testTimeout: 60_000 });

function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

/** Init a repo checked out on `branch`, with git identity configured. */
function initRepoBranch(dir: string, branch: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync(`git checkout -b ${branch}`, { cwd: dir, stdio: 'pipe' });
}

/** Write, stage, and commit a file; return the resulting HEAD sha. */
function commitFile(dir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/** Configure git identity on a freshly cloned repo (clone doesn't carry it). */
function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

function makeServices(worktreePath: string, sessionOverrides: Record<string, unknown> = {}): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 's1', worktreePath, isMainRepo: false, archived: false, ...sessionOverrides })),
      getProjectForSession: vi.fn(() => ({ id: 7, name: 'Proj', path: worktreePath })),
    },
    gitDiffManager: new GitDiffManager(),
    worktreeManager: new WorktreeManager(),
    claudeCodeManager: {},
    gitStatusManager: {
      updateGitStatusAfterRebase: vi.fn(async () => {}),
      updateProjectGitStatusAfterMainUpdate: vi.fn(async () => {}),
      refreshSessionGitStatus: vi.fn(async () => {}),
    },
    databaseService: { getDb: () => inertDb() },
    configManager: { isDemoMode: () => false, getConfig: () => ({}) },
    endLiveSession: vi.fn(async () => {}),
  } as unknown as AppServices;
}

type ComparisonBasesResult = {
  success: boolean;
  data?: ComparisonBases;
  error?: string;
};

describe('sessionGit ops getComparisonBases (real repos)', () => {
  it("origin/HEAD symref present: defaultBranch resolves to the remote's actual default branch (not a hardcoded 'main'), and originDefault carries a fetch timestamp", async () => {
    await withTempDir('cb-symref-', async (root) => {
      const workDir = path.join(root, 'work');
      fs.mkdirSync(workDir);
      initRepoBranch(workDir, 'trunk');
      commitFile(workDir, 'a.txt', 'a1\n', 'base');

      const remoteDir = path.join(root, 'remote.git');
      execSync(`git clone --bare "${workDir}" "${remoteDir}"`, { stdio: 'pipe' });

      // A normal (non-bare) clone sets up the `origin` remote AND
      // refs/remotes/origin/HEAD (pointed at the remote's default branch) AND
      // writes FETCH_HEAD — all as test SETUP, never inside the code under
      // test.
      const sessionDir = path.join(root, 'session');
      execSync(`git clone "${remoteDir}" "${sessionDir}"`, { stdio: 'pipe' });
      configureIdentity(sessionDir);
      // Modern `git clone` does NOT write FETCH_HEAD — only an explicit
      // `git fetch` does. Run it here, as test SETUP, so `originDefault` has a
      // freshness timestamp to report.
      execSync('git fetch origin', { cwd: sessionDir, stdio: 'pipe' });

      const ops = createGitOps(makeServices(sessionDir));
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      expect(result.data?.defaultBranch).toBe('trunk');
      expect(result.data?.localDefault).toEqual({ ref: 'trunk', behind: 0 });
      expect(result.data?.originDefault).not.toBeNull();
      expect(result.data?.originDefault?.ref).toBe('origin/trunk');
      expect(typeof result.data?.originDefault?.behind).toBe('number');
      expect(result.data?.originDefault?.fetchedAt).not.toBeNull();
    });
  });

  it('no origin/HEAD symref (no remote at all): defaultBranch falls back to getProjectMainBranch, and originDefault is null', async () => {
    await withTempDir('cb-noremote-', async (repo) => {
      initRepoBranch(repo, 'develop');
      commitFile(repo, 'a.txt', 'a1\n', 'base');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      expect(result.data?.defaultBranch).toBe('develop');
      expect(result.data?.localDefault).toEqual({ ref: 'develop', behind: 0 });
      expect(result.data?.originDefault).toBeNull();
    });
  });

  it('detached HEAD project root: defaultBranch degrades to null (getProjectMainBranch throws internally) without the overall call failing', async () => {
    await withTempDir('cb-detached-', async (repo) => {
      initRepoBranch(repo, 'main');
      commitFile(repo, 'a.txt', 'a1\n', 'base');
      execSync('git checkout --detach HEAD', { cwd: repo, stdio: 'pipe' });

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      expect(result.data?.defaultBranch).toBeNull();
      expect(result.data?.localDefault).toBeNull();
      expect(result.data?.originDefault).toBeNull();
    });
  });

  it('behind-counts are numerically correct: local default and origin default diverge from HEAD by known, distinct counts', async () => {
    await withTempDir('cb-behind-', async (root) => {
      const workDir = path.join(root, 'work');
      fs.mkdirSync(workDir);
      initRepoBranch(workDir, 'main');
      commitFile(workDir, 'base.txt', 'base\n', 'base');

      const remoteDir = path.join(root, 'remote.git');
      execSync(`git clone --bare "${workDir}" "${remoteDir}"`, { stdio: 'pipe' });

      const sessionDir = path.join(root, 'session');
      execSync(`git clone "${remoteDir}" "${sessionDir}"`, { stdio: 'pipe' });
      configureIdentity(sessionDir);

      // Branch feature off main (both at the base commit) — feature becomes HEAD.
      execSync('git checkout -b feature', { cwd: sessionDir, stdio: 'pipe' });

      // Advance the LOCAL main branch by 2 commits, without touching feature/HEAD.
      execSync('git checkout main', { cwd: sessionDir, stdio: 'pipe' });
      commitFile(sessionDir, 'b.txt', 'b1\n', 'local B');
      commitFile(sessionDir, 'c.txt', 'c1\n', 'local C');
      execSync('git checkout feature', { cwd: sessionDir, stdio: 'pipe' });

      // Advance the REMOTE by 3 DIFFERENT commits via a separate pusher clone,
      // then fetch (test setup only) so origin/main reflects them.
      const pusherDir = path.join(root, 'pusher');
      execSync(`git clone "${remoteDir}" "${pusherDir}"`, { stdio: 'pipe' });
      configureIdentity(pusherDir);
      commitFile(pusherDir, 'd.txt', 'd1\n', 'remote D');
      commitFile(pusherDir, 'e.txt', 'e1\n', 'remote E');
      commitFile(pusherDir, 'f.txt', 'f1\n', 'remote F');
      execSync('git push origin main', { cwd: pusherDir, stdio: 'pipe' });
      execSync('git fetch origin', { cwd: sessionDir, stdio: 'pipe' });

      const ops = createGitOps(makeServices(sessionDir));
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      expect(result.data?.defaultBranch).toBe('main');
      expect(result.data?.localDefault).toEqual({ ref: 'main', behind: 2 });
      expect(result.data?.originDefault?.ref).toBe('origin/main');
      expect(result.data?.originDefault?.behind).toBe(3);
      expect(result.data?.originDefault?.fetchedAt).not.toBeNull();
    });
  });

  it("branchPoint resolves session.baseCommit to its own 40-char sha; null when baseCommit is unset", async () => {
    await withTempDir('cb-branchpoint-', async (repo) => {
      initRepoBranch(repo, 'main');
      const baseSha = commitFile(repo, 'a.txt', 'a1\n', 'base');
      commitFile(repo, 'b.txt', 'b1\n', 'second');

      const withBaseOps = createGitOps(makeServices(repo, { baseCommit: baseSha }));
      const withBaseResult = (await withBaseOps.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;
      expect(withBaseResult.success).toBe(true);
      expect(withBaseResult.data?.branchPoint?.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(withBaseResult.data?.branchPoint?.ref).toBe(baseSha);
      expect(withBaseResult.data?.branchPoint?.shortSha).toBe(baseSha.slice(0, 7));

      const withoutBaseOps = createGitOps(makeServices(repo));
      const withoutBaseResult = (await withoutBaseOps.getComparisonBases({
        sessionId: 's1',
      })) as ComparisonBasesResult;
      expect(withoutBaseResult.success).toBe(true);
      expect(withoutBaseResult.data?.branchPoint).toBeNull();
    });
  });

  it('never issues a git fetch: no recorded git argv has `fetch` as its subcommand, and fetchedAt is byte-identical across two calls', async () => {
    // The implementation only ever READS FETCH_HEAD's mtime — it has no
    // `git fetch` call anywhere on its path. Proven two ways: (1) directly, by
    // inspecting every argv handed to git through utils/runGit during the
    // calls (none may start with `fetch`); (2) behaviorally: fetch ONCE in
    // test setup, then call getComparisonBases twice and assert the reported
    // fetchedAt never moves (a re-fetch would bump the file's mtime).
    await withTempDir('cb-no-fetch-', async (root) => {
      const workDir = path.join(root, 'work');
      fs.mkdirSync(workDir);
      initRepoBranch(workDir, 'main');
      commitFile(workDir, 'a.txt', 'a1\n', 'base');

      const remoteDir = path.join(root, 'remote.git');
      execSync(`git clone --bare "${workDir}" "${remoteDir}"`, { stdio: 'pipe' });

      const sessionDir = path.join(root, 'session');
      execSync(`git clone "${remoteDir}" "${sessionDir}"`, { stdio: 'pipe' });
      configureIdentity(sessionDir);
      // Fetch ONCE, in test setup, so FETCH_HEAD exists before either call.
      execSync('git fetch origin', { cwd: sessionDir, stdio: 'pipe' });

      const ops = createGitOps(makeServices(sessionDir));
      vi.mocked(runGitAsync).mockClear();
      vi.mocked(runGitCapture).mockClear();
      vi.mocked(runGit).mockClear();
      const first = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;
      const second = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      const argv = recordedGitArgv();
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.filter((args) => args[0] === 'fetch')).toEqual([]);
      // Nor any other network-touching subcommand.
      expect(argv.filter((args) => ['pull', 'remote', 'ls-remote'].includes(args[0]))).toEqual([]);

      expect(first.data?.originDefault?.fetchedAt).not.toBeNull();
      expect(second.data?.originDefault?.fetchedAt).toBe(first.data?.originDefault?.fetchedAt);
    });
  });

  it('behind-count argv carries the RESOLVED 40-char sha for both legs, never the raw branch / origin ref name', async () => {
    await withTempDir('cb-sha-argv-', async (root) => {
      const workDir = path.join(root, 'work');
      fs.mkdirSync(workDir);
      initRepoBranch(workDir, 'main');
      commitFile(workDir, 'base.txt', 'base\n', 'base');

      const remoteDir = path.join(root, 'remote.git');
      execSync(`git clone --bare "${workDir}" "${remoteDir}"`, { stdio: 'pipe' });

      const sessionDir = path.join(root, 'session');
      execSync(`git clone "${remoteDir}" "${sessionDir}"`, { stdio: 'pipe' });
      configureIdentity(sessionDir);
      execSync('git checkout -b feature', { cwd: sessionDir, stdio: 'pipe' });
      // Advance local main by one commit so the two legs point at DIFFERENT shas.
      execSync('git checkout main', { cwd: sessionDir, stdio: 'pipe' });
      commitFile(sessionDir, 'b.txt', 'b1\n', 'local B');
      execSync('git checkout feature', { cwd: sessionDir, stdio: 'pipe' });

      const localMainSha = execSync('git rev-parse main', { cwd: sessionDir, encoding: 'utf8' }).trim();
      const originMainSha = execSync('git rev-parse origin/main', { cwd: sessionDir, encoding: 'utf8' }).trim();
      expect(localMainSha).not.toBe(originMainSha);

      const ops = createGitOps(makeServices(sessionDir));
      vi.mocked(runGitAsync).mockClear();
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      // Labels stay human-readable...
      expect(result.data?.localDefault).toEqual({ ref: 'main', behind: 1 });
      expect(result.data?.originDefault?.ref).toBe('origin/main');
      expect(result.data?.originDefault?.behind).toBe(0);

      // ...but every rev-list argv names a resolved sha, never the raw name.
      const revLists = vi
        .mocked(runGitAsync)
        .mock.calls.map(([, args]) => args)
        .filter((args) => args[0] === 'rev-list');
      expect(revLists).toHaveLength(2);
      const ranges = revLists.map((args) => args[args.length - 1]);
      expect(ranges).toContain(`HEAD..${localMainSha}`);
      expect(ranges).toContain(`HEAD..${originMainSha}`);
      expect(ranges).not.toContain('HEAD..main');
      expect(ranges).not.toContain('HEAD..origin/main');
    });
  });

  it('unborn HEAD with a resolvable default branch: legs whose behind-count git cannot answer are null, never a fabricated 0', async () => {
    await withTempDir('cb-unborn-', async (root) => {
      const workDir = path.join(root, 'work');
      fs.mkdirSync(workDir);
      initRepoBranch(workDir, 'main');
      commitFile(workDir, 'base.txt', 'base\n', 'base');

      const remoteDir = path.join(root, 'remote.git');
      execSync(`git clone --bare "${workDir}" "${remoteDir}"`, { stdio: 'pipe' });

      const sessionDir = path.join(root, 'session');
      execSync(`git clone "${remoteDir}" "${sessionDir}"`, { stdio: 'pipe' });
      configureIdentity(sessionDir);
      // An UNBORN branch: origin/HEAD + origin/main + local main all resolve,
      // but `HEAD` does not, so `rev-list --count HEAD..<sha>` fails.
      execSync('git checkout --orphan unborn', { cwd: sessionDir, stdio: 'pipe' });
      execSync('git rm -rf --quiet .', { cwd: sessionDir, stdio: 'pipe' });

      const ops = createGitOps(makeServices(sessionDir));
      const result = (await ops.getComparisonBases({ sessionId: 's1' })) as ComparisonBasesResult;

      expect(result.success).toBe(true);
      expect(result.data?.defaultBranch).toBe('main');
      expect(result.data?.localDefault).toBeNull();
      expect(result.data?.originDefault).toBeNull();
    });
  });
});
