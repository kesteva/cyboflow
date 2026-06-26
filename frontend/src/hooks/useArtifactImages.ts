/**
 * useArtifactImages — resolve on-disk screenshot bytes for the artifact gallery
 * (FU4, display half).
 *
 * Given a run id + the basenames the producer reported on a 'screenshots'
 * artifact's `payload.fileNames`, this calls the `artifacts:load-images` IPC
 * channel (registered in main/src/index.ts, exposed in preload as
 * window.electronAPI.artifacts.loadImages) and returns a basename -> data URL
 * map plus loading/error state. The main handler path-validates each fileName
 * against the run's image root and fail-softs per file, so a missing/oversized
 * file simply has no entry in the map (the renderer shows a per-card fallback).
 *
 * PRODUCER CONVENTION (capture is environmental / out of scope): a visual-verifier
 * agent writes PNGs under CYBOFLOW_DIR/artifacts/runs/<runId>/ and reports a
 * 'screenshots' artifact (via the cyboflow_report_artifact MCP tool) whose
 * payload.fileNames are those files' BASENAMES — see main/src/ipc/artifactImages.ts.
 *
 * Empty input (no fileNames) short-circuits to a resolved empty map with no IPC
 * call; in-flight results are dropped on unmount / when the inputs change.
 */
import { useEffect, useState } from 'react';
export interface UseArtifactImages {
  /** basename -> data: URL for every file that resolved on disk. */
  images: Record<string, string>;
  loading: boolean;
  error: string | null;
}

/**
 * Reach the `artifacts.loadImages` channel through the typed `window.electronAPI`
 * surface (declared in frontend/src/types/electron.d.ts) — no cast, no `any`,
 * no local IPCResponse re-declare (it is imported from utils/api.ts).
 */
function getApi(): Window['electronAPI'] | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI ?? null;
}

export function useArtifactImages(runId: string, fileNames: string[]): UseArtifactImages {
  const [images, setImages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-run when the run id or the set of requested files changes. Keying on the
  // joined names (not the array identity) avoids a refetch loop on every render.
  const fileKey = fileNames.join('|');

  useEffect(() => {
    let cancelled = false;

    // Empty input → resolved empty map, no IPC round-trip.
    if (!runId || fileNames.length === 0) {
      setImages({});
      setLoading(false);
      setError(null);
      return;
    }

    const api = getApi();
    if (!api) {
      setImages({});
      setLoading(false);
      setError('Electron API not available');
      return;
    }

    setLoading(true);
    setError(null);

    api.artifacts.loadImages({ runId, fileNames }).then(
      (res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          const map: Record<string, string> = {};
          for (const img of res.data.images) {
            map[img.fileName] = img.dataUrl;
          }
          setImages(map);
          setError(null);
        } else {
          setImages({});
          setError(res.error ?? 'Failed to load screenshots.');
        }
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setImages({});
        setError(err instanceof Error ? err.message : 'Failed to load screenshots.');
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
    // fileNames is captured via fileKey; runId drives the per-run root.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, fileKey]);

  return { images, loading, error };
}
