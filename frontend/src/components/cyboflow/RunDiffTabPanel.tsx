/**
 * RunDiffTabPanel — the run-scoped Diff tab body in RunRightRail.
 *
 * Flow runs have workflow_runs.session_id = NULL and are keyed by runId, so the
 * session-scoped combined-diff path (sessions:get-combined-diff) cannot serve
 * them. This panel fetches the run's working-directory diff via the run-scoped
 * `cyboflow.runs.gitDiff` query (which resolves workflow_runs.worktree_path) and
 * renders the shared DiffViewer.
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
 *   - otherwise                   → DiffViewer (read-only; no sessionId, so it
 *                                    renders the parsed unified diff directly).
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../../trpc/client';
import type { AppRouter } from '../../../../shared/types/trpc';
import DiffViewer from '../panels/diff/DiffViewer';

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
}: {
  runId: string;
  /** Forwarded to DiffViewer — click a file header to open it (vs. toggle). */
  onOpenFile?: (filePath: string) => void;
}): ReactElement {
  const [state, setState] = useState<RunDiffState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    setState({ ...INITIAL_STATE, isLoading: true });

    trpc.cyboflow.runs.gitDiff.query({ runId }).then(
      (result) => {
        if (cancelled) return;
        setState({ diff: result, isLoading: false, error: null });
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
  if (diffText.trim() === '') {
    return (
      <div
        data-testid="run-right-rail-diff-empty"
        className="p-4 text-sm text-text-secondary"
      >
        No changes in this run's worktree yet.
      </div>
    );
  }

  // Read-only render: no sessionId, so DiffViewer skips the full-content edit
  // path and renders the parsed unified diff directly. isAllCommitsSelected=false
  // keeps it read-only (no Monaco save path).
  return (
    <div data-testid="run-right-rail-diff" className="h-full">
      <DiffViewer diff={diffText} isAllCommitsSelected={false} onOpenFile={onOpenFile} />
    </div>
  );
}
