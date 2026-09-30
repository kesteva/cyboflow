/**
 * useSystemSnapshot — live System-view snapshot (processes, worktrees + disk
 * tri-state, ports/sockets) for one project.
 *
 * Seeds from `trpc.cyboflow.system.snapshot({ projectId })` and stays live by
 * POLLING that same query on a fixed interval (default 2.5s), mirroring
 * useVerificationRequests. One `snapshot` call is one `ps` scan plus lazily
 * queued `du` measurements server-side, so the poll is only cheap while the
 * caller keeps it gated: pass `enabled: false` while the System view is not
 * visible and the hook is inert (no query, no timer, state reset).
 *
 * The return type is AppRouter-inferred (never a local mirror). `generatedAt`
 * changes on every server call, so the content-equal compare ignores it —
 * otherwise no poll would ever look unchanged and every tick would re-render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** The aggregated snapshot as returned by `cyboflow.system.snapshot`. */
export type SystemSnapshotData = RouterOutputs['cyboflow']['system']['snapshot'];

export interface UseSystemSnapshotArgs {
  /** Project whose worktree registry to reconcile. `null` disables the hook. */
  projectId: number | null;
  /** Poll interval in ms (default 2500). */
  refetchIntervalMs?: number;
  /** When false the hook is inert: no query, no timer, `snapshot` is null (default true). */
  enabled?: boolean;
}

export interface UseSystemSnapshotResult {
  snapshot: SystemSnapshotData | null;
  /** True only until the FIRST seed resolves (subsequent polls do not flip it). */
  isLoading: boolean;
  error: Error | null;
  /** Fetch now (out of band of the poll timer). No-op while the hook is inert. */
  refetch: () => void;
  /**
   * Wall-clock ms of the last SUCCESSFUL fetch (null before the first). Bumped
   * even when the content-equal dedupe keeps the previous snapshot object, so a
   * relative "Updated Ns ago" can't be frozen by `generatedAt`.
   */
  lastUpdatedAt: number | null;
}

const DEFAULT_REFETCH_INTERVAL_MS = 2500;

/**
 * Content-equal compare that ignores the per-call `generatedAt` stamp. The
 * payload is JSON-safe (it crosses tRPC), so a stringify compare of the rest is
 * exact and far cheaper than a hand-rolled deep compare of the nested shape.
 */
function snapshotEqual(a: SystemSnapshotData, b: SystemSnapshotData): boolean {
  if (a === b) return true;
  return JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
}

export function useSystemSnapshot({
  projectId,
  refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
  enabled = true,
}: UseSystemSnapshotArgs): UseSystemSnapshotResult {
  const [snapshot, setSnapshot] = useState<SystemSnapshotData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // Points at the live effect's fetcher; null while the hook is inert.
  const fetchRef = useRef<((firstLoad: boolean) => void) | null>(null);

  useEffect(() => {
    if (projectId === null || !enabled) {
      fetchRef.current = null;
      setSnapshot(null);
      setIsLoading(false);
      setError(null);
      setLastUpdatedAt(null);
      return;
    }

    // `cancelled` guards async fetches from landing after a dep change/unmount.
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const fetchOnce = (firstLoad: boolean): void => {
      void trpc.cyboflow.system.snapshot
        .query({ projectId })
        .then((next) => {
          if (cancelled) return;
          setSnapshot((prev) => (prev !== null && snapshotEqual(prev, next) ? prev : next));
          setLastUpdatedAt(Date.now());
          setError(null);
          if (firstLoad) setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          if (firstLoad) setIsLoading(false);
        });
    };
    fetchRef.current = fetchOnce;

    // Seed immediately, then poll on the interval.
    fetchOnce(true);
    const timer = setInterval(() => fetchOnce(false), refetchIntervalMs);

    return () => {
      cancelled = true;
      fetchRef.current = null;
      clearInterval(timer);
    };
  }, [projectId, refetchIntervalMs, enabled]);

  const refetch = useCallback((): void => {
    fetchRef.current?.(false);
  }, []);

  return { snapshot, isLoading, error, refetch, lastUpdatedAt };
}
