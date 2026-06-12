/**
 * landingStore — cross-project aggregation store for the landing home.
 *
 * The landing experience is a single home view that spans ALL projects, not the
 * per-project rail. It aggregates three things:
 *   - the project list (API.projects.getAll)
 *   - the pending review_items inbox per project (trpc.cyboflow.reviewItems.list)
 *   - (reused) the active workflow runs from {@link useActiveRunsStore}
 *
 * ## Reuse, do NOT re-fetch
 *
 * Runs already have a single authoritative source — {@link useActiveRunsStore}
 * (runsByProject + refresh + the global lifecycle subscriptions). This store
 * does NOT re-implement that: `init()` calls `useActiveRunsStore.getState().init()`
 * (idempotent) and `refresh(projectId)` per project so runs populate, and the
 * aggregation hooks read `runsByProject` directly. Real-time approvals likewise
 * live in {@link useReviewQueueStore} — the landing UI reads that store directly
 * rather than duplicating its queue here.
 *
 * What this store DOES own is the cross-project review_items fan-out: the
 * per-project `reviewItems.list({ projectId, status: 'pending' })` query plus the
 * per-project `onReviewItemChanged` delta subscriptions, keyed by projectId.
 *
 * ## Reactivity strategy (mirrors activeRunsStore)
 *
 * The full-state fan-out is the source of truth. Two layers keep it fresh:
 *   1. Per-project `onReviewItemChanged` deltas upsert into the matching bucket
 *      (cheap, no re-query).
 *   2. The GLOBAL lifecycle signals that activeRunsStore also uses
 *      (onRunStatusChanged / onApprovalCreated / onApprovalDecided) trigger a
 *      DEBOUNCED (~150ms) full re-sync of projects + review_items, because those
 *      events can change the project set or the pending inbox without emitting a
 *      per-project review-item delta.
 *
 * All failures are caught and `console.warn`-ed (never thrown), mirroring
 * activeRunsStore. `init()` returns an unsubscribe that tears down every
 * subscription it created (review-item deltas + lifecycle signals).
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import { trpc } from '../trpc/client';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { ReviewItem } from '../../../shared/types/reviews';
import { useActiveRunsStore, type ActiveRunRow } from './activeRunsStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the global-lifecycle-driven full re-sync. */
const RESYNC_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Pure reducer helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Upsert a single review item into a per-project list. Returns a NEW array.
 *  - If the item is no longer pending, REMOVE it (the landing inbox only shows
 *    pending work — a resolved/dismissed item must drop out).
 *  - Else replace the matching id in place, or append if it is new.
 */
export function upsertReviewItem(list: ReviewItem[], item: ReviewItem): ReviewItem[] {
  if (item.status !== 'pending') {
    return list.filter((it) => it.id !== item.id);
  }
  const idx = list.findIndex((it) => it.id === item.id);
  if (idx === -1) {
    return [...list, item];
  }
  const next = list.slice();
  next[idx] = item;
  return next;
}

/**
 * Flatten the per-project review buckets into a single list of the items the
 * landing home surfaces: pending DECISION + HUMAN_TASK items only. Findings are
 * non-blocking noise here and permission gates belong to the real-time approval
 * queue (useReviewQueueStore), so both are dropped.
 */
