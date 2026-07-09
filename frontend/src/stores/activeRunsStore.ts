/**
 * activeRunsStore — Zustand slice that surfaces ACTIVE workflow runs in the rail.
 *
 * Workflow runs live in the `workflow_runs` table and do NOT create `sessions`
 * rows, so they are invisible to the session-store-driven rail. This store fills
 * that gap: it lists workflow runs per project and exposes only the ACTIVE ones
 * (anything that is not terminal — see {@link TERMINAL_RUN_STATUSES}) so an
 * in-flight run (e.g. a "planner" run) stays reachable from the sidebar.
 *
 * ## Data source (reused, not new)
 *   - `trpc.cyboflow.runs.list({ projectId })`      → WorkflowRunListRow[]
 *   - `trpc.cyboflow.workflows.list({ projectId })` → WorkflowRow[] (id → name)
 * The workflows list resolves each run's `workflow_id` to a human display name
 * and lets us drop the `__quick__` sentinel runs (those are already shown as
 * quick sessions — never double-list them).
 *
 * ## Reactivity strategy
 * There is no single project-wide "run status changed" tRPC subscription. We
 * reuse the existing GLOBAL lifecycle subscriptions as invalidation signals and
 * re-fetch on each:
 *   - `cyboflow.events.onStuckDetected`     (run → stuck)
 *   - `cyboflow.events.onApprovalCreated`   (run → awaiting_review via a gate)
 *   - `cyboflow.events.onApprovalDecided`   (review resolved / run advances)
 *   - `cyboflow.events.onRunStatusChanged`  (any executor lifecycle transition —
 *       crucially the clean-drain REST to awaiting_review, which creates NO
 *       approval row and so fired none of the events above, leaving a finished
 *       run's action bar disabled. See RunStatusChangedEvent.)
 * Run start and run completion are also picked up by an explicit `refresh()`
 * call from `cyboflowStore.setActiveRun` (start) and from the rail's own
 * project-expand effect. This avoids inventing a polling loop.
 *
 * ## Filtering
 *   - Terminal statuses (completed / failed / canceled) are excluded.
 *   - `__quick__` sentinel-workflow runs are excluded (quick sessions own those).
 */
import { create } from 'zustand';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';
import type { ExperimentArm } from '../../../shared/types/experiments';
import { useCyboflowStore } from './cyboflowStore';

// ---------------------------------------------------------------------------
// Types inferred from the router output — never a local mirror.
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
type WorkflowRunListRow = RouterOutputs['cyboflow']['runs']['list'][number];
type WorkflowRow = RouterOutputs['cyboflow']['workflows']['list'][number];

/** The internal `__quick__` sentinel workflow name (see migration 012). */
const QUICK_WORKFLOW_NAME = '__quick__';

/**
 * Suffix of the deterministic `__quick__` sentinel workflow id
 * (`wf-<projectId>-__quick__`, produced by `ensureQuickWorkflow` and migration
 * 012). The sentinel workflow is intentionally absent from `workflows.list`, so
 * its runs can NOT be identified by resolving `workflow_id → name` — they must
 * be matched on the id itself. See {@link buildActiveRunRows}.
 */
const QUICK_WORKFLOW_ID_SUFFIX = `-${QUICK_WORKFLOW_NAME}`;

/**
 * Terminal run statuses. A run in any of these is NOT active and is excluded
 * from the rail. Everything else (queued / starting / running / awaiting_review
 * / stuck / any future awaiting_* state) is treated as active — defined as an
 * exclusion set so new non-terminal statuses surface by default.
 */
const TERMINAL_RUN_STATUSES = new Set<string>(['completed', 'failed', 'canceled']);

/**
 * An active workflow run as rendered in the rail: the list row plus its
 * resolved workflow display name.
 */
export interface ActiveRunRow extends WorkflowRunListRow {
  /** Human-readable workflow name (e.g. "planner"), resolved from workflow_id. */
  workflowName: string;
  /**
   * Side-by-side experiment id (migration 049) — soft link to experiments.id.
   * OPTIONAL, additive widening (mirrors `variant_label?` above). `runs.list`'s
   * SQL projection (listRunsHandler, runQueries.ts) DOES select this column, so it
   * is populated for experiment-arm runs and NULL for every non-experiment run.
   * Kept optional so a caller/consumer that predates the column still type-checks.
   */
  experiment_id?: string | null;
  /** Which arm of the experiment this run drives; selected by listRunsHandler alongside `experiment_id`. */
  experiment_arm?: ExperimentArm | null;
}

export interface ActiveRunsState {
  /** Active runs keyed by projectId. Empty until `refresh(projectId)` runs. */
  runsByProject: Record<number, ActiveRunRow[]>;

