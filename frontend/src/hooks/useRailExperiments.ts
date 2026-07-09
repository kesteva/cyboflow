/**
 * useRailExperiments — per-project A/B experiment data for the sidebar group rows.
 *
 * The rail groups an experiment's two arm sessions under one parent row (see
 * railExperimentGrouping). To do that it needs, per visible project:
 *   - experiments.listForProject  → ExperimentRow[]  (status, arms, winner, sessions)
 *   - experiments.listForDashboard → ExperimentSummary[] (armALabel/armBLabel +
 *     verdictPreference, used for the display name + the 'verdict ready' pill)
 *
 * ## Reactivity (few rows, so a lightweight refetch is fine)
 *   1. Mount / tracked-project-set change → fetch every tracked project.
 *   2. A project's active-run rows change (useActiveRunsStore.runsByProject) →
 *      refetch just that project. Run status transitions (running → grading →
 *      decided) are what flip a group's arms + pill, and those ride run-lifecycle
 *      refreshes of activeRunsStore, so keying off its per-project run signature
 *      keeps the group state live without a bespoke experiments subscription.
 *   3. experiments.onComparisonReady fires when a pairwise verdict lands →
 *      refetch the project that owns that experiment (else all tracked) so the
 *      pill flips to 'verdict ready' live even before the run status moves.
 *
 * Every read is advisory: a failed fetch logs + leaves prior state untouched
 * (mirrors activeRunsStore.refresh), never surfacing an error banner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import type { ExperimentRow, ExperimentSummary } from '../../../shared/types/experiments';
import { useActiveRunsStore } from '../stores/activeRunsStore';

/** Per-project experiments payload consumed by the grouping helper. */
export interface RailExperimentData {
  experiments: ExperimentRow[];
  summariesById: Record<string, ExperimentSummary>;
}

export interface UseRailExperimentsResult {
  /** Experiments + summaries keyed by projectId. Missing until first fetch resolves. */
  byProject: Record<number, RailExperimentData>;
  /** Force a refetch for one project (e.g. after abandoning an experiment). */
  refetch: (projectId: number) => void;
}

/** Signature of a project's active-run rows — changes drive an experiments refetch. */
function runsSignature(rows: { id: string; status: string; experiment_id?: string | null }[] | undefined): string {
  if (!rows) return '';
  return rows.map((r) => `${r.id}|${r.status}|${r.experiment_id ?? ''}`).join(';');
}

/**
 * @param projectIds The projects currently visible in the rail (usually every
 *   project). Grouping only reads entries for the projects it renders, so passing
 *   all of them is fine.
 */
export function useRailExperiments(projectIds: number[]): UseRailExperimentsResult {
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const [byProject, setByProject] = useState<Record<number, RailExperimentData>>({});

  // Stable dependency key for the tracked-project set.
  const projectsKey = [...projectIds].sort((a, b) => a - b).join(',');

  // Latest project list, read by the mount-once subscription callback.
  const projectIdsRef = useRef<number[]>(projectIds);
  projectIdsRef.current = projectIds;

  const fetchProject = useCallback(async (projectId: number): Promise<void> => {
    // The experiments router is always fully present in the real app; guard on the
    // specific methods so a PARTIAL tRPC stub (a component test that renders the
    // rail without its own experiments mock) is a silent no-op rather than a crash.
    const api = trpc.cyboflow.experiments;
    if (!api?.listForProject || !api?.listForDashboard) return;
    try {
      const [experiments, summaries] = await Promise.all([
        api.listForProject.query({ projectId }),
        api.listForDashboard.query({ projectId }),
      ]);
      const summariesById: Record<string, ExperimentSummary> = {};
      for (const s of summaries) summariesById[s.experimentId] = s;
      setByProject((prev) => ({ ...prev, [projectId]: { experiments, summariesById } }));
    } catch (err: unknown) {
      console.warn('[useRailExperiments] fetch failed for project', projectId, err);
    }
  }, []);

  // Per-project run signatures, so the runsByProject effect only refetches the
  // project(s) whose run rows actually changed (not every project on any change).
  const runSigRef = useRef<Record<number, string>>({});

  // (1) Mount + tracked-project-set change → fetch all; seed the run signatures so
  //     the runsByProject effect below does not immediately double-fetch.
  useEffect(() => {
    for (const pid of projectIdsRef.current) {
      runSigRef.current[pid] = runsSignature(useActiveRunsStore.getState().runsByProject[pid]);
      void fetchProject(pid);
    }
    // projectsKey captures the tracked set; projectIdsRef holds the concrete ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsKey, fetchProject]);

  // (2) A tracked project's active-run rows changed → refetch just that project.
  useEffect(() => {
    for (const pid of projectIdsRef.current) {
      const sig = runsSignature(runsByProject[pid]);
      if (runSigRef.current[pid] !== sig) {
        runSigRef.current[pid] = sig;
        void fetchProject(pid);
      }
    }
  }, [runsByProject, projectsKey, fetchProject]);

  // (3) Live pairwise-verdict stream → refetch the owning project (else all).
  useEffect(() => {
    // Same guard as fetchProject: skip when the subscription method is absent
    // (partial test stub) so the effect never throws while wiring up the stream.
    const onComparisonReady = trpc.cyboflow.experiments?.onComparisonReady;
    if (!onComparisonReady) return;
    const sub = onComparisonReady.subscribe(undefined, {
      onData: (event) => {
        const tracked = projectIdsRef.current;
        const owner = tracked.find((pid) =>
          byProjectRef.current[pid]?.experiments.some((e) => e.id === event.experimentId),
        );
        if (owner !== undefined) {
          void fetchProject(owner);
        } else {
          for (const pid of tracked) void fetchProject(pid);
        }
      },
      onError: (err: unknown) => console.warn('[useRailExperiments] onComparisonReady error:', err),
    });
    return () => sub.unsubscribe();
  }, [fetchProject]);

  // Latest byProject, read (non-reactively) by the subscription callback so it can
  // resolve which project owns the ready experiment without re-subscribing.
  const byProjectRef = useRef<Record<number, RailExperimentData>>(byProject);
  byProjectRef.current = byProject;

  return { byProject, refetch: fetchProject };
}
