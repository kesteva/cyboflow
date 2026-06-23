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
 *   - dailyUsage      — per-(day, model) token buckets for the usage chart
 *                       (DailyModelUsagePoint[]); fetched once per fan-out in
 *                       PHASE 1 alongside the other top-level aggregates.
 *   - reviewSummary   — review-queue counters (ReviewItemSummary).
 *   - qualityFindings — kind='finding' review items flattened for the quality
 *                       columns (QualityFinding[]).
 *   - stepTokens      — per-workflow token attribution by step, keyed by
 *                       workflowId. Fetched per workflow, capped at the 6
 *                       most-recently-run workflows to bound fan-out.
 *   - usageTrend      — per-workflow time-bucketed sparkline points, keyed by
 *                       workflowId. Same 6-workflow cap.
 *   - revisionHistory — per-workflow per-spec_hash run stats (version history),
 *                       keyed by workflowId. Same 6-workflow cap / fan-out.
 *
 * `triageFindings` is the kind='finding', status='pending' subset of the review
 * inbox, fetched via `cyboflow.reviewItems.list` (NOT the insights router), each
 * mapped to a {@link TriageFinding} view-model that carries a derived
 * `triageState` ('untriaged' when `staged_at` is null, 'ready' once approved).
 * The `list` query is project-scoped (its input requires a positive projectId),
 * so the cross-project case enumerates projects and fans out per project — the
 * same shape landingStore uses for its review-item fan-out (the small loop is
 * duplicated here deliberately rather than importing landingStore internals).
 *
 * ## Idempotency + live refresh (mirrors reviewQueueStore / backlogStore)
 *
 * `init()` is guarded by a closure-private `initialized` boolean: the first call
 * fetches + subscribes; later calls are no-ops. AFTER the first fetch resolves,
 * `init()` wires the three GLOBAL lifecycle subscriptions activeRunsStore/
 * landingStore also use (`events.onRunStatusChanged` / `onApprovalCreated` /
 * `onApprovalDecided`) — each signals run-lifecycle or review-item activity that
 * can change any insights aggregate — PLUS a per-project
 * `reviewItems.onReviewItemChanged` subscription (the landingStore pattern,
 * re-wired when the project set changes) so a same-session/Review-Queue
 * Dismiss/re-tag/select reconciles BOTH the rows and the findings-scoped counter
 * strip (none of the three lifecycle signals fire on a ReviewItemRouter write).
 * On any of those events we DEBOUNCE for 2s, then `refresh()`. The unsubscribe
 * handles live in MODULE scope (the closure), so `init()` cannot double-subscribe.
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
import type {
  ReviewItem,
  FindingProposedTarget,
  FindingPriority,
  FindingTagBucket,
} from '../../../shared/types/reviews';
import { findingBucket } from '../../../shared/types/reviews';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  StepTokenBucket,
  UsageTrendPoint,
  ReviewItemSummary,
  QualityFinding,
  WorkflowRevisionStats,
  DailyModelUsagePoint,
} from '../../../shared/types/insights';
import {
  READY_BUCKETS,
  sortWithinBucket,
  allocateReadyRows,
  type RowsByBucket,
  type ReadyAllocation,
  type TallyCounts,
} from '../components/Insights/findingsTagMeta';

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
// Triage view-model + pure triage selectors — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * The triage view-model for one pending finding: the raw {@link ReviewItem}
 * plus a derived `triageState`. `staged_at === null` ⇒ 'untriaged' (the human
 * has not approved it into READY); a non-null `staged_at` ⇒ 'ready' (approved,
 * possibly de-selected). `status` is NOT overloaded — both states are
 * `status='pending'`; only Dismiss/compound-consume change `status` (mig 032).
 */
export type TriageFinding = ReviewItem & { triageState: 'untriaged' | 'ready' };

/** Map a pending finding ReviewItem to its TriageFinding view-model. */
function toTriageFinding(item: ReviewItem): TriageFinding {
  return { ...item, triageState: item.staged_at === null ? 'untriaged' : 'ready' };
}

