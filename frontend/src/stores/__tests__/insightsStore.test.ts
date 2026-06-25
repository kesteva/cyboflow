/**
 * Unit tests for insightsStore.
 *
 * Two layers are exercised:
 *
 *   1. The PURE helpers (selectFanoutWorkflows, filterPendingFindings) — direct
 *      input/output assertions, no store instance.
 *   2. The store ACTIONS (init / refresh / setProjectFilter) against a mocked
 *      tRPC client + mocked projects IPC. Because the store's idempotency guard
 *      lives in a module-private closure, each store-behavior test re-imports the
 *      module fresh via vi.resetModules() + a dynamic import (see loadStore) so
 *      `initialized` starts false — there is no contract teardown handle.
 *
 * The tRPC client + projects API are mocked at module level so importing
 * insightsStore.ts does not require a live Electron IPC bridge. Mock paths are
 * relative to this test file: ../../trpc/client and ../../utils/api.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReviewItem, ReviewItemKind, ReviewItemStatus } from '../../../../shared/types/reviews';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  ReviewItemSummary,
  QualityFinding,
  StepTokenBucket,
  UsageTrendPoint,
  WorkflowRevisionStats,
  DailyModelUsagePoint,
} from '../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Mutable mock references — re-created in beforeEach so each test is isolated.
// The vi.mock factories read these via getters so swapping the reference takes
// effect even after the module under test captured `trpc`.
// ---------------------------------------------------------------------------

interface SubscribeHandlers {
  onData: (event: unknown) => void;
  onError?: (err: unknown) => void;
}

/** Captured onData callbacks for the run-status subscription (the debounce trigger we drive). */
let runStatusOnData: Array<(event: unknown) => void>;
/** Captured per-project onReviewItemChanged onData callbacks (the review-item delta trigger). */
let reviewItemOnData: Array<(event: unknown) => void>;

