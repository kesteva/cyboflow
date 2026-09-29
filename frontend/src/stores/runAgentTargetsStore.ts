/**
 * runAgentTargetsStore — a per-run change counter for the run-scoped
 * agent-target overrides (`workflow_runs.agent_target_overrides_json`,
 * migration 144 — the layer a systemic-pause "Switch runtime & retry" writes
 * and its "Revert" clears).
 *
 * WHY A RENDERER-SIDE COUNTER. Two surfaces read that layer indirectly:
 * {@link AgentTargetOverridesChip} (the "Agents switched: …" notice) and the
 * per-step model rail on the workflow canvas (`runs.getStepModels`, resolved
 * through the same effective-agent layering, fetched ONCE per run id by
 * RunCenterPane). The ONLY writers are the two renderer-initiated mutations
 * `runs.switchPausedStepAgents` and `runs.clearRunAgentTargets` (the monitor's
 * switch action was deliberately cut — it runs on Claude and cannot execute
 * under a Claude limit), so a main-process subscription seam would carry
 * nothing the renderer did not already know. Each writer bumps this counter
 * after its mutation resolves; readers key their re-fetch on it.
 *
 * NOT covered (documented, not papered over): a project- or workflow-scoped
 * agent config edited MID-RUN from another surface still changes what later
 * steps spawn on without refreshing the rail — that is a different write path
 * with no renderer-side signal yet.
 *
 * IN-MEMORY, keyed by run id; a fresh load re-fetches everything anyway.
 */
import { create } from 'zustand';

interface RunAgentTargetsStore {
  /** Monotonic per-run change counter; absent ⇒ 0. */
  versionByRun: Record<string, number>;
  /** Record that `runId`'s override layer changed (a switch or a revert landed). */
  bump: (runId: string) => void;
}

export const useRunAgentTargetsStore = create<RunAgentTargetsStore>((set) => ({
  versionByRun: {},
  bump: (runId) =>
    set((s) => ({ versionByRun: { ...s.versionByRun, [runId]: (s.versionByRun[runId] ?? 0) + 1 } })),
}));

/** Reactive selector: how many times `runId`'s override layer has changed this app session. */
export function useRunAgentTargetsVersion(runId: string | null): number {
  return useRunAgentTargetsStore((s) => (runId !== null ? (s.versionByRun[runId] ?? 0) : 0));
}