/**
 * Findings-scoped counter strip (OD-11). Pending is the COUNT OF ROWS THE TWO
 * SECTIONS ACTUALLY RENDER — `triageFindings.length` (untriaged ∪ ready) — NOT
 * the whole-inbox `reviewSummary.pendingByKind.finding`. The summary count also
 * includes ORPHANED pending findings whose producing run has gone terminal
 * (canceled/failed/completed), which the `reviewItems.list` orphan-hide clause
 * deliberately suppresses from the list — so a summary-driven strip reads (e.g.)
 * "56 pending" above ~17 visible rows. The strip sits directly above the sections
 * that enumerate "what is pending", so it MUST equal what they show; deriving it
 * from `triageFindings` (the same orphan-hidden fetch the sections partition)
 * guarantees that. Resolved/Dismissed are client-derived by counting `status`
 * over the already-fetched `qualityFindings` (each carries `status`).
 */
export function selectFindingsCounters(
  triageFindings: TriageFinding[],
  qualityFindings: QualityFinding[],
): { pending: number; resolved: number; dismissed: number } {
  let resolved = 0;
  let dismissed = 0;
  for (const f of qualityFindings) {
    if (f.status === 'resolved') resolved += 1;
    else if (f.status === 'dismissed') dismissed += 1;
  }
  return {
    pending: triageFindings.length,
    resolved,
    dismissed,
  };
}

/**
 * Untriaged findings (`triageState==='untriaged'`), newest-first with a
 * P0→P1→P2 tiebreak (null priority sorts last). Pure + exported.
 */
export function selectUntriaged(findings: TriageFinding[]): TriageFinding[] {
  return findings
    .filter((f) => f.triageState === 'untriaged')
    .sort((a, b) => {
      // Newest-first by created_at (ISO strings sort lexically).
      const byAge = b.created_at.localeCompare(a.created_at);
      if (byAge !== 0) return byAge;
      // Tiebreak: P0→P1→P2, null last (OD-8).
      return priorityRankForUntriaged(a.priority) - priorityRankForUntriaged(b.priority);
    });
}

/** P0=0, P1=1, P2=2, null LAST — the untriaged tiebreak rank (OD-8). */
function priorityRankForUntriaged(priority: FindingPriority | null): number {
  if (priority === 'P0') return 0;
  if (priority === 'P1') return 1;
  if (priority === 'P2') return 2;
  return 3;
}

/**
 * Partition the READY findings (`triageState==='ready'`) into the three buckets
 * via the canonical {@link findingBucket} mapping, each side `sortWithinBucket`ed
 * (P0→P1→P2, null last, created_at tiebreak). Pure + exported.
 */
export function selectReadyBuckets(findings: TriageFinding[]): RowsByBucket<TriageFinding> {
  const byBucket: Record<FindingTagBucket, TriageFinding[]> = { quick: [], doc: [], task: [] };
  for (const f of findings) {
    if (f.triageState !== 'ready') continue;
    byBucket[findingBucket(readyTarget(f))].push(f);
  }
  return {
    quick: sortWithinBucket(byBucket.quick),
    doc: sortWithinBucket(byBucket.doc),
    task: sortWithinBucket(byBucket.task),
  };
}

/** Lift the finding's proposedTarget from its payload (null when absent). */
function readyTarget(f: TriageFinding): FindingProposedTarget | null {
  const payload = f.payload;
  if (payload && payload.kind === 'finding' && payload.proposedTarget !== undefined) {
    return payload.proposedTarget;
  }
  return null;
}

/**
 * Greedy 5-row budget over the (already-bucketed) ready rows in fixed bucket
 * order — `showAll` expands to everything. Delegates to the pure
 * {@link allocateReadyRows} allocator. Header full counts are taken from the
 * RAW buckets by the consumer (`buckets[k].length`), NOT this allocation.
 */
export function selectGreedyReadyRows(
  buckets: RowsByBucket<TriageFinding>,
  showAll: boolean,
  budget = 5,
): ReadyAllocation<TriageFinding> {
  return allocateReadyRows(buckets, showAll ? Infinity : budget);
}

/**
 * Per-bucket SELECTED tally over the READY findings (only `selected` ready rows
 * count) feeding the compounding-tray pluralization. Pure + exported.
 */
export function selectTallyParts(findings: TriageFinding[]): TallyCounts {
  const counts: TallyCounts = { count: 0, quick: 0, doc: 0, task: 0 };
  for (const f of findings) {
    if (f.triageState !== 'ready' || !f.selected) continue;
    counts.count += 1;
    counts[findingBucket(readyTarget(f))] += 1;
  }
  return counts;
}

/**
 * The selected READY finding ids, in stable bucket-then-within-bucket order
 * (the order the wizard / compound seed consume). Pure + exported.
 */