export function flattenPendingReviewItems(
  byProject: Record<number, ReviewItem[]>,
): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const list of Object.values(byProject)) {
    for (const item of list) {
      if (
        item.status === 'pending' &&
        (item.kind === 'decision' || item.kind === 'human_task')
      ) {
        out.push(item);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface LandingState {
  /** All projects (cross-project home). Empty until `init()` runs. */
  projects: Project[];
  /** Pending review items keyed by projectId. Empty until `init()` runs. */
  reviewItemsByProject: Record<number, ReviewItem[]>;
  /** True while the initial fan-out is in flight. */
  loading: boolean;

  /**
   * Bootstrap the landing aggregation:
   *   (a) init + refresh the reused runs store for every known project,
   *   (b) load the project list,
   *   (c) fan out the pending review_items query per project,
   *   (d) subscribe to per-project review-item deltas,
   *   (e) subscribe to the global lifecycle signals → DEBOUNCED full re-sync.
   * Idempotent. Returns an unsubscribe that tears down every subscription.
   */
  init: () => (() => void);
}

export const useLandingStore = create<LandingState>((set) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  // Per-project review-item delta subscriptions, keyed by projectId so we can
  // tear down stale ones when the project set changes.
  const reviewItemSubs = new Map<number, { unsubscribe: () => void }>();
  // Global lifecycle subscriptions (created once in init).
  const lifecycleSubs: Array<{ unsubscribe: () => void }> = [];
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fetch the project list. Returns [] (and warns) on failure. */
  const fetchProjects = async (): Promise<Project[]> => {
    try {
      const res = await API.projects.getAll();
      if (res.success && res.data) return res.data;
      console.warn('[landingStore] projects.getAll returned no data:', res.error);
      return [];
    } catch (err: unknown) {
      console.warn('[landingStore] projects.getAll failed:', err);
      return [];
    }
  };

  /** Fetch the pending review inbox for one project. Returns [] on failure. */
  const fetchReviewItems = async (projectId: number): Promise<ReviewItem[]> => {
    try {
      return await trpc.cyboflow.reviewItems.list.query({ projectId, status: 'pending' });
    } catch (err: unknown) {
      console.warn('[landingStore] reviewItems.list failed for project', projectId, err);
      return [];
    }
  };

  /** Upsert a single delta into the bucket for its project. */
  const applyReviewItemDelta = (projectId: number, item: ReviewItem): void => {
    set((state) => {
      const current = state.reviewItemsByProject[projectId] ?? [];
      return {
        reviewItemsByProject: {
          ...state.reviewItemsByProject,
          [projectId]: upsertReviewItem(current, item),
        },
      };
    });
  };

  /** (Re)subscribe to per-project review-item deltas for exactly `projectIds`. */
  const wireReviewItemSubscriptions = (projectIds: number[]): void => {
    const wanted = new Set(projectIds);
    // Drop subscriptions for projects that no longer exist.
    for (const [pid, sub] of reviewItemSubs) {
      if (!wanted.has(pid)) {
        sub.unsubscribe();
        reviewItemSubs.delete(pid);
      }
    }
    // Add subscriptions for projects we are not yet watching.
    for (const projectId of projectIds) {
      if (reviewItemSubs.has(projectId)) continue;
      const sub = trpc.cyboflow.reviewItems.onReviewItemChanged.subscribe(
        { projectId },
        {
          onData: (event) => {
            // event.projectId is authoritative; key the bucket by it.
            applyReviewItemDelta(event.projectId, event.item);
          },
          onError: (err: unknown) =>
            console.warn('[landingStore] onReviewItemChanged error for project', projectId, err),
        },
      );
      reviewItemSubs.set(projectId, sub);
    }
  };

  /**
   * Full re-sync of projects + review_items (the authoritative fan-out). Also
   * re-wires per-project delta subscriptions and refreshes the reused runs
   * store for the current project set.
   */
  const resync = async (): Promise<void> => {
    const projects = await fetchProjects();
    const projectIds = projects.map((p) => p.id);

    // Reuse the runs store: refresh every project so runsByProject populates.
    for (const pid of projectIds) {
      void useActiveRunsStore.getState().refresh(pid);
    }

    const lists = await Promise.all(projectIds.map((pid) => fetchReviewItems(pid)));
    const reviewItemsByProject: Record<number, ReviewItem[]> = {};
    projectIds.forEach((pid, i) => {
      reviewItemsByProject[pid] = lists[i];
    });

    wireReviewItemSubscriptions(projectIds);
    set({ projects, reviewItemsByProject, loading: false });
  };

  /** Debounced full re-sync fired by the global lifecycle signals. */
  const scheduleResync = (): void => {
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      void resync();
    }, RESYNC_DEBOUNCE_MS);
  };

  return {
    projects: [],
    reviewItemsByProject: {},
    loading: false,

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;

      set({ loading: true });

      // (a) Reused runs store — idempotent init wires its own global lifecycle
      // subscriptions; resync() below refreshes each project.
      useActiveRunsStore.getState().init();

      // (b)+(c)+(d) Initial fan-out (also wires per-project delta subscriptions).
      void resync();

      // (e) Global lifecycle signals → debounced full re-sync. These are the same
      // signals activeRunsStore uses; they can change the project set or pending
      // inbox without a per-project review-item delta.
      const onLifecycle = () => scheduleResync();

      // Project creation fires NO run/approval lifecycle signal, so without
      // this the landing keeps its stale (possibly empty) project list until
      // some run activity happens — the home showed "Add your first project"
      // with a freshly-created project already in the rail. CreateProjectDialog
      // broadcasts this window event on every successful create.
      window.addEventListener('project-created', onLifecycle);

      lifecycleSubs.push(
        trpc.cyboflow.events.onRunStatusChanged.subscribe(undefined, {
          onData: onLifecycle,
          onError: (err: unknown) =>
            console.warn('[landingStore] onRunStatusChanged error:', err),
        }),
        trpc.cyboflow.events.onApprovalCreated.subscribe(undefined, {
          onData: onLifecycle,
          onError: (err: unknown) =>
            console.warn('[landingStore] onApprovalCreated error:', err),
        }),
        trpc.cyboflow.events.onApprovalDecided.subscribe(undefined, {
          onData: onLifecycle,
          onError: (err: unknown) =>
            console.warn('[landingStore] onApprovalDecided error:', err),
        }),
      );

      const unsubscribe = () => {
        if (resyncTimer !== null) {
          clearTimeout(resyncTimer);
          resyncTimer = null;
        }
        window.removeEventListener('project-created', onLifecycle);
        for (const sub of reviewItemSubs.values()) sub.unsubscribe();
        reviewItemSubs.clear();
        for (const sub of lifecycleSubs) sub.unsubscribe();
        lifecycleSubs.length = 0;
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

/** The cross-project list. */
export const useLandingProjects = (): Project[] => useLandingStore((s) => s.projects);

/** Number of projects (scalar — stable, no new reference per render). */
export const useProjectsCount = (): number => useLandingStore((s) => s.projects.length);

/**
 * Pending DECISION + HUMAN_TASK items across all projects. Derived from the
 * stable `reviewItemsByProject` slice via useMemo so it does not return a fresh
 * array reference every render (which would loop the subscriber).
 */
export function useAggregatedReviewItems(): ReviewItem[] {
  const byProject = useLandingStore((s) => s.reviewItemsByProject);
  return useMemo(() => flattenPendingReviewItems(byProject), [byProject]);
}

/**
 * All active runs across every project, flattened from the REUSED
 * {@link useActiveRunsStore} (never re-fetched here). Memoized on the stable
 * `runsByProject` slice.
 */
export function useAggregatedRuns(): ActiveRunRow[] {
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  return useMemo(() => {
    const out: ActiveRunRow[] = [];
    for (const runs of Object.values(runsByProject)) out.push(...runs);
    return out;
  }, [runsByProject]);
}

/**
 * runId → project_id map built from the aggregated runs, so a consumer holding
 * a runId (e.g. an approval) can resolve which project it belongs to.
 */
export function useRunProjectMap(): Record<string, number> {
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  return useMemo(() => {
    const map: Record<string, number> = {};
    for (const runs of Object.values(runsByProject)) {
      for (const run of runs) map[run.id] = run.project_id;
    }
    return map;
  }, [runsByProject]);
}
