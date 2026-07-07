/**
 * useWorkflowPhaseState — bridges tRPC phase state to WorkflowCanvas.
 *
 * Lifecycle:
 *   1. On mount (or when runId changes to a non-null value):
 *      a. Sets isLoading=true.
 *      b. Fires `trpc.cyboflow.runs.getPhaseState.query({ runId })` (Promise).
 *      c. Immediately after kicking off the query (without awaiting), subscribes
 *         via `trpc.cyboflow.runs.onStepTransition.subscribe({ runId }, callbacks)`.
 *   2. On query resolution: merges definition/currentStepId/stepStates into state
 *      and clears isLoading.
 *   3. On each subscription onData event: applies mergeTransition() delta to state.
 *   4. On unmount or runId change: sets cancelled=true and calls
 *      subscription.unsubscribe() to prevent stale updates.
 *   5. When runId === null: resets to initial empty state without calling tRPC.
 *
 * tRPC API: vanilla createTRPCProxyClient (NOT @trpc/react-query) — .query()
 * returns Promise<T>; .subscribe() returns { unsubscribe(): void }.
 *
 * TASK-771 / IDEA-026
 */
import { useState, useEffect } from 'react';
import { trpc } from '../trpc/client';
import type { WorkflowDefinition, WorkflowStepState } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseWorkflowPhaseStateResult {
  definition: WorkflowDefinition | null;
  currentStepId: string | null;
  stepStates: WorkflowStepState[];
  isLoading: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Initial (empty) state
// ---------------------------------------------------------------------------

const INITIAL_STATE: UseWorkflowPhaseStateResult = {
  definition: null,
  currentStepId: null,
  stepStates: [],
  isLoading: false,
  error: null,
};

// ---------------------------------------------------------------------------
// mergeTransition — pure delta-merge function
// ---------------------------------------------------------------------------

/**
 * Merges a WorkflowStepTransitionEvent delta into the current snapshot.
 *
 * Ordering rules (applied to flat step order across all phases), MARKER-PRESERVING:
 *   - Bare run-level 'done' event: every step → 'done', EXCEPT steps already
 *     carrying a terminal 'failed'/'skipped' marker (those are preserved).
 *   - Positional event (status 'running'/'failed'/'skipped') at flat index idx:
 *       · step at idx        → event.status
 *       · steps AFTER idx     → 'pending'
 *       · steps BEFORE idx    → keep an existing 'failed'/'skipped' marker, else 'done'
 *
 * Rationale for marker preservation: after an optional-step SKIP the walk CONTINUES,
 * so the next step's 'running' event must NOT bleach the earlier skip marker back to
 * 'done'. A RETRY re-runs AT the marked step's OWN idx, so its 'running' event lands
 * on i === idx and correctly clears that step's stale marker (the marker only survives
 * as a "before" step, never as the event's own step).
 *
 * Returns prev unchanged if:
 *   - prev.definition is null (race protection — query hasn't resolved yet)
 *   - event.stepId is not found in the definition (defensive guard)
 */
function mergeTransition(
  prev: UseWorkflowPhaseStateResult,
  event: { stepId: string; status: WorkflowStepState['status'] },
): UseWorkflowPhaseStateResult {
  if (prev.definition === null) {
    // Query hasn't resolved yet — drop this event.
    return prev;
  }

  const orderedIds = prev.definition.phases.flatMap((p) => p.steps).map((s) => s.id);
  const idx = orderedIds.indexOf(event.stepId);

  if (idx === -1) {
    // Unknown stepId — defensive guard.
    return prev;
  }

  // Prior status per step id, so terminal markers ('failed'/'skipped') already
  // recorded on a step survive a later positional event landing past them.
  const prevStatusById = new Map(prev.stepStates.map((s) => [s.stepId, s.status]));
  const markerOrDone = (stepId: string): WorkflowStepState['status'] => {
    const prior = prevStatusById.get(stepId);
    return prior === 'failed' || prior === 'skipped' ? prior : 'done';
  };

  const newStates: WorkflowStepState[] = orderedIds.map((stepId, i) => {
    let status: WorkflowStepState['status'];
    if (event.status === 'done') {
      // Run-level all-done: keep terminal markers, everything else → 'done'.
      status = markerOrDone(stepId);
    } else if (i < idx) {
      status = markerOrDone(stepId);
    } else if (i === idx) {
      status = event.status;
    } else {
      status = 'pending';
    }
    return { stepId, status };
  });

  return {
    ...prev,
    currentStepId: event.stepId,
    stepStates: newStates,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns live phase state for the given workflow run.
 *
 * When `runId` is null, returns the initial empty state immediately without
 * invoking any tRPC procedures.
 *
 * @param runId - The workflow_runs.id to track. Pass null to disable.
 */
export function useWorkflowPhaseState(runId: string | null): UseWorkflowPhaseStateResult {
  const [snapshot, setSnapshot] = useState<UseWorkflowPhaseStateResult>(INITIAL_STATE);

  useEffect(() => {
    if (runId === null) {
      // Reset to empty state; no tRPC calls.
      setSnapshot(INITIAL_STATE);
      return;
    }

    let cancelled = false;

    // Reset loading state for this runId.
    setSnapshot({ ...INITIAL_STATE, isLoading: true });

    // Subscribe BEFORE awaiting the query so no transition events are missed.
    const subscription = trpc.cyboflow.runs.onStepTransition.subscribe(
      { runId },
      {
        onData: (event) => {
          if (cancelled) return;
          setSnapshot((prev) => mergeTransition(prev, event));
        },
        onError: (err: unknown) => {
          if (cancelled) return;
          const error = err instanceof Error ? err : new Error(String(err));
          setSnapshot((prev) => ({ ...prev, error }));
        },
      },
    );

    // Fire the initial state query.
    trpc.cyboflow.runs.getPhaseState.query({ runId }).then(
      (result) => {
        if (cancelled) return;
        setSnapshot({
          definition: result.definition,
          currentStepId: result.currentStepId,
          stepStates: result.stepStates,
          isLoading: false,
          error: null,
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