export function selectSelectedFindingIds(findings: TriageFinding[]): string[] {
  const buckets = selectReadyBuckets(findings);
  const ids: string[] = [];
  for (const bucket of READY_BUCKETS) {
    for (const row of buckets[bucket]) {
      if (row.selected) ids.push(row.id);
    }
  }
  return ids;
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
  /** Per-(day, model) token buckets for the usage chart (cross-project when the
   *  filter is null). Fetched once per fan-out in PHASE 1. */
  dailyUsage: DailyModelUsagePoint[];
  reviewSummary: ReviewItemSummary | null;
  qualityFindings: QualityFinding[];
  /**
   * kind='finding', status='pending' review items mapped to the triage
   * view-model ({@link TriageFinding}). One fetch feeds BOTH the UNTRIAGED and
   * READY-to-compound sections (untriaged = staged_at null; ready = staged_at
   * set) — the UI consumes the exported triage selectors, never this raw array.
   */
  triageFindings: TriageFinding[];
  /** Per-step token attribution, keyed by workflowId. */
  stepTokens: Record<string, StepTokenBucket[]>;
  /** Time-bucketed usage trend points, keyed by workflowId. */
  usageTrends: Record<string, UsageTrendPoint[]>;
  /** Per-spec_hash revision run stats (version history), keyed by workflowId. */
  revisionHistory: Record<string, WorkflowRevisionStats[]>;

  /** View-only: whether the UNTRIAGED section shows all rows (not just top-5). */
  untriagedExpanded: boolean;
  /** View-only: whether the READY section shows all rows (not the greedy-5 budget). */
  readyShowAll: boolean;

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
  /**
   * Lazily fetch the per-workflow drill-down detail (stepTokens + usageTrend +
   * revisionHistory) for ONE workflow that the PHASE-2 fan-out cap left out — the
   * stats drill-down for a workflow outside the top-{@link PER_WORKFLOW_FANOUT_CAP}
   * set. Returns immediately when all three maps already carry the key. Otherwise
   * it fetches the same three per-workflow queries the fan-out uses (each caught
   * independently — a failure is console.warn'd, not surfaced as `error`) and
   * merges ONLY this workflowId's entries into the three maps, leaving every other
   * key untouched. Concurrent calls for the same id dedupe via a closure-private
   * in-flight set, so opening a drill-down does not double-fetch.
   */
  ensureWorkflowDetail: (workflowId: string) => Promise<void>;

  /** Toggle the UNTRIAGED section's expanded ("show N more") state. */
  toggleUntriagedExpand: () => void;
  /** Toggle the READY section's show-all (vs greedy-5 budget) state. */
  toggleReadyShowAll: () => void;

  /**
   * Optimistic triage actions. Each: snapshot → in-place set() patch → await the
   * tRPC mutation (result type INFERRED from the client, never a local mirror) →
   * on reject restore the snapshot + record the error. Successful mutations do
   * NOT refresh() — the per-project `onReviewItemChanged` subscription reconciles
   * the rows + counter (reconcile-by-id; the optimistic patch holds until then).
   */
  /** Approve an untriaged finding into READY (staged + pre-selected). */
  approveFinding: (projectId: number, reviewItemId: string) => Promise<void>;
  /**
   * Dismiss a finding: optimistically remove its row AND bump the derived
   * Dismissed counter (`qualityFindings` gains a dismissed row, `pendingByKind`
   * decremented) so the strip is live before the subscription debounce true-ups.
   */
  dismissFinding: (projectId: number, reviewItemId: string) => Promise<void>;
  /** Re-tag an untriaged finding's proposed target (applied-not-consumed). */
  setFindingTag: (
    projectId: number,
    reviewItemId: string,
    proposedTarget: FindingProposedTarget,
  ) => Promise<void>;
  /** Re-prioritize an untriaged finding (applied-not-consumed). */
  setFindingPriority: (
    projectId: number,
    reviewItemId: string,
    priority: FindingPriority,
  ) => Promise<void>;
  /** Toggle the compound-selection flag on ONE ready finding. */
  toggleFindingSelected: (projectId: number, reviewItemId: string) => Promise<void>;
  /** Select/deselect EVERY ready finding (the section-level Select-all). */
  selectAllReady: (projectId: number, selected: boolean) => Promise<void>;
  /** Select/deselect every ready finding in ONE bucket (the header checkbox). */
  selectBucket: (projectId: number, bucket: FindingTagBucket, selected: boolean) => Promise<void>;
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
  // Per-project review-item delta subscriptions, keyed by projectId. A
  // ReviewItemRouter write emits on 'review-project-<id>' ONLY — none of the
  // three global lifecycle signals fire on it — so without this a same-session /
  // Review-Queue dismiss/re-tag/select never refreshes the Insights findings.
  // Re-wired whenever the resolved project set changes (the landingStore pattern).
  const reviewItemSubs = new Map<number, { unsubscribe: () => void }>();
  // The project ids the latest committed fetch resolved over — used to wire the
  // per-project review-item subscriptions in init() AFTER the global subs exist
  // (runFetch runs once BEFORE init wires lifecycleSubs, so its wire call no-ops).
  let lastProjectIds: number[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic fetch generation: a stale in-flight fan-out (whose projectFilter
  // changed mid-flight) must not clobber a newer one's committed slices.
  let fetchGeneration = 0;
  // Workflow ids whose ensureWorkflowDetail fetch is in flight — concurrent calls
  // for the same id short-circuit on this set instead of double-fetching.
  const detailInFlight = new Set<string>();

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
   * Fetch the pending-findings inbox for the resolved project set and map each
   * to its {@link TriageFinding} view-model. The `reviewItems.list` query is
   * project-scoped, so we fan out per project (the landingStore pattern,
   * duplicated deliberately) and keep only the kind='finding', status='pending'
   * rows. ONE fetch feeds BOTH the untriaged and ready sections (the triage
   * state derives from `staged_at`). Per-project failures are caught and
   * recorded but never abort the other projects' fetches.
   */
  const fetchTriageFindings = async (
    projectIds: number[],
    recordError: (msg: string) => void,
  ): Promise<TriageFinding[]> => {
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
    return filterPendingFindings(lists.flat()).map(toTriageFinding);
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
    // when null); only triageFindings needs the enumerated project set.
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
      dailyUsage,
      reviewSummary,
      qualityFindings,
      projectIds,
    ] = await Promise.all([
      safe('workflowStats', trpc.cyboflow.insights.workflowStats.query({ projectId })),
      safe('workflowUsage', trpc.cyboflow.insights.workflowUsage.query({ projectId })),
      safe('dailyUsage', trpc.cyboflow.insights.dailyUsage.query({ projectId })),
      safe('reviewSummary', trpc.cyboflow.insights.reviewSummary.query({ projectId })),
      safe('qualityFindings', trpc.cyboflow.insights.qualityFindings.query({ projectId })),
      projectIdsPromise,
    ]);

    const triageFindings =
      projectIds.length > 0 ? await fetchTriageFindings(projectIds, recordError) : undefined;

    // A newer fetch superseded us — drop everything we computed.
    if (generation !== fetchGeneration) return;

    // Remember the resolved set, then re-wire the per-project review-item delta
    // subscriptions to it (no-op pre-init; init() re-wires once after the global
    // subs exist, and later filter flips re-wire here directly).
    lastProjectIds = projectIds;
    wireReviewItemSubscriptions(projectIds);

    // -- Phase 2: per-workflow stepTokens + usageTrend + revisionHistory for the
    // capped set, derived from whichever workflowStats we just got (or the prior
    // slice when the workflowStats query failed). All keyed by workflowId; the
    // revisionHistory fan-out rides the SAME cap as stepTokens/usageTrend.
    const statsForFanout = workflowStats ?? get().workflowStats;
    const fanoutWorkflows = selectFanoutWorkflows(statsForFanout);

    const detail = await Promise.all(
      fanoutWorkflows.map(async (wf) => {
        const [steps, trend, revisions] = await Promise.all([
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
          safe(
            `revisionHistory:${wf.workflowId}`,
            trpc.cyboflow.insights.revisionHistory.query({ workflowId: wf.workflowId }),
          ),
        ]);
        return { workflowId: wf.workflowId, steps, trend, revisions };
      }),
    );

    if (generation !== fetchGeneration) return;

    // Merge per-workflow detail onto the PRIOR maps so a failed individual
    // query keeps its stale entry rather than dropping the workflow.
    const stepTokens: Record<string, StepTokenBucket[]> = { ...get().stepTokens };
    const usageTrends: Record<string, UsageTrendPoint[]> = { ...get().usageTrends };
    const revisionHistory: Record<string, WorkflowRevisionStats[]> = {
      ...get().revisionHistory,
    };
    for (const { workflowId, steps, trend, revisions } of detail) {
      if (steps !== undefined) stepTokens[workflowId] = steps;
      if (trend !== undefined) usageTrends[workflowId] = trend;
      if (revisions !== undefined) revisionHistory[workflowId] = revisions;
    }

    // Commit: every slice that resolved replaces its prior value; an undefined
    // (failed) slice keeps the prior value via the get() fallback.
    const prev = get();
    set({
      workflowStats: workflowStats ?? prev.workflowStats,
      workflowUsage: workflowUsage ?? prev.workflowUsage,
      dailyUsage: dailyUsage ?? prev.dailyUsage,
      reviewSummary: reviewSummary ?? prev.reviewSummary,
      qualityFindings: qualityFindings ?? prev.qualityFindings,
      triageFindings: triageFindings ?? prev.triageFindings,
      stepTokens,
      usageTrends,
      revisionHistory,
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

  /**
   * (Re)subscribe to per-project review-item deltas for exactly `projectIds`,
   * dropping subscriptions for projects no longer in the set (the landingStore
   * pattern). Any delta — created/resolved/dismissed/mutated/staged/
   * selection-changed — schedules a debounced refresh that reconciles both the
   * triage rows and the findings-scoped counter strip. The onData payload is
   * AppRouter-inferred; we ignore it and only use it as a debounce trigger (the
   * 2000ms window coalesces the N per-id `selection-changed` events a batch
   * `setSelected` emits). No-op until `init()` has wired the global subs.
   */
  const wireReviewItemSubscriptions = (projectIds: number[]): void => {
    if (lifecycleSubs.length === 0) return; // not subscribed yet (pre-init).
    const wanted = new Set(projectIds);
    for (const [pid, sub] of reviewItemSubs) {
      if (!wanted.has(pid)) {
        sub.unsubscribe();
        reviewItemSubs.delete(pid);
      }
    }
    for (const projectId of projectIds) {
      if (reviewItemSubs.has(projectId)) continue;
      const sub = trpc.cyboflow.reviewItems.onReviewItemChanged.subscribe(
        { projectId },
        {
          onData: () => scheduleRefresh(),
          onError: (err: unknown) =>
            console.warn('[insightsStore] onReviewItemChanged error for project', projectId, err),
        },
      );
      reviewItemSubs.set(projectId, sub);
    }
  };

  /**
   * Shared optimistic selection toggle for one/all/bucket: snapshot, flip
   * `selected` on the given ids in place, await `reviewItems.setSelected` (result
   * type INFERRED from the client, never a local `{count}` mirror), and roll back
   * to the snapshot + record the error on reject.
   */
  const applySelection = async (
    projectId: number,
    reviewItemIds: string[],
    selected: boolean,
  ): Promise<void> => {
    const snapshot = get().triageFindings;
    const idSet = new Set(reviewItemIds);
    set({ triageFindings: snapshot.map((f) => (idSet.has(f.id) ? { ...f, selected } : f)) });
    try {
      await trpc.cyboflow.reviewItems.setSelected.mutate({ projectId, reviewItemIds, selected });
    } catch (err: unknown) {
      set({
        triageFindings: snapshot,
        error: err instanceof Error ? err.message : 'setSelected failed',
      });
    }
  };

  return {
    initialized: false,
    loading: false,
    error: null,
    projectFilter: null,
    workflowStats: [],
    workflowUsage: [],
    dailyUsage: [],
    reviewSummary: null,
    qualityFindings: [],
    triageFindings: [],
    stepTokens: {},
    usageTrends: {},
    revisionHistory: {},
    untriagedExpanded: false,
    readyShowAll: false,

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

      // Now that the global subs exist, wire the per-project review-item delta
      // subscriptions for the project set the first fetch resolved over (the
      // wire call inside runFetch no-op'd because lifecycleSubs was still empty).
      wireReviewItemSubscriptions(lastProjectIds);
    },

    refresh: async () => {
      await runFetch();
    },

    setProjectFilter: async (projectId) => {
      set({ projectFilter: projectId });
      await runFetch();
    },

    ensureWorkflowDetail: async (workflowId) => {
      // Already have all three slices for this id, or a fetch is in flight — nothing to do.
      const have = get();
      if (
        workflowId in have.stepTokens &&
        workflowId in have.usageTrends &&
        workflowId in have.revisionHistory
      ) {
        return;
      }
      if (detailInFlight.has(workflowId)) return;
      detailInFlight.add(workflowId);

      // The usageTrend query carries the current project filter (the cross-project
      // view passes null), mirroring the PHASE-2 fan-out. Each query is caught
      // individually: a failure is warned and that one slice is simply left absent
      // rather than aborting the other two or surfacing on `error`.
      const projectId = get().projectFilter;
      try {
        const [steps, trend, revisions] = await Promise.all([
          trpc.cyboflow.insights.stepTokens.query({ workflowId }).catch((err: unknown) => {
            console.warn(`[insightsStore] stepTokens:${workflowId} failed:`, err);
            return undefined;
          }),
          trpc.cyboflow.insights.usageTrend.query({ workflowId, projectId }).catch((err: unknown) => {
            console.warn(`[insightsStore] usageTrend:${workflowId} failed:`, err);
            return undefined;
          }),
          trpc.cyboflow.insights.revisionHistory.query({ workflowId }).catch((err: unknown) => {
            console.warn(`[insightsStore] revisionHistory:${workflowId} failed:`, err);
            return undefined;
          }),
        ]);

        // Merge ONLY this workflowId's entries onto the prior maps; a failed
        // (undefined) slice leaves its map untouched and other keys are preserved.
        const prev = get();
        const stepTokens: Record<string, StepTokenBucket[]> = { ...prev.stepTokens };
        const usageTrends: Record<string, UsageTrendPoint[]> = { ...prev.usageTrends };
        const revisionHistory: Record<string, WorkflowRevisionStats[]> = {
          ...prev.revisionHistory,
        };
        if (steps !== undefined) stepTokens[workflowId] = steps;
        if (trend !== undefined) usageTrends[workflowId] = trend;
        if (revisions !== undefined) revisionHistory[workflowId] = revisions;
        set({ stepTokens, usageTrends, revisionHistory });
      } finally {
        detailInFlight.delete(workflowId);
      }
    },

    toggleUntriagedExpand: () => set((s) => ({ untriagedExpanded: !s.untriagedExpanded })),
    toggleReadyShowAll: () => set((s) => ({ readyShowAll: !s.readyShowAll })),

    approveFinding: async (projectId, reviewItemId) => {
      const snapshot = get().triageFindings;
      // Optimistically stage + pre-select + flip the row to READY. The real
      // staged_at lands via the subscription; a non-null sentinel is enough for
      // the view-model derivation (triageState='ready') in the interim.
      set({
        triageFindings: snapshot.map((f) =>
          f.id === reviewItemId
            ? {
                ...f,
                staged_at: f.staged_at ?? new Date().toISOString(),
                selected: true,
                triageState: 'ready',
              }
            : f,
        ),
      });
      try {
        // Result type inferred from the tRPC client (never a local {staged:true} mirror).
        await trpc.cyboflow.reviewItems.approve.mutate({ projectId, reviewItemId });
      } catch (err: unknown) {
        set({
          triageFindings: snapshot,
          error: err instanceof Error ? err.message : 'approve failed',
        });
      }
    },

    dismissFinding: async (projectId, reviewItemId) => {
      const findingsBefore = get().triageFindings;
      const summaryBefore = get().reviewSummary;
      const qualityBefore = get().qualityFindings;
      const target = findingsBefore.find((f) => f.id === reviewItemId);

      // Optimistically remove the row, decrement findings-pending, and reflect a
      // dismissed quality finding so the strip's derived Dismissed bumps live
      // (before the debounced onReviewItemChanged refresh true-ups).
      const nextFindings = findingsBefore.filter((f) => f.id !== reviewItemId);
      const nextSummary = summaryBefore
        ? {
            ...summaryBefore,
            pendingByKind: {
              ...summaryBefore.pendingByKind,
              finding: Math.max(0, summaryBefore.pendingByKind.finding - 1),
            },
          }
        : summaryBefore;
      const nextQuality = applyDismissedToQuality(qualityBefore, target);
      set({ triageFindings: nextFindings, reviewSummary: nextSummary, qualityFindings: nextQuality });

      try {
        await trpc.cyboflow.reviewItems.dismiss.mutate({ projectId, reviewItemId });
      } catch (err: unknown) {
        set({
          triageFindings: findingsBefore,
          reviewSummary: summaryBefore,
          qualityFindings: qualityBefore,
          error: err instanceof Error ? err.message : 'dismiss failed',
        });
      }
    },

    setFindingTag: async (projectId, reviewItemId, proposedTarget) => {
      const snapshot = get().triageFindings;
      set({
        triageFindings: snapshot.map((f) =>
          f.id === reviewItemId ? withProposedTarget(f, proposedTarget) : f,
        ),
      });
      try {
        await trpc.cyboflow.reviewItems.setTag.mutate({ projectId, reviewItemId, proposedTarget });
      } catch (err: unknown) {
        set({
          triageFindings: snapshot,
          error: err instanceof Error ? err.message : 'setTag failed',
        });
      }
    },

    setFindingPriority: async (projectId, reviewItemId, priority) => {
      const snapshot = get().triageFindings;
      set({
        triageFindings: snapshot.map((f) => (f.id === reviewItemId ? { ...f, priority } : f)),
      });
      try {
        await trpc.cyboflow.reviewItems.setPriority.mutate({ projectId, reviewItemId, priority });
      } catch (err: unknown) {
        set({
          triageFindings: snapshot,
          error: err instanceof Error ? err.message : 'setPriority failed',
        });
      }
    },

    toggleFindingSelected: async (projectId, reviewItemId) => {
      const target = get().triageFindings.find((f) => f.id === reviewItemId);
      if (!target) return;
      await applySelection(projectId, [reviewItemId], !target.selected);
    },

    selectAllReady: async (projectId, selected) => {
      const ids = get()
        .triageFindings.filter((f) => f.triageState === 'ready')
        .map((f) => f.id);
      if (ids.length === 0) return;
      await applySelection(projectId, ids, selected);
    },

    selectBucket: async (projectId, bucket, selected) => {
      const buckets = selectReadyBuckets(get().triageFindings);
      const ids = buckets[bucket].map((f) => f.id);
      if (ids.length === 0) return;
      await applySelection(projectId, ids, selected);
    },
  };
});

// ---------------------------------------------------------------------------
// Optimistic-action helpers (module-private, pure — no store closure dependency).
// ---------------------------------------------------------------------------

/**
 * Return a copy of the finding with `proposedTarget` set on its payload WITHOUT
 * clobbering sibling payload fields (mirrors the backend `runMutate` merge): when
 * the payload is absent it synthesizes a minimal `{ kind:'finding', proposedTarget }`.
 */
function withProposedTarget(f: TriageFinding, proposedTarget: FindingProposedTarget): TriageFinding {
  const payload = f.payload;
  if (payload && payload.kind === 'finding') {
    return { ...f, payload: { ...payload, proposedTarget } };
  }
  return { ...f, payload: { kind: 'finding', proposedTarget } };
}

/**
 * Reflect a dismissed finding in the `qualityFindings` array so the strip's
 * client-derived Dismissed counter bumps live: flip an existing matching row's
 * status, else append a minimal dismissed QualityFinding synthesized from the
 * triage row. Returns the prior array untouched when there is no target.
 */
function applyDismissedToQuality(
  quality: QualityFinding[],
  target: TriageFinding | undefined,
): QualityFinding[] {
  if (!target) return quality;
  const existing = quality.find((q) => q.id === target.id);
  if (existing) {
    return quality.map((q) => (q.id === target.id ? { ...q, status: 'dismissed' } : q));
  }
  return [...quality, triageToQualityDismissed(target)];
}

/** Synthesize a minimal dismissed QualityFinding from a triage row (counter-only). */
function triageToQualityDismissed(target: TriageFinding): QualityFinding {
  const payload = target.payload;
  const locations =
    payload && payload.kind === 'finding' && payload.locations ? payload.locations : [];
  const category = payload && payload.kind === 'finding' ? (payload.category ?? null) : null;
  return {
    id: target.id,
    projectId: target.project_id,
    title: target.title,
    severity: target.severity,
    status: 'dismissed',
    source: target.source,
    sourceStep:
      target.source && target.source.startsWith('agent:')
        ? target.source.slice('agent:'.length)
        : null,
    category,
    locations,
    createdAt: target.created_at,
    resolution: null,
    runId: target.run_id,
    runOutcome: null,
    runEndedAt: null,
    workflowName: null,
  };
}