let mockWorkflowStatsQuery: ReturnType<typeof vi.fn>;
let mockWorkflowUsageQuery: ReturnType<typeof vi.fn>;
let mockDailyUsageQuery: ReturnType<typeof vi.fn>;
let mockReviewSummaryQuery: ReturnType<typeof vi.fn>;
let mockQualityFindingsQuery: ReturnType<typeof vi.fn>;
let mockStepTokensQuery: ReturnType<typeof vi.fn>;
let mockUsageTrendQuery: ReturnType<typeof vi.fn>;
let mockRevisionHistoryQuery: ReturnType<typeof vi.fn>;
let mockReviewItemsListQuery: ReturnType<typeof vi.fn>;
let mockApproveMutate: ReturnType<typeof vi.fn>;
let mockDismissMutate: ReturnType<typeof vi.fn>;
let mockSetTagMutate: ReturnType<typeof vi.fn>;
let mockSetPriorityMutate: ReturnType<typeof vi.fn>;
let mockSetSelectedMutate: ReturnType<typeof vi.fn>;
let mockProjectsGetAll: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: {
        workflowStats: { get query() { return mockWorkflowStatsQuery; } },
        workflowUsage: { get query() { return mockWorkflowUsageQuery; } },
        dailyUsage: { get query() { return mockDailyUsageQuery; } },
        reviewSummary: { get query() { return mockReviewSummaryQuery; } },
        qualityFindings: { get query() { return mockQualityFindingsQuery; } },
        stepTokens: { get query() { return mockStepTokensQuery; } },
        usageTrend: { get query() { return mockUsageTrendQuery; } },
        revisionHistory: { get query() { return mockRevisionHistoryQuery; } },
      },
      reviewItems: {
        list: { get query() { return mockReviewItemsListQuery; } },
        approve: { get mutate() { return mockApproveMutate; } },
        dismiss: { get mutate() { return mockDismissMutate; } },
        setTag: { get mutate() { return mockSetTagMutate; } },
        setPriority: { get mutate() { return mockSetPriorityMutate; } },
        setSelected: { get mutate() { return mockSetSelectedMutate; } },
        onReviewItemChanged: {
          subscribe: (_input: { projectId: number }, handlers: SubscribeHandlers) => {
            reviewItemOnData.push(handlers.onData);
            return { unsubscribe: vi.fn() };
          },
        },
      },
      events: {
        onRunStatusChanged: {
          subscribe: (_input: undefined, handlers: SubscribeHandlers) => {
            runStatusOnData.push(handlers.onData);
            return { unsubscribe: vi.fn() };
          },
        },
        onApprovalCreated: { subscribe: () => ({ unsubscribe: vi.fn() }) },
        onApprovalDecided: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

vi.mock('../../utils/api', () => ({
  API: { projects: { get getAll() { return mockProjectsGetAll; } } },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<WorkflowRunStats> & { workflowId: string }): WorkflowRunStats {
  return {
    workflowId: overrides.workflowId,
    workflowName: overrides.workflowName ?? overrides.workflowId,
    projectId: overrides.projectId ?? 1,
    totalRuns: overrides.totalRuns ?? 1,
    activeRuns: overrides.activeRuns ?? 0,
    completedRuns: overrides.completedRuns ?? 1,
    failedRuns: overrides.failedRuns ?? 0,
    canceledRuns: overrides.canceledRuns ?? 0,
    mergedRuns: overrides.mergedRuns ?? 0,
    dismissedRuns: overrides.dismissedRuns ?? 0,
    nullOutcomeRuns: overrides.nullOutcomeRuns ?? 0,
    errorRatePct: overrides.errorRatePct ?? 0,
    avgDurationMs: overrides.avgDurationMs ?? null,
    lastRunAt: overrides.lastRunAt ?? null,
  };
}

function makeUsage(workflowId: string): WorkflowUsageStats {
  return {
    workflowId,
    workflowName: workflowId,
    runsWithUsage: 1,
    avgTotalTokens: 100,
    totalTokens: 100,
    totalCacheTokens: 5000,
    totalCostUsd: 0.1,
    avgCostUsd: 0.1,
  };
}

function makeSummary(): ReviewItemSummary {
  return {
    total: 3,
    pending: 2,
    resolved: 1,
    dismissed: 0,
    pendingByKind: { finding: 1, permission: 0, decision: 1, human_task: 0 },
  };
}

function makeFinding(id: string): QualityFinding {
  return {
    id,
    projectId: 1,
    title: `finding ${id}`,
    severity: 'warning',
    status: 'pending',
    source: 'agent:executor',
    sourceStep: 'executor',
    category: null,
    locations: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    resolution: null,
    runId: 'run-1',
    runOutcome: null,
    runEndedAt: null,
    workflowName: 'sprint',
  };
}

function makeReviewItem(
  overrides: Partial<ReviewItem> & { id: string },
): ReviewItem {
  const kind: ReviewItemKind = overrides.kind ?? 'finding';
  const status: ReviewItemStatus = overrides.status ?? 'pending';
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id ?? null,
    entity_type: overrides.entity_type ?? null,
    entity_id: overrides.entity_id ?? null,
    kind,
    status,
    blocking: overrides.blocking ?? false,
    title: overrides.title ?? `item ${overrides.id}`,
    body: overrides.body ?? null,
    severity: overrides.severity ?? null,
    priority: overrides.priority ?? null,
    staged_at: overrides.staged_at ?? null,
    selected: overrides.selected ?? false,
    source: overrides.source ?? null,
    payload: overrides.payload ?? null,
    created_at: overrides.created_at ?? '2026-06-05T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-05T00:00:00.000Z',
    resolved_by: overrides.resolved_by ?? null,
    resolution: overrides.resolution ?? null,
  };
}

const DAILY_USAGE: DailyModelUsagePoint[] = [
  {
    day: '2026-06-10',
    model: 'claude-opus',
    inputTokens: 400,
    outputTokens: 100,
    totalTokens: 500,
    assistantMessageCount: 3,
  },
];
const STEP_BUCKET: StepTokenBucket[] = [
  { stepId: 'execute', totalTokens: 500, assistantMessageCount: 4 },
];
const TREND_POINTS: UsageTrendPoint[] = [
  { date: '2026-06-05', totalTokens: 500, runs: 1 },
];
const REVISION_HISTORY: WorkflowRevisionStats[] = [
  {
    workflowId: 'wf-sprint',
    specHash: 'feedface0000',
    firstSeenAt: '2026-06-05T00:00:00.000Z',
    isCurrent: true,
    runs: 2,
    mergedRuns: 2,
    failedRuns: 0,
    successRatePct: 100,
    avgTotalTokens: 1200,
  },
];

// ---------------------------------------------------------------------------
// Fresh-module store loader: re-import insightsStore so its closure-private
// `initialized` guard starts false in every store-behavior test.
// ---------------------------------------------------------------------------

type InsightsModule = typeof import('../insightsStore');

async function loadStore(): Promise<InsightsModule> {
  vi.resetModules();
  return import('../insightsStore');
}

beforeEach(() => {
  runStatusOnData = [];
  reviewItemOnData = [];
  mockWorkflowStatsQuery = vi.fn().mockResolvedValue([
    makeStats({ workflowId: 'wf-sprint', lastRunAt: '2026-06-10T00:00:00.000Z' }),
  ]);
  mockWorkflowUsageQuery = vi.fn().mockResolvedValue([makeUsage('wf-sprint')]);
  mockDailyUsageQuery = vi.fn().mockResolvedValue(DAILY_USAGE);
  mockReviewSummaryQuery = vi.fn().mockResolvedValue(makeSummary());
  mockQualityFindingsQuery = vi.fn().mockResolvedValue([makeFinding('q1')]);
  mockStepTokensQuery = vi.fn().mockResolvedValue(STEP_BUCKET);
  mockUsageTrendQuery = vi.fn().mockResolvedValue(TREND_POINTS);
  mockRevisionHistoryQuery = vi.fn().mockResolvedValue(REVISION_HISTORY);
  mockReviewItemsListQuery = vi.fn().mockResolvedValue([
    makeReviewItem({ id: 'f1', kind: 'finding', status: 'pending' }),
  ]);
  mockApproveMutate = vi.fn().mockResolvedValue({ reviewItemId: 'f1', staged: true });
  mockDismissMutate = vi.fn().mockResolvedValue({ reviewItemId: 'f1' });
  mockSetTagMutate = vi.fn().mockResolvedValue({ reviewItemId: 'f1' });
  mockSetPriorityMutate = vi.fn().mockResolvedValue({ reviewItemId: 'f1' });
  mockSetSelectedMutate = vi.fn().mockResolvedValue({ count: 1 });
  mockProjectsGetAll = vi.fn().mockResolvedValue({
    success: true,
    data: [{ id: 1, name: 'p1' }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('selectFanoutWorkflows', () => {
  it('caps at 6 workflows, newest-run first', async () => {
    const { selectFanoutWorkflows } = await loadStore();
    const stats = Array.from({ length: 9 }, (_v, i) =>
      makeStats({
        workflowId: `wf-${i}`,
        // i=0 newest (…09), i=8 oldest (…01).
        lastRunAt: `2026-06-${String(9 - i).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const out = selectFanoutWorkflows(stats);
    expect(out).toHaveLength(6);
    // Newest-first → wf-0 (06-09) down to wf-5 (06-04).
    expect(out.map((w) => w.workflowId)).toEqual(['wf-0', 'wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5']);
  });

  it('sorts never-run workflows (lastRunAt null) last', async () => {
    const { selectFanoutWorkflows } = await loadStore();
    const out = selectFanoutWorkflows([
      makeStats({ workflowId: 'never', lastRunAt: null }),
      makeStats({ workflowId: 'old', lastRunAt: '2026-06-01T00:00:00.000Z' }),
      makeStats({ workflowId: 'new', lastRunAt: '2026-06-09T00:00:00.000Z' }),
    ]);
    expect(out.map((w) => w.workflowId)).toEqual(['new', 'old', 'never']);
  });

  it('does not mutate its input', async () => {
    const { selectFanoutWorkflows } = await loadStore();
    const input = [
      makeStats({ workflowId: 'a', lastRunAt: '2026-06-01T00:00:00.000Z' }),
      makeStats({ workflowId: 'b', lastRunAt: '2026-06-09T00:00:00.000Z' }),
    ];
    selectFanoutWorkflows(input);
    expect(input.map((w) => w.workflowId)).toEqual(['a', 'b']);
  });
});

describe('filterPendingFindings', () => {
  it('keeps only kind=finding AND status=pending', async () => {
    const { filterPendingFindings } = await loadStore();
    const out = filterPendingFindings([
      makeReviewItem({ id: 'keep', kind: 'finding', status: 'pending' }),
      makeReviewItem({ id: 'drop-kind', kind: 'decision', status: 'pending' }),
      makeReviewItem({ id: 'drop-perm', kind: 'permission', status: 'pending' }),
      makeReviewItem({ id: 'drop-status', kind: 'finding', status: 'resolved' }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['keep']);
  });

  it('returns empty for an empty list', async () => {
    const { filterPendingFindings } = await loadStore();
    expect(filterPendingFindings([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// init() — first fetch + idempotency
// ---------------------------------------------------------------------------

describe('init()', () => {
  it('fetches every slice and populates state on first call', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();

    const s = useInsightsStore.getState();
    expect(s.initialized).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.workflowStats).toHaveLength(1);
    expect(s.workflowUsage).toHaveLength(1);
    // dailyUsage fetched in the PHASE-1 fan-out, projectId=null (cross-project).
    expect(s.dailyUsage).toEqual(DAILY_USAGE);
    expect(mockDailyUsageQuery).toHaveBeenCalledWith({ projectId: null });
    expect(s.reviewSummary).toEqual(makeSummary());
    expect(s.qualityFindings.map((f) => f.id)).toEqual(['q1']);
    // triageFindings fanned out via reviewItems.list (kept finding/pending), each
    // mapped to a TriageFinding view-model carrying a derived triageState.
    expect(s.triageFindings.map((f) => f.id)).toEqual(['f1']);
    expect(s.triageFindings[0].triageState).toBe('untriaged');
    // per-workflow detail keyed by workflowId for the single run workflow.
    expect(s.stepTokens['wf-sprint']).toEqual(STEP_BUCKET);
    expect(s.usageTrends['wf-sprint']).toEqual(TREND_POINTS);
    // revisionHistory rides the same per-workflow fan-out, keyed by workflowId.
    expect(s.revisionHistory['wf-sprint']).toEqual(REVISION_HISTORY);
    expect(mockRevisionHistoryQuery).toHaveBeenCalledWith({ workflowId: 'wf-sprint' });
  });

  it('passes projectId=null (cross-project) to the insights queries by default', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledWith({ projectId: null });
    // triageFindings enumerated the project list for the cross-project case.
    expect(mockProjectsGetAll).toHaveBeenCalledTimes(1);
    expect(mockReviewItemsListQuery).toHaveBeenCalledWith({
      projectId: 1,
      status: 'pending',
      kind: 'finding',
      requireMergedSession: true,
    });
  });

  it('keeps initialized=false while the first fetch is in flight (skeleton, not empty data)', async () => {
    // Gate the first fan-out on a manually-resolved promise so we can observe
    // the mid-flight state. InsightsView renders LoadingSkeleton while
    // `loading && !initialized`; if initialized flipped true before the fetch
    // settled the dashboard would paint empty zero-state sections as if loaded.
    let releaseStats: (value: WorkflowRunStats[]) => void = () => {};
    mockWorkflowStatsQuery.mockReturnValueOnce(
      new Promise<WorkflowRunStats[]>((resolve) => {
        releaseStats = resolve;
      }),
    );

    const { useInsightsStore } = await loadStore();
    const initPromise = useInsightsStore.getState().init();

    // Mid-flight: loading is on but the dashboard is NOT yet "initialized".
    const inFlight = useInsightsStore.getState();
    expect(inFlight.loading).toBe(true);
    expect(inFlight.initialized).toBe(false);

    // Let the fetch settle; only then does initialized flip true / loading off.
    releaseStats([makeStats({ workflowId: 'wf-sprint' })]);
    await initPromise;

    const done = useInsightsStore.getState();
    expect(done.initialized).toBe(true);
    expect(done.loading).toBe(false);
  });

  it('is idempotent — a second init() does NOT re-fetch', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    await useInsightsStore.getState().init();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(1);
  });

  it('subscribes to the run-status lifecycle signal exactly once', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    expect(runStatusOnData).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// refresh() — stale-on-error merge semantics
// ---------------------------------------------------------------------------

describe('refresh()', () => {
  it('does not flip loading (no UI flash) and re-fetches', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(1);

    await useInsightsStore.getState().refresh();
    expect(useInsightsStore.getState().loading).toBe(false);
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(2);
  });

  it('keeps the prior slice when a query fails on refresh (stale-not-cleared)', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    const goodStats = useInsightsStore.getState().workflowStats;
    expect(goodStats).toHaveLength(1);

    // Next refresh: workflowStats rejects, the rest still resolve.
    mockWorkflowStatsQuery.mockRejectedValueOnce(new Error('db locked'));
    await useInsightsStore.getState().refresh();

    const s = useInsightsStore.getState();
    // Stale workflowStats preserved (not cleared to []).
    expect(s.workflowStats).toEqual(goodStats);
    // Error string surfaced for the failure.
    expect(s.error).toContain('db locked');
    // A sibling slice that DID resolve is still present.
    expect(s.reviewSummary).toEqual(makeSummary());
  });

  it('clears the error on a subsequent clean refresh', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    mockWorkflowStatsQuery.mockRejectedValueOnce(new Error('transient'));
    await useInsightsStore.getState().refresh();
    expect(useInsightsStore.getState().error).toContain('transient');

    // Clean refresh — error resets to null.
    await useInsightsStore.getState().refresh();
    expect(useInsightsStore.getState().error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setProjectFilter()
// ---------------------------------------------------------------------------

describe('setProjectFilter()', () => {
  it('sets the filter and re-fetches with the filtered projectId', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    mockWorkflowStatsQuery.mockClear();
    mockReviewItemsListQuery.mockClear();
    mockProjectsGetAll.mockClear();

    await useInsightsStore.getState().setProjectFilter(7);

    expect(useInsightsStore.getState().projectFilter).toBe(7);
    expect(mockWorkflowStatsQuery).toHaveBeenCalledWith({ projectId: 7 });
    // Filtered case must NOT enumerate the project list — it targets project 7.
    expect(mockProjectsGetAll).not.toHaveBeenCalled();
    expect(mockReviewItemsListQuery).toHaveBeenCalledWith({
      projectId: 7,
      status: 'pending',
      kind: 'finding',
      requireMergedSession: true,
    });
  });
});

// ---------------------------------------------------------------------------
// ensureWorkflowDetail() — lazy per-workflow drill-down for out-of-cap workflows
// ---------------------------------------------------------------------------

describe('ensureWorkflowDetail()', () => {
  it('fetches and merges the three slices for a workflow missing from the maps', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    // The fan-out only populated 'wf-sprint'; 'wf-other' is out of the cap.
    expect(useInsightsStore.getState().stepTokens['wf-other']).toBeUndefined();

    mockStepTokensQuery.mockClear();
    mockUsageTrendQuery.mockClear();
    mockRevisionHistoryQuery.mockClear();

    await useInsightsStore.getState().ensureWorkflowDetail('wf-other');

    const s = useInsightsStore.getState();
    // The missing workflow's three slices are now present.
    expect(s.stepTokens['wf-other']).toEqual(STEP_BUCKET);
    expect(s.usageTrends['wf-other']).toEqual(TREND_POINTS);
    expect(s.revisionHistory['wf-other']).toEqual(REVISION_HISTORY);
    // usageTrend carried the current (null) project filter, like the fan-out.
    expect(mockStepTokensQuery).toHaveBeenCalledWith({ workflowId: 'wf-other' });
    expect(mockUsageTrendQuery).toHaveBeenCalledWith({
      workflowId: 'wf-other',
      projectId: null,
    });
    expect(mockRevisionHistoryQuery).toHaveBeenCalledWith({ workflowId: 'wf-other' });
    // The fan-out's existing workflow is untouched.
    expect(s.stepTokens['wf-sprint']).toEqual(STEP_BUCKET);
  });

  it('is a no-op when all three slices already carry the workflow id', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    // 'wf-sprint' was populated by the fan-out — all three maps have it.
    mockStepTokensQuery.mockClear();
    mockUsageTrendQuery.mockClear();
    mockRevisionHistoryQuery.mockClear();

    await useInsightsStore.getState().ensureWorkflowDetail('wf-sprint');

    // No re-fetch — the slices are already present.
    expect(mockStepTokensQuery).not.toHaveBeenCalled();
    expect(mockUsageTrendQuery).not.toHaveBeenCalled();
    expect(mockRevisionHistoryQuery).not.toHaveBeenCalled();
  });

  it('dedupes concurrent calls for the same workflow id', async () => {
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    mockStepTokensQuery.mockClear();

    // Fire two concurrent ensures for the same out-of-cap id before either settles.
    await Promise.all([
      useInsightsStore.getState().ensureWorkflowDetail('wf-other'),
      useInsightsStore.getState().ensureWorkflowDetail('wf-other'),
    ]);

    // The second call short-circuited on the in-flight set → one fetch only.
    expect(mockStepTokensQuery).toHaveBeenCalledTimes(1);
  });

  it('leaves the other two slices when one per-workflow query fails (warned, not surfaced)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useInsightsStore } = await loadStore();
    await useInsightsStore.getState().init();
    const errorBefore = useInsightsStore.getState().error;

    mockUsageTrendQuery.mockRejectedValueOnce(new Error('trend boom'));
    await useInsightsStore.getState().ensureWorkflowDetail('wf-other');

    const s = useInsightsStore.getState();
    // stepTokens + revisionHistory still merged; usageTrend left absent.
    expect(s.stepTokens['wf-other']).toEqual(STEP_BUCKET);
    expect(s.revisionHistory['wf-other']).toEqual(REVISION_HISTORY);
    expect(s.usageTrends['wf-other']).toBeUndefined();
    // The failure is console.warn'd, NOT surfaced on the store's `error`.
    expect(warnSpy).toHaveBeenCalled();
    expect(s.error).toBe(errorBefore);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Debounced event-driven refresh
// ---------------------------------------------------------------------------

describe('debounced live refresh', () => {
  it('debounces lifecycle events: many events → a single refresh after 2s', async () => {
    vi.useFakeTimers();
    const { useInsightsStore } = await loadStore();
    // init() awaits a real microtask chain; run timers so the awaited fetch
    // promises settle under fake timers.
    const initPromise = useInsightsStore.getState().init();
    await vi.runAllTimersAsync();
    await initPromise;

    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(1);
    expect(runStatusOnData).toHaveLength(1);
    const fire = runStatusOnData[0];

    // Three events inside the debounce window collapse to one refresh.
    fire({ runId: 'r1', status: 'running' });
    fire({ runId: 'r1', status: 'awaiting_review' });
    fire({ runId: 'r2', status: 'running' });

    // Before the window elapses: no refresh yet.
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(1);

    // Cross the 2s boundary → exactly one debounced refresh.
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(2);
  });

  it('separate event bursts past the window each trigger a refresh', async () => {
    vi.useFakeTimers();
    const { useInsightsStore } = await loadStore();
    const initPromise = useInsightsStore.getState().init();
    await vi.runAllTimersAsync();
    await initPromise;
    const fire = runStatusOnData[0];

    fire({ runId: 'r1', status: 'running' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(2);

    fire({ runId: 'r2', status: 'running' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(3);
  });

  it('per-project onReviewItemChanged delta triggers a debounced refresh', async () => {
    vi.useFakeTimers();
    const { useInsightsStore } = await loadStore();
    const initPromise = useInsightsStore.getState().init();
    await vi.runAllTimersAsync();
    await initPromise;

    // The single (cross-project, one project) review-item subscription was wired.
    expect(reviewItemOnData).toHaveLength(1);
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(1);

    // A ReviewItemRouter delta (dismiss/re-tag/select from any surface) refreshes.
    reviewItemOnData[0]({ projectId: 1, item: { id: 'f1' } });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();
    expect(mockWorkflowStatsQuery).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Optimistic triage actions — patch in place, roll back on reject, infer types
// ---------------------------------------------------------------------------

/**
 * Seed the store with a known triageFindings set by pointing the list mock at
 * the given review items, then init().
 */
async function loadStoreWith(items: ReviewItem[]): Promise<InsightsModule> {
  mockReviewItemsListQuery.mockResolvedValue(items);
  const mod = await loadStore();
  await mod.useInsightsStore.getState().init();
  return mod;
}

describe('approveFinding (optimistic)', () => {
  it('stages (without selecting) + flips the row to ready, then awaits approve', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, selected: false }),
    ]);

    await useInsightsStore.getState().approveFinding(1, 'f1');

    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    expect(row?.triageState).toBe('ready');
    expect(row?.staged_at).not.toBeNull();
    expect(row?.selected).toBe(false); // approve stages a candidate; selection is separate
    expect(mockApproveMutate).toHaveBeenCalledWith({ projectId: 1, reviewItemId: 'f1' });
    expect(useInsightsStore.getState().error).toBeNull();
  });

  it('rolls back the optimistic patch and records the error on reject', async () => {
    mockApproveMutate.mockRejectedValueOnce(new Error('approve boom'));
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, selected: false }),
    ]);

    await useInsightsStore.getState().approveFinding(1, 'f1');

    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    // Restored to the untriaged snapshot.
    expect(row?.triageState).toBe('untriaged');
    expect(row?.staged_at).toBeNull();
    expect(row?.selected).toBe(false);
    expect(useInsightsStore.getState().error).toContain('approve boom');
  });
});

describe('dismissFinding (optimistic, counter bump)', () => {
  it('removes the row and bumps the Dismissed counter WITHOUT a run-lifecycle event', async () => {
    const { useInsightsStore, selectFindingsCounters } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, selected: false }),
    ]);
    const before = useInsightsStore.getState();
    const countsBefore = selectFindingsCounters(before.triageFindings, before.qualityFindings);

    await useInsightsStore.getState().dismissFinding(1, 'f1');

    const after = useInsightsStore.getState();
    // Row gone from the triage set.
    expect(after.triageFindings.find((f) => f.id === 'f1')).toBeUndefined();
    const countsAfter = selectFindingsCounters(after.triageFindings, after.qualityFindings);
    // Pending decremented, Dismissed incremented — no lifecycle event fired.
    expect(countsAfter.pending).toBe(countsBefore.pending - 1);
    expect(countsAfter.dismissed).toBe(countsBefore.dismissed + 1);
    expect(mockDismissMutate).toHaveBeenCalledWith({ projectId: 1, reviewItemId: 'f1' });
  });

  it('rolls back the removal AND the counter on reject', async () => {
    mockDismissMutate.mockRejectedValueOnce(new Error('dismiss boom'));
    const { useInsightsStore, selectFindingsCounters } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, selected: false }),
    ]);
    const before = useInsightsStore.getState();
    const countsBefore = selectFindingsCounters(before.triageFindings, before.qualityFindings);

    await useInsightsStore.getState().dismissFinding(1, 'f1');

    const after = useInsightsStore.getState();
    expect(after.triageFindings.find((f) => f.id === 'f1')).toBeDefined();
    const countsAfter = selectFindingsCounters(after.triageFindings, after.qualityFindings);
    expect(countsAfter).toEqual(countsBefore);
    expect(after.error).toContain('dismiss boom');
  });
});

describe('setFindingTag / setFindingPriority (optimistic)', () => {
  it('re-tags in place without clobbering sibling payload fields', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({
        id: 'f1',
        staged_at: null,
        payload: { kind: 'finding', category: 'security', proposedTarget: 'docs' },
      }),
    ]);

    await useInsightsStore.getState().setFindingTag(1, 'f1', 'fix');

    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    expect(row?.payload).toEqual({ kind: 'finding', category: 'security', proposedTarget: 'fix' });
    expect(mockSetTagMutate).toHaveBeenCalledWith({
      projectId: 1,
      reviewItemId: 'f1',
      proposedTarget: 'fix',
    });
  });

  it('synthesizes a finding payload when re-tagging a finding with none', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, payload: null }),
    ]);
    await useInsightsStore.getState().setFindingTag(1, 'f1', 'backlog');
    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    expect(row?.payload).toEqual({ kind: 'finding', proposedTarget: 'backlog' });
  });

  it('re-prioritizes in place and rolls back on reject', async () => {
    mockSetPriorityMutate.mockRejectedValueOnce(new Error('prio boom'));
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, priority: null }),
    ]);

    await useInsightsStore.getState().setFindingPriority(1, 'f1', 'P0');

    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    // Rolled back to the null-priority snapshot.
    expect(row?.priority).toBeNull();
    expect(useInsightsStore.getState().error).toContain('prio boom');
  });
});

describe('selection toggles (optimistic)', () => {
  it('toggleFindingSelected flips one ready row and forwards [id]', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: '2026-06-06T00:00:00.000Z', selected: false }),
    ]);

    await useInsightsStore.getState().toggleFindingSelected(1, 'f1');

    const row = useInsightsStore.getState().triageFindings.find((f) => f.id === 'f1');
    expect(row?.selected).toBe(true);
    expect(mockSetSelectedMutate).toHaveBeenCalledWith({
      projectId: 1,
      reviewItemIds: ['f1'],
      selected: true,
    });
  });

  it('selectAllReady toggles every ready row (untriaged untouched)', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'r1', staged_at: '2026-06-06T00:00:00.000Z', selected: false }),
      makeReviewItem({ id: 'r2', staged_at: '2026-06-06T00:00:01.000Z', selected: false }),
      makeReviewItem({ id: 'u1', staged_at: null, selected: false }),
    ]);

    await useInsightsStore.getState().selectAllReady(1, true);

    const s = useInsightsStore.getState();
    expect(s.triageFindings.find((f) => f.id === 'r1')?.selected).toBe(true);
    expect(s.triageFindings.find((f) => f.id === 'r2')?.selected).toBe(true);
    // The untriaged row was not part of the selection set.
    expect(s.triageFindings.find((f) => f.id === 'u1')?.selected).toBe(false);
    expect(mockSetSelectedMutate).toHaveBeenCalledWith({
      projectId: 1,
      reviewItemIds: ['r1', 'r2'],
      selected: true,
    });
  });

  it('selectBucket toggles only the matching bucket and rolls back on reject', async () => {
    mockSetSelectedMutate.mockRejectedValueOnce(new Error('select boom'));
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({
        id: 'q1',
        staged_at: '2026-06-06T00:00:00.000Z',
        selected: false,
        payload: { kind: 'finding', proposedTarget: 'fix' },
      }),
      makeReviewItem({
        id: 't1',
        staged_at: '2026-06-06T00:00:01.000Z',
        selected: false,
        payload: { kind: 'finding', proposedTarget: 'backlog' },
      }),
    ]);

    await useInsightsStore.getState().selectBucket(1, 'quick', true);

    const s = useInsightsStore.getState();
    // Rejected → both restored to the unselected snapshot.
    expect(s.triageFindings.find((f) => f.id === 'q1')?.selected).toBe(false);
    expect(s.triageFindings.find((f) => f.id === 't1')?.selected).toBe(false);
    expect(mockSetSelectedMutate).toHaveBeenCalledWith({
      projectId: 1,
      reviewItemIds: ['q1'],
      selected: true,
    });
    expect(s.error).toContain('select boom');
  });
});

describe('reconcile-by-id against the subscription (no duplicate/flicker)', () => {
  it('a refresh replaces the optimistic row by id rather than appending', async () => {
    const { useInsightsStore } = await loadStoreWith([
      makeReviewItem({ id: 'f1', staged_at: null, selected: false }),
    ]);

    // Optimistically approve (row flips to ready locally).
    await useInsightsStore.getState().approveFinding(1, 'f1');
    expect(useInsightsStore.getState().triageFindings).toHaveLength(1);

    // Server truth now returns the same id, staged (the subscription's refresh).
    mockReviewItemsListQuery.mockResolvedValueOnce([
      makeReviewItem({ id: 'f1', staged_at: '2026-06-06T00:00:00.000Z', selected: true }),
    ]);
    await useInsightsStore.getState().refresh();

    const s = useInsightsStore.getState();
    // Reconciled by id — exactly one row, no duplicate.
    expect(s.triageFindings).toHaveLength(1);
    expect(s.triageFindings[0].id).toBe('f1');
    expect(s.triageFindings[0].triageState).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// UI toggles
// ---------------------------------------------------------------------------

describe('view-only toggles', () => {
  it('toggleUntriagedExpand / toggleReadyShowAll flip their flags', async () => {
    const { useInsightsStore } = await loadStore();
    expect(useInsightsStore.getState().untriagedExpanded).toBe(false);
    expect(useInsightsStore.getState().readyShowAll).toBe(false);

    useInsightsStore.getState().toggleUntriagedExpand();
    useInsightsStore.getState().toggleReadyShowAll();

    expect(useInsightsStore.getState().untriagedExpanded).toBe(true);
    expect(useInsightsStore.getState().readyShowAll).toBe(true);
  });
});
