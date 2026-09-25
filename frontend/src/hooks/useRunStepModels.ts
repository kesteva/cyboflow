/**
 * useRunStepModels — the ONE renderer read of `runs.getStepModels` (IDEA-061's
 * per-step model data, resolved by `main/src/orchestrator/runStepModels.ts`).
 * Shared by RunCenterPane (the live canvas rail) and WorkflowSummaryPanel (the
 * post-run "Models used" section), which previously carried hand-duplicated
 * copies of the same fetch effect and queried the same run concurrently.
 *
 * Fetch semantics:
 *   - once per run id, plus ONE re-fetch each time the run's agent-target
 *     override layer changes (runAgentTargetsStore — a systemic-pause
 *     "Switch runtime & retry" or its "Revert"); no polling;
 *   - reset to `null` on a run-id change (a mounted component must never show
 *     run A's rows attributed to run B), but a same-run re-fetch keeps the
 *     previous rows until the new ones resolve (no flicker);
 *   - fail-soft: a rejected query leaves the current value (so `null` on a
 *     first-load failure) — consumers render without model data;
 *   - concurrent callers for the same (run, version) share one in-flight
 *     request.
 *
 * It is a SNAPSHOT: the spawn seam re-resolves each step's agent at spawn, so a
 * project/workflow agent config edited mid-run from another surface is not
 * reflected until the next fetch (see runAgentTargetsStore's "NOT covered").
 */
import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useRunAgentTargetsVersion } from '../stores/runAgentTargetsStore';
import { stepModelKey, type ModelFamily } from '../../../shared/types/agents';

/**
 * One flattened step's resolved model, inferred off the tRPC client rather than
 * imported from `main/src/orchestrator/*` (the frontend tsconfig only includes
 * `src` and `../shared`).
 */
export type StepModelRow = Awaited<ReturnType<typeof trpc.cyboflow.runs.getStepModels.query>>[number];

/** What a step card needs to paint its model segment. */
export interface StepModelEntry {
  label: string;
  family: ModelFamily;
}

/** Rows indexed by {@link stepModelKey}(phaseId, stepId). */
export type StepModelMap = ReadonlyMap<string, StepModelEntry>;

const inFlight = new Map<string, Promise<StepModelRow[]>>();

function fetchStepModels(runId: string, version: number): Promise<StepModelRow[]> {
  const key = `${runId}#${version}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  let started: Promise<StepModelRow[]>;
  try {
    // Promise.resolve: a synchronous throw (or a non-promise return) from the
    // client still lands on the fail-soft `.catch` path instead of the render.
    started = Promise.resolve(trpc.cyboflow.runs.getStepModels.query({ runId }));
  } catch (err) {
    started = Promise.reject(err);
  }
  const p = started.finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** Index rows by `(phaseId, stepId)` for the step cards. */
export function indexStepModels(rows: readonly StepModelRow[]): StepModelMap {
  return new Map(rows.map((r) => [stepModelKey(r.phaseId, r.stepId), { label: r.label, family: r.family }]));
}

export function useRunStepModels(runId: string): StepModelRow[] | null {
  const [rows, setRows] = useState<StepModelRow[] | null>(null);
  // Mirrors `rows` for the resolve callback (which must not re-subscribe).
  const rowsRef = useRef<StepModelRow[] | null>(null);
  const version = useRunAgentTargetsVersion(runId);
  const runRef = useRef<string | null>(null);
  useEffect(() => {
    if (runRef.current !== runId) {
      runRef.current = runId;
      rowsRef.current = null;
      setRows(null);
    }
    let alive = true;
    fetchStepModels(runId, version)
      .then((r) => {
        if (!alive) return;
        // No data on first load renders exactly like "not loaded" (every
        // consumer treats null and [] alike), so skip the no-op state update
        // and its re-render.
        if (r.length === 0 && rowsRef.current === null) return;
        rowsRef.current = r;
        setRows(r);
      })
      .catch(() => {
        // Fail-soft: consumers simply render without model data.
      });
    return () => {
      alive = false;
    };
  }, [runId, version]);
  return rows;
}
