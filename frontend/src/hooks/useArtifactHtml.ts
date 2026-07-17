/**
 * useArtifactHtml — resolve the on-disk static HTML body for a `ui-prototype`
 * (Approach C — self-contained static mockup) or a committed canvas artifact.
 *
 * Given a run id + the canvas atype + its commit state, this calls the
 * `artifacts:load-html` IPC channel (registered in main/src/index.ts, exposed in
 * preload as window.electronAPI.artifacts.loadHtml) and returns the document
 * string (with a restrictive CSP <meta> already spliced in by the main handler)
 * plus loading/error state. The renderer embeds the returned string via
 * `<iframe srcDoc>` with a BARE `sandbox=""` (no scripts, no same-origin).
 *
 * Source contract (main handler, dual-sourced): the canonical
 * `prototype/index.html` is read from the run's artifacts subtree first, else
 * the committed project snapshot store; a missing/unreadable file fail-softs to
 * `html: null` (NOT an error), which the renderer surfaces as an explicit empty
 * state rather than a blank iframe.
 *
 * Short-circuit (NO IPC): the CALLER decides whether on-disk HTML is possible and
 * passes `enabled`. It is true when the artifact has a `fileName` pointer OR is a
 * committed canvas with no `url` (its snapshot / preserved subtree may hold
 * `prototype/index.html`); a url-only live canvas passes `enabled=false` and
 * short-circuits to a resolved `html: null` with no round-trip. A null/empty
 * runId does the same.
 *
 * Mirrors {@link useArtifactImages}: reaches the typed `window.electronAPI`
 * surface (declared in frontend/src/types/electron.d.ts) — no cast, no `any`,
 * no local IPCResponse re-declare (imported from utils/api.ts). In-flight
 * results are dropped on unmount / when the [runId, atype, enabled] inputs change.
 */
import { useEffect, useState } from 'react';
import type { IPCResponse } from '../utils/api';
import type { LoadArtifactHtmlAtype, LoadArtifactHtmlResult } from '../../../shared/types/artifacts';

export interface UseArtifactHtml {
  /** The static mockup document (CSP <meta> injected), or null when absent/unreadable. */
  html: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Reach the `artifacts.loadHtml` channel through the typed `window.electronAPI`
 * surface — no cast, no `any`.
 */
function getApi(): Window['electronAPI'] | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI ?? null;
}

export function useArtifactHtml(
  runId: string,
  atype: LoadArtifactHtmlAtype,
  enabled: boolean,
): UseArtifactHtml {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Caller says on-disk HTML isn't possible (url-only canvas) → resolved null.
    if (!runId || !enabled) {
      setHtml(null);
      setLoading(false);
      setError(null);
      return;
    }

    const api = getApi();
    if (!api) {
      setHtml(null);
      setLoading(false);
      setError('Electron API not available');
      return;
    }

    setLoading(true);
    setError(null);

    api.artifacts.loadHtml({ runId, atype }).then(
      (res: IPCResponse<LoadArtifactHtmlResult>) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setHtml(res.data.html);
          setError(null);
        } else {
          setHtml(null);
          setError(res.error ?? 'Failed to load prototype.');
        }
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setHtml(null);
        setError(err instanceof Error ? err.message : 'Failed to load prototype.');
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runId, atype, enabled]);

  return { html, loading, error };
}
