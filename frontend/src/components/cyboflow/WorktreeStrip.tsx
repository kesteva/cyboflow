/**
 * WorktreeStrip — the rail's compact "N uncommitted" working-tree strip
 * (TASK-219), mounted directly below BaseSelector and above the file groups
 * in the Diff tab body.
 *
 * It renders the `WorktreeStatusPayload` the ACTIVE diff panel fetched
 * (lifted by the rail via the panel's `onWorktree` echo) rather than issuing
 * its own second `getCombinedDiff` — so the count is always the SAME snapshot
 * the grouped list below it renders (TASK-218 D-8), including for a
 * parentless flow run whose worktree only the run-scoped panel can see.
 * Wires two EXISTING tRPC procedures:
 *   - `sessionGit.commit` (via the reusable CommitDialog) — stages everything
 *     (`git add -A`) and commits with a user-entered message.
 *   - `workspaceFiles.gitRestore` — destructive (`git clean -fd` + checkout),
 *     gated behind a `window.confirm`.
 * After either succeeds it calls `onMutated`, which the rail turns into a
 * refetch of the panel (and therefore of this strip's own snapshot).
 *
 * The uncommitted count is simply `entries.length`: `WorktreeStatusPayload`'s
 * `entries` is already the exact distinct-uncommitted-porcelain-paths list
 * (one entry per path; Committed-only paths never appear here), so no extra
 * dedup/group-membership arithmetic is needed or correct.
 *
 * Conflict guard (TASK-219 iv): Commit is enabled ONLY with a successful
 * status snapshot in hand that contains no conflicted entry — an absent
 * snapshot (still loading, or the fetch failed) disables it rather than being
 * treated as "clean" — and the same check is re-run inside submission against
 * the LATEST snapshot. That is a UX courtesy, not the guarantee: the snapshot
 * is only as fresh as the panel's last fetch, and an agent can conflict the
 * tree between the dialog opening and submit. The AUTHORITATIVE guard is the
 * `sessionGit.commit` op itself, which probes the live index
 * (`git diff --diff-filter=U`) immediately before `git add -A` and returns
 * `{ success: false, error }` on any unmerged path — surfaced here through
 * CommitDialog exactly like any other commit failure.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { CommitDialog } from '../CommitDialog';
import type { WorktreeStatusPayload } from '../../../../shared/types/runFiles';

export interface WorktreeStripProps {
  /**
   * The session backing this strip's actions — null disables Commit/Restore
   * with an explanatory title. Both tRPC procedures this strip touches are
   * sessionId-keyed; flow runs have workflow_runs.session_id = NULL, so a
   * run with no parent session correctly renders both actions disabled
   * (its COUNT still comes from the lifted `worktree`).
   */
  sessionId: string | null;
  /**
   * The active panel's working-tree snapshot, lifted by the rail. `undefined`
   * = no successful snapshot yet (loading, or the last fetch failed) — the
   * count reads as unknown and Commit is disabled.
   */
  worktree: WorktreeStatusPayload | undefined;
  /** Called after a successful Commit / Restore so the rail can refetch. */
  onMutated?: () => void;
}

const NO_CONFLICT_ERROR = 'Resolve conflicts before committing';
const NO_STATUS_ERROR = 'Working-tree status is not available yet';

export function WorktreeStrip({ sessionId, worktree, onMutated }: WorktreeStripProps): ReactElement {
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);

  const entries = worktree?.entries ?? [];
  const hasConflict = entries.some((e) => e.conflicted);

  const commitDisabledReason =
    sessionId === null
      ? 'Select a session to commit changes'
      : worktree === undefined
        ? NO_STATUS_ERROR
        : hasConflict
          ? NO_CONFLICT_ERROR
          : null;
  const restoreDisabledReason = sessionId === null ? 'Select a session to restore changes' : null;

  const handleCommit = useCallback(
    async (message: string) => {
      if (sessionId === null) return;
      // Re-check against the LATEST snapshot at submission time — the dialog
      // may have been opened before a conflicted/failed status arrived.
      if (worktree === undefined) throw new Error(NO_STATUS_ERROR);
      if (worktree.entries.some((e) => e.conflicted)) throw new Error(NO_CONFLICT_ERROR);
      const result = await trpc.cyboflow.sessionGit.commit.mutate({ sessionId, message });
      if (!result.success) {
        throw new Error(result.error || 'Failed to commit changes');
      }
      onMutated?.();
    },
    [sessionId, worktree, onMutated],
  );

  const handleRestore = useCallback(() => {
    if (sessionId === null) return;
    if (
      !window.confirm(
        'Are you sure you want to restore all uncommitted changes? This will permanently discard all local modifications and cannot be undone.',
      )
    ) {
      return;
    }
    trpc.cyboflow.workspaceFiles.gitRestore.mutate({ sessionId }).then((result) => {
      if (result.success) {
        onMutated?.();
      }
    });
  }, [sessionId, onMutated]);

  return (
    <div
      data-testid="worktree-strip"
      className="flex items-center justify-between gap-2 border-l-2 border-status-warning bg-bg-primary px-2 py-1.5 text-sm"
    >
      <span data-testid="worktree-strip-count" className="text-text-secondary">
        {worktree === undefined ? '… uncommitted' : `${entries.length} uncommitted`}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="worktree-strip-commit"
          disabled={commitDisabledReason !== null}
          title={commitDisabledReason ?? undefined}
          onClick={() => setCommitDialogOpen(true)}
          className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Commit…
        </button>
        <button
          type="button"
          data-testid="worktree-strip-restore"
          disabled={restoreDisabledReason !== null}
          title={restoreDisabledReason ?? undefined}
          onClick={handleRestore}
          className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Restore
        </button>
      </div>
      <CommitDialog
        isOpen={commitDialogOpen}
        onClose={() => setCommitDialogOpen(false)}
        onCommit={handleCommit}
        fileCount={entries.length}
      />
    </div>
  );
}
