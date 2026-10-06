/**
 * Worktree prune primitive for the reap executor: removes one confirmed worktree
 * target through `WorktreeManager.removeWorktreeByPath` (the same idempotent
 * primitive run close-out uses — no second removal path), optionally force-deletes
 * its branch, then drops the git-status cache entry of the owning session.
 *
 * Owner rows are deliberately left alone: nothing here touches `sessions` or
 * `workflow_runs`. A pruned worktree keeps its owner's history; the registry
 * simply stops reporting the path.
 *
 * Ordering (kill processes → reap Codex brokers → remove the directory) is owned by
 * `ReapExecutorImpl.execute`, which calls this last.
 */
import { resolve } from 'node:path';
import type { ReapExecutionResult, ReapWorktreeTarget } from '../../orchestrator/reapTypes';
import { reapTargetKey } from '../../orchestrator/reapTypes';
import type { WorktreeManager } from '../worktreeManager';

export interface WorktreePrunerDeps {
  worktreeManager: Pick<WorktreeManager, 'removeWorktreeByPath' | 'deleteBranch'>;
  /** Filesystem path of a project's main checkout, or null when the project is unknown. */
  resolveProjectPath(projectId: number): string | null;
  /** Drops `GitStatusManager`'s cached status for a session. */
  clearGitStatusCache(sessionId: string): void;
}

export type PruneWorktreeFn = (
  target: ReapWorktreeTarget,
  options: { alsoDeleteBranch: boolean; projectId?: number },
) => Promise<ReapExecutionResult>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createWorktreePruner(deps: WorktreePrunerDeps): PruneWorktreeFn {
  return async (target, options) => {
    const targetId = reapTargetKey(target);
    if (options.projectId === undefined) {
      return { targetId, kind: 'failed', error: 'Cannot prune a worktree without its project.' };
    }
    const projectPath = deps.resolveProjectPath(options.projectId);
    if (!projectPath) {
      return { targetId, kind: 'failed', error: `Unknown project ${options.projectId}; worktree not pruned.` };
    }
    // The project's own checkout is never a prune target (in_place / main-repo guard).
    if (resolve(target.path) === resolve(projectPath)) {
      return { targetId, kind: 'failed', error: 'Refusing to prune the project checkout.' };
    }

    try {
      await deps.worktreeManager.removeWorktreeByPath(projectPath, target.path);
    } catch (err) {
      return { targetId, kind: 'failed', error: errorMessage(err) };
    }

    // The directory is gone: its cached git status is now a lie whatever happens next.
    if (target.sessionId) deps.clearGitStatusCache(target.sessionId);

    // Branch deletion is opt-in only (the manifest's confirmed choice), and must follow
    // the removal so the branch is no longer checked out. A failure is surfaced — the
    // worktree is already gone, but the branch the user asked to drop is not.
    if (options.alsoDeleteBranch && target.branch.trim() !== '') {
      try {
        await deps.worktreeManager.deleteBranch(projectPath, target.branch, { force: true });
      } catch (err) {
        return {
          targetId,
          kind: 'failed',
          error: `Worktree removed, but deleting branch '${target.branch}' failed: ${errorMessage(err)}`,
        };
      }
    }
    return { targetId, kind: 'pruned' };
  };
}
