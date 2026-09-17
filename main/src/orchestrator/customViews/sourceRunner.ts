/**
 * sourceRunner — resolves and executes one widget's declared sources
 * (docs/proposals/CUSTOM-VIEWS.md §4.2).
 *
 * Input is a spec that ALREADY went through `resolveSpecSettings`, so every
 * `{setting: name}` reference is a concrete scalar by the time it gets here;
 * what remains to resolve are `{literal}` values and the three `{context}`
 * values (`projectId`, `nowIso`, `todayIso`) the caller supplies per request.
 *
 * Two kinds of source:
 *   - `sql`   — raw SELECT-only SQL, executed through `../readOnlyQuery` on the
 *               readonly sibling handle under the WIDGET profile and the widget
 *               output caps (including `maxRowBytes`, which the agent profile
 *               does not apply).
 *   - `query` — an allowlisted read helper from `../insightsQueries`, reached
 *               through one adapter each because their signatures differ.
 *               Helper inputs are validated with the SAME zod schemas the
 *               insights tRPC router uses (`../insightsInputSchemas`), and
 *               their materialized output is capped like SQL rows — the helpers
 *               call `.all()`, so the widget-wide output cap has to be enforced
 *               on their output rather than their input.
 *
 * Errors are PER SOURCE: a source that fails lands `{ error }` in its own slot
 * and the widget still renders whatever the other sources produced. Nothing
 * here throws for a caller-authored mistake.
 */
import type {
  QuerySourceName,
  Scalar,
  SourceParam,
  SourceOutcome,
  WidgetSpec,
} from '../../../../shared/types/customViews';
import { WIDGET_LIMITS } from '../../../../shared/types/customViews';
import { applyTransform } from '../../../../shared/customViews/transform';
import type { DatabaseLike } from '../types';
import type BetterSqlite3Database from 'better-sqlite3';
import {
  coerceBindParams,
  collectQueryPlan,
  DB_QUERY_MAX_STRING_LEN,
  runReadonlyQuery,
  validateReadonlySql,
  type BindableParams,
  type ReadonlyQueryLimits,
} from '../readOnlyQuery';
import {
  dailyUsageInputSchema,
  usageTrendInputSchema,
  workflowStatsInputSchema,
} from '../insightsInputSchemas';
import {
  selectDailyModelUsage,
  selectUsageTrend,
  selectWorkflowRunStats,
} from '../insightsQueries';

// `collectQueryPlan` lives with the executor it shares a handle type with; it
// is re-exported here because the plan is a SOURCE-level advisory, and §4.2/§4.3
// name this module as where the data service reaches for it.
export { collectQueryPlan };

/** The widget profile's output caps, assembled from the shared limits. */
export const WIDGET_QUERY_LIMITS: ReadonlyQueryLimits = {
  maxRows: WIDGET_LIMITS.maxRows,
  maxPayloadBytes: WIDGET_LIMITS.maxPayloadBytes,
  maxStringLen: DB_QUERY_MAX_STRING_LEN,
  maxRowBytes: WIDGET_LIMITS.maxRowBytes,
};

/** Per-request values a `{context: …}` source param resolves against. */
export interface WidgetSourceContext {
  projectId: number | null;
  nowIso: string;
  todayIso: string;
}

/** One source's slot in the result: its rows, or the reason it failed. */
export type { SourceOutcome } from '../../../../shared/types/customViews';

export interface RunWidgetSourcesResult {
  sources: Record<string, SourceOutcome>;
  warnings: string[];
}

export interface RunWidgetSourcesInput {
  /** A spec that already passed through `resolveSpecSettings`. */
  resolvedSpec: WidgetSpec;
  context: WidgetSourceContext;
  /** The writer connection, for the `query` helpers (which are pure SELECTs). */
  db: DatabaseLike;
  /**
   * The readonly sibling handle, for `sql` sources. `null` when the caller
   * could not open one (an in-memory or adapter-less DatabaseLike); the `sql`
   * sources then fail individually with `db_query_unavailable` while the
   * `query` sources still run.
   */
  handle: BetterSqlite3Database.Database | null;
}

// ---------------------------------------------------------------------------
// Param resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one already-setting-resolved `SourceParam` to a scalar. A surviving
 * `{setting}` means the caller skipped `resolveSpecSettings`; that is a
 * programming error in the pipeline, reported as this source's error rather
 * than silently bound as null.
 */
function resolveSourceParam(param: SourceParam, context: WidgetSourceContext): Scalar {
  if ('literal' in param) return param.literal;
  if ('context' in param) {
    if (param.context === 'projectId') return context.projectId;
    if (param.context === 'nowIso') return context.nowIso;
    return context.todayIso;
  }
  throw new Error(`unresolved_setting:${param.setting}`);
}

/**
 * Resolve a whole param bag to scalars. Exported so the data service can bind
 * the SAME values when it collects a source's `EXPLAIN QUERY PLAN` — a plan for
 * a statement with unbound named parameters cannot be prepared at all.
 */
export function resolveParamBag(
  params: Record<string, SourceParam>,
  context: WidgetSourceContext,
): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [name, param] of Object.entries(params)) {
    out[name] = resolveSourceParam(param, context);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

/**
 * Narrow one helper/SQL value to a `Scalar`. Everything the renderer cannot
 * display as a cell — a nested object or array a helper returned — becomes its
 * JSON text rather than being dropped, so a widget author can still see it.
 */
function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toScalarRow(row: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(row)) out[key] = toScalar(value);
  return out;
}

