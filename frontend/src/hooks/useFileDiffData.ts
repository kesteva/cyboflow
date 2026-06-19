/**
 * useFileDiffData — resolve a single file's parsed diff for a center-pane file
 * tab.
 *
 * Reads the run's working diff via `API.sessions.getCombinedDiff(sessionId)`
 * (all changes) and extracts the one file with `findFileDiff`. The `sessionId`
 * is the center pane's session key (the run's parent session); the file-open
 * entry point (File Explorer) only renders with a resolved session, so there is
 * no null-session window to guard here.
 *
 * Snapshot semantics: fetched on mount / when sessionId|filePath change. The file
 * tab content remounts on tab focus, so switching back re-fetches; live
 * streaming of the diff while the agent works is out of scope for this slice.
 */
import { useEffect, useState } from 'react';
import { API } from '../utils/api';
import { findFileDiff, type ParsedFileDiff } from '../utils/parseFileHunks';

export interface FileDiffData {
  loading: boolean;
  error: string | null;
  /** Null when the file has no changes in the diff (or while loading/errored). */
  fileDiff: ParsedFileDiff | null;
}

export function useFileDiffData(sessionId: string, filePath: string): FileDiffData {
  const [state, setState] = useState<FileDiffData>({ loading: true, error: null, fileDiff: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, fileDiff: null });

    API.sessions.getCombinedDiff(sessionId).then(
      (res) => {
        if (cancelled) return;
        if (!res.success || !res.data) {
          setState({ loading: false, error: res.error ?? 'Failed to load diff', fileDiff: null });
          return;
        }
        setState({ loading: false, error: null, fileDiff: findFileDiff(res.data.diff, filePath) });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load diff',
          fileDiff: null,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [sessionId, filePath]);

  return state;
}
