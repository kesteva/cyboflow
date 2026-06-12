/**
 * insightsStore — Zustand slice feeding the Insights view (run statistics, token
 * usage rollups, review-queue summary, and code-quality buckets).
 *
 * GLOBAL singleton with an in-memory `projectFilter` (null = ALL projects). Like
 * {@link useLandingStore} and {@link useBacklogStore}, this store owns a
 * cross-project fan-out: when `projectFilter` is null it enumerates every
 * project and fans out the per-project queries, otherwise it queries the single
 * filtered project. Narrowing is a VIEW concern handled by `setProjectFilter`,
 * which re-runs the fetch fan-out.
 *
 * ## Data sources (all `cyboflow.insights.*` queries)
 *
 *   - workflowStats   — per-workflow run-outcome statistics (WorkflowRunStats[]).
 *   - workflowUsage   — per-workflow token/cost aggregate (WorkflowUsageStats[]).
 *   - reviewSummary   — review-queue counters (ReviewItemSummary).
 *   - qualityFindings — kind='finding' review items flattened for the quality
 *                       columns (QualityFinding[]).
 *   - stepTokens      — per-workflow token attribution by step, keyed by
 *                       workflowId. Fetched per workflow, capped at the 6
 *                       most-recently-run workflows to bound fan-out.
 *   - usageTrend      — per-workflow time-bucketed sparkline points, keyed by
 *                       workflowId. Same 6-workflow cap.
 *
 * `pendingFindings` is the kind='finding', status='pending' subset of the review
 * inbox, fetched via `cyboflow.reviewItems.list` (NOT the insights router). The
 * `list` query is project-scoped (its input requires a positive projectId), so
 * the cross-project case enumerates projects and fans out per project — the same
 * shape landingStore uses for its review-item fan-out (the small loop is
 * duplicated here deliberately rather than importing landingStore internals).
 *
 * ## Idempotency + live refresh (mirrors reviewQueueStore / backlogStore)
 *
 * `init()` is guarded by a closure-private `initialized` boolean: the first call
 * fetches + subscribes; later calls are no-ops. AFTER the first fetch resolves,
 * `init()` wires the three GLOBAL lifecycle subscriptions activeRunsStore/
 * landingStore also use (`events.onRunStatusChanged` / `onApprovalCreated` /
 * `onApprovalDecided`) — each signals run-lifecycle or review-item activity that
 * can change any insights aggregate. On any of those events we DEBOUNCE for 2s,
 * then `refresh()`. The unsubscribe handles live in MODULE scope (the closure),
 * so `init()` cannot double-subscribe.
 *
 * ## Stale-on-error + non-flashing refresh
 *
 * `loading` is set true ONLY on the first init (`!initialized`) so live refreshes
 * never flash the UI. Each query is caught independently: the first failure sets
 * `error` to its message; successful queries still commit, and a failed query
 * keeps the PREVIOUS slice value (stale-not-cleared). This means a transient
 * backend hiccup degrades gracefully instead of blanking the dashboard.
 *
 * The subscription `onData` callbacks are typed by AppRouter inference (no local
 * payload interface, no `(evt: unknown)` — CLAUDE.md rule); the callbacks ignore
 * the payload entirely and only use the event as a debounce trigger.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { ReviewItem } from '../../../shared/types/reviews';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  StepTokenBucket,
  UsageTrendPoint,
  ReviewItemSummary,
  QualityFinding,
} from '../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the lifecycle-event-driven live refresh. */
const REFRESH_DEBOUNCE_MS = 2000;

/**
 * Cap on the number of workflows fanned out for the per-workflow stepTokens +
 * usageTrend queries. We keep the most-recently-run workflows so the dashboard
 * surfaces fresh activity without an unbounded N-query fan-out.
 */
const PER_WORKFLOW_FANOUT_CAP = 6;

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Pick the workflows whose per-step / trend detail we fan out, capped at
 * {@link PER_WORKFLOW_FANOUT_CAP}. Sorted by `lastRunAt` DESC (ISO strings sort
 * lexically), with never-run workflows (lastRunAt === null) sorted last. Pure +
 * exported so the cap/ordering can be asserted without a live store.
 */
export function selectFanoutWorkflows(stats: WorkflowRunStats[]): WorkflowRunStats[] {
  return [...stats]
    .sort((a, b) => {
      // null lastRunAt sorts last; otherwise newest-first by ISO string.
      if (a.lastRunAt === null && b.lastRunAt === null) return 0;
      if (a.lastRunAt === null) return 1;
      if (b.lastRunAt === null) return -1;
      return a.lastRunAt < b.lastRunAt ? 1 : a.lastRunAt > b.lastRunAt ? -1 : 0;
    })
    .slice(0, PER_WORKFLOW_FANOUT_CAP);
}

