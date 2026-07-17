/**
 * activeRunsStore — Zustand slice that surfaces reachable workflow runs in the rail.
 *
 * Workflow runs live in the `workflow_runs` table and do NOT create `sessions`
 * rows, so they are invisible to the session-store-driven rail. This store fills
 * that gap: it lists workflow runs per project and exposes every non-terminal
 * run plus the newest terminal run for each parent session, so both in-flight
 * work and the latest finished terminal workflow stay reachable in the sidebar.
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
 *   - Every non-terminal run is included.
 *   - The newest terminal run for each non-null session_id is retained.
 *   - The selected run is retained even when it is older or parentless.
 *   - Other terminal history and parentless terminal runs are excluded.
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
 * Terminal run statuses. Everything else (queued / starting / running /
 * awaiting_review / stuck / any future awaiting_* state) is treated as active.
 * The exclusion set makes new non-terminal statuses active by default.
 */
const TERMINAL_RUN_STATUSES = new Set<string>(['completed', 'failed', 'canceled']);

/** Shared active/busy discriminator for consumers of retained rail rows. */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * A workflow run reachable from the rail: the list row plus its resolved
 * workflow display name. The row may be terminal under the retention rules.
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
  /** Sidebar-reachable runs keyed by projectId. Empty until `refresh(projectId)` runs. */
  runsByProject: Record<number, ActiveRunRow[]>;

  /**
   * Fetch and refresh the reachable-run list for a single project.
   * Resolves workflow_id → name and applies the quick/terminal retention rules.
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
// Pure helper — build the sidebar-reachable rows from the two list queries.
// ---------------------------------------------------------------------------

export function buildActiveRunRows(
  runs: WorkflowRunListRow[],
  workflows: WorkflowRow[],
  pinnedRunId?: string | null,
): ActiveRunRow[] {
  const nameById = new Map<string, string>();
  for (const wf of workflows) nameById.set(wf.id, wf.name);

  const nonQuickRuns = runs
    // Exclude quick-session sentinel runs. They can't be filtered by resolved
    // name (the `__quick__` workflow is excluded from `workflows.list`, so
    // `nameById` never holds it — the old name-based check let every quick run
    // slip through with a "workflow" fallback label). Match the id suffix
    // instead, which is the only reliable signal here.
    .filter((run) => !run.workflow_id.endsWith(QUICK_WORKFLOW_ID_SUFFIX));

  // Retain one terminal workflow per real parent session. runs.list is ordered
  // newest-first, but comparing created_at keeps this helper correct for callers
  // and tests that supply a different order. Ties preserve the first list row.
  const newestTerminalBySession = new Map<string, WorkflowRunListRow>();
  for (const run of nonQuickRuns) {
    if (!isTerminalRunStatus(run.status) || run.session_id == null) continue;
    const previous = newestTerminalBySession.get(run.session_id);
    if (!previous || run.created_at > previous.created_at) {
      newestTerminalBySession.set(run.session_id, run);
    }
  }

  return nonQuickRuns
    // Keep every active row, the newest terminal row per parent session, and the
    // selected row. This is intentionally not a history list: older terminal
    // rows and unpinned terminal rows without a parent session remain hidden.
    .filter((run) =>
      !isTerminalRunStatus(run.status) ||
      run.id === pinnedRunId ||
      (run.session_id != null && newestTerminalBySession.get(run.session_id)?.id === run.id),
    )
    .map((run) => ({
      ...run,
      workflowName: nameById.get(run.workflow_id) ?? 'workflow',
    }));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Coalesce window for the lifecycle-driven refetch. The global lifecycle events
 * arrive in bursts — an active A/B experiment has TWO concurrent arm runs, each
 * emitting its own onRunStatusChanged transitions (plus the eval settle churns
 * more), so a naive re-fetch-per-event fans out `runs.list` + `workflows.list`
 * across every tracked project many times in a few milliseconds and thrashes the
 * (unmemoized) rail tree. A short trailing coalesce collapses each burst into ONE
 * refetch pass while keeping the rail effectively real-time.
 */
const LIFECYCLE_REFETCH_DEBOUNCE_MS = 150;

export const useActiveRunsStore = create<ActiveRunsState>((set, get) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;
  let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Re-fetch every project we already track. */
  const refreshAllKnownProjects = (): void => {
    const projectIds = Object.keys(get().runsByProject).map((k) => Number(k));
    for (const pid of projectIds) {
      void get().refresh(pid);
    }
  };

  /**
   * Debounced refetch: the first event in a burst arms a timer, later events in
   * the window are dropped (the single trailing pass already reflects them), so a
   * burst of N lifecycle events becomes exactly one refetch-all. Bounded latency —
   * always fires within LIFECYCLE_REFETCH_DEBOUNCE_MS of the first event.
   */
  const scheduleRefreshAllKnownProjects = (): void => {
    if (lifecycleTimer !== null) return;
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = null;
      refreshAllKnownProjects();
    }, LIFECYCLE_REFETCH_DEBOUNCE_MS);
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
        const reachable = buildActiveRunRows(runs, workflows, pinnedRunId);
        set((state) => ({
          runsByProject: { ...state.runsByProject, [projectId]: reachable },
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
      // Debounced so a burst of transitions (two concurrent A/B arms + eval
      // settle) collapses into a single refetch pass instead of one per event.
      const onLifecycle = () => scheduleRefreshAllKnownProjects();

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
        if (lifecycleTimer !== null) {
          clearTimeout(lifecycleTimer);
          lifecycleTimer = null;
        }
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
