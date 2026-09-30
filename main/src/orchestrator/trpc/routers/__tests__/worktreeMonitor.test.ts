/**
 * cyboflow.worktreeMonitor router — end-to-end over a REAL git repo (actual
 * `git worktree add` in a temp dir, real WorktreeManager.listWorktrees, real
 * reconciler, real DiskUsageService with a fake `du` runner). Only the DB rows are
 * seeded rows in a REAL temp DatabaseService (full migration chain), so the actual
 * `getSessionWorktreeRefs` / `getRunWorktreeRefs` SQL is on the tested path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../../database/database';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { setWorktreeMonitorProvider } from '../worktreeMonitor';
import { createWorktreeMonitorProvider } from '../../../../services/worktreeMonitorProvider';
import { WorktreeManager } from '../../../../services/worktreeManager';
import { DiskUsageService } from '../../../../services/diskUsageService';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

let root: string;
let repo: string;
const wtPath = (name: string) => join(root, name);

let svc: DatabaseService;
let dbDir: string;
let projectId: number;
let duCalls: string[];
let duGate: Array<() => void>;
let disk: DiskUsageService;

function seedSession(id: string, worktreePath: string, pid: number, flags: { in_place?: boolean; is_main_repo?: boolean } = {}): void {
  svc.createSession({
    id,
    name: id,
    initial_prompt: '',
    worktree_name: id,
    worktree_path: worktreePath,
    project_id: pid,
    in_place: flags.in_place,
    is_main_repo: flags.is_main_repo,
  });
}

function seedRun(id: string, worktreePath: string, pid: number): void {
  svc.getDb()
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path)
       VALUES (?, 'wf-1', ?, 'running', 'default', ?)`,
    )
    .run(id, pid, worktreePath);
}

function useProvider(): void {
  setWorktreeMonitorProvider(
    createWorktreeMonitorProvider({
      database: svc,
      worktreeManager: new WorktreeManager(),
      diskUsage: disk,
    }),
  );
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-monitor-')));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
  for (const name of ['sess-wt', 'run-wt', 'orphan-wt', 'inplace-wt']) {
    git(repo, 'worktree', 'add', '-b', name, wtPath(name));
  }
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'wt-monitor-db-'));
  svc = new DatabaseService(join(dbDir, 'test.db'));
  svc.setMigrationsDirForTesting(join(__dirname, '..', '..', '..', '..', 'database', 'migrations'));
  svc.initialize();
  const project = svc.createProject('wt', repo);
  projectId = project.id;
  const other = svc.createProject('other', join(root, 'other-proj'));
  seedSession('s-main', repo, projectId, { is_main_repo: true });
  seedSession('s-1', wtPath('sess-wt'), projectId);
  seedSession('s-inplace', wtPath('inplace-wt'), projectId, { in_place: true });
  svc.getDb()
    .prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', ?, 'sprint', '{}')")
    .run(projectId);
  seedRun('r-1', wtPath('run-wt'), projectId);
  // Negative control: rows owned by a DIFFERENT project must not claim orphan-wt.
  seedSession('s-other', wtPath('orphan-wt'), other.id);
  duCalls = [];
  duGate = [];
  disk = new DiskUsageService({
    runDu: (p) => {
      duCalls.push(p);
      return new Promise<number>((resolve) => duGate.push(() => resolve(4096)));
    },
    sleep: async () => {},
  });
  useProvider();
});

afterEach(() => {
  setWorktreeMonitorProvider(null);
  svc.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const caller = () => appRouter.createCaller(createContext()).cyboflow.worktreeMonitor;

describe('cyboflow.worktreeMonitor wiring', () => {
  it('is registered on the appRouter', () => {
    expect(typeof caller().registry).toBe('function');
    expect(typeof caller().diskUsage).toBe('function');
    expect(typeof caller().requestFresh).toBe('function');
  });

  it('rejects with PRECONDITION_FAILED when no provider is wired', async () => {
    setWorktreeMonitorProvider(null);
    await expect(caller().registry({ projectId })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('cyboflow.worktreeMonitor.registry (real git worktrees)', () => {
  it('tags every git worktree end-to-end', async () => {
    const { worktrees } = await caller().registry({ projectId });
    const byPath = new Map(worktrees.map((w) => [w.path, w]));

    expect(byPath.get(repo)).toMatchObject({ tag: 'is_main_repo', prunable: false, sessionId: 's-main' });
    expect(byPath.get(wtPath('sess-wt'))).toMatchObject({ tag: 'session-owned', prunable: true, sessionId: 's-1' });
    expect(byPath.get(wtPath('run-wt'))).toMatchObject({ tag: 'run-owned', prunable: true, runId: 'r-1' });
    expect(byPath.get(wtPath('orphan-wt'))).toMatchObject({ tag: 'orphan', prunable: true });
    expect(byPath.get(wtPath('inplace-wt'))).toMatchObject({ tag: 'in_place', prunable: false });
  });

  it('never marks an in_place / is_main_repo entry prunable', async () => {
    const { worktrees } = await caller().registry({ projectId });
    const guarded = worktrees.filter((w) => w.tag === 'in_place' || w.tag === 'is_main_repo');
    expect(guarded.length).toBeGreaterThanOrEqual(2);
    for (const w of guarded) expect(w.prunable).toBe(false);
  });

  it('keeps the main checkout non-prunable even when no session row owns it', async () => {
    svc.getDb().prepare("DELETE FROM sessions WHERE id = 's-main'").run();
    const { worktrees } = await caller().registry({ projectId });
    expect(worktrees.find((w) => w.path === repo)).toMatchObject({ tag: 'is_main_repo', prunable: false });
  });

  it('ignores other projects\' rows: their session on orphan-wt leaves it orphan (project_id filter)', async () => {
    const { worktrees } = await caller().registry({ projectId });
    expect(worktrees.find((w) => w.path === wtPath('orphan-wt'))).toMatchObject({ tag: 'orphan' });
    expect(worktrees.some((w) => w.sessionId === 's-other')).toBe(false);
  });

  it('returns an empty list for an unknown project', async () => {
    expect((await caller().registry({ projectId: 999 })).worktrees).toEqual([]);
  });

  // Negative control: the orphan tag is real, not a default — owning the path flips it.
  it('flips orphan -> run-owned once a run row references the path', async () => {
    seedRun('r-2', wtPath('orphan-wt'), projectId);
    const { worktrees } = await caller().registry({ projectId });
    expect(worktrees.find((w) => w.path === wtPath('orphan-wt'))?.tag).toBe('run-owned');
  });
});

describe('cyboflow.worktreeMonitor disk usage', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('returns the tri-state — never a bare number — for unmeasured paths', async () => {
    const a = wtPath('sess-wt');
    const b = wtPath('run-wt');
    const { entries } = await caller().diskUsage({ paths: [a, b] });
    expect(entries.map((e) => e.usage.status)).toEqual(['queued', 'queued']);
    for (const e of entries) expect(e.usage).not.toHaveProperty('bytes');
    await flush();
    // concurrency 1: only the first path is being measured.
    expect(duCalls).toEqual([a]);

    const during = await caller().diskUsage({ paths: [a, b] });
    expect(during.entries.map((e) => e.usage.status)).toEqual(['measuring', 'queued']);

    duGate.shift()?.();
    await flush();
    await flush();
    const after = await caller().diskUsage({ paths: [a] });
    expect(after.entries[0].usage).toMatchObject({ status: 'measured', bytes: 4096 });
  });

  it('requestFresh jumps a path ahead of the TTL queue', async () => {
    const [a, b, c] = ['sess-wt', 'run-wt', 'orphan-wt'].map(wtPath);
    await caller().diskUsage({ paths: [a, b, c] });
    await flush();
    expect(duCalls).toEqual([a]); // a in flight; b, c waiting in TTL order

    const fresh = await caller().requestFresh({ path: c });
    expect(fresh.path).toBe(c);
    expect(fresh.usage.status).toBe('queued');

    duGate.shift()?.(); // finish a
    await flush();
    await flush();
    // c was queued last but measures next, ahead of b.
    expect(duCalls).toEqual([a, c]);
    duGate.shift()?.();
    await flush();
    await flush();
    expect(duCalls).toEqual([a, c, b]);
  });

  it('does not start any du when nobody queries', async () => {
    await flush();
    expect(duCalls).toEqual([]);
  });
});
