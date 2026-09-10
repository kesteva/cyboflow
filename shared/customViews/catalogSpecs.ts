/**
 * Tier-2 built-in catalog widget SPECS (docs/proposals/CUSTOM-VIEWS.md §5.1,
 * §9 row S3). The renderer owns the CATALOG (`frontend/src/customViews/catalog.tsx`,
 * planner-scoped for S4/S5) — titles, descriptions, categories — but a spec
 * entry's `WidgetSpec` is a cross-package value both main AND the renderer
 * need: main resolves `{type:'catalog', catalogId}` refs against it to run
 * `runWidget`/actions, and the renderer's library card / inspector preview
 * read the very same object. Defining it once here (shared) is what keeps
 * the two from drifting.
 *
 * Every entry is validated against `widgetSpecSchema`
 * (`shared/customViews/__tests__/catalogSpecs.test.ts`) — the same schema the
 * router validates an inline/custom spec with, so a built-in gets no free
 * pass on shape or cross-field rules (declared sources, `rowKey` on row
 * actions, `{setting}` refs naming a real setting, template tokens scoped to
 * `row.<field>` / `setting.<name>` / `context.projectId`).
 *
 * SQL is written directly against `main/src/database/schema.sql` (`sessions`,
 * `review_items`, `run_usage`, `workflow_runs`) — SELECT-only, named `:params`
 * bound through `resolveSpecSettings` + `runWidgetSources`
 * (`main/src/orchestrator/customViews/sourceRunner.ts`), same as any
 * assistant- or user-authored widget.
 *
 * Keep this file free of Node.js built-ins so it runs in any environment
 * (main process AND renderer).
 */
import type { WidgetSpec } from '../types/customViews';

/** Every project-scoped catalog widget declares this knob so the same widget
 *  works unscoped (review-queue, projectId null) or pinned to one project. */
const PROJECT_SETTING = {
  name: 'project',
  label: 'Project',
  kind: 'project' as const,
  default: null,
};

// ---------------------------------------------------------------------------
// insights.daily-usage — stacked columns of daily/weekly token usage by model
// ---------------------------------------------------------------------------

const insightsDailyUsage: WidgetSpec = {
  version: 1,
  sources: {
    usage: {
      type: 'query',
      name: 'insights.dailyUsage',
      input: {
        projectId: { setting: 'project' },
        days: { setting: 'days' },
      },
    },
  },
  transforms: {
    usage: [
      { op: 'bucketDate', field: 'day', unit: { setting: 'groupBy' }, as: 'bucket' },
      {
        op: 'group',
        by: ['bucket', 'model'],
        aggregates: [{ fn: 'sum', field: 'totalTokens', as: 'totalTokens' }],
      },
    ],
  },
  render: { type: 'shape', shape: 'columns', source: 'usage', x: 'bucket', series: 'model', y: 'totalTokens' },
  settings: [
    {
      name: 'groupBy',
      label: 'Group by',
      kind: 'select',
      options: [
        { value: 'day', label: 'Daily' },
        { value: 'week', label: 'Weekly' },
      ],
      default: 'day',
    },
    { name: 'days', label: 'Lookback (days)', kind: 'number', min: 7, max: 365, step: 1, default: 30 },
    PROJECT_SETTING,
  ],
  refreshSec: 300,
};

// ---------------------------------------------------------------------------
// insights.workflow-stats — per-workflow run outcome table
// ---------------------------------------------------------------------------

const insightsWorkflowStats: WidgetSpec = {
  version: 1,
  sources: {
    stats: {
      type: 'query',
      name: 'insights.workflowStats',
      input: { projectId: { setting: 'project' } },
    },
  },
  render: {
    type: 'shape',
    shape: 'table',
    source: 'stats',
    columns: [
      { field: 'workflowName', label: 'Workflow' },
      { field: 'totalRuns', label: 'Total', format: 'number' },
      { field: 'completedRuns', label: 'Completed', format: 'number' },
      { field: 'failedRuns', label: 'Failed', format: 'number' },
      { field: 'activeRuns', label: 'Active', format: 'number' },
    ],
  },
  settings: [PROJECT_SETTING],
  refreshSec: 120,
};

// ---------------------------------------------------------------------------
// stats.tokens-today — a single stat card, today's token spend
// ---------------------------------------------------------------------------

const statsTokensToday: WidgetSpec = {
  version: 1,
  sources: {
    tokens: {
      type: 'sql',
      sql: `SELECT COALESCE(SUM(ru.total_tokens), 0) AS totalTokens
              FROM run_usage ru
              JOIN workflow_runs r ON r.id = ru.run_id
             WHERE date(ru.computed_at) = date(:today)
               AND (:projectId IS NULL OR r.project_id = :projectId)`,
      params: {
        today: { context: 'todayIso' },
        projectId: { setting: 'project' },
      },
    },
  },
  render: { type: 'shape', shape: 'stat', source: 'tokens', value: 'totalTokens', label: 'Tokens today', format: 'tokens' },
  settings: [PROJECT_SETTING],
  refreshSec: 60,
};

// ---------------------------------------------------------------------------
// stats.open-review-items — a single stat card, open review-queue count
// ---------------------------------------------------------------------------

const statsOpenReviewItems: WidgetSpec = {
  version: 1,
  sources: {
    open: {
      type: 'sql',
      sql: `SELECT COUNT(*) AS openCount
              FROM review_items
             WHERE status = 'pending'
               AND (:projectId IS NULL OR project_id = :projectId)`,
      params: { projectId: { setting: 'project' } },
    },
  },
  render: { type: 'shape', shape: 'stat', source: 'open', value: 'openCount', label: 'Open review items', format: 'number' },
  settings: [PROJECT_SETTING],
  refreshSec: 60,
};

// ---------------------------------------------------------------------------
// sessions.recent — recently updated sessions, with an open-session row action
// ---------------------------------------------------------------------------

const sessionsRecent: WidgetSpec = {
  version: 1,
  sources: {
    recent: {
      type: 'sql',
      sql: `SELECT id, name, status, updated_at AS updatedAt
              FROM sessions
             WHERE (:projectId IS NULL OR project_id = :projectId)
               AND (archived IS NULL OR archived = 0)
             ORDER BY updated_at DESC
             LIMIT 20`,
      params: { projectId: { setting: 'project' } },
    },
  },
  render: { type: 'shape', shape: 'list', source: 'recent', title: 'name', subtitle: 'status', meta: 'updatedAt' },
  actions: [
    {
      id: 'open',
      label: 'Open',
      kind: 'open-session',
      placement: 'row',
      rowKey: 'id',
      params: { target: 'quick-session', sessionId: '{row.id}' },
    },
  ],
  settings: [PROJECT_SETTING],
  refreshSec: 30,
};

/** Every tier-2 built-in catalog widget's `WidgetSpec`, keyed by catalog id. */
export const CATALOG_WIDGET_SPECS: Record<string, WidgetSpec> = {
  'insights.daily-usage': insightsDailyUsage,
  'insights.workflow-stats': insightsWorkflowStats,
  'stats.tokens-today': statsTokensToday,
  'stats.open-review-items': statsOpenReviewItems,
  'sessions.recent': sessionsRecent,
};
