/**
 * SessionDiffTabPanel — the session-scoped Diff tab body in RunRightRail.
 *
 * The at-rest twin of RunDiffTabPanel: a selected session (quick / session-hosted,
 * no active run) has a real `sessions` row, so its working diff comes from the
 * session-scoped `API.sessions.getCombinedDiff(sessionId)` path. Like the run
 * panel it renders the flat RunDiffFileList — clicking a file opens it in the
 * center pane (Diff / Split / Preview).
 *
 * Snapshot fetch: an effect keyed by `[sessionId, comparisonRef, refreshNonce]`
 * (TASK-218 — selecting a new comparison base refetches; the rail bumps the
 * nonce on worktree-change events, window focus, ↻, and its own mutations)
 * with a `cancelled` guard. A refetch keeps the previous snapshot on screen
 * until the new one lands — no "Loading diff…" flash on a live tree.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { API } from '../../utils/api';
import type { DiffGroupScope, WorktreeStatusPayload } from '../../../../shared/types/runFiles';
import { RunDiffFileList } from './RunDiffFileList';

interface SessionDiffState {
  diff: string;
  /** The response's per-scope status/rollups (TASK-218) — passed through to
   * RunDiffFileList's `groups` prop for the grouped rendering. */
  worktree: WorktreeStatusPayload | undefined;
  isLoading: boolean;
  error: string | null;
}

const INITIAL_STATE: SessionDiffState = { diff: '', worktree: undefined, isLoading: false, error: null };

export function SessionDiffTabPanel({
  sessionId,
  comparisonRef,
  refreshNonce,
  onOpenFile,
  onResolvedBase,
  onWorktree,
}: {
  sessionId: string;
  /**
   * The user-selected comparison base (BaseSelector / TASK-218), lifted by the
   * rail and forwarded verbatim into `getCombinedDiff`'s `comparisonRef`
   * argument (undefined/null both mean "use the session default"). Included
   * in the fetch effect's deps — selecting a new base DOES refetch.
   */
  comparisonRef?: string | null;
  /**
   * Forwarded to RunDiffFileList — click a file row to open it. The grouped
   * arm additionally passes the clicked row's group scope.
   */
  onOpenFile?: (filePath: string, scope?: DiffGroupScope) => void;
  /**
   * Echoes the base this panel's diff was actually resolved against — called
   * once per successful fetch, never on the error arm. See RunDiffTabPanel's
   * twin for the rationale (lifts the SAME base into openFileTab).
   */
  onResolvedBase?: (base: string | null) => void;
  /**
   * Bumped by the rail after a working-tree MUTATION (WorktreeStrip's Commit
   * / Restore) so this panel refetches the same [sessionId, comparisonRef]
   * and the grouped list + the strip's count move together.
   */
  refreshNonce?: number;
  /**
   * Echoes the fetched response's `worktree` payload (the SAME snapshot the
   * grouped list renders) so the rail can lift it into WorktreeStrip. Called
   * with `undefined` on BOTH failure arms (see RunDiffTabPanel's twin).
   */
  onWorktree?: (worktree: WorktreeStatusPayload | undefined) => void;
}): ReactElement {
  const [state, setState] = useState<SessionDiffState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    // Keep the last successful snapshot on screen while refetching — the
    // rail refetches on every worktree-change event and window focus, and
    // blanking the list to "Loading diff…" on each would make a live tree
    // flicker. The placeholder shows only until the FIRST snapshot lands.
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    API.sessions.getCombinedDiff(sessionId, undefined, comparisonRef ?? undefined).then(
      (res) => {
        if (cancelled) return;
        if (!res.success) {
          setState({ diff: '', worktree: undefined, isLoading: false, error: res.error ?? 'Failed to load diff' });
          onWorktree?.(undefined);
          return;
        }
        setState({ diff: res.data.diff ?? '', worktree: res.data.worktree, isLoading: false, error: null });
        onResolvedBase?.(res.data.resolvedBase ?? null);
        onWorktree?.(res.data.worktree);
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          diff: '',
          worktree: undefined,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load diff',
        });
        onWorktree?.(undefined);
      },
    );

    return () => {
      cancelled = true;
    };
    // onResolvedBase/onWorktree are per-render callbacks from the rail; keying
    // the fetch on them would refetch on every rail render (D-8: single fetch
    // per [sessionId, comparisonRef] pair). comparisonRef IS a dep on purpose
    // — a new selection must refetch — as is refreshNonce (a post-mutation
    // refetch signal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, comparisonRef, refreshNonce]);

  if (state.isLoading && state.worktree === undefined && state.diff === '') {
    return (
      <div data-testid="session-diff-loading" className="p-4 text-sm text-text-secondary">
        Loading diff…
      </div>
    );
  }
  if (state.error) {
    return (
      <div data-testid="session-diff-error" className="p-4 text-sm text-text-secondary">
        Could not load this session's diff: {state.error}
      </div>
    );
  }

  return (
    <div data-testid="run-right-rail-session-diff" className="h-full">
      <RunDiffFileList diff={state.diff} onOpenFile={onOpenFile} groups={state.worktree} />
    </div>
  );
}