/** Keep only kind='finding', status='pending' review items. Pure + exported. */
export function filterPendingFindings(items: ReviewItem[]): ReviewItem[] {
  return items.filter((it) => it.kind === 'finding' && it.status === 'pending');
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

export interface InsightsState {
  /** True once the first fetch + subscribe has run. Closure-mirror of the guard. */
  initialized: boolean;
  /** True only during the FIRST fetch — live refreshes do not flip it. */
  loading: boolean;
  /** First fetch failure's message for the current fan-out; null when clean. */
  error: string | null;
  /** Active project filter; null = ALL projects (the default). In-memory only. */
  projectFilter: number | null;

  workflowStats: WorkflowRunStats[];
  workflowUsage: WorkflowUsageStats[];
  reviewSummary: ReviewItemSummary | null;
  qualityFindings: QualityFinding[];
  /** kind='finding', status='pending' review items. */
  pendingFindings: ReviewItem[];
  /** Per-step token attribution, keyed by workflowId. */
  stepTokens: Record<string, StepTokenBucket[]>;
  /** Time-bucketed usage trend points, keyed by workflowId. */
  usageTrends: Record<string, UsageTrendPoint[]>;

  /**
   * Bootstrap the insights dashboard: first fetch (loading=true) for the current
   * projectFilter, then wire the global lifecycle subscriptions that drive the
   * debounced live refresh. Idempotent — repeat calls are no-ops.
   */
  init: () => Promise<void>;
  /**
   * Re-run the fetch fan-out for the current projectFilter WITHOUT flipping
   * `initialized` or `loading` (so live refreshes never flash). Successful
   * queries commit; a failed query keeps its prior slice (stale-not-cleared).
   */
  refresh: () => Promise<void>;
  /** Set the project filter (null = ALL projects) and refresh. */
  setProjectFilter: (projectId: number | null) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useInsightsStore = create<InsightsState>((set, get) => {
  // Closure-private subscription + lifecycle state — NOT exposed on the state.
  // `initialized` guards init() idempotency AND gates the loading flag; the
  // store mirrors it onto state purely for consumer/test visibility.
  let initialized = false;
  // Global lifecycle subscriptions (created once, after the first fetch).
  const lifecycleSubs: Array<{ unsubscribe: () => void }> = [];
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic fetch generation: a stale in-flight fan-out (whose projectFilter
  // changed mid-flight) must not clobber a newer one's committed slices.
  let fetchGeneration = 0;

  /**
   * Resolve the projectIds to fan out over: a single id when filtered, else the
   * full project list (cross-project). Returns [] (and records the error) on a
   * project-list failure so the caller can short-circuit gracefully.
   */
  const resolveProjectIds = async (
    filter: number | null,
    recordError: (msg: string) => void,
  ): Promise<number[]> => {
    if (filter !== null) return [filter];
    try {
      const res = await API.projects.getAll();
      if (res.success && res.data) return res.data.map((p: Project) => p.id);
      recordError(res.error ?? 'projects.getAll returned no data');
      return [];
    } catch (err: unknown) {
      recordError(err instanceof Error ? err.message : 'projects.getAll failed');
      return [];
    }
  };

  /**
   * Fetch the pending-findings inbox for the resolved project set. The
   * `reviewItems.list` query is project-scoped, so we fan out per project (the
   * landingStore pattern, duplicated deliberately) and keep only the
   * kind='finding', status='pending' rows. Per-project failures are caught and
   * recorded but never abort the other projects' fetches.
   */
  const fetchPendingFindings = async (
    projectIds: number[],
    recordError: (msg: string) => void,
  ): Promise<ReviewItem[]> => {
    const lists = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          return await trpc.cyboflow.reviewItems.list.query({
            projectId,
            status: 'pending',
            kind: 'finding',
          });
        } catch (err: unknown) {
          recordError(err instanceof Error ? err.message : `reviewItems.list failed for ${projectId}`);
          return [] as ReviewItem[];
        }
      }),
    );
    return filterPendingFindings(lists.flat());
  };

  /**
   * The core fetch fan-out shared by init() + refresh(). Commits each slice that
   * resolved; a failed query records the first error and leaves the prior value
   * untouched (stale-not-cleared). Guarded by a fetch generation so a stale
   * fan-out (its projectFilter changed mid-flight) cannot overwrite a newer one.
   */
  const runFetch = async (): Promise<void> => {
    const generation = ++fetchGeneration;
    const filter = get().projectFilter;
    // `insights.*` queries take projectId number|null directly (cross-project
    // when null); only pendingFindings needs the enumerated project set.
    const projectId = filter;

    // First-failure-wins error accumulator for THIS fan-out.
    let firstError: string | null = null;
    const recordError = (msg: string): void => {
      if (firstError === null) firstError = msg;
    };

    // Wrap each query so an individual failure records the error and yields
    // `undefined` (→ "keep prior slice") rather than rejecting the whole fan-out.
    const safe = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch (err: unknown) {
        recordError(err instanceof Error ? err.message : `${label} failed`);
        return undefined;
      }
    };

    // -- Phase 1: the four top-level aggregates + the project-list-driven
    // pending-findings fan-out, all in parallel.
    const projectIdsPromise = resolveProjectIds(filter, recordError);
    const [
      workflowStats,
      workflowUsage,
      reviewSummary,
      qualityFindings,
      projectIds,
    ] = await Promise.all([
      safe('workflowStats', trpc.cyboflow.insights.workflowStats.query({ projectId })),
      safe('workflowUsage', trpc.cyboflow.insights.workflowUsage.query({ projectId })),
      safe('reviewSummary', trpc.cyboflow.insights.reviewSummary.query({ projectId })),
      safe('qualityFindings', trpc.cyboflow.insights.qualityFindings.query({ projectId })),
      projectIdsPromise,
    ]);

    const pendingFindings =
      projectIds.length > 0 ? await fetchPendingFindings(projectIds, recordError) : undefined;

    // A newer fetch superseded us — drop everything we computed.
    if (generation !== fetchGeneration) return;

    // -- Phase 2: per-workflow stepTokens + usageTrend for the capped set,
    // derived from whichever workflowStats we just got (or the prior slice when
    // the workflowStats query failed). Keyed by workflowId.
    const statsForFanout = workflowStats ?? get().workflowStats;
    const fanoutWorkflows = selectFanoutWorkflows(statsForFanout);

    const detail = await Promise.all(
      fanoutWorkflows.map(async (wf) => {
        const [steps, trend] = await Promise.all([
          safe(
            `stepTokens:${wf.workflowId}`,
            trpc.cyboflow.insights.stepTokens.query({ workflowId: wf.workflowId }),
          ),
          safe(
            `usageTrend:${wf.workflowId}`,
            trpc.cyboflow.insights.usageTrend.query({
              workflowId: wf.workflowId,
              projectId,
            }),
          ),
        ]);
        return { workflowId: wf.workflowId, steps, trend };
      }),
    );

    if (generation !== fetchGeneration) return;

    // Merge per-workflow detail onto the PRIOR maps so a failed individual
    // query keeps its stale entry rather than dropping the workflow.
    const stepTokens: Record<string, StepTokenBucket[]> = { ...get().stepTokens };
    const usageTrends: Record<string, UsageTrendPoint[]> = { ...get().usageTrends };
    for (const { workflowId, steps, trend } of detail) {
      if (steps !== undefined) stepTokens[workflowId] = steps;
      if (trend !== undefined) usageTrends[workflowId] = trend;
    }

    // Commit: every slice that resolved replaces its prior value; an undefined
    // (failed) slice keeps the prior value via the get() fallback.
    const prev = get();
    set({
      workflowStats: workflowStats ?? prev.workflowStats,
      workflowUsage: workflowUsage ?? prev.workflowUsage,
      reviewSummary: reviewSummary ?? prev.reviewSummary,
      qualityFindings: qualityFindings ?? prev.qualityFindings,
      pendingFindings: pendingFindings ?? prev.pendingFindings,
      stepTokens,
      usageTrends,
      error: firstError,
    });
  };

  /** Debounced live refresh fired by the global lifecycle subscriptions. */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  return {
    initialized: false,
    loading: false,
    error: null,
    projectFilter: null,
    workflowStats: [],
    workflowUsage: [],
    reviewSummary: null,
    qualityFindings: [],
    pendingFindings: [],
    stepTokens: {},
    usageTrends: {},

    init: async () => {
      // Closure-private guard makes init idempotent even before the async fetch
      // resolves (a second synchronous call returns immediately). The PUBLIC
      // `initialized` state field is NOT flipped here — it must stay false for
      // the duration of the first fetch so the dashboard renders LoadingSkeleton
      // (InsightsView computes `showSkeleton = loading && !initialized`) rather
      // than empty zero-state sections masquerading as loaded data. See the
      // field's own doc: "True once the first fetch + subscribe has run."
      if (initialized) return;
      initialized = true;
      set({ loading: true });

      await runFetch();
      set({ initialized: true, loading: false });

      // Wire the GLOBAL lifecycle subscriptions AFTER the first fetch. These are
      // the same signals landingStore/activeRunsStore use; each can change a run
      // outcome (→ stats/usage) or the review inbox (→ summary/findings) without
      // a per-project review-item delta. onData payloads are AppRouter-inferred
      // (CLAUDE.md rule); we ignore the payload and only debounce a refresh.
      lifecycleSubs.push(
        trpc.cyboflow.events.onRunStatusChanged.subscribe(undefined, {
          onData: () => scheduleRefresh(),
          onError: (err: unknown) =>
            console.warn('[insightsStore] onRunStatusChanged error:', err),
        }),
        trpc.cyboflow.events.onApprovalCreated.subscribe(undefined, {
          onData: () => scheduleRefresh(),
          onError: (err: unknown) =>
            console.warn('[insightsStore] onApprovalCreated error:', err),
        }),
        trpc.cyboflow.events.onApprovalDecided.subscribe(undefined, {
          onData: () => scheduleRefresh(),
          onError: (err: unknown) =>
            console.warn('[insightsStore] onApprovalDecided error:', err),
        }),
      );
    },

    refresh: async () => {
      await runFetch();
    },

    setProjectFilter: async (projectId) => {
      set({ projectFilter: projectId });
      await runFetch();
    },
  };
});