/**
 * The column list describing `rows` after transforms (which can add fields via
 * `derive`/`group` and drop them via `group`). Falls back to the statement's own
 * columns when the transformed result is empty, so an empty table still renders
 * its headers.
 */
function columnsOf(rows: Array<Record<string, Scalar>>, fallback: string[]): string[] {
  if (rows.length === 0) return fallback;
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// query-source adapters
// ---------------------------------------------------------------------------

/**
 * One adapter per QUERY_SOURCE_NAMES entry. Each validates the resolved input
 * bag with the router's own schema, then calls the pure SELECT helper with the
 * argument shape that helper happens to take.
 */
function runQuerySource(
  name: QuerySourceName,
  input: Record<string, Scalar>,
  db: DatabaseLike,
): Array<Record<string, unknown>> {
  switch (name) {
    case 'insights.dailyUsage': {
      const parsed = dailyUsageInputSchema.safeParse(input);
      if (!parsed.success) throw new Error(`invalid_input:${parsed.error.issues[0]?.message ?? 'bad input'}`);
      return selectDailyModelUsage(db, parsed.data.projectId, parsed.data.days ?? 30) as unknown as Array<
        Record<string, unknown>
      >;
    }
    case 'insights.workflowStats': {
      const parsed = workflowStatsInputSchema.safeParse(input);
      if (!parsed.success) throw new Error(`invalid_input:${parsed.error.issues[0]?.message ?? 'bad input'}`);
      return selectWorkflowRunStats(db, parsed.data.projectId) as unknown as Array<Record<string, unknown>>;
    }
    case 'insights.usageTrend': {
      const parsed = usageTrendInputSchema.safeParse(input);
      if (!parsed.success) throw new Error(`invalid_input:${parsed.error.issues[0]?.message ?? 'bad input'}`);
      return selectUsageTrend(db, {
        workflowId: parsed.data.workflowId,
        projectId: parsed.data.projectId,
        days: parsed.data.days,
      }) as unknown as Array<Record<string, unknown>>;
    }
    default:
      throw new Error(`unknown_query_source:${name}`);
  }
}

/**
 * Apply the widget output caps to a helper's MATERIALIZED rows. The helpers
 * `.all()` internally, so this is a truncation of what they already built — the
 * cap bounds what crosses to the renderer, not what SQLite scanned.
 */
function capHelperRows(rows: Array<Record<string, unknown>>, limits: ReadonlyQueryLimits): {
  rows: Array<Record<string, Scalar>>;
  truncated: boolean;
} {
  const out: Array<Record<string, Scalar>> = [];
  let truncated = false;
  let payloadBytes = 0;
  for (const raw of rows) {
    if (out.length >= limits.maxRows) {
      truncated = true;
      break;
    }
    const scalarRow = toScalarRow(raw);
    const size = Buffer.byteLength(JSON.stringify(scalarRow), 'utf8');
    if (limits.maxRowBytes !== undefined && size > limits.maxRowBytes) {
      throw new Error('row_too_large');
    }
    if (out.length > 0 && payloadBytes + size > limits.maxPayloadBytes) {
      truncated = true;
      break;
    }
    out.push(scalarRow);
    payloadBytes += size;
  }
  return { rows: out, truncated };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute every source in `resolvedSpec` and apply its transforms.
 *
 * A source's own failure never fails the widget: its slot carries `{ error }`
 * and the remaining sources still run. `warnings` collects the advisories the
 * inspector shows (today: which sources were truncated by the caps).
 */
export function runWidgetSources(input: RunWidgetSourcesInput): RunWidgetSourcesResult {
  const { resolvedSpec, context, db, handle } = input;
  const sources: Record<string, SourceOutcome> = {};
  const warnings: string[] = [];

  for (const [name, source] of Object.entries(resolvedSpec.sources)) {
    try {
      const startedAt = Date.now();
      let rows: Array<Record<string, Scalar>>;
      let truncated: boolean;
      let rawColumns: string[];

      if (source.type === 'sql') {
        if (!handle) throw new Error('db_query_unavailable: no on-disk database file for this connection');
        const validation = validateReadonlySql(source.sql, { profile: 'widget' });
        if (!validation.ok) throw new Error(validation.reason);
        const resolved = resolveParamBag(source.params ?? {}, context);
        const bound: BindableParams = coerceBindParams(resolved);
        const result = runReadonlyQuery(handle, validation.sql, bound, WIDGET_QUERY_LIMITS);
        rows = result.rows.map(toScalarRow);
        truncated = result.truncated;
        rawColumns = result.columns;
      } else {
        const resolved = resolveParamBag(source.input, context);
        const helperRows = runQuerySource(source.name, resolved, db);
        const capped = capHelperRows(helperRows, WIDGET_QUERY_LIMITS);
        rows = capped.rows;
        truncated = capped.truncated;
        rawColumns = helperRows.length > 0 ? Object.keys(helperRows[0]) : [];
      }

      const steps = resolvedSpec.transforms?.[name];
      const finalRows = steps && steps.length > 0 ? applyTransform(rows, steps) : rows;

      sources[name] = {
        columns: columnsOf(finalRows, rawColumns),
        rows: finalRows,
        truncated,
        tookMs: Date.now() - startedAt,
      };
      if (truncated) warnings.push(`source '${name}' truncated (row or payload cap reached)`);
    } catch (err) {
      sources[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { sources, warnings };
}
