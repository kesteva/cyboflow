/**
 * useFileContentData — read a single file's text content for a center-pane file
 * tab when it has NO diff to show.
 *
 * The file tab shows a diff when the file changed in the run's working tree
 * (useFileDiffData). When it didn't — an unchanged file the user opened from the
 * File Explorer — there is nothing to diff, so the tab falls back to the plain
 * file contents fetched here via `cyboflow.files.read` (session-scoped: the
 * center pane's session key resolves the worktree). This is the same read the
 * File Explorer's takeover viewer uses, so binary / too-large files surface the
 * same `unviewableReason`.
 *
 * Snapshot semantics mirror useFileDiffData: fetched on mount / when
 * sessionId|filePath change, with a `cancelled` guard. The hook is only mounted
 * once the diff resolves to "no diff", so files that DO have a diff never pay
 * this read.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { RunFileContent } from '../../../shared/types/runFiles';

export interface FileContentData {
  loading: boolean;
  error: string | null;
  content: RunFileContent | null;
}

export function useFileContentData(sessionId: string, filePath: string): FileContentData {
  const [state, setState] = useState<FileContentData>({ loading: true, error: null, content: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, content: null });

    trpc.cyboflow.files.read.query({ sessionId, path: filePath }).then(
      (content) => {
        if (cancelled) return;
        setState({ loading: false, error: null, content });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load file',
          content: null,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [sessionId, filePath]);

  return state;
}
