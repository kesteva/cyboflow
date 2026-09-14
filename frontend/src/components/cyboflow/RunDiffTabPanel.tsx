/**
 * RunDiffTabPanel — the run-scoped Diff tab body in RunRightRail.
 *
 * Flow runs have workflow_runs.session_id = NULL and are keyed by runId, so the
 * session-scoped combined-diff path (sessions:get-combined-diff) cannot serve
 * them. This panel fetches the run's working-directory diff via the run-scoped
 * `cyboflow.runs.gitDiff` query (which resolves workflow_runs.worktree_path) and
 * renders the flat RunDiffFileList — clicking a file opens it in the center pane
 * (where the actual Diff / Split / Preview lives).
 *
 * tRPC: vanilla createTRPCProxyClient — `.query()` returns a Promise (there are
 * no React-Query hooks in this app). The fetch mirrors useSprintLanes: an effect
 * keyed by runId, a `cancelled` guard on unmount/runId-change, and the
 * AppRouter-inferred output type (never a local mirror).
 *
 * States:
 *   - loading                     → muted "Loading diff…"
 *   - error                       → muted error line
 *   - null / empty diff / no files → muted "No changes in this run's worktree yet."
 *   - otherwise                   → RunDiffFileList (flat changed-files list;
 *                                    clicking a row opens the file in the center
 *                                    pane where the Diff / Split / Preview lives).
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../../trpc/client';
import type { AppRouter } from '../../../../shared/types/trpc';
import type { DiffGroupScope } from '../../../../shared/types/runFiles';
import { RunDiffFileList } from './RunDiffFileList';

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** The run-scoped diff payload as returned by `cyboflow.runs.gitDiff`. */
type RunGitDiffOutput = RouterOutputs['cyboflow']['runs']['gitDiff'];

interface RunDiffState {
  diff: RunGitDiffOutput;
  isLoading: boolean;
  error: Error | null;
}

const INITIAL_STATE: RunDiffState = {
  diff: null,
  isLoading: false,
  error: null,
};

export function RunDiffTabPanel({
  runId,
  onOpenFile,
  onResolvedBase,
}: {
  runId: string;
  /**
   * Forwarded to DiffViewer — click a file header to open it (vs. toggle). The
   * grouped arm additionally passes the clicked row's group scope.
   */
  onOpenFile?: (filePath: string, scope?: DiffGroupScope) => void;
  /**
   * Echoes the base this panel's diff was actually resolved against — called
   * once per successful fetch (including a null/no-worktree result), never on
   * the error arm. Lets the rail lift the SAME base into openFileTab so a file
   * tab opened from this panel (or the File Explorer) resolves against the
   * base the rail is currently showing, not a separately-derived one.
   */
  onResolvedBase?: (base: string | null) => void;
}): ReactElement {
  const [state, setState] = useState<RunDiffState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    setState({ ...INITIAL_STATE, isLoading: true });

    trpc.cyboflow.runs.gitDiff.query({ runId }).then(
      (result) => {
        if (cancelled) return;
        setState({ diff: result, isLoading: false, error: null });
        onResolvedBase?.(result?.resolvedBase ?? null);
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ diff: null, isLoading: false, error });
      },
    );

    return () => {
      cancelled = true;
    };
    // onResolvedBase is a per-render callback from the rail; keying the fetch
    // on it would refetch on every rail render (D-8: single fetch per runId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (state.isLoading) {
    return (
      <div
        data-testid="run-right-rail-diff-loading"
        className="p-4 text-sm text-text-secondary"
      >
        Loading diff…
      </div>
    );
  }

  if (state.error) {
    return (
      <div
        data-testid="run-right-rail-diff-error"
        className="p-4 text-sm text-text-secondary"
      >
        Could not load this run's diff: {state.error.message}
      </div>
    );
  }

  const diffText = state.diff?.diff ?? '';

  // Flat changed-files list — the diff body itself opens in the center pane.
  return (
    <div data-testid="run-right-rail-diff" className="h-full">
      <RunDiffFileList diff={diffText} onOpenFile={onOpenFile} />
    </div>
  );
}
