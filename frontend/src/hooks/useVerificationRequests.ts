/**
 * useVerificationRequests — live list of a project's verification requests
 * (L6 Verify-Queue panel, S7).
 *
 * Seeds from `trpc.cyboflow.verificationRequests.list({ projectId, runId?,
 * status? })` and stays live by POLLING that same query on a fixed interval
 * (default 2.5s). A dedicated live tRPC subscription is OUT OF SCOPE for this
 * observability panel (S7 seam decision) — polling keeps the queue fresh without
 * a new subscription channel.
 *
 * The query return type is AppRouter-inferred (VerificationRequestRow[]) — never
 * a local mirror or `unknown` + shape guard (CLAUDE.md hard rule). Returns `[]`
 * until `projectId` is non-null; the effect re-seeds + re-polls when any of
 * `projectId` / `runId` / `status` / `refetchIntervalMs` changes, and clears the
 * interval on unmount / dep change.
 */
import { useEffect, useState } from 'react';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;

/** A verification-request row as returned by `cyboflow.verificationRequests.list`. */
export type VerificationRequest =
  RouterOutputs['cyboflow']['verificationRequests']['list'][number];

/** The optional status filter accepted by the list query (a RequestStatus member). */
export type VerificationRequestStatusFilter = NonNullable<
  RouterInputs['cyboflow']['verificationRequests']['list']['status']
>;

export interface UseVerificationRequestsArgs {
  /** Project to list verify requests for. `null` disables the hook (returns []). */
  projectId: number | null;
  /** Optional run-scoped narrowing. */
  runId?: string;
  /** Optional lifecycle-status narrowing. */
  status?: VerificationRequestStatusFilter;
  /** Poll interval in ms (default 2500). */
  refetchIntervalMs?: number;
}

export interface UseVerificationRequestsResult {
  requests: VerificationRequest[];
  /** True only until the FIRST seed resolves (subsequent polls do not flip it). */
  isLoading: boolean;
  error: Error | null;
}

const DEFAULT_REFETCH_INTERVAL_MS = 2500;

export function useVerificationRequests({
  projectId,
  runId,
  status,
  refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
}: UseVerificationRequestsArgs): UseVerificationRequestsResult {
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (projectId === null) {
      setRequests([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    // `cancelled` guards async fetches from landing after a dep change/unmount.
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const fetchOnce = (firstLoad: boolean): void => {
      void trpc.cyboflow.verificationRequests.list
        .query({
          projectId,
          ...(runId !== undefined ? { runId } : {}),
          ...(status !== undefined ? { status } : {}),
        })
        .then((rows) => {
          if (cancelled) return;
          setRequests(rows);
          setError(null);
          if (firstLoad) setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          if (firstLoad) setIsLoading(false);
        });
    };

    // Seed immediately, then poll on the interval.
    fetchOnce(true);
    const timer = setInterval(() => fetchOnce(false), refetchIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, runId, status, refetchIntervalMs]);

  return { requests, isLoading, error };
}
