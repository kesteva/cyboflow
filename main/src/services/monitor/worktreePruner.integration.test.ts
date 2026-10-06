/**
 * Worktree prune primitive — REAL git repo + REAL WorktreeManager (actual
 * `git worktree add`/remove/branch delete in a temp dir), a REAL temp DatabaseService
 * for the owner rows, and a REAL GitStatusManager cache. Only process/broker
 * primitives are fakes. (worktreePruner.test.ts covers the pure-fake unit cases.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../database/database';
import { WorktreeManager } from '../worktreeManager';
import { GitStatusManager } from '../gitStatusManager';
import type { ReapManifest, ReapProcessTarget, ReapWorktreeTarget } from '../../orchestrator/reapTypes';
import { ReapExecutorImpl } from './reapExecutor';
import { createWorktreePruner } from './worktreePruner';

vi.setConfig({ testTimeout: 60_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const hasBranch = (repo: string, name: string) => git(repo, 'branch', '--list', name).trim() !== '';

let root: string;
let repo: string;
let dbDir: string;
let svc: DatabaseService;
let projectId: number;
let gsm: GitStatusManager;
const wtPath = (name: string) => join(root, name);

const target = (name: string, extra: Partial<ReapWorktreeTarget> = {}): ReapWorktreeTarget => ({
  kind: 'worktree',
  path: wtPath(name),
  branch: name,
  tag: 'session-owned',
  sessionId: null,
  runId: null,
  reclaimableBytes: 1,
  dirty: false,
  dirtyFileCount: 0,
  aheadOfMain: 0,
  ...extra,
});

const manifestOf = (targets: ReapManifest['targets']): ReapManifest => ({
  id: 'reap_x',
  kind: 'card',
  snapshotGeneratedAt: 1,
  builtAt: 1,
  targets,
  reclaimableBytes: 0,
  unmeasuredTargetCount: 0,
  dirtyFileCount: 0,
  dirtyCountUnknownTargetCount: 0,
  aheadOfMainCount: 0,
  descendantPidCount: 0,
  alsoDeleteBranch: false,
});

function makePruner() {
  return createWorktreePruner({
    worktreeManager: new WorktreeManager(),
    resolveProjectPath: (id) => svc.getProject(id)?.path ?? null,
    clearGitStatusCache: (sessionId) => gsm.clearSessionCache(sessionId),
  });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-pruner-')));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'wt-pruner-db-'));
  svc = new DatabaseService(join(dbDir, 'test.db'));
  svc.setMigrationsDirForTesting(join(__dirname, '..', '..', 'database', 'migrations'));
  svc.initialize();
  projectId = svc.createProject('p', repo).id;
  gsm = new GitStatusManager({} as never, {} as never, {} as never);
});

afterEach(() => {
  svc.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('createWorktreePruner (real git)', () => {
  it('prunes through removeWorktreeByPath and leaves the branch alone by default', async () => {
    git(repo, 'worktree', 'add', '-b', 'keep-branch', wtPath('keep-branch'));
    const res = await makePruner()(target('keep-branch'), { alsoDeleteBranch: false, projectId });
    expect(res).toEqual({ targetId: `worktree:${wtPath('keep-branch')}`, kind: 'pruned' });
    expect(existsSync(wtPath('keep-branch'))).toBe(false);
    expect(hasBranch(repo, 'keep-branch')).toBe(true);
  });

  it('deletes the branch only on explicit opt-in', async () => {
    git(repo, 'worktree', 'add', '-b', 'drop-branch', wtPath('drop-branch'));
    const res = await makePruner()(target('drop-branch'), { alsoDeleteBranch: true, projectId });
    expect(res.kind).toBe('pruned');
    expect(existsSync(wtPath('drop-branch'))).toBe(false);
    expect(hasBranch(repo, 'drop-branch')).toBe(false);
  });

  it('is idempotent on an already-removed worktree', async () => {
    const res = await makePruner()(target('never-existed'), { alsoDeleteBranch: false, projectId });
    expect(res.kind).toBe('pruned');
  });

  it('invalidates the owning session cache entry and leaves session/run rows untouched', async () => {
    git(repo, 'worktree', 'add', '-b', 'owned-wt', wtPath('owned-wt'));
    svc.createSession({
      id: 's-owned',
      name: 's-owned',
      initial_prompt: '',
      worktree_name: 'owned-wt',
      worktree_path: wtPath('owned-wt'),
      project_id: projectId,
    });
    svc.getDb()
      .prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', ?, 'sprint', '{}')")
      .run(projectId);
    svc.getDb()
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path)
         VALUES ('r-owned', 'wf-1', ?, 'running', 'default', ?)`,
      )
      .run(projectId, wtPath('owned-wt'));
    const rows = () => ({
      session: svc.getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('s-owned'),
      run: svc.getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get('r-owned'),
    });
    const before = rows();
    expect(before.session).toBeDefined();
    expect(before.run).toBeDefined();

    const cache = (gsm as unknown as { cache: Record<string, unknown> }).cache;
    cache['s-owned'] = { status: {}, lastChecked: 1 };
    cache['s-other'] = { status: {}, lastChecked: 1 };
    expect(gsm.peekCachedStatus('s-owned')).not.toBeNull();

    const res = await makePruner()(target('owned-wt', { sessionId: 's-owned', runId: 'r-owned' }), {
      alsoDeleteBranch: true,
      projectId,
    });
    expect(res.kind).toBe('pruned');
    expect(gsm.peekCachedStatus('s-owned')).toBeNull();
    expect(gsm.peekCachedStatus('s-other')).not.toBeNull();
    expect(rows()).toEqual(before);
  });

  it('refuses the project checkout', async () => {
    const res = await makePruner()(target('main', { path: repo }), { alsoDeleteBranch: true, projectId });
    expect(res.kind).toBe('failed');
    expect(existsSync(repo)).toBe(true);
    expect(hasBranch(repo, 'main')).toBe(true);
  });

  it('reports a failed branch delete after the worktree is gone (never a silent success)', async () => {
    git(repo, 'worktree', 'add', '-b', 'held-branch', wtPath('held-branch'));
    git(repo, 'worktree', 'add', '-b', 'other-branch', wtPath('other-wt'));
    // Ask to delete a branch that ANOTHER worktree still has checked out.
    const res = await makePruner()(target('held-branch', { branch: 'other-branch' }), {
      alsoDeleteBranch: true,
      projectId,
    });
    expect(res.kind).toBe('failed');
    expect(res.error).toMatch(/Worktree removed, but deleting branch 'other-branch' failed/);
    expect(existsSync(wtPath('held-branch'))).toBe(false);
    expect(hasBranch(repo, 'other-branch')).toBe(true);
  });
});

describe('ReapExecutorImpl with the real pruner: card ordering', () => {
  it('kills the card processes, then reaps brokers, then removes the directory', async () => {
    git(repo, 'worktree', 'add', '-b', 'card-wt', wtPath('card-wt'));
    const order: string[] = [];
    let dead = false;
    const proc: ReapProcessTarget = {
      kind: 'process',
      pid: 4242,
      processType: 'claude-cli',
      bucket: 'owned',
      command: 'claude',
      worktreePath: wtPath('card-wt'),
      sessionId: null,
      runId: null,
      taggedAsCyboflow: true,
      descendantPidCount: 0,
    };
    const realPrune = makePruner();
    const ex = new ReapExecutorImpl({
      killTree: async (pid) => {
        order.push(`kill:${pid}:${existsSync(wtPath('card-wt'))}`);
        dead = true;
        return true;
      },
      listDescendants: async () => [],
      isPidAlive: () => !dead,
      reapBrokersForWorktree: async (p) => {
        order.push(`brokers:${existsSync(p)}`);
      },
      pruneWorktree: async (t, o) => {
        order.push('prune');
        return realPrune(t, o);
      },
      selfPid: 1,
    });
    const results = await ex.execute(manifestOf([target('card-wt'), proc]), { alsoDeleteBranch: false, projectId });
    // Directory still present while processes die and brokers are reaped.
    expect(order).toEqual(['kill:4242:true', 'brokers:true', 'prune']);
    expect(results.map((r) => r.kind)).toEqual(['killed', 'pruned']);
    expect(existsSync(wtPath('card-wt'))).toBe(false);
  });
});
