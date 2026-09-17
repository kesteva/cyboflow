/**
 * Zod input schemas for the insights read helpers.
 *
 * Factored out of `trpc/routers/insights.ts` (which imports them back
 * unchanged) so a SECOND caller can validate the same inputs against the same
 * bounds: the custom-views widget engine resolves a `query` source's `input`
 * bag through these before calling the matching helper in `insightsQueries.ts`
 * (docs/proposals/CUSTOM-VIEWS.md §4.2). A widget-authored input is exactly as
 * untrusted as a renderer-supplied one, and duplicating the bounds is how the
 * two drift apart.
 *
 * Router-only concerns (the `ctx.db` precondition guard, output types) stay in
 * the router; this module is pure zod.
 */
import { z } from 'zod';

/**
 * The cross-project filter shared by every project-scoped procedure — null
 * aggregates every project, a positive integer scopes to one. Declared once so
 * the callers cannot drift in their bounds (rejecting 0 / negatives while still
 * admitting null).
 */
export const projectIdSchema = z.number().int().positive().nullable();

/** `insights.workflowStats` — per-workflow run-outcome statistics. */
export const workflowStatsInputSchema = z.object({ projectId: projectIdSchema });

/**
 * `insights.usageTrend` — time-bucketed token/run trend points. `workflowId`
 * null trends across all workflows; `days` caps the lookback (1..90), omitted
 * lets the helper apply its own default.
 */
export const usageTrendInputSchema = z.object({
  workflowId: z.string().min(1).nullable(),
  projectId: projectIdSchema,
  days: z.number().int().min(1).max(90).optional(),
});

/**
 * `insights.dailyUsage` — per-(day, model) token buckets. `days` caps the
 * lookback (1..365); the helper clamps defensively as well.
 */
export const dailyUsageInputSchema = z.object({
  projectId: projectIdSchema,
  days: z.number().int().min(1).max(365).optional(),
});

export type WorkflowStatsInput = z.infer<typeof workflowStatsInputSchema>;
export type UsageTrendInput = z.infer<typeof usageTrendInputSchema>;
export type DailyUsageInput = z.infer<typeof dailyUsageInputSchema>;
