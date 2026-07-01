/**
 * cyboflow.insights sub-router.
 *
 * Read-only typed tRPC contract backing the Insights view (run statistics, token
 * usage rollups, the review-queue summary counters, and the code-quality buckets):
 *   - workflowStats    : query -> WorkflowRunStats[]   (per-workflow run outcomes)
 *   - workflowUsage    : query -> WorkflowUsageStats[]  (per-workflow token/cost aggregate)
 *   - runUsage         : query -> RunUsageRollup        (single-run token/cost rollup + runtime)
 *   - runEval          : query -> RunEval | null        (single-run code-review eval)
 *   - reviewSummary    : query -> ReviewItemSummary     (inbox counters)
 *   - qualityFindings  : query -> QualityFinding[]      (kind='finding' rows joined to runs)
 *   - stepTokens       : query -> StepTokenBucket[]     (tokens attributed per workflow step)
 *   - usageTrend       : query -> UsageTrendPoint[]     (time-bucketed sparkline points)
 *   - revisionHistory  : query -> WorkflowRevisionStats[] (per-spec_hash run stats, newest-first)
 *   - dailyUsage       : query -> DailyModelUsagePoint[] (per-(day, model) token buckets)
 *
 * Every procedure is a thin wrapper over a pure SELECT helper in
 * `../../insightsQueries` — this router owns ONLY zod input validation + the
 * `ctx.db` precondition guard, never SQL. The helpers (and their projections) are
 * covered by their own colocated tests; the tests in this directory exercise the
 * router's input contract + pass-through wiring exclusively (the queries module is
 * stubbed there via vi.mock).
 *
 * `projectId` is `number | null` on the cross-project queries: `null` aggregates
 * EVERY project (the global Insights view), a positive integer scopes to one
 * project — mirroring the tasks router's nullable-projectId convention. All
 * returned values are JSON primitives per the shared/types/insights header
 * (timestamps are ISO strings, durations are ms numbers) so they cross the
 * tRPC/superjson boundary without Date-revival surprises.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  RunUsageRollup,
  ReviewItemSummary,
  QualityFinding,
  StepTokenBucket,
  UsageTrendPoint,
  WorkflowRevisionStats,
  DailyModelUsagePoint,
  RunEval,
} from '../../../../../shared/types/insights';
import {
  selectWorkflowRunStats,
  selectWorkflowUsageStats,
  selectRunUsageRollups,
  selectReviewItemSummary,
  selectQualityFindings,
  selectStepTokenBuckets,
  selectUsageTrend,
  selectWorkflowRevisionStats,
  selectDailyModelUsage,
  getRunEval,
} from '../../insightsQueries';

// ---------------------------------------------------------------------------
// db precondition guard
//
// Every procedure reads from ctx.db, so each asserts it is wired before touching
// a query helper — matching the PRECONDITION_FAILED convention the runs /
// reviewItems routers use. The `where` label is folded into the message so a
// missing-db failure points at the exact procedure.
// ---------------------------------------------------------------------------

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[insights.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

// ---------------------------------------------------------------------------
// Shared zod fragments
//
// `projectId: number | null` is the cross-project filter — null aggregates every
// project, a positive integer scopes to one. Declared once so the four
// project-scoped procedures cannot drift in their bounds (rejecting 0 / negatives
// while still admitting null).
// ---------------------------------------------------------------------------

const projectIdSchema = z.number().int().positive().nullable();

/**
 * Build the zeroed RunUsageRollup returned when a run has no persisted usage yet
 * (or does not exist). `selectRunUsageRollups` only emits rows for runs that
 * carried usage, so a single-run lookup can legitimately come back empty — the
 * UI still wants a stable, all-zero shape keyed to the requested runId rather than
 * a null it must special-case. costUsd / numTurns are null (SDK-only fields that
 * never appeared), mirroring the shared-type "null when no result carried it"
 * convention; every count is 0.
 */
function zeroedRunUsageRollup(runId: string): RunUsageRollup {
  return {
    runId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: null,
    numTurns: null,
    assistantMessageCount: 0,
    // No run row (or none matched) → no runtime timestamps to report.
    startedAt: null,
    endedAt: null,
  };
}

