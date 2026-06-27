/**
 * SessionDiffTabPanel — the session-scoped Diff tab body in RunRightRail.
 *
 * The at-rest twin of RunDiffTabPanel: a selected session (quick / session-hosted,
 * no active run) has a real `sessions` row, so its working diff comes from the
 * session-scoped `API.sessions.getCombinedDiff(sessionId)` path. Like the run
 * panel it renders the flat RunDiffFileList — clicking a file opens it in the
 * center pane (Diff / Split / Preview).
 *
 * Snapshot fetch: an effect keyed by sessionId with a `cancelled` guard.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { API } from '../../utils/api';
import { RunDiffFileList } from './RunDiffFileList';

interface SessionDiffState {
  diff: string;
  isLoading: boolean;
  error: string | null;
}

const INITIAL_STATE: SessionDiffState = { diff: '', isLoading: false, error: null };

export function SessionDiffTabPanel({
  sessionId,
  onOpenFile,
}: {
  sessionId: string;
  /** Forwarded to RunDiffFileList — click a file row to open it. */
  onOpenFile?: (filePath: string) => void;
}): ReactElement {
  const [state, setState] = useState<SessionDiffState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    setState({ ...INITIAL_STATE, isLoading: true });

    API.sessions.getCombinedDiff(sessionId).then(
      (res) => {
        if (cancelled) return;
        if (!res.success || !res.data) {
          setState({ diff: '', isLoading: false, error: res.error ?? 'Failed to load diff' });
          return;
        }
        setState({ diff: res.data.diff ?? '', isLoading: false, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          diff: '',
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load diff',
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.isLoading) {
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
      <RunDiffFileList diff={state.diff} onOpenFile={onOpenFile} />
    </div>
  );
}