  /**
   * Fetch and refresh the active-run list for a single project.
   * Resolves workflow_id → name, excludes `__quick__` runs and terminal runs.
   * Failures are logged and leave existing state untouched (never throws).
   */
  refresh: (projectId: number) => Promise<void>;

  /**
   * Subscribe to the global run-lifecycle subscriptions so the rail stays
   * reactive. Re-fetches every project currently in `runsByProject` whenever a
   * lifecycle event fires. Idempotent — safe to call on every mount.
   * Returns an unsubscribe function.
   */
  init: () => (() => void);
}

// ---------------------------------------------------------------------------
// Pure helper — build the active-run rows from the two list queries.
// ---------------------------------------------------------------------------

export function buildActiveRunRows(
  runs: WorkflowRunListRow[],
  workflows: WorkflowRow[],
  pinnedRunId?: string | null,
): ActiveRunRow[] {
  const nameById = new Map<string, string>();
  for (const wf of workflows) nameById.set(wf.id, wf.name);

  return runs
    // Exclude quick-session sentinel runs. They can't be filtered by resolved
    // name (the `__quick__` workflow is excluded from `workflows.list`, so
    // `nameById` never holds it — the old name-based check let every quick run
    // slip through with a "workflow" fallback label). Match the id suffix
    // instead, which is the only reliable signal here.
    .filter((run) => !run.workflow_id.endsWith(QUICK_WORKFLOW_ID_SUFFIX))
    // Drop terminal runs so the rail stays an active-runs list, NOT a historic
    // log — EXCEPT the currently-selected run (`pinnedRunId`). A run the user is
    // viewing must stay reachable even after it completes/fails, otherwise it
    // vanishes mid-session and can't be reopened (e.g. a planner that finished
    // or got stuck with no merge prompt).
    .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status) || run.id === pinnedRunId)
    .map((run) => ({
      ...run,
      workflowName: nameById.get(run.workflow_id) ?? 'workflow',
    }));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useActiveRunsStore = create<ActiveRunsState>((set, get) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  /** Re-fetch every project we already track. */
  const refreshAllKnownProjects = (): void => {
    const projectIds = Object.keys(get().runsByProject).map((k) => Number(k));
    for (const pid of projectIds) {
      void get().refresh(pid);
    }
  };

  return {
    runsByProject: {},

    refresh: async (projectId) => {
      try {
        const [runs, workflows] = await Promise.all([
          trpc.cyboflow.runs.list.query({ projectId }),
          trpc.cyboflow.workflows.list.query({ projectId }),
        ]);
        // Pin the currently-selected run so it stays reachable even when
        // terminal (read non-reactively — refresh already re-runs on
        // activeRunId change via the rail's effect).
        const pinnedRunId = useCyboflowStore.getState().activeRunId;
        const active = buildActiveRunRows(runs, workflows, pinnedRunId);
        set((state) => ({
          runsByProject: { ...state.runsByProject, [projectId]: active },
        }));
      } catch (err: unknown) {
        console.warn('[activeRunsStore] refresh failed for project', projectId, err);
      }
    },

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;

      // The global lifecycle subscriptions only signal that *something*
      // changed; we re-fetch the authoritative list rather than mutate
      // optimistically (same source-of-truth strategy as reviewQueueStore).
      const onLifecycle = () => refreshAllKnownProjects();

      const stuckSub = trpc.cyboflow.events.onStuckDetected.subscribe(undefined, {
        onData: onLifecycle,
        onError: (err: unknown) =>
          console.warn('[activeRunsStore] onStuckDetected error:', err),
      });
      const approvalCreatedSub = trpc.cyboflow.events.onApprovalCreated.subscribe(undefined, {
        onData: onLifecycle,
        onError: (err: unknown) =>
          console.warn('[activeRunsStore] onApprovalCreated error:', err),
      });
      const approvalDecidedSub = trpc.cyboflow.events.onApprovalDecided.subscribe(undefined, {
        onData: onLifecycle,
        onError: (err: unknown) =>
          console.warn('[activeRunsStore] onApprovalDecided error:', err),
      });
      // The clean-drain REST (running → awaiting_review) and the failed/canceled
      // executor transitions emit no approval row, so this is the only signal
      // that re-enables a finished run's action bar without a manual refresh.
      const runStatusSub = trpc.cyboflow.events.onRunStatusChanged.subscribe(undefined, {
        onData: onLifecycle,
        onError: (err: unknown) =>
          console.warn('[activeRunsStore] onRunStatusChanged error:', err),
      });

      const unsubscribe = () => {
        stuckSub.unsubscribe();
        approvalCreatedSub.unsubscribe();
        approvalDecidedSub.unsubscribe();
        runStatusSub.unsubscribe();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