export const insightsRouter = router({
  /**
   * Per-workflow run-outcome statistics derived from `workflow_runs`.
   * `projectId: null` aggregates every project; a number scopes to one.
   */
  workflowStats: protectedProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .query(({ ctx, input }): WorkflowRunStats[] => {
      const db = requireDb(ctx.db, 'workflowStats');
      return selectWorkflowRunStats(db, input.projectId);
    }),

  /**
   * Per-workflow token/cost aggregate over the runs that carried usage data.
   * `limitRunsPerWorkflow` caps how many recent runs per workflow are folded into
   * the aggregate (a cost ceiling on the underlying raw_events scan); omitted lets
   * the helper apply its own default.
   */
  workflowUsage: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        limitRunsPerWorkflow: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }): WorkflowUsageStats[] => {
      const db = requireDb(ctx.db, 'workflowUsage');
      return selectWorkflowUsageStats(db, input.projectId, input.limitRunsPerWorkflow);
    }),

  /**
   * Token/cost rollup for a single run, aggregated from its persisted
   * `raw_events`. `selectRunUsageRollups` returns a row ONLY for runs that carried
   * usage, so a run with no usage yet (or an unknown runId) comes back empty — we
   * fall back to a stable zeroed RunUsageRollup keyed to the requested runId
   * (see zeroedRunUsageRollup) rather than throwing, so the UI never special-cases
   * a missing rollup.
   */
  runUsage: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }): RunUsageRollup => {
      const db = requireDb(ctx.db, 'runUsage');
      return selectRunUsageRollups(db, [input.runId])[0] ?? zeroedRunUsageRollup(input.runId);
    }),

  /**
   * The canonical code-review evaluation for a single run (migration-043
   * `run_evals`), or `null` when no eval exists yet. Unlike runUsage's zeroed
   * fallback, a missing eval is genuinely absent (the worker may not have fired,
   * or the run is not a built-in flow) — the panel treats null as "no eval" and
   * a `pending`/`running` status as "in progress", so we hand the null straight
   * through rather than fabricating a placeholder row.
   */
  runEval: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }): RunEval | null => {
      const db = requireDb(ctx.db, 'runEval');
      return getRunEval(db, input.runId);
    }),

  /**
   * Review-queue inbox counters (total / pending / resolved / dismissed + the
   * per-kind pending breakdown). `projectId: null` counts across every project.
   */
  reviewSummary: protectedProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .query(({ ctx, input }): ReviewItemSummary => {
      const db = requireDb(ctx.db, 'reviewSummary');
      return selectReviewItemSummary(db, input.projectId);
    }),

  /**
   * `kind='finding'` review items flattened + joined to their creating run, for
   * the code-quality columns (the renderer buckets them via the shared
   * classifyQualityFinding). `limit` caps the number returned (newest-first);
   * omitted lets the helper apply its own default.
   */
  qualityFindings: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }): QualityFinding[] => {
      const db = requireDb(ctx.db, 'qualityFindings');
      return selectQualityFindings(db, input.projectId, input.limit);
    }),

  /**
   * Tokens attributed to each step of one workflow across its recent runs.
   * `workflowId` is required (this is a per-workflow drill-down, not a
   * cross-project aggregate); `lastNRuns` caps how many recent runs feed the
   * buckets, omitted lets the helper apply its own default.
   */
  stepTokens: protectedProcedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        lastNRuns: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }): StepTokenBucket[] => {
      const db = requireDb(ctx.db, 'stepTokens');
      return selectStepTokenBuckets(db, input.workflowId, input.lastNRuns);
    }),

  /**
   * Time-bucketed token/run trend points for the usage sparklines. `workflowId`
   * is `string | null` (null trends across all workflows) and `projectId` is the
   * usual nullable cross-project filter; `days` caps the lookback window (1..90),
   * omitted lets the helper apply its own default.
   */
  usageTrend: protectedProcedure
    .input(
      z.object({
        workflowId: z.string().min(1).nullable(),
        projectId: projectIdSchema,
        days: z.number().int().min(1).max(90).optional(),
      }),
    )
    .query(({ ctx, input }): UsageTrendPoint[] => {
      const db = requireDb(ctx.db, 'usageTrend');
      return selectUsageTrend(db, {
        workflowId: input.workflowId,
        projectId: input.projectId,
        days: input.days,
      });
    }),

  /**
   * Per-revision (per-spec_hash) run statistics for one workflow's version
   * history (mockup S6), newest revision first. `workflowId` is required — this
   * is a per-workflow drill-down. Runs frozen before migration 026 (spec_hash
   * NULL) are invisible by design; see selectWorkflowRevisionStats.
   */
  revisionHistory: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(({ ctx, input }): WorkflowRevisionStats[] => {
      const db = requireDb(ctx.db, 'revisionHistory');
      return selectWorkflowRevisionStats(db, input.workflowId);
    }),

  /**
   * Per-(day, model) token buckets for the usage chart at the top of the
   * Statistics section, scanned over the last `days` days of `assistant`
   * raw_events. `projectId` is the usual nullable cross-project filter (null
   * aggregates every project); `days` caps the lookback window (1..365), omitted
   * defaults to 30. The helper clamps `days` defensively as well.
   */
  dailyUsage: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        days: z.number().int().min(1).max(365).optional(),
      }),
    )
    .query(({ ctx, input }): DailyModelUsagePoint[] => {
      const db = requireDb(ctx.db, 'dailyUsage');
      return selectDailyModelUsage(db, input.projectId, input.days ?? 30);
    }),
});
