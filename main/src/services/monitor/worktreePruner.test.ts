/**
 * createWorktreePruner: prunes through WorktreeManager.removeWorktreeByPath, branch
 * deletion is opt-in and follows removal, the git-status cache is invalidated, the
 * project checkout is protected, and no owner-row store is ever touched (the deps
 * expose none). Fakes only — no git or filesystem access.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReapWorktreeTarget } from '../../orchestrator/reapTypes';
import { createWorktreePruner, type WorktreePrunerDeps } from './worktreePruner';

const target = (over: Partial<ReapWorktreeTarget> = {}): ReapWorktreeTarget => ({
  kind: 'worktree',
  path: '/repo/worktrees/a',
  branch: 'feat/a',
  tag: 'session-owned',
  sessionId: 'sess-1',
  runId: null,
  reclaimableBytes: 1,
  dirty: false,
  dirtyFileCount: 0,
  aheadOfMain: 0,
  ...over,
});

function setup(over: Partial<WorktreePrunerDeps> = {}) {
  const calls: string[] = [];
  const removeWorktreeByPath = vi.fn(async () => {
    calls.push('remove');
  });
  const deleteBranch = vi.fn(async () => {
    calls.push('deleteBranch');
  });
  const clearGitStatusCache = vi.fn(() => {
    calls.push('clearCache');
  });
  const prune = createWorktreePruner({
    worktreeManager: { removeWorktreeByPath, deleteBranch },
    resolveProjectPath: (id) => (id === 1 ? '/repo' : null),
    clearGitStatusCache,
    ...over,
  });
  return { prune, removeWorktreeByPath, deleteBranch, clearGitStatusCache, calls };
}

describe('createWorktreePruner', () => {
  it('removes via removeWorktreeByPath, keeps the branch by default, and clears the session cache', async () => {
    const s = setup();
    const res = await s.prune(target(), { alsoDeleteBranch: false, projectId: 1 });
    expect(res).toEqual({ targetId: 'worktree:/repo/worktrees/a', kind: 'pruned' });
    expect(s.removeWorktreeByPath).toHaveBeenCalledWith('/repo', '/repo/worktrees/a');
    expect(s.deleteBranch).not.toHaveBeenCalled();
    expect(s.clearGitStatusCache).toHaveBeenCalledWith('sess-1');
  });

  it('deletes the branch only on explicit opt-in, after the worktree is removed', async () => {
    const s = setup();
    const res = await s.prune(target(), { alsoDeleteBranch: true, projectId: 1 });
    expect(res.kind).toBe('pruned');
    expect(s.deleteBranch).toHaveBeenCalledWith('/repo', 'feat/a', { force: true });
    expect(s.calls).toEqual(['remove', 'clearCache', 'deleteBranch']);
  });

  it('surfaces a branch-delete failure after removal as failed, not pruned', async () => {
    const s = setup();
    s.deleteBranch.mockRejectedValueOnce(new Error('boom'));
    const res = await s.prune(target(), { alsoDeleteBranch: true, projectId: 1 });
    expect(res.kind).toBe('failed');
    expect(res).toMatchObject({ error: expect.stringContaining('boom') });
    expect(s.clearGitStatusCache).toHaveBeenCalled();
  });

  it('does not clear any cache for an ownerless (orphan) worktree', async () => {
    const s = setup();
    await s.prune(target({ sessionId: null, tag: 'orphan' }), { alsoDeleteBranch: false, projectId: 1 });
    expect(s.clearGitStatusCache).not.toHaveBeenCalled();
  });

  it('reports a failed removal and neither clears cache nor deletes the branch', async () => {
    const s = setup();
    s.removeWorktreeByPath.mockRejectedValueOnce(new Error('EBUSY'));
    const res = await s.prune(target(), { alsoDeleteBranch: true, projectId: 1 });
    expect(res).toMatchObject({ kind: 'failed', error: 'EBUSY' });
    expect(s.clearGitStatusCache).not.toHaveBeenCalled();
    expect(s.deleteBranch).not.toHaveBeenCalled();
  });

  it('refuses the project checkout itself (in_place / main-repo guard)', async () => {
    const s = setup();
    const res = await s.prune(target({ path: '/repo/' }), { alsoDeleteBranch: false, projectId: 1 });
    expect(res.kind).toBe('failed');
    expect(s.removeWorktreeByPath).not.toHaveBeenCalled();
  });

  it('fails without touching anything when the project is missing or unknown', async () => {
    const s = setup();
    expect((await s.prune(target(), { alsoDeleteBranch: false })).kind).toBe('failed');
    expect((await s.prune(target(), { alsoDeleteBranch: false, projectId: 9 })).kind).toBe('failed');
    expect(s.removeWorktreeByPath).not.toHaveBeenCalled();
  });
});
