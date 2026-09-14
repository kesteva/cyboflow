/**
 * WorktreeStrip — the rail's compact "N uncommitted" working-tree strip
 * (TASK-219), mounted directly below BaseSelector and above the file groups
 * in the Diff tab body.
 *
 * A self-contained sub-component (mirrors BaseSelector's shape): it fetches
 * its OWN `WorktreeStatusPayload` via `API.sessions.getCombinedDiff` rather
 * than receiving data lifted from a sibling panel — this repo's established
 * pattern for rail sub-components. Wires two EXISTING tRPC procedures:
 *   - `sessionGit.commit` (via the reusable CommitDialog) — stages everything
 *     (`git add -A`) and commits with a user-entered message.
 *   - `workspaceFiles.gitRestore` — destructive (`git clean -fd` + checkout),
 *     gated behind a `window.confirm`.
 *
 * The uncommitted count is simply `entries.length`: `WorktreeStatusPayload`'s
 * `entries` is already the exact distinct-uncommitted-porcelain-paths list
 * (one entry per path; Committed-only paths never appear here), so no extra
 * dedup/group-membership arithmetic is needed or correct.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { API } from '../../utils/api';
import { CommitDialog } from '../CommitDialog';
import type { WorktreeStatusPayload } from '../../../../shared/types/runFiles';

export interface WorktreeStripProps {
  /**
   * The session backing this strip's actions — null disables Commit/Restore
   * with an explanatory title. All three tRPC procedures this strip touches
   * are sessionId-keyed; flow runs have workflow_runs.session_id = NULL, so a
   * run with no parent session correctly renders both actions disabled.
   */
  sessionId: string | null;
}

export function WorktreeStrip({ sessionId }: WorktreeStripProps): ReactElement {
  const [status, setStatus] = useState<WorktreeStatusPayload | undefined>(undefined);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);

  const fetchStatus = useCallback(() => {
    if (sessionId === null) {
      setStatus(undefined);
      return () => {};
    }
    let cancelled = false;
    API.sessions.getCombinedDiff(sessionId).then(
      (res) => {
        if (cancelled) return;
        setStatus(res.success ? res.data.worktree : undefined);
      },
      () => {
        if (cancelled) return;
        setStatus(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const cleanup = fetchStatus();
    return cleanup;
  }, [fetchStatus]);

  const entries = status?.entries ?? [];
  const hasConflict = entries.some((e) => e.conflicted);

  const commitDisabledReason =
    sessionId === null
      ? 'Select a session to commit changes'
      : hasConflict
        ? 'Resolve conflicts before committing'
        : null;
  const restoreDisabledReason = sessionId === null ? 'Select a session to restore changes' : null;

  const handleCommit = useCallback(
    async (message: string) => {
      if (sessionId === null) return;
      const result = await trpc.cyboflow.sessionGit.commit.mutate({ sessionId, message });
      if (!result.success) {
        throw new Error(result.error || 'Failed to commit changes');
      }
      fetchStatus();
    },
    [sessionId, fetchStatus],
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
        fetchStatus();
      }
    });
  }, [sessionId, fetchStatus]);

  return (
    <div
      data-testid="worktree-strip"
      className="flex items-center justify-between gap-2 border-l-2 border-status-warning bg-bg-primary px-2 py-1.5 text-sm"
    >
      <span data-testid="worktree-strip-count" className="text-text-secondary">
        {entries.length} uncommitted
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
