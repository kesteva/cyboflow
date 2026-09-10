/**
 * DailyUsageChart — the 30-day daily token-use chart at the top of the Insights
 * Statistics section.
 *
 * As of the Custom Views work (docs/proposals/CUSTOM-VIEWS.md §5.3) this is a
 * thin ADAPTER over {@link StackedColumns}, the generic column chart in
 * `customViews/shape/`. The SVG, the stack order, the palette assignment, the
 * hover zones and the tooltip all live there now, so the tier-2 `columns`
 * widget shape and this chart are one implementation rather than two that drift.
 * What stays here is everything genuinely daily-usage-specific:
 *
 *   - the UTC day axis ({@link utcDayKeys}), which fills gaps so a sparse
 *     history keeps evenly-spaced slots instead of collapsing them,
 *   - {@link PALETTE} and the {@link modelLegend} view of the generic ranking,
 *   - the compact token figures and the `claude-` prefix trim,
 *   - the `daily-usage-*` test hooks and the empty-state sentence.
 *
 * Dependency-free and pure-presentational as before: props only, no store or
 * router import, no chart library.
 */
import type { Scalar } from '../../../../../shared/types/customViews';
import type { DailyModelUsagePoint } from '../../../../../shared/types/insights';
import { StackedColumns, seriesLegend } from '../../../customViews/shape/StackedColumns';

/**
 * Deterministic warm-paper palette for the per-model stack, indexed by legend
 * order (model rank by grand-total tokens, DESC). These are the theme's phase
 * hues (styles/tokens/colors.css `--color-phase-*`) used as explicit SVG fills —
 * Sparkline/BarRow set the precedent that SVG geometry takes literal colors
 * rather than semantic Tailwind classes. More models than entries wrap modulo
 * the array length.
 */
export const PALETTE: readonly string[] = [
  '#c96442', // terracotta (execute)
  '#3b6dd6', // blue (plan)
  '#2d8a5b', // green (verify)
  '#8b5cf6', // violet (compound)
  '#a87a2c', // amber (review)
  '#5a4ad6', // indigo (refine)
  '#8a4a4a', // muted red (prune)
];

/**
 * Compact token figure: >= 1M → 'N.Nm', >= 1000 → 'Nk' (rounded), else the raw
 * integer.
 *
 * Replicates StatsSection.compactTokens deliberately (this chart stays
 * import-free of section internals) so its legend totals read identically to
 * the cards above it.
 */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

/** Strip a leading 'claude-' so the legend shows e.g. 'sonnet-4' not the full id. */
function shortModelName(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

/** Two-digit zero-pad for the UTC date parts of {@link utcDayKeys}. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * The 'YYYY-MM-DD' UTC day keys for the last `days` days ending on `today`
 * (oldest first, today last). Built off the UTC midnight of `today` so the keys
 * line up with `DailyModelUsagePoint.day` (a UTC date slice) regardless of the
 * caller's local timezone. Exported so the colocated test pins the axis math
 * without re-deriving it.
 */
export function utcDayKeys(days: number, today: Date): string[] {
  const base = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base - i * 86_400_000);
    out.push(
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    );
  }
  return out;
}

/** One model's window-wide total, paired with its rendered swatch color. */
export interface ModelLegendEntry {
  model: string;
  totalTokens: number;
  color: string;
}

/** `DailyModelUsagePoint[]` as the generic chart's row shape. */
function toRows(points: DailyModelUsagePoint[]): Array<Record<string, Scalar>> {
  return points.map((p) => ({ day: p.day, model: p.model, totalTokens: p.totalTokens }));
}

/**
 * Distinct models ranked by grand-total tokens (DESC), each tagged with its
 * palette color by rank. Drives BOTH the stack order and the legend. Ties break
 * on model id (ascending) so the order is stable across renders. Exported for
 * the colocated test; delegates to {@link seriesLegend} so the ranking has ONE
 * implementation shared with the generic chart.
 */
export function modelLegend(points: DailyModelUsagePoint[]): ModelLegendEntry[] {
  return seriesLegend(toRows(points), 'model', 'totalTokens', PALETTE).map((entry) => ({
    model: entry.series,
    totalTokens: entry.total,
    color: entry.color,
  }));
}

interface DailyUsageChartProps {
  /** The per-day, per-model usage buckets (a sparse set; gaps are filled). */
  points: DailyModelUsagePoint[];
  /** Trailing window length in days, ending today. Defaults to 30. */
  days?: number;
}

export function DailyUsageChart({
  points,
  days = 30,
}: DailyUsageChartProps): React.JSX.Element {
  return (
    <StackedColumns
      rows={toRows(points)}
      x="day"
      series="model"
      y="totalTokens"
      palette={PALETTE}
      xCategories={utcDayKeys(days, new Date())}
      formatValue={compactTokens}
      formatSeries={shortModelName}
      emptyLabel={`No token usage recorded in the last ${days} days.`}
      testIdPrefix="daily-usage"
      ariaLabel={`daily token usage over ${days} days`}
    />
  );
}
