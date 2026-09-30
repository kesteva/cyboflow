/**
 * cyboflow.worktreeMonitor router — end-to-end over a REAL git repo (actual
 * `git worktree add` in a temp dir, real WorktreeManager.listWorktrees, real
 * reconciler, real DiskUsageService with a fake `du` runner). Only the DB rows are
 * seeded fixtures (a structural fake of the two read helpers).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface SessionRef { id: string; worktree_path: string; in_place: number | null; is_main_repo: number | null }
interface RunRef { id: string; worktree_path: string }

let sessions: SessionRef[];
let runs: RunRef[];
let duCalls: string[];
let duGate: Array<() => void>;
let disk: DiskUsageService;

function useProvider(): void {
  setWorktreeMonitorProvider(
    createWorktreeMonitorProvider({
      database: {
        getProject: (id) => (id === 1 ? { path: repo } : undefined),
        getSessionWorktreeRefs: () => sessions,
        getRunWorktreeRefs: () => runs,
      },
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
  sessions = [
    { id: 's-main', worktree_path: repo, in_place: 0, is_main_repo: 1 },
    { id: 's-1', worktree_path: wtPath('sess-wt'), in_place: 0, is_main_repo: 0 },
    { id: 's-inplace', worktree_path: wtPath('inplace-wt'), in_place: 1, is_main_repo: 0 },
  ];
  runs = [{ id: 'r-1', worktree_path: wtPath('run-wt') }];
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
    await expect(caller().registry({ projectId: 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('cyboflow.worktreeMonitor.registry (real git worktrees)', () => {
  it('tags every git worktree end-to-end', async () => {
    const { worktrees } = await caller().registry({ projectId: 1 });
    const byPath = new Map(worktrees.map((w) => [w.path, w]));

    expect(byPath.get(repo)).toMatchObject({ tag: 'is_main_repo', prunable: false, sessionId: 's-main' });
    expect(byPath.get(wtPath('sess-wt'))).toMatchObject({ tag: 'session-owned', prunable: true, sessionId: 's-1' });
    expect(byPath.get(wtPath('run-wt'))).toMatchObject({ tag: 'run-owned', prunable: true, runId: 'r-1' });
    expect(byPath.get(wtPath('orphan-wt'))).toMatchObject({ tag: 'orphan', prunable: true });
    expect(byPath.get(wtPath('inplace-wt'))).toMatchObject({ tag: 'in_place', prunable: false });
  });

  it('never marks an in_place / is_main_repo entry prunable', async () => {
    const { worktrees } = await caller().registry({ projectId: 1 });
    const guarded = worktrees.filter((w) => w.tag === 'in_place' || w.tag === 'is_main_repo');
    expect(guarded.length).toBeGreaterThanOrEqual(2);
    for (const w of guarded) expect(w.prunable).toBe(false);
  });

  it('keeps the main checkout non-prunable even when no session row owns it', async () => {
    sessions = sessions.filter((s) => s.id !== 's-main');
    const { worktrees } = await caller().registry({ projectId: 1 });
    expect(worktrees.find((w) => w.path === repo)).toMatchObject({ tag: 'is_main_repo', prunable: false });
  });

  it('returns an empty list for an unknown project', async () => {
    expect((await caller().registry({ projectId: 999 })).worktrees).toEqual([]);
  });

  // Negative control: the orphan tag is real, not a default — owning the path flips it.
  it('flips orphan -> run-owned once a run row references the path', async () => {
    runs = [...runs, { id: 'r-2', worktree_path: wtPath('orphan-wt') }];
    const { worktrees } = await caller().registry({ projectId: 1 });
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
