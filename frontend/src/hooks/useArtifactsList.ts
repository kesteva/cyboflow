/**
 * useArtifactsList — live list of a run's artifacts (deliverables).
 *
 * Seeds from `trpc.cyboflow.artifacts.list({ runId })` and stays reactive via
 * the project-scoped `trpc.cyboflow.artifacts.onArtifactChanged` subscription:
 *   - created / updated / committed → upsert the carried `event.artifact`
 *   - deleted                       → remove `event.artifactId`
 *
 * The subscription is project-scoped (every run in the project shares one
 * channel), so events are filtered to the current run on upsert. Returns `[]`
 * until BOTH `runId` and `projectId` are non-null; the effect re-seeds and
 * re-subscribes when either changes, and cleans up on unmount / dep change.
 *
 * Backs the right-rail Artifacts panel (the reopen surface) and the M5 artifact
 * tab renderer; the durable source of truth is the artifacts DB table.
 *
 * onData payload is AppRouter-inferred (ArtifactChangedEvent) — written as
 * `onData: (event) => …`. NEVER a local event type or `unknown` + shape guard
 * (CLAUDE.md hard rule).
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { Artifact } from '../../../shared/types/artifacts';

export interface UseArtifactsListResult {
  artifacts: Artifact[];
}

/** Upsert by id (replace existing, else append) — keeps created_at ordering stable. */
function upsert(list: Artifact[], next: Artifact): Artifact[] {
  const idx = list.findIndex((a) => a.id === next.id);
  if (idx === -1) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function useArtifactsList(
  runId: string | null,
  projectId: number | null,
): UseArtifactsListResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    // Nothing to track until both the run and its project are known.
    if (runId === null || projectId === null) {
      setArtifacts([]);
      return;
    }

    // `cancelled` guards the async seed from landing after a dep change/unmount.
    let cancelled = false;
    // Reset so a stale list never flashes while the new seed is in flight.
    setArtifacts([]);

    void trpc.cyboflow.artifacts.list
      .query({ runId })
      .then((rows) => {
        if (!cancelled) setArtifacts(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn('[useArtifactsList] initial list failed:', err);
      });

    // Project-scoped change stream. Payload type is inferred from AppRouter
    // (ArtifactChangedEvent) — never a local mirror or `unknown` + guard.
    const sub = trpc.cyboflow.artifacts.onArtifactChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          // The channel carries every run in the project; ignore other runs.
          if (event.runId !== runId) return;
          if (event.action === 'deleted') {
            setArtifacts((prev) => prev.filter((a) => a.id !== event.artifactId));
            return;
          }
          // created / updated / committed all carry the shaped artifact.
          if (event.artifact !== null) {
            const next = event.artifact;
            setArtifacts((prev) => upsert(prev, next));
          }
        },
        onError: (err: unknown) =>
          console.warn('[useArtifactsList] onArtifactChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [runId, projectId]);

  return { artifacts };
}
