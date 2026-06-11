/**
 * useSprintLanes — live per-task lane state for a sprint run (feat/parallel-
 * sprint, single-run lane model).
 *
 * A sprint run seeded with N tasks carries a `sprint_batches` batch whose
 * per-task `sprint_batch_tasks` rows ("lanes") are written by the sprint
 * orchestrator's subagents via the cyboflow_update_sprint_task MCP tool. This
 * hook bridges that state to the run progress rail.
 *
 * Lifecycle (mirrors useWorkflowPhaseState's subscribe-then-query pattern):
 *   1. On mount (or when runId changes to a non-null value):
 *      a. Sets isLoading=true.
 *      b. Subscribes via `trpc.cyboflow.runs.onSprintLaneChanged.subscribe`
 *         BEFORE awaiting the query so no lane events are missed.
 *      c. Fires `trpc.cyboflow.runs.sprintLanes.query({ runId })` (Promise).
 *   2. On query resolution: the snapshot becomes the base lane list; any lane
 *      that only arrived via a pre-snapshot event is kept (defensive — the DB
 *      write happens before the emit, so the snapshot normally subsumes it).
 *   3. On each subscription onData event: upserts the lane into the by-taskId
 *      list (event payloads carry no ref/title, so an event-created lane keeps
 *      those null until a fresh snapshot resolves them).
 *   4. On unmount or runId change: sets cancelled=true and unsubscribes.
 *   5. When runId === null (or the run has no batch): empty lanes, no tRPC.
 *
 * tRPC API: vanilla createTRPCProxyClient — .query() returns Promise<T>;
 * .subscribe() returns { unsubscribe(): void }. The lane row + event payload
 * types are AppRouter-inferred — never local mirrors.
 */
import { useState, useEffect } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';

// ---------------------------------------------------------------------------
// Public types — inferred from the router output, never a local mirror.
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** A lane row as returned by `cyboflow.runs.sprintLanes`. */
export type SprintLane = RouterOutputs['cyboflow']['runs']['sprintLanes'][number];

export interface UseSprintLanesResult {
  /** One row per seeded task, in lane (insertion) order. Empty when the run has no batch. */
  lanes: SprintLane[];
  isLoading: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Initial (empty) state
// ---------------------------------------------------------------------------

const INITIAL_STATE: UseSprintLanesResult = {
  lanes: [],
  isLoading: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns live lane state for the given sprint run. A non-sprint run (or a
 * sprint launched without seed tasks) yields an empty lane list.
 *
 * @param runId - The workflow_runs.id to track. Pass null to disable.
 */
export function useSprintLanes(runId: string | null): UseSprintLanesResult {
  const [snapshot, setSnapshot] = useState<UseSprintLanesResult>(INITIAL_STATE);

  useEffect(() => {
    if (runId === null) {
      // Reset to empty state; no tRPC calls.
      setSnapshot(INITIAL_STATE);
      return;
    }

    let cancelled = false;

    // Reset loading state for this runId.
    setSnapshot({ ...INITIAL_STATE, isLoading: true });

    // Subscribe BEFORE awaiting the query so no lane events are missed. The
    // onData payload type is AppRouter-inferred — do not annotate it.
    const subscription = trpc.cyboflow.runs.onSprintLaneChanged.subscribe(
      { runId },
      {
        onData: (event) => {
          if (cancelled) return;
          setSnapshot((prev) => {
            const idx = prev.lanes.findIndex((l) => l.taskId === event.taskId);
            if (idx === -1) {
              // Event arrived before the snapshot listed this lane — create a
              // bare row (ref/title/blockedByRefs resolve on the next snapshot;
              // blockedByRefs is a read-side join, so events never carry it).
              return {
                ...prev,
                lanes: [
                  ...prev.lanes,
                  {
                    batchId: event.batchId,
                    taskId: event.taskId,
                    status: event.status,
                    currentStepId: event.currentStepId,
                    ref: null,
                    title: null,
                    attempts: event.attempts,
                    blockedByRefs: [],
                    updatedAt: event.timestamp,
                  },
                ],
                error: null,
              };
            }
            const lanes = prev.lanes.slice();
            lanes[idx] = {
              ...lanes[idx],
              status: event.status,
              currentStepId: event.currentStepId,
              attempts: event.attempts,
              updatedAt: event.timestamp,
            };
            return { ...prev, lanes, error: null };
          });
        },
        onError: (err: unknown) => {
          if (cancelled) return;
          const error = err instanceof Error ? err : new Error(String(err));
          setSnapshot((prev) => ({ ...prev, error }));
        },
      },
    );

    // Fire the initial snapshot query.
    trpc.cyboflow.runs.sprintLanes.query({ runId }).then(
      (rows) => {
        if (cancelled) return;
        setSnapshot((prev) => {
          // Snapshot is the base; keep any event-only lane it does not cover
          // (defensive — lane writes hit the DB before the event is emitted).
          const seen = new Set(rows.map((r) => r.taskId));
          const extras = prev.lanes.filter((l) => !seen.has(l.taskId));
          return { lanes: [...rows, ...extras], isLoading: false, error: null };
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setSnapshot((prev) => ({ ...prev, isLoading: false, error }));
      },
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [runId]);

  return snapshot;
}
