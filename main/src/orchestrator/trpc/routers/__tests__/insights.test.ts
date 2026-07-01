/**
 * Router-layer tests for the cyboflow.insights procedures.
 *
 * SCOPE — input validation + pass-through wiring ONLY. The seven SELECT helpers
 * in `../../insightsQueries` (and their SQL projections) are covered by that
 * module's own colocated tests; here we stub the entire module via vi.mock so the
 * caller exercises EXCLUSIVELY:
 *   1. zod input rejection (projectId 0 / negative, out-of-range days / limits,
 *      empty required strings) — bad input must never reach a helper.
 *   2. db precondition guard (missing ctx.db → PRECONDITION_FAILED).
 *   3. helper delegation (the right helper is called with the parsed args).
 *   4. result pass-through (the helper's return value is returned verbatim).
 *   5. runUsage's documented zeroed-fallback when the helper returns no rollup.
 *
 * The mocked module is the seam: each helper is a vi.fn() whose return value we
 * control per-test, so no SQLite / DatabaseLike fixture is needed (ctx.db is a
 * bare sentinel — the guard only checks truthiness, the mocked helpers ignore it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  RunUsageRollup,
  ReviewItemSummary,
  QualityFinding,
  StepTokenBucket,
  UsageTrendPoint,
  WorkflowRevisionStats,
  RunEval,
} from '../../../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Mock the (concurrently-authored) insightsQueries module at the canonical
// resolved path the router imports (main/src/orchestrator/insightsQueries — i.e.
// '../../../insightsQueries' from this __tests__ dir, matching the router's
// '../../insightsQueries' from one level up). The factory replaces the real
// module entirely, so these tests neither depend on its runtime behavior nor on a
// live DB — they assert the router's own input + wiring contract in isolation.
// ---------------------------------------------------------------------------

vi.mock('../../../insightsQueries', () => ({
  selectWorkflowRunStats: vi.fn(),
  selectWorkflowUsageStats: vi.fn(),
  selectRunUsageRollups: vi.fn(),
  selectReviewItemSummary: vi.fn(),
  selectQualityFindings: vi.fn(),
  selectStepTokenBuckets: vi.fn(),
  selectUsageTrend: vi.fn(),
  selectWorkflowRevisionStats: vi.fn(),
  getRunEval: vi.fn(),
}));

// Imported AFTER vi.mock is hoisted so the router (and these handles) bind to the
// mocked module.
import * as insightsQueries from '../../../insightsQueries';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { DatabaseLike } from '../../../types';

// A bare sentinel db: the router's requireDb guard only checks truthiness and the
// mocked helpers ignore the argument, so no real prepare/transaction is needed.
const fakeDb = {} as DatabaseLike;

/** Typed accessor for a mocked helper (avoids `any` while reaching .mock APIs). */
function mocked<T extends keyof typeof insightsQueries>(name: T) {
  return vi.mocked(insightsQueries[name]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// workflowStats
// ---------------------------------------------------------------------------

describe('cyboflow.insights.workflowStats', () => {
  const sample: WorkflowRunStats[] = [
    {
      workflowId: 'wf-1',
      workflowName: 'Sprint',
      projectId: 1,
      totalRuns: 3,
      activeRuns: 1,
      completedRuns: 1,
      failedRuns: 1,
      canceledRuns: 0,
      mergedRuns: 1,
      dismissedRuns: 0,
      nullOutcomeRuns: 0,
      errorRatePct: 50,
      avgDurationMs: 1200,
      lastRunAt: '2026-06-11T00:00:00.000Z',
    },
  ];

  it('passes the parsed projectId through and returns the helper result verbatim', async () => {
    mocked('selectWorkflowRunStats').mockReturnValue(sample);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.workflowStats({ projectId: 7 });

    expect(result).toBe(sample);
    expect(insightsQueries.selectWorkflowRunStats).toHaveBeenCalledOnce();
    expect(insightsQueries.selectWorkflowRunStats).toHaveBeenCalledWith(fakeDb, 7);
  });

  it('accepts projectId null (all-projects aggregate)', async () => {
    mocked('selectWorkflowRunStats').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.workflowStats({ projectId: null });

    expect(insightsQueries.selectWorkflowRunStats).toHaveBeenCalledWith(fakeDb, null);
  });

  it('rejects projectId 0 (not positive) without calling the helper', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.workflowStats({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectWorkflowRunStats).not.toHaveBeenCalled();
  });

  it('rejects a negative projectId without calling the helper', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.workflowStats({ projectId: -3 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectWorkflowRunStats).not.toHaveBeenCalled();
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    mocked('selectWorkflowRunStats').mockReturnValue(sample);
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.insights.workflowStats({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
    expect(insightsQueries.selectWorkflowRunStats).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// workflowUsage
// ---------------------------------------------------------------------------

describe('cyboflow.insights.workflowUsage', () => {
  const sample: WorkflowUsageStats[] = [
    {
      workflowId: 'wf-1',
      workflowName: 'Sprint',
      runsWithUsage: 2,
      avgTotalTokens: 1500,
      totalTokens: 3000,
      totalCacheTokens: 120000,
      totalCostUsd: 0.42,
      avgCostUsd: 0.21,
    },
  ];

  it('forwards projectId + limitRunsPerWorkflow to the helper', async () => {
    mocked('selectWorkflowUsageStats').mockReturnValue(sample);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.workflowUsage({
      projectId: 2,
      limitRunsPerWorkflow: 25,
    });

    expect(result).toBe(sample);
    expect(insightsQueries.selectWorkflowUsageStats).toHaveBeenCalledWith(fakeDb, 2, 25);
  });

  it('passes limitRunsPerWorkflow undefined when omitted', async () => {
    mocked('selectWorkflowUsageStats').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.workflowUsage({ projectId: null });

    expect(insightsQueries.selectWorkflowUsageStats).toHaveBeenCalledWith(fakeDb, null, undefined);
  });

  it('rejects limitRunsPerWorkflow above 500', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.workflowUsage({ projectId: 1, limitRunsPerWorkflow: 501 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectWorkflowUsageStats).not.toHaveBeenCalled();
  });

  it('rejects a non-integer limitRunsPerWorkflow', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.workflowUsage({ projectId: 1, limitRunsPerWorkflow: 3.5 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// runUsage — including the documented zeroed fallback
// ---------------------------------------------------------------------------

describe('cyboflow.insights.runUsage', () => {
  const rollup: RunUsageRollup = {
    runId: 'run-1',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    totalTokens: 150,
    costUsd: 0.01,
    numTurns: 3,
    assistantMessageCount: 4,
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T10:05:00.000Z',
  };

  it('returns the single rollup when the helper produces one (wrapped in a single-element array)', async () => {
    mocked('selectRunUsageRollups').mockReturnValue([rollup]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.runUsage({ runId: 'run-1' });

    expect(result).toBe(rollup);
    expect(insightsQueries.selectRunUsageRollups).toHaveBeenCalledWith(fakeDb, ['run-1']);
  });

  it('returns a ZEROED rollup keyed to the runId when the helper returns no row', async () => {
    mocked('selectRunUsageRollups').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.runUsage({ runId: 'run-empty' });

    expect(result).toEqual({
      runId: 'run-empty',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: null,
      numTurns: null,
      assistantMessageCount: 0,
      startedAt: null,
      endedAt: null,
    });
  });

  it('rejects an empty runId without calling the helper', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.runUsage({ runId: '' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectRunUsageRollups).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // runEval — pass-through of the helper's row-or-null
  // -------------------------------------------------------------------------

  it('runEval returns the helper row verbatim and forwards the runId', async () => {
    const evalRow = { runId: 'run-1', evalStatus: 'complete' } as unknown as RunEval;
    mocked('getRunEval').mockReturnValue(evalRow);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.runEval({ runId: 'run-1' });

    expect(result).toBe(evalRow);
    expect(insightsQueries.getRunEval).toHaveBeenCalledWith(fakeDb, 'run-1');
  });

  it('runEval hands null straight through when no eval exists', async () => {
    mocked('getRunEval').mockReturnValue(null);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.runEval({ runId: 'run-x' });

    expect(result).toBeNull();
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.insights.runUsage({ runId: 'run-1' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// reviewSummary
// ---------------------------------------------------------------------------

describe('cyboflow.insights.reviewSummary', () => {
  const summary: ReviewItemSummary = {
    total: 5,
    pending: 3,
    resolved: 1,
    dismissed: 1,
    pendingByKind: { finding: 1, permission: 1, decision: 1, human_task: 0 },
  };

  it('forwards projectId and returns the summary verbatim', async () => {
    mocked('selectReviewItemSummary').mockReturnValue(summary);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.reviewSummary({ projectId: 3 });

    expect(result).toBe(summary);
    expect(insightsQueries.selectReviewItemSummary).toHaveBeenCalledWith(fakeDb, 3);
  });

  it('accepts projectId null', async () => {
    mocked('selectReviewItemSummary').mockReturnValue(summary);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.reviewSummary({ projectId: null });

    expect(insightsQueries.selectReviewItemSummary).toHaveBeenCalledWith(fakeDb, null);
  });

  it('rejects projectId 0', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.reviewSummary({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// qualityFindings
// ---------------------------------------------------------------------------

describe('cyboflow.insights.qualityFindings', () => {
  const findings: QualityFinding[] = [
    {
      id: 'find-1',
      projectId: 1,
      title: 'unguarded JSON parse',
      severity: 'warning',
      status: 'pending',
      source: 'agent:executor',
      sourceStep: 'executor',
      category: null,
      locations: [{ path: 'main/src/x.ts', line: 12 }],
      createdAt: '2026-06-11T00:00:00.000Z',
      resolution: null,
      runId: 'run-1',
      runOutcome: null,
      runEndedAt: null,
      workflowName: 'Sprint',
    },
  ];

  it('forwards projectId + limit and returns the findings verbatim', async () => {
    mocked('selectQualityFindings').mockReturnValue(findings);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.qualityFindings({ projectId: 1, limit: 50 });

    expect(result).toBe(findings);
    expect(insightsQueries.selectQualityFindings).toHaveBeenCalledWith(fakeDb, 1, 50);
  });

  it('passes limit undefined when omitted', async () => {
    mocked('selectQualityFindings').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.qualityFindings({ projectId: null });

    expect(insightsQueries.selectQualityFindings).toHaveBeenCalledWith(fakeDb, null, undefined);
  });

  it('rejects limit above 500', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.qualityFindings({ projectId: 1, limit: 999 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectQualityFindings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stepTokens
// ---------------------------------------------------------------------------

describe('cyboflow.insights.stepTokens', () => {
  const buckets: StepTokenBucket[] = [
    { stepId: 'execute-tasks', totalTokens: 900, assistantMessageCount: 6 },
    { stepId: 'unattributed', totalTokens: 100, assistantMessageCount: 1 },
  ];

  it('forwards workflowId + lastNRuns and returns the buckets verbatim', async () => {
    mocked('selectStepTokenBuckets').mockReturnValue(buckets);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.stepTokens({ workflowId: 'wf-1', lastNRuns: 10 });

    expect(result).toBe(buckets);
    expect(insightsQueries.selectStepTokenBuckets).toHaveBeenCalledWith(fakeDb, 'wf-1', 10);
  });

  it('passes lastNRuns undefined when omitted', async () => {
    mocked('selectStepTokenBuckets').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.stepTokens({ workflowId: 'wf-1' });

    expect(insightsQueries.selectStepTokenBuckets).toHaveBeenCalledWith(fakeDb, 'wf-1', undefined);
  });

  it('rejects an empty workflowId', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.stepTokens({ workflowId: '' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectStepTokenBuckets).not.toHaveBeenCalled();
  });

  it('rejects lastNRuns above 100', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.stepTokens({ workflowId: 'wf-1', lastNRuns: 101 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// usageTrend
// ---------------------------------------------------------------------------

describe('cyboflow.insights.usageTrend', () => {
  const points: UsageTrendPoint[] = [
    { date: '2026-06-10', totalTokens: 500, runs: 2 },
    { date: '2026-06-11', totalTokens: 800, runs: 3 },
  ];

  it('forwards an opts object {workflowId, projectId, days} to the helper', async () => {
    mocked('selectUsageTrend').mockReturnValue(points);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.usageTrend({
      workflowId: 'wf-1',
      projectId: 4,
      days: 30,
    });

    expect(result).toBe(points);
    expect(insightsQueries.selectUsageTrend).toHaveBeenCalledWith(fakeDb, {
      workflowId: 'wf-1',
      projectId: 4,
      days: 30,
    });
  });

  it('accepts workflowId null + projectId null (all-workflows, all-projects trend)', async () => {
    mocked('selectUsageTrend').mockReturnValue([]);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await caller.cyboflow.insights.usageTrend({ workflowId: null, projectId: null });

    expect(insightsQueries.selectUsageTrend).toHaveBeenCalledWith(fakeDb, {
      workflowId: null,
      projectId: null,
      days: undefined,
    });
  });

  it('rejects days above 90 without calling the helper', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.usageTrend({ workflowId: null, projectId: null, days: 200 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectUsageTrend).not.toHaveBeenCalled();
  });

  it('rejects days below 1', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.usageTrend({ workflowId: null, projectId: null, days: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects an empty workflowId string (must be null or non-empty)', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.usageTrend({ workflowId: '', projectId: 1 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// revisionHistory
// ---------------------------------------------------------------------------

describe('cyboflow.insights.revisionHistory', () => {
  const revisions: WorkflowRevisionStats[] = [
    {
      workflowId: 'wf-1',
      specHash: 'abc1234deadbeef',
      firstSeenAt: '2026-06-10T00:00:00.000Z',
      isCurrent: true,
      runs: 4,
      mergedRuns: 3,
      failedRuns: 1,
      successRatePct: 75,
      avgTotalTokens: 1800,
    },
  ];

  it('forwards workflowId and returns the revisions verbatim', async () => {
    mocked('selectWorkflowRevisionStats').mockReturnValue(revisions);
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    const result = await caller.cyboflow.insights.revisionHistory({ workflowId: 'wf-1' });

    expect(result).toBe(revisions);
    expect(insightsQueries.selectWorkflowRevisionStats).toHaveBeenCalledWith(fakeDb, 'wf-1');
  });

  it('rejects an empty workflowId without calling the helper', async () => {
    const caller = appRouter.createCaller(createContext({ db: fakeDb }));

    await expect(
      caller.cyboflow.insights.revisionHistory({ workflowId: '' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
    expect(insightsQueries.selectWorkflowRevisionStats).not.toHaveBeenCalled();
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    mocked('selectWorkflowRevisionStats').mockReturnValue(revisions);
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.insights.revisionHistory({ workflowId: 'wf-1' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
    expect(insightsQueries.selectWorkflowRevisionStats).not.toHaveBeenCalled();
  });
});
