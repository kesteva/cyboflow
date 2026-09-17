/**
 * StackedColumns — the generic stacked column chart, extracted verbatim from
 * `Insights/charts/DailyUsageChart` (docs/proposals/CUSTOM-VIEWS.md §5.3).
 *
 * It is the SAME implementation, not a second one: the daily-usage chart is now
 * a thin adapter over this component, so the tier-2 `columns` shape and the
 * Insights page cannot drift in their axis math, stack order, palette
 * assignment, hover behaviour, or tooltip layout. The generic parameters are
 * exactly the three fields the shape's render declares — `x`, `series`, `y` —
 * plus the four things the daily chart needed on top of them:
 *
 *   - `xCategories`: the FULL axis, so days with no rows still take a slot and
 *     a sparse history keeps a stable, evenly-spaced axis instead of collapsing
 *     its gaps. Omitted, the axis is the distinct `x` values in first-seen
 *     order — the right default for a `group`ed source, which already emits one
 *     row per bucket.
 *   - `formatValue` / `formatSeries`: the legend and tooltip's display strings.
 *   - `testIdPrefix`: so the adapter keeps the `daily-usage-*` hooks its own
 *     tests pin.
 *
 * Presentation rules (unchanged from the original):
 *   - Stack AND legend order is series ranked by GRAND TOTAL across the window,
 *     descending, ties broken on the series name — so the largest contributor
 *     always takes the first palette color and sits at the base of every column.
 *   - Colors come from `palette` indexed by that rank, wrapping modulo its
 *     length, so one series keeps one hue everywhere on the chart.
 *   - Heights normalize against the busiest column, so the tallest fills the
 *     plot and quiet columns stay proportional.
 *
 * The y-axis max label and the hover zones are HTML overlaid on the SVG rather
 * than SVG children: `preserveAspectRatio="none"` stretches the viewBox to the
 * container width, which distorts `<text>` glyphs horizontally (rects stretch
 * fine, text does not).
 */
import { useState } from 'react';
import type { Scalar } from '../../../../shared/types/customViews';
import { toNumber } from '../format';

/** SVG drawing height in px (the plot area; legend sits below in normal flow). */
const PLOT_HEIGHT = 120;

/** SVG drawing width in px — arbitrary; the viewBox makes the render responsive. */
const PLOT_WIDTH = 480;

/** Fraction of each column slot occupied by the bar (rest is inter-bar gap). */
const BAR_FILL = 0.7;

/** Vertical padding (px) reserved at the top so the tallest bar never clips. */
const TOP_INSET = 4;

/** One series' window-wide total, paired with its rendered swatch color. */
export interface SeriesLegendEntry {
  series: string;
  total: number;
  color: string;
}

/**
 * Distinct series ranked by grand total (DESC), each tagged with its palette
 * color by rank. Drives BOTH the stack order and the legend; ties break on the
 * series name (ascending) so the order is stable across renders. Exported so
 * both the adapter and the colocated tests pin the ranking at its source.
 */
