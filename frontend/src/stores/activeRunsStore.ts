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
 *   - `cyboflow.events.onStuckDetected`   (run → stuck)
 *   - `cyboflow.events.onApprovalCreated` (run → awaiting_review)
 *   - `cyboflow.events.onApprovalDecided` (review resolved / run advances)
 * Run start and run completion are picked up by an explicit `refresh()` call
 * from `cyboflowStore.setActiveRun` (start) and from the rail's own
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

// ---------------------------------------------------------------------------
// Types inferred from the router output — never a local mirror.
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
type WorkflowRunListRow = RouterOutputs['cyboflow']['runs']['list'][number];
type WorkflowRow = RouterOutputs['cyboflow']['workflows']['list'][number];

/** The internal `__quick__` sentinel workflow name (see migration 012). */
const QUICK_WORKFLOW_NAME = '__quick__';

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
): ActiveRunRow[] {
  const nameById = new Map<string, string>();
  for (const wf of workflows) nameById.set(wf.id, wf.name);

  return runs
    .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    .filter((run) => nameById.get(run.workflow_id) !== QUICK_WORKFLOW_NAME)
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
        const active = buildActiveRunRows(runs, workflows);
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

      const unsubscribe = () => {
        stuckSub.unsubscribe();
        approvalCreatedSub.unsubscribe();
        approvalDecidedSub.unsubscribe();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