export function seriesLegend(
  rows: ReadonlyArray<Record<string, Scalar>>,
  seriesField: string,
  yField: string,
  palette: readonly string[],
): SeriesLegendEntry[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = String(row[seriesField] ?? '');
    totals.set(name, (totals.get(name) ?? 0) + (toNumber(row[yField] ?? null) ?? 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([series, total], i) => ({ series, total, color: palette[i % palette.length] }));
}

export interface StackedColumnsProps {
  rows: ReadonlyArray<Record<string, Scalar>>;
  /** Row field holding the column (x) key. */
  x: string;
  /** Row field holding the series name (one stack segment per series). */
  series: string;
  /** Row field holding the numeric magnitude. */
  y: string;
  palette: readonly string[];
  /** The full ordered axis. Omitted, the distinct `x` values in first-seen order. */
  xCategories?: readonly string[];
  /** Legend/tooltip number formatter. Defaults to `toLocaleString`. */
  formatValue?: (n: number) => string;
  /** Legend/tooltip series-name formatter. Defaults to identity. */
  formatSeries?: (name: string) => string;
  /** Rendered instead of the plot when there is nothing to draw. */
  emptyLabel?: React.ReactNode;
  /** Test id stem: `<prefix>-chart` / `-legend` / `-tooltip` / `-hover-<key>`. */
  testIdPrefix?: string;
  /** SVG accessible name. */
  ariaLabel?: string;
}

/** StackedColumns — see {@link StackedColumnsProps}. */
export function StackedColumns({
  rows,
  x,
  series,
  y,
  palette,
  xCategories,
  formatValue = (n) => n.toLocaleString(),
  formatSeries = (name) => name,
  emptyLabel = 'No data to chart.',
  testIdPrefix = 'stacked-columns',
  ariaLabel = 'stacked column chart',
}: StackedColumnsProps): React.JSX.Element {
  // Column index currently hovered, or null. Declared before the empty-state
  // early return so the hook order stays stable.
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-text-muted" data-testid={`${testIdPrefix}-chart`}>
        {emptyLabel}
      </p>
    );
  }

  const legend = seriesLegend(rows, series, y, palette);

  const keys: string[] =
    xCategories !== undefined
      ? [...xCategories]
      : [...new Set(rows.map((row) => String(row[x] ?? '')))];

  // column key -> series -> magnitude, restricted to the visible axis.
  const byColumn = new Map<string, Map<string, number>>();
  for (const key of keys) byColumn.set(key, new Map());
  for (const row of rows) {
    const bucket = byColumn.get(String(row[x] ?? ''));
    if (bucket === undefined) continue; // outside the axis — ignore.
    const name = String(row[series] ?? '');
    bucket.set(name, (bucket.get(name) ?? 0) + (toNumber(row[y] ?? null) ?? 0));
  }

  // Busiest column drives the vertical scale; 0 only when every visible column
  // is empty, in which case the bars collapse rather than divide by zero.
  let maxTotal = 0;
  for (const key of keys) {
    let sum = 0;
    for (const v of byColumn.get(key)!.values()) sum += v;
    if (sum > maxTotal) maxTotal = sum;
  }

  const cols = Math.max(keys.length, 1);
  const slotWidth = PLOT_WIDTH / cols;
  const barWidth = slotWidth * BAR_FILL;
  const usableHeight = PLOT_HEIGHT - TOP_INSET;
  const toHeight = (value: number): number =>
    maxTotal <= 0 ? 0 : (value / maxTotal) * usableHeight;

  return (
    <div data-testid={`${testIdPrefix}-chart`}>
      {/* relative wrapper so the y-axis max label can overlay the plot as HTML. */}
      <div className="relative">
        {maxTotal > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0.5 top-0.5 font-mono text-[10px] leading-none text-text-tertiary"
          >
            {formatValue(maxTotal)}
          </span>
        )}
        <svg
          width="100%"
          height={PLOT_HEIGHT}
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
        >
          {keys.map((key, col) => {
            const bucket = byColumn.get(key)!;
            const left = col * slotWidth + (slotWidth - barWidth) / 2;
            // Stack from the baseline up, in legend order (largest first).
            let cursor = PLOT_HEIGHT;
            return legend.map((entry) => {
              const value = bucket.get(entry.series) ?? 0;
              if (value <= 0) return null;
              const h = toHeight(value);
              cursor -= h;
              return (
                <rect
                  key={`${key}:${entry.series}`}
                  x={left}
                  y={cursor}
                  width={barWidth}
                  height={h}
                  fill={entry.color}
                  opacity={hoveredCol === null || hoveredCol === col ? 1 : 0.35}
                  style={{ transition: 'opacity 120ms' }}
                />
              );
            });
          })}
        </svg>

        {/* Full-height hover zones (one per column) overlaid on the plot, so
            even thin or empty slots are an easy target. */}
        <div className="absolute inset-0 flex" onMouseLeave={() => setHoveredCol(null)}>
          {keys.map((key, col) => (
            <div
              key={key}
              className="h-full flex-1"
              style={{
                backgroundColor:
                  hoveredCol === col ? 'var(--color-interactive-surface-hover)' : 'transparent',
              }}
              onMouseEnter={() => setHoveredCol(col)}
              data-testid={`${testIdPrefix}-hover-${key}`}
            />
          ))}
        </div>

        {hoveredCol !== null && (
          <ColumnTooltip
            columnKey={keys[hoveredCol]}
            bucket={byColumn.get(keys[hoveredCol])!}
            legend={legend}
            col={hoveredCol}
            cols={cols}
            formatValue={formatValue}
            formatSeries={formatSeries}
            testIdPrefix={testIdPrefix}
          />
        )}
      </div>
      <ul
        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]"
        data-testid={`${testIdPrefix}-legend`}
      >
        {legend.map((entry) => (
          <li key={entry.series} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            <span className="font-mono text-text-secondary">{formatSeries(entry.series)}</span>
            <span className="font-mono tabular-nums text-text-tertiary">
              {formatValue(entry.total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ColumnTooltipProps {
  columnKey: string;
  /** The hovered column's series -> magnitude map (may be empty). */
  bucket: Map<string, number>;
  legend: SeriesLegendEntry[];
  col: number;
  cols: number;
  formatValue: (n: number) => string;
  formatSeries: (name: string) => string;
  testIdPrefix: string;
}

/**
 * Floating tooltip for the hovered column: its key, each contributing series in
 * legend order, and the column total. Anchored to the column centre and flipped
 * to an edge in the outer thirds so it never clips the plot.
 * `pointer-events-none` so it can't steal the hover.
 */
function ColumnTooltip({
  columnKey,
  bucket,
  legend,
  col,
  cols,
  formatValue,
  formatSeries,
  testIdPrefix,
}: ColumnTooltipProps): React.JSX.Element {
  const entries = legend
    .map((entry) => ({ entry, value: bucket.get(entry.series) ?? 0 }))
    .filter((r) => r.value > 0);
  const total = entries.reduce((sum, r) => sum + r.value, 0);

  const centerPct = ((col + 0.5) / cols) * 100;
  const align: 'left' | 'center' | 'right' =
    col < cols / 3 ? 'left' : col >= (cols * 2) / 3 ? 'right' : 'center';
  const position: React.CSSProperties =
    align === 'left'
      ? { left: `${(col / cols) * 100}%` }
      : align === 'right'
        ? { right: `${((cols - 1 - col) / cols) * 100}%` }
        : { left: `${centerPct}%`, transform: 'translateX(-50%)' };

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-1 z-10 min-w-[8rem] border border-border-primary bg-surface-secondary px-2 py-1.5 text-[11px] shadow-md"
      style={position}
      data-testid={`${testIdPrefix}-tooltip`}
    >
      <div className="mb-1 font-mono text-text-secondary">{columnKey}</div>
      {entries.length === 0 ? (
        <div className="text-text-tertiary">No usage</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {entries.map(({ entry, value }) => (
            <li key={entry.series} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: entry.color }}
              />
              <span className="font-mono text-text-secondary">{formatSeries(entry.series)}</span>
              <span className="ml-auto pl-2 font-mono tabular-nums text-text-tertiary">
                {formatValue(value)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 1 && (
        <div className="mt-1 flex items-center gap-1.5 border-t border-border-primary pt-1">
          <span className="font-mono text-text-tertiary">total</span>
          <span className="ml-auto pl-2 font-mono tabular-nums text-text-secondary">
            {formatValue(total)}
          </span>
        </div>
      )}
    </div>
  );
}
